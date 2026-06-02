const crypto = require("crypto");

const TOKEN_REFRESH_SKEW_SECONDS = 300;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) {
      return null;
    }
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function normalizeScalar(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function extractIdentity(tokens) {
  const idPayload = decodeJwtPayload(tokens.id_token) || {};
  const accessPayload = decodeJwtPayload(tokens.access_token) || {};
  const idAuth = idPayload["https://api.openai.com/auth"] || {};
  const accessAuth = accessPayload["https://api.openai.com/auth"] || {};
  const profile = idPayload["https://api.openai.com/profile"] || {};

  const email = firstString(idPayload.email, profile.email, accessAuth.email, idAuth.email);
  if (!email) {
    throw new Error("OAuth 响应中缺少 email");
  }

  const planType = firstString(
    accessAuth.chatgpt_plan_type,
    idAuth.chatgpt_plan_type,
    accessAuth.plan_type,
    idAuth.plan_type
  );
  const subscriptionActiveUntil = normalizeScalar(
    accessAuth.chatgpt_subscription_active_until ??
      idAuth.chatgpt_subscription_active_until
  );
  const accountId = firstString(
    tokens.account_id,
    accessAuth.chatgpt_account_id,
    accessAuth.account_id,
    idAuth.chatgpt_account_id,
    idAuth.account_id
  );
  const organizationId = firstString(
    accessAuth.organization_id,
    accessAuth.org_id,
    idAuth.organization_id,
    idAuth.org_id
  );
  const userId = firstString(accessAuth.chatgpt_user_id, idAuth.chatgpt_user_id, idPayload.sub);

  return {
    email,
    userId,
    planType,
    subscriptionActiveUntil,
    accountId,
    organizationId
  };
}

function buildAccountId(identity) {
  const seed = [
    identity.email.toLowerCase(),
    identity.accountId || "",
    identity.organizationId || ""
  ].join("|");
  return `codex_${sha256(seed).slice(0, 24)}`;
}

function isAccessTokenExpired(
  accessToken,
  getNowSeconds = nowSeconds,
  skewSeconds = TOKEN_REFRESH_SKEW_SECONDS
) {
  const payload = decodeJwtPayload(accessToken);
  if (!payload || typeof payload.exp !== "number") {
    return true;
  }
  return payload.exp <= getNowSeconds() + skewSeconds;
}

function formatError(error) {
  if (!error) {
    return "未知错误";
  }
  if (typeof error === "string") {
    return error;
  }
  return error.message || String(error);
}

function isRefreshTokenReuseError(error) {
  const text = [
    error?.code,
    error?.message,
    error?.response?.body,
    typeof error === "string" ? error : null
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return text.includes("refresh_token_reused");
}

function normalizeAccountTokens(tokens) {
  if (!tokens || !tokens.id_token || !tokens.access_token) {
    return null;
  }
  return {
    id_token: tokens.id_token,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || "",
    account_id: tokens.account_id || null
  };
}

function extractCodexAuthTokens(auth) {
  return normalizeAccountTokens(auth?.tokens || auth);
}

function codexBundleTimestampSeconds(auth) {
  const timestamp = Date.parse(auth?.last_refresh || "");
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

class AccountAuthCoordinator {
  constructor({
    loadStore,
    saveStore,
    loadAccountTokens,
    saveAccountTokens,
    refreshTokens,
    loadCodexAuthBundles,
    saveCodexAuthBundle,
    nowSeconds: getNowSeconds = nowSeconds,
    tokenRefreshSkewSeconds = TOKEN_REFRESH_SKEW_SECONDS,
    formatError: formatFailure = formatError
  }) {
    this.loadStore = loadStore;
    this.saveStore = saveStore;
    this.loadAccountTokens = loadAccountTokens;
    this.saveAccountTokens = saveAccountTokens;
    this.refreshTokens = refreshTokens;
    this.loadCodexAuthBundles = loadCodexAuthBundles;
    this.saveCodexAuthBundle = saveCodexAuthBundle;
    this.nowSeconds = getNowSeconds;
    this.tokenRefreshSkewSeconds = tokenRefreshSkewSeconds;
    this.formatError = formatFailure;
    this.accountLocks = new Map();
  }

  async syncCodexAuthBundleForKnownAccount() {
    const match = await this.findCodexBundleMatch();
    if (!match) {
      return null;
    }
    return this.withAccountLock(match.accountId, () =>
      this.importCodexMatchInsideLock(match)
    );
  }

  async ensureFreshAccount(accountId) {
    return this.withAccountLock(accountId, async () => {
      await this.syncCodexAuthBundleForAccountInsideLock(accountId);
      return this.ensureFreshAccountInsideLock(accountId);
    });
  }

  async refreshStoredAccountTokens(accountId, reason) {
    return this.withAccountLock(accountId, async () => {
      await this.syncCodexAuthBundleForAccountInsideLock(accountId);
      return this.refreshStoredAccountTokensInsideLock(accountId, reason);
    });
  }

  async withAccountLock(accountId, operation) {
    const previous = this.accountLocks.get(accountId) || Promise.resolve();
    let releaseCurrent;
    const current = new Promise((resolve) => {
      releaseCurrent = resolve;
    });
    const next = previous.catch(() => {}).then(() => current);
    this.accountLocks.set(accountId, next);

    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (this.accountLocks.get(accountId) === next) {
        this.accountLocks.delete(accountId);
      }
    }
  }

  async ensureFreshAccountInsideLock(accountId) {
    const { account, tokens } = await this.loadAccountWithTokens(accountId);
    if (
      !isAccessTokenExpired(
        tokens.access_token,
        this.nowSeconds,
        this.tokenRefreshSkewSeconds
      )
    ) {
      return { account, tokens };
    }
    return this.refreshStoredAccountTokensInsideLock(
      accountId,
      "access_token 已过期"
    );
  }

  async refreshStoredAccountTokensInsideLock(accountId, reason, options = {}) {
    const { store, account, tokens } = await this.loadAccountWithTokens(accountId);
    if (!tokens.refresh_token) {
      const message = `${reason}: 缺少 refresh_token，请重新登录`;
      this.markReauthRequiredInsideLock(store, account, message);
      throw new Error(message);
    }

    try {
      const nextTokens = await this.refreshTokens(tokens.refresh_token, tokens.id_token);
      const identity = extractIdentity(nextTokens);
      const nextId = buildAccountId(identity);
      if (nextId !== accountId) {
        throw new Error("刷新响应账号与当前账号不匹配");
      }
      this.applyIdentityToAccount(account, identity);
      this.saveStore(store);
      await this.saveAccountTokens(accountId, normalizeAccountTokens(nextTokens));
      try {
        await this.mirrorCodexAuthBundleIfCurrentAccount(accountId, account, nextTokens);
      } catch {
        // The Codexit token has already been advanced; switching still does a hard write.
      }
      return { account, tokens: normalizeAccountTokens(nextTokens) };
    } catch (error) {
      const recovered = await this.recoverFromRefreshTokenReuseInsideLock(
        accountId,
        tokens.refresh_token,
        reason,
        error,
        options
      );
      if (recovered) {
        return recovered;
      }
      const message = this.buildRefreshFailureMessage(reason, error);
      this.markReauthRequiredInsideLock(store, account, message);
      throw new Error(message);
    }
  }

  async recoverFromRefreshTokenReuseInsideLock(
    accountId,
    staleRefreshToken,
    reason,
    error,
    options
  ) {
    if (options.skipRecovery || !isRefreshTokenReuseError(error)) {
      return null;
    }
    const recovered = await this.syncCodexAuthBundleForAccountInsideLock(accountId, {
      requireDifferentRefreshToken: staleRefreshToken,
      allowOlder: true
    });
    if (!recovered) {
      return null;
    }
    if (
      !isAccessTokenExpired(
        recovered.tokens.access_token,
        this.nowSeconds,
        this.tokenRefreshSkewSeconds
      )
    ) {
      return recovered;
    }
    return this.refreshStoredAccountTokensInsideLock(accountId, reason, {
      skipRecovery: true
    });
  }

  buildRefreshFailureMessage(reason, error) {
    if (!isRefreshTokenReuseError(error)) {
      return `${reason}: 授权刷新失败，请重新登录。${this.formatError(error)}`;
    }
    return `${reason}: 授权刷新失败，refresh token 已被其他会话轮换，无法继续使用旧 token。需要重新登录以建立新的 refresh token 链。${this.formatError(error)}`;
  }

  async loadAccountWithTokens(accountId) {
    const store = this.loadStore();
    const account = store.accounts.find((item) => item.id === accountId);
    if (!account) {
      throw new Error("账号不存在");
    }
    const tokens = await this.loadAccountTokens(accountId);
    return { store, account, tokens };
  }

  async findCodexBundleMatch(accountId = null) {
    const store = this.loadStore();
    const accounts = Array.isArray(store.accounts) ? store.accounts : [];
    const bundles = await this.loadCodexAuthBundles();
    const matches = [];

    for (const [index, bundle] of bundles.entries()) {
      const auth = bundle?.auth || bundle;
      const tokens = extractCodexAuthTokens(auth);
      if (!tokens?.refresh_token) {
        continue;
      }

      let identity;
      try {
        identity = extractIdentity(tokens);
      } catch {
        continue;
      }
      const matchedAccountId = buildAccountId(identity);
      if (accountId && matchedAccountId !== accountId) {
        continue;
      }
      const account = accounts.find((item) => item.id === matchedAccountId);
      if (!account) {
        continue;
      }
      matches.push({
        account,
        accountId: matchedAccountId,
        identity,
        tokens,
        source: bundle?.source || "codex-auth",
        timestampSeconds: codexBundleTimestampSeconds(auth),
        index
      });
    }

    matches.sort((left, right) => {
      const rightTime = right.timestampSeconds || 0;
      const leftTime = left.timestampSeconds || 0;
      return rightTime - leftTime || left.index - right.index;
    });
    return matches[0] || null;
  }

  async syncCodexAuthBundleForAccountInsideLock(accountId, options = {}) {
    const match = await this.findCodexBundleMatch(accountId);
    if (!match) {
      return null;
    }
    if (
      options.requireDifferentRefreshToken &&
      match.tokens.refresh_token === options.requireDifferentRefreshToken
    ) {
      return null;
    }
    return this.importCodexMatchInsideLock(match, options);
  }

  async importCodexMatchInsideLock(match, options = {}) {
    const store = this.loadStore();
    const account = store.accounts.find((item) => item.id === match.accountId);
    if (!account) {
      return null;
    }
    if (!options.allowOlder && this.isClearlyOlderThanStored(match, account)) {
      return null;
    }

    this.applyIdentityToAccount(account, match.identity, match.timestampSeconds);
    this.saveStore(store);
    await this.saveAccountTokens(match.accountId, normalizeAccountTokens(match.tokens));
    return {
      account,
      tokens: normalizeAccountTokens(match.tokens),
      source: match.source
    };
  }

  isClearlyOlderThanStored(match, account) {
    if (!match.timestampSeconds || !account.tokenUpdatedAt) {
      return false;
    }
    return match.timestampSeconds + 1 < account.tokenUpdatedAt;
  }

  applyIdentityToAccount(account, identity, tokenUpdatedAt = null) {
    account.email = identity.email;
    account.userId = identity.userId;
    account.planType = identity.planType || account.planType;
    account.subscriptionActiveUntil =
      identity.subscriptionActiveUntil || account.subscriptionActiveUntil;
    account.accountId = identity.accountId || account.accountId;
    account.organizationId = identity.organizationId || account.organizationId;
    account.tokenUpdatedAt = tokenUpdatedAt || this.nowSeconds();
    account.requiresReauth = false;
    account.reauthReason = null;
    account.quotaError = null;
  }

  markReauthRequiredInsideLock(store, account, reason) {
    account.requiresReauth = true;
    account.reauthReason = reason;
    this.saveStore(store);
  }

  async mirrorCodexAuthBundleIfCurrentAccount(accountId, account, tokens) {
    if (!this.saveCodexAuthBundle) {
      return false;
    }
    const match = await this.findCodexBundleMatch(accountId);
    if (!match) {
      return false;
    }
    await this.saveCodexAuthBundle(account, tokens);
    return true;
  }
}

module.exports = {
  AccountAuthCoordinator,
  TOKEN_REFRESH_SKEW_SECONDS,
  buildAccountId,
  decodeJwtPayload,
  extractCodexAuthTokens,
  extractIdentity,
  isAccessTokenExpired,
  isRefreshTokenReuseError,
  sha256
};
