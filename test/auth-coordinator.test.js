const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  AccountAuthCoordinator,
  buildAccountId,
  extractIdentity
} = require("../src/auth-coordinator");

const NOW_SECONDS = 1_800_000_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature"
  ].join(".");
}

function makeTokens({
  email = "user@example.com",
  accountId = "acct_user",
  userId = "user_1",
  accessExp = NOW_SECONDS + 3600,
  refreshToken = "refresh_token"
} = {}) {
  const auth = {
    email,
    chatgpt_account_id: accountId,
    chatgpt_user_id: userId,
    chatgpt_plan_type: "team"
  };
  return {
    id_token: jwt({
      email,
      sub: userId,
      "https://api.openai.com/auth": auth
    }),
    access_token: jwt({
      exp: accessExp,
      "https://api.openai.com/auth": auth
    }),
    refresh_token: refreshToken
  };
}

function makeAccount(tokens, overrides = {}) {
  const identity = extractIdentity(tokens);
  return {
    id: buildAccountId(identity),
    email: identity.email,
    userId: identity.userId,
    planType: identity.planType,
    subscriptionActiveUntil: identity.subscriptionActiveUntil,
    accountId: identity.accountId,
    organizationId: identity.organizationId,
    createdAt: NOW_SECONDS - 1000,
    lastUsedAt: NOW_SECONDS - 900,
    tokenUpdatedAt: NOW_SECONDS - 800,
    requiresReauth: false,
    reauthReason: null,
    quota: null,
    quotaError: null,
    ...overrides
  };
}

function makeCodexBundle(tokens, lastRefreshSeconds = NOW_SECONDS) {
  return {
    source: "auth.json",
    auth: {
      OPENAI_API_KEY: null,
      tokens,
      last_refresh: new Date(lastRefreshSeconds * 1000).toISOString()
    }
  };
}

function makeHarness({ accounts, tokensByAccountId, codexBundles = [], refreshTokens }) {
  let store = {
    version: 1,
    currentAccountId: accounts[0]?.id || null,
    accounts: clone(accounts)
  };
  const tokenStore = new Map(
    Object.entries(tokensByAccountId).map(([accountId, tokens]) => [
      accountId,
      clone(tokens)
    ])
  );
  const savedCodexBundles = [];

  const coordinator = new AccountAuthCoordinator({
    loadStore: () => clone(store),
    saveStore: (nextStore) => {
      store = clone(nextStore);
    },
    loadAccountTokens: async (accountId) => clone(tokenStore.get(accountId)),
    saveAccountTokens: async (accountId, tokens) => {
      tokenStore.set(accountId, clone(tokens));
    },
    refreshTokens,
    loadCodexAuthBundles: async () => clone(codexBundles),
    saveCodexAuthBundle: async (account, tokens) => {
      savedCodexBundles.push({ account: clone(account), tokens: clone(tokens) });
    },
    nowSeconds: () => NOW_SECONDS,
    formatError: (error) => error.message || String(error)
  });

  return {
    coordinator,
    getStore: () => clone(store),
    getTokens: (accountId) => clone(tokenStore.get(accountId)),
    savedCodexBundles
  };
}

test("serializes concurrent refreshes for the same expired account", async () => {
  const expiredTokens = makeTokens({
    accessExp: NOW_SECONDS - 10,
    refreshToken: "old-refresh"
  });
  const refreshedTokens = makeTokens({
    accessExp: NOW_SECONDS + 3600,
    refreshToken: "new-refresh"
  });
  const account = makeAccount(expiredTokens);
  const refreshCalls = [];

  const { coordinator, getTokens } = makeHarness({
    accounts: [account],
    tokensByAccountId: { [account.id]: expiredTokens },
    refreshTokens: async (refreshToken) => {
      refreshCalls.push(refreshToken);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return refreshedTokens;
    }
  });

  await Promise.all([
    coordinator.ensureFreshAccount(account.id),
    coordinator.ensureFreshAccount(account.id)
  ]);

  assert.deepEqual(refreshCalls, ["old-refresh"]);
  assert.equal(getTokens(account.id).refresh_token, "new-refresh");
});

test("imports a newer Codex auth bundle before refreshing stored tokens", async () => {
  const staleTokens = makeTokens({
    accessExp: NOW_SECONDS - 10,
    refreshToken: "stale-refresh"
  });
  const codexTokens = makeTokens({
    accessExp: NOW_SECONDS + 3600,
    refreshToken: "codex-refresh"
  });
  const account = makeAccount(staleTokens, {
    tokenUpdatedAt: NOW_SECONDS - 200
  });
  const refreshCalls = [];

  const { coordinator, getStore, getTokens } = makeHarness({
    accounts: [account],
    tokensByAccountId: { [account.id]: staleTokens },
    codexBundles: [makeCodexBundle(codexTokens, NOW_SECONDS - 10)],
    refreshTokens: async (refreshToken) => {
      refreshCalls.push(refreshToken);
      throw new Error("refresh should not be called");
    }
  });

  await coordinator.ensureFreshAccount(account.id);

  assert.deepEqual(refreshCalls, []);
  assert.equal(getTokens(account.id).refresh_token, "codex-refresh");
  assert.equal(getStore().accounts[0].requiresReauth, false);
});

test("syncs the current Codex token before switching to another account", async () => {
  const currentStoredTokens = makeTokens({
    email: "current@example.com",
    accountId: "acct_current",
    accessExp: NOW_SECONDS - 10,
    refreshToken: "current-stale-refresh"
  });
  const currentCodexTokens = makeTokens({
    email: "current@example.com",
    accountId: "acct_current",
    accessExp: NOW_SECONDS + 3600,
    refreshToken: "current-codex-refresh"
  });
  const targetStoredTokens = makeTokens({
    email: "target@example.com",
    accountId: "acct_target",
    accessExp: NOW_SECONDS - 10,
    refreshToken: "target-old-refresh"
  });
  const targetRefreshedTokens = makeTokens({
    email: "target@example.com",
    accountId: "acct_target",
    accessExp: NOW_SECONDS + 3600,
    refreshToken: "target-new-refresh"
  });
  const currentAccount = makeAccount(currentStoredTokens, {
    tokenUpdatedAt: NOW_SECONDS - 200
  });
  const targetAccount = makeAccount(targetStoredTokens);
  const refreshCalls = [];

  const { coordinator, getTokens } = makeHarness({
    accounts: [currentAccount, targetAccount],
    tokensByAccountId: {
      [currentAccount.id]: currentStoredTokens,
      [targetAccount.id]: targetStoredTokens
    },
    codexBundles: [makeCodexBundle(currentCodexTokens, NOW_SECONDS - 10)],
    refreshTokens: async (refreshToken) => {
      refreshCalls.push(refreshToken);
      return targetRefreshedTokens;
    }
  });

  await coordinator.syncCodexAuthBundleForKnownAccount();
  await coordinator.refreshStoredAccountTokens(targetAccount.id, "切换前刷新 token");

  assert.equal(getTokens(currentAccount.id).refresh_token, "current-codex-refresh");
  assert.deepEqual(refreshCalls, ["target-old-refresh"]);
  assert.equal(getTokens(targetAccount.id).refresh_token, "target-new-refresh");
});

test("marks reauth when a reused refresh token cannot be recovered", async () => {
  const expiredTokens = makeTokens({
    accessExp: NOW_SECONDS - 10,
    refreshToken: "already-used-refresh"
  });
  const account = makeAccount(expiredTokens);

  const { coordinator, getStore } = makeHarness({
    accounts: [account],
    tokensByAccountId: { [account.id]: expiredTokens },
    refreshTokens: async () => {
      throw new Error(
        'refresh_token_reused: {"error":{"code":"refresh_token_reused"}}'
      );
    }
  });

  await assert.rejects(
    coordinator.ensureFreshAccount(account.id),
    /需要重新登录以建立新的 refresh token 链/
  );

  const storedAccount = getStore().accounts[0];
  assert.equal(storedAccount.requiresReauth, true);
  assert.match(storedAccount.reauthReason, /refresh_token_reused/);
});

test("recovers a reused refresh token from a different Codex auth token", async () => {
  const expiredTokens = makeTokens({
    accessExp: NOW_SECONDS - 10,
    refreshToken: "already-used-refresh"
  });
  const codexTokens = makeTokens({
    accessExp: NOW_SECONDS + 3600,
    refreshToken: "recoverable-codex-refresh"
  });
  const account = makeAccount(expiredTokens, {
    tokenUpdatedAt: NOW_SECONDS
  });

  const { coordinator, getStore, getTokens } = makeHarness({
    accounts: [account],
    tokensByAccountId: { [account.id]: expiredTokens },
    codexBundles: [makeCodexBundle(codexTokens, NOW_SECONDS - 100)],
    refreshTokens: async () => {
      throw new Error(
        'refresh_token_reused: {"error":{"code":"refresh_token_reused"}}'
      );
    }
  });

  await coordinator.ensureFreshAccount(account.id);

  const storedAccount = getStore().accounts[0];
  assert.equal(storedAccount.requiresReauth, false);
  assert.equal(getTokens(account.id).refresh_token, "recoverable-codex-refresh");
});
