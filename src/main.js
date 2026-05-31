const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  net,
  session,
  shell,
  Tray
} = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_ENDPOINT = "https://auth.openai.com/oauth/authorize";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const SCOPES =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
const ORIGINATOR = "codex_vscode";
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_REFRESH_SKEW_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 20 * 1000;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CHATGPT_REFERER = "https://chatgpt.com/";
const CHATGPT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const ACCOUNT_TOKEN_SERVICE = "Codexit Account Tokens";
const CODEX_KEYCHAIN_SERVICE = "Codex Auth";
const CODEX_APP_PATH = "/Applications/Codex.app";
const APP_BACKGROUND = "#f4f1ea";

let mainWindow = null;
let pendingOAuth = null;
let tray = null;
let trayBusyLabel = null;
let trayLastError = null;
let isQuitting = false;

app.setName("Codexit");

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function appIconPath() {
  const packagedIcon = path.join(process.resourcesPath, "icon.icns");
  if (app.isPackaged && fs.existsSync(packagedIcon)) {
    return packagedIcon;
  }
  return path.join(__dirname, "..", "build", "icon.icns");
}

function assetPath(fileName) {
  return path.join(__dirname, "assets", fileName);
}

function trayIconPath() {
  return assetPath("menu-bar-template.png");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    title: "Codexit",
    backgroundColor: APP_BACKGROUND,
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  return mainWindow;
}

function showMainWindow() {
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow();
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }
  window.focus();
}

app.whenReady().then(() => {
  if (process.argv.includes("--smoke-test")) {
    console.log("codexit-smoke-ok");
    app.quit();
    return;
  }
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }
  createTray();
  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function appDataDir() {
  return app.getPath("userData");
}

function storePath() {
  return path.join(appDataDir(), "accounts.json");
}

function codexHome() {
  const raw = process.env.CODEX_HOME ? process.env.CODEX_HOME.trim() : "";
  if (raw) {
    return path.resolve(raw.replace(/^['"]|['"]$/g, ""));
  }
  return path.join(os.homedir(), ".codex");
}

function authJsonPath() {
  return path.join(codexHome(), "auth.json");
}

function configTomlPath() {
  return path.join(codexHome(), "config.toml");
}

function execFileP(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        maxBuffer: 8 * 1024 * 1024,
        ...options
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function readJsonIfExists(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeFileAtomic(file, content, backup = true) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (backup && fs.existsSync(file)) {
    const backupFile = `${file}.bak`;
    try {
      fs.copyFileSync(file, backupFile);
    } catch {
      // Best effort only; the atomic write below is the important part.
    }
  }
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function writeJsonAtomic(file, value, backup = true) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, backup);
}

function defaultStore() {
  return {
    version: 1,
    currentAccountId: null,
    accounts: []
  };
}

function loadStore() {
  const store = readJsonIfExists(storePath(), defaultStore());
  if (!Array.isArray(store.accounts)) {
    store.accounts = [];
  }
  if (!("currentAccountId" in store)) {
    store.currentAccountId = null;
  }
  return store;
}

function saveStore(store) {
  writeJsonAtomic(storePath(), store);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function randomToken() {
  return base64Url(crypto.randomBytes(32));
}

function buildCodeChallenge(verifier) {
  return base64Url(crypto.createHash("sha256").update(verifier).digest());
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

function sanitizeAccount(account, store) {
  return {
    ...account,
    isCurrent: store.currentAccountId === account.id
  };
}

function listAccounts() {
  const store = loadStore();
  return store.accounts
    .slice()
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
    .map((account) => sanitizeAccount(account, store));
}

async function keychainWrite(service, account, secret) {
  await execFileP("/usr/bin/security", [
    "add-generic-password",
    "-U",
    "-s",
    service,
    "-a",
    account,
    "-w",
    secret
  ]);
}

async function keychainRead(service, account) {
  try {
    const { stdout } = await execFileP("/usr/bin/security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w"
    ]);
    const secret = stdout.trim();
    return secret || null;
  } catch (error) {
    const stderr = String(error.stderr || "").toLowerCase();
    if (
      error.code === 44 ||
      stderr.includes("could not be found") ||
      stderr.includes("errsecitemnotfound") ||
      stderr.includes("specified item could not be found")
    ) {
      return null;
    }
    throw error;
  }
}

async function keychainDelete(service, account) {
  try {
    await execFileP("/usr/bin/security", [
      "delete-generic-password",
      "-s",
      service,
      "-a",
      account
    ]);
  } catch {
    // Missing items are fine.
  }
}

async function saveAccountTokens(accountId, tokens) {
  await keychainWrite(ACCOUNT_TOKEN_SERVICE, accountId, JSON.stringify(tokens));
}

async function loadAccountTokens(accountId) {
  const secret = await keychainRead(ACCOUNT_TOKEN_SERVICE, accountId);
  if (!secret) {
    throw new Error("账号 token 不存在，请重新登录");
  }
  return JSON.parse(secret);
}

async function upsertAccount(tokens) {
  const identity = extractIdentity(tokens);
  const id = buildAccountId(identity);
  const store = loadStore();
  const existingIndex = store.accounts.findIndex((account) => account.id === id);
  const existing = existingIndex >= 0 ? store.accounts[existingIndex] : null;
  const timestamp = nowSeconds();
  const account = {
    id,
    email: identity.email,
    userId: identity.userId,
    planType: identity.planType,
    subscriptionActiveUntil: identity.subscriptionActiveUntil,
    accountId: identity.accountId,
    organizationId: identity.organizationId,
    createdAt: existing?.createdAt || timestamp,
    lastUsedAt: timestamp,
    tokenUpdatedAt: timestamp,
    requiresReauth: false,
    reauthReason: null,
    quota: existing?.quota || null,
    quotaError: null
  };

  if (existingIndex >= 0) {
    store.accounts[existingIndex] = account;
  } else {
    store.accounts.push(account);
  }
  saveStore(store);
  await saveAccountTokens(id, tokens);
  return sanitizeAccount(account, store);
}

async function replaceAccountTokens(accountId, tokens) {
  const identity = extractIdentity(tokens);
  const nextId = buildAccountId(identity);
  if (nextId !== accountId) {
    throw new Error(
      `登录账号不匹配：当前选择的是 ${accountId}，但 OAuth 返回的是 ${identity.email}。请使用原账号重新登录。`
    );
  }

  const store = loadStore();
  const account = store.accounts.find((item) => item.id === accountId);
  if (!account) {
    throw new Error("账号不存在");
  }

  const timestamp = nowSeconds();
  account.email = identity.email;
  account.userId = identity.userId;
  account.planType = identity.planType || account.planType;
  account.subscriptionActiveUntil =
    identity.subscriptionActiveUntil || account.subscriptionActiveUntil;
  account.accountId = identity.accountId;
  account.organizationId = identity.organizationId;
  account.lastUsedAt = timestamp;
  account.tokenUpdatedAt = timestamp;
  account.requiresReauth = false;
  account.reauthReason = null;
  account.quotaError = null;
  saveStore(store);
  await saveAccountTokens(accountId, tokens);
  return sanitizeAccount(account, store);
}

function isAccessTokenExpired(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (!payload || typeof payload.exp !== "number") {
    return true;
  }
  return payload.exp <= nowSeconds() + TOKEN_REFRESH_SKEW_SECONDS;
}

function formatFetchFailure(error) {
  const pieces = [error?.name, error?.message, error?.cause?.code, error?.cause?.message]
    .filter(Boolean)
    .map((item) => String(item).trim())
    .filter(Boolean);
  return pieces.length > 0 ? pieces.join(": ") : "fetch failed";
}

async function fetchWithTimeout(fetcher, url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetcher(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestWithFallback(url, init = {}) {
  try {
    return await fetchWithTimeout(globalThis.fetch.bind(globalThis), url, init);
  } catch (primaryError) {
    if (net && typeof net.fetch === "function") {
      try {
        return await fetchWithTimeout(net.fetch.bind(net), url, init);
      } catch (fallbackError) {
        throw new Error(
          `网络请求失败: ${formatFetchFailure(primaryError)}; Electron net fallback: ${formatFetchFailure(fallbackError)}`
        );
      }
    }
    throw new Error(`网络请求失败: ${formatFetchFailure(primaryError)}`);
  }
}

function parseJsonText(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function extractResponseErrorCode(payload, response) {
  return (
    payload?.detail?.code ||
    payload?.error?.code ||
    payload?.error ||
    payload?.code ||
    response?.statusText ||
    "request_failed"
  );
}

async function postFormJson(url, params) {
  const response = await requestWithFallback(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json"
    },
    body: new URLSearchParams(params)
  });
  const text = await response.text();
  const json = parseJsonText(text);
  if (!response.ok) {
    const code = extractResponseErrorCode(json, response);
    throw new Error(`${code}: ${text.slice(0, 600)}`);
  }
  return json || {};
}

async function refreshTokens(refreshToken, currentIdToken) {
  const tokenResponse = await postFormJson(TOKEN_ENDPOINT, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID
  });
  const accessToken = tokenResponse.access_token;
  if (!accessToken) {
    throw new Error("刷新响应中缺少 access_token");
  }
  return {
    id_token: tokenResponse.id_token || currentIdToken,
    access_token: accessToken,
    refresh_token: tokenResponse.refresh_token || refreshToken
  };
}

function applyIdentityToAccount(account, identity) {
  account.email = identity.email;
  account.userId = identity.userId;
  account.planType = identity.planType || account.planType;
  account.subscriptionActiveUntil =
    identity.subscriptionActiveUntil || account.subscriptionActiveUntil;
  account.accountId = identity.accountId || account.accountId;
  account.organizationId = identity.organizationId || account.organizationId;
  account.tokenUpdatedAt = nowSeconds();
  account.requiresReauth = false;
  account.reauthReason = null;
}

async function markReauthRequired(accountId, reason) {
  const store = loadStore();
  const account = store.accounts.find((item) => item.id === accountId);
  if (account) {
    account.requiresReauth = true;
    account.reauthReason = reason;
    saveStore(store);
  }
}

function saveQuotaError(accountId, error, code = null) {
  const store = loadStore();
  const account = store.accounts.find((item) => item.id === accountId);
  if (!account) {
    return;
  }
  account.quotaError = {
    code,
    message: formatError(error),
    timestamp: nowSeconds()
  };
  saveStore(store);
}

async function refreshStoredAccountTokens(accountId, reason) {
  const store = loadStore();
  const account = store.accounts.find((item) => item.id === accountId);
  if (!account) {
    throw new Error("账号不存在");
  }

  const tokens = await loadAccountTokens(accountId);
  if (!tokens.refresh_token) {
    const message = `${reason}: 缺少 refresh_token，请重新登录`;
    await markReauthRequired(accountId, message);
    throw new Error(message);
  }

  try {
    const nextTokens = await refreshTokens(tokens.refresh_token, tokens.id_token);
    const identity = extractIdentity(nextTokens);
    applyIdentityToAccount(account, identity);
    saveStore(store);
    await saveAccountTokens(accountId, nextTokens);
    return { account, tokens: nextTokens };
  } catch (error) {
    const message = `${reason}: 授权刷新失败，请重新登录。${formatError(error)}`;
    await markReauthRequired(accountId, message);
    throw new Error(message);
  }
}

async function ensureFreshAccount(accountId) {
  const store = loadStore();
  const account = store.accounts.find((item) => item.id === accountId);
  if (!account) {
    throw new Error("账号不存在");
  }
  const tokens = await loadAccountTokens(accountId);
  if (!isAccessTokenExpired(tokens.access_token)) {
    return { account, tokens };
  }
  return refreshStoredAccountTokens(accountId, "access_token 已过期");
}

function buildAuthUrl(redirectUri, codeChallenge, state) {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("originator", ORIGINATOR);
  return url.toString();
}

function closePendingOAuth() {
  if (pendingOAuth?.window && !pendingOAuth.window.isDestroyed()) {
    pendingOAuth.window.close();
  }
  if (pendingOAuth?.server) {
    try {
      pendingOAuth.server.close();
    } catch {
      // Already closed.
    }
  }
  pendingOAuth = null;
}

async function openOAuthLoginWindow(state) {
  if (state.window && !state.window.isDestroyed()) {
    state.window.focus();
    return;
  }

  const partition = `codexit-oauth-${state.loginId}`;
  const oauthSession = session.fromPartition(partition);
  await oauthSession.clearStorageData();
  await oauthSession.clearCache();

  const oauthWindow = new BrowserWindow({
    width: 980,
    height: 780,
    minWidth: 780,
    minHeight: 620,
    title: "OpenAI Login - Codexit",
    parent: mainWindow || undefined,
    modal: false,
    backgroundColor: "#111111",
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  oauthWindow.webContents.setWindowOpenHandler(({ url }) => {
    oauthWindow.loadURL(url);
    return { action: "deny" };
  });

  oauthWindow.on("closed", () => {
    if (pendingOAuth?.loginId === state.loginId) {
      pendingOAuth.window = null;
    }
  });

  state.window = oauthWindow;
  await oauthWindow.loadURL(state.authUrl);
}

async function startCallbackServer(state) {
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
    if (requestUrl.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const receivedState = requestUrl.searchParams.get("state");
    const code = requestUrl.searchParams.get("code");
    const error = requestUrl.searchParams.get("error");

    if (error) {
      state.error = error;
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end("<h1>Codexit 登录失败</h1><p>可以关闭这个页面。</p>");
      return;
    }
    if (receivedState !== state.state || !code) {
      res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      res.end("<h1>Codexit 回调无效</h1><p>可以关闭这个页面。</p>");
      return;
    }

    state.code = code;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<h1>Codexit 登录完成</h1><p>可以回到 Codexit。</p>");
    if (state.window && !state.window.isDestroyed()) {
      setTimeout(() => {
        if (state.window && !state.window.isDestroyed()) {
          state.window.close();
        }
      }, 800);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("oauth:completed", { loginId: state.loginId });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(CALLBACK_PORT, "localhost", resolve);
  });
  state.server = server;
}

async function startOAuth(options = {}) {
  if (pendingOAuth && Date.now() < pendingOAuth.expiresAt) {
    await openOAuthLoginWindow(pendingOAuth);
    return {
      loginId: pendingOAuth.loginId,
      authUrl: pendingOAuth.authUrl,
      reauthAccountId: pendingOAuth.reauthAccountId || null
    };
  }
  closePendingOAuth();

  const codeVerifier = randomToken();
  const codeChallenge = buildCodeChallenge(codeVerifier);
  const stateToken = randomToken();
  const loginId = randomToken();
  const redirectUri = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
  const authUrl = buildAuthUrl(redirectUri, codeChallenge, stateToken);
  const state = {
    loginId,
    state: stateToken,
    codeVerifier,
    redirectUri,
    authUrl,
    reauthAccountId: options.reauthAccountId || null,
    code: null,
    error: null,
    expiresAt: Date.now() + OAUTH_TIMEOUT_MS,
    server: null
  };

  try {
    await startCallbackServer(state);
  } catch (error) {
    throw new Error(
      error.code === "EADDRINUSE"
        ? `OAuth 回调端口 ${CALLBACK_PORT} 已被占用`
        : `OAuth 回调服务启动失败: ${formatError(error)}`
    );
  }

  pendingOAuth = state;
  await openOAuthLoginWindow(state);
  return { loginId, authUrl, reauthAccountId: state.reauthAccountId };
}

async function startOAuthReauth(accountId) {
  const store = loadStore();
  if (!store.accounts.some((account) => account.id === accountId)) {
    throw new Error("账号不存在");
  }
  return startOAuth({ reauthAccountId: accountId });
}

async function completeOAuth(loginId) {
  if (!pendingOAuth || pendingOAuth.loginId !== loginId) {
    throw new Error("OAuth 登录会话不存在或已过期");
  }
  if (pendingOAuth.error) {
    throw new Error(`OAuth 登录失败: ${pendingOAuth.error}`);
  }
  if (!pendingOAuth.code) {
    throw new Error("尚未收到 OAuth 回调");
  }

  const tokens = await postFormJson(TOKEN_ENDPOINT, {
    grant_type: "authorization_code",
    code: pendingOAuth.code,
    redirect_uri: pendingOAuth.redirectUri,
    client_id: CLIENT_ID,
    code_verifier: pendingOAuth.codeVerifier
  });
  const normalized = {
    id_token: tokens.id_token,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token
  };
  if (!normalized.id_token || !normalized.access_token) {
    throw new Error("OAuth 响应缺少必要 token");
  }

  const account = pendingOAuth.reauthAccountId
    ? await replaceAccountTokens(pendingOAuth.reauthAccountId, normalized)
    : await upsertAccount(normalized);
  closePendingOAuth();
  return account;
}

function normalizeWindow(windowInfo) {
  if (!windowInfo) {
    return {
      usedPercent: null,
      remainingPercent: null,
      resetAt: null,
      windowMinutes: null,
      present: false
    };
  }
  const used = Number.isFinite(windowInfo.used_percent)
    ? Math.max(0, Math.min(100, windowInfo.used_percent))
    : 0;
  const resetAt =
    typeof windowInfo.reset_at === "number"
      ? windowInfo.reset_at
      : typeof windowInfo.reset_after_seconds === "number" &&
          windowInfo.reset_after_seconds >= 0
        ? nowSeconds() + windowInfo.reset_after_seconds
        : null;
  const windowMinutes =
    typeof windowInfo.limit_window_seconds === "number" &&
    windowInfo.limit_window_seconds > 0
      ? Math.ceil(windowInfo.limit_window_seconds / 60)
      : null;
  return {
    usedPercent: used,
    remainingPercent: 100 - used,
    resetAt,
    windowMinutes,
    present: true
  };
}

function parseQuota(payload) {
  const rateLimit = payload?.rate_limit || {};
  return {
    fiveHour: normalizeWindow(rateLimit.primary_window),
    weekly: normalizeWindow(rateLimit.secondary_window),
    allowed: rateLimit.allowed ?? null,
    limitReached: rateLimit.limit_reached ?? null,
    planType: payload?.plan_type || null,
    updatedAt: nowSeconds()
  };
}

async function fetchUsage(tokens) {
  const response = await requestWithFallback(USAGE_URL, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${tokens.access_token}`,
      referer: CHATGPT_REFERER,
      "user-agent": CHATGPT_USER_AGENT
    }
  });
  const body = await response.text();
  const payload = parseJsonText(body);
  return { response, body, payload };
}

function isRetryableAuthFailure(response, payload, body) {
  if (response.status !== 401) {
    return false;
  }
  const code = String(extractResponseErrorCode(payload, response) || "").toLowerCase();
  const text = String(body || "").toLowerCase();
  return (
    code.includes("token") ||
    code.includes("unauthorized") ||
    text.includes("token_invalidated") ||
    text.includes("authentication token has been invalidated") ||
    text.includes("expired") ||
    text.includes("unauthorized")
  );
}

async function refreshQuotaInternal(accountId) {
  let { account, tokens } = await ensureFreshAccount(accountId);
  let result = await fetchUsage(tokens);

  if (isRetryableAuthFailure(result.response, result.payload, result.body)) {
    ({ account, tokens } = await refreshStoredAccountTokens(
      accountId,
      "额度查询认证失败"
    ));
    result = await fetchUsage(tokens);
  }

  const { response, body, payload } = result;
  if (!response.ok) {
    const code = extractResponseErrorCode(payload, response);
    throw new Error(`额度查询失败 (${response.status} ${code}): ${body.slice(0, 500)}`);
  }
  const quota = parseQuota(payload);

  const store = loadStore();
  const stored = store.accounts.find((item) => item.id === account.id);
  if (stored) {
    stored.quota = quota;
    stored.quotaError = null;
    if (quota.planType) {
      stored.planType = quota.planType;
    }
    saveStore(store);
    return sanitizeAccount(stored, store).quota;
  }
  return quota;
}

async function refreshQuota(accountId) {
  try {
    return await refreshQuotaInternal(accountId);
  } catch (error) {
    saveQuotaError(accountId, error);
    throw error;
  }
}

function officialCodexKeychainAccount() {
  const home = codexHome();
  let resolved = home;
  try {
    resolved = fs.realpathSync.native(home);
  } catch {
    resolved = path.resolve(home);
  }
  return `cli|${sha256(resolved).slice(0, 16)}`;
}

function buildCodexAuthFile(account, tokens) {
  return {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || "",
      account_id: account.accountId || null
    },
    last_refresh: new Date().toISOString()
  };
}

function prepareConfigForOAuth() {
  const file = configTomlPath();
  if (!fs.existsSync(file)) {
    return false;
  }
  const original = fs.readFileSync(file, "utf8");
  const lines = original.split(/\r?\n/);
  const next = [];
  let inTopLevel = true;
  let preferredSeen = false;
  let insertedPreferred = false;

  for (const line of lines) {
    if (inTopLevel && /^\s*\[/.test(line)) {
      if (!preferredSeen && !insertedPreferred) {
        next.push('preferred_auth_method = "chatgpt"');
        insertedPreferred = true;
      }
      inTopLevel = false;
    }

    if (inTopLevel && /^\s*(openai_base_url|model_provider)\s*=/.test(line)) {
      continue;
    }
    if (inTopLevel && /^\s*preferred_auth_method\s*=/.test(line)) {
      next.push('preferred_auth_method = "chatgpt"');
      preferredSeen = true;
      continue;
    }
    next.push(line);
  }

  if (!preferredSeen && !insertedPreferred) {
    next.push('preferred_auth_method = "chatgpt"');
  }

  const updated = next.join("\n");
  if (updated !== original) {
    writeFileAtomic(file, updated, true);
    return true;
  }
  return false;
}

async function writeCodexAuthBundle(account, tokens) {
  const home = codexHome();
  fs.mkdirSync(home, { recursive: true });
  const authFile = buildCodexAuthFile(account, tokens);
  writeJsonAtomic(authJsonPath(), authFile, true);
  prepareConfigForOAuth();
  await keychainWrite(
    CODEX_KEYCHAIN_SERVICE,
    officialCodexKeychainAccount(),
    JSON.stringify(authFile)
  );
}

async function findCodexMainPids() {
  try {
    const { stdout } = await execFileP("/bin/ps", ["-axo", "pid=,command="]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) {
          return null;
        }
        return { pid: Number(match[1]), command: match[2] };
      })
      .filter(Boolean)
      .filter((entry) => entry.command.includes("/Codex.app/Contents/MacOS/Codex"))
      .map((entry) => entry.pid);
  } catch {
    return [];
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCodexExit(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pids = await findCodexMainPids();
    if (pids.length === 0) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function stopCodex() {
  const initialPids = await findCodexMainPids();
  if (initialPids.length === 0) {
    return false;
  }
  try {
    await execFileP("/usr/bin/osascript", [
      "-e",
      'tell application "Codex" to quit'
    ]);
  } catch {
    // Fall through to process termination if AppleScript cannot talk to the app.
  }
  if (await waitForCodexExit(12000)) {
    return true;
  }

  for (const pid of await findCodexMainPids()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may already be gone.
    }
  }
  if (await waitForCodexExit(5000)) {
    return true;
  }
  for (const pid of await findCodexMainPids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process may already be gone.
    }
  }
  await waitForCodexExit(3000);
  return true;
}

async function startCodex() {
  if (fs.existsSync(CODEX_APP_PATH)) {
    await execFileP("/usr/bin/open", [CODEX_APP_PATH]);
    return true;
  }
  await execFileP("/usr/bin/open", ["-a", "Codex"]);
  return true;
}

async function switchAccount(accountId) {
  const { account, tokens } = await refreshStoredAccountTokens(
    accountId,
    "切换前刷新 token"
  );
  const codexStopped = await stopCodex();
  await writeCodexAuthBundle(account, tokens);

  const store = loadStore();
  const stored = store.accounts.find((item) => item.id === accountId);
  if (stored) {
    stored.lastUsedAt = nowSeconds();
    stored.requiresReauth = false;
    stored.reauthReason = null;
  }
  store.currentAccountId = accountId;
  saveStore(store);

  const codexStarted = await startCodex();
  return {
    account: sanitizeAccount(stored || account, store),
    codexStopped,
    authWritten: true,
    keychainWritten: true,
    codexStarted
  };
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

function truncateMenuText(value, maxLength = 72) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function trayQuotaValue(account, key) {
  const windowInfo = account.quota?.[key];
  if (!windowInfo || windowInfo.remainingPercent === null) {
    return "-";
  }
  const remaining = Math.round(
    Math.max(0, Math.min(100, windowInfo.remainingPercent))
  );
  return `${remaining}%`;
}

function trayAccountSublabel(account) {
  const error = account.reauthReason || account.quotaError?.message;
  if (error) {
    return `需处理 · ${truncateMenuText(error, 44)}`;
  }
  return `5 小时 ${trayQuotaValue(account, "fiveHour")} · 周额度 ${trayQuotaValue(
    account,
    "weekly"
  )}`;
}

function refreshTrayMenu() {
  if (!tray) {
    return;
  }

  const accounts = listAccounts();
  const current = accounts.find((account) => account.isCurrent);
  const hasAccounts = accounts.length > 0;
  const accountItems = hasAccounts
    ? accounts.map((account) => ({
        label: account.email,
        sublabel: trayAccountSublabel(account),
        type: "checkbox",
        checked: Boolean(account.isCurrent),
        enabled: !trayBusyLabel,
        click: () => {
          if (account.isCurrent) {
            return;
          }
          runTrayTask(`正在切换到 ${account.email}...`, () =>
            switchAccount(account.id)
          );
        }
      }))
    : [
        {
          label: "还没有账号",
          sublabel: "打开主窗口添加账号",
          enabled: false
        }
      ];

  const template = [
    {
      label: trayBusyLabel || `当前：${current?.email || "未切换"}`,
      enabled: false
    },
    {
      label: hasAccounts
        ? `额度：5 小时 ${trayQuotaValue(current || {}, "fiveHour")} · 周额度 ${trayQuotaValue(
            current || {},
            "weekly"
          )}`
        : "额度：暂无账号",
      enabled: false
    },
    ...(trayLastError
      ? [
          { type: "separator" },
          {
            label: `上次错误：${truncateMenuText(trayLastError)}`,
            enabled: false
          }
        ]
      : []),
    { type: "separator" },
    {
      label: "切换账号",
      enabled: hasAccounts && !trayBusyLabel,
      submenu: accountItems
    },
    {
      label: "刷新全部额度",
      enabled: hasAccounts && !trayBusyLabel,
      click: () => runTrayTask("正在刷新全部额度...", refreshAllAccountsFromTray)
    },
    { type: "separator" },
    {
      label: "打开 Codexit",
      click: showMainWindow
    },
    {
      label: "打开 Codex 目录",
      click: () => runTrayTask("正在打开 Codex 目录...", openCodexHome)
    },
    { type: "separator" },
    {
      label: "退出 Codexit",
      role: "quit"
    }
  ];

  tray.setToolTip(`Codexit · 当前：${current?.email || "未切换"}`);
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function runTrayTask(label, task) {
  if (trayBusyLabel) {
    return;
  }
  trayBusyLabel = label;
  trayLastError = null;
  refreshTrayMenu();

  Promise.resolve()
    .then(task)
    .catch((error) => {
      trayLastError = formatError(error);
    })
    .finally(() => {
      trayBusyLabel = null;
      refreshTrayMenu();
    });
}

async function refreshAllAccountsFromTray() {
  const accounts = listAccounts();
  let failedCount = 0;
  for (const account of accounts) {
    try {
      await refreshQuota(account.id);
    } catch {
      failedCount += 1;
    }
  }
  if (failedCount > 0) {
    throw new Error(`${failedCount} 个账号刷新失败，请打开 Codexit 查看详情`);
  }
}

function createTray() {
  if (tray) {
    return;
  }

  const source = nativeImage.createFromPath(trayIconPath());
  const image = (source.isEmpty()
    ? nativeImage.createFromPath(appIconPath())
    : source
  ).resize({ width: 21, height: 21 });
  image.setTemplateImage(true);

  tray = new Tray(image);
  tray.on("click", refreshTrayMenu);
  refreshTrayMenu();
}

async function openCodexHome() {
  fs.mkdirSync(codexHome(), { recursive: true });
  await shell.openPath(codexHome());
  return true;
}

ipcMain.handle("accounts:list", async () => listAccounts());
ipcMain.handle("oauth:start", async () => startOAuth());
ipcMain.handle("oauth:reauth", async (_event, accountId) => startOAuthReauth(accountId));
ipcMain.handle("oauth:complete", async (_event, loginId) => {
  const account = await completeOAuth(loginId);
  refreshTrayMenu();
  return account;
});
ipcMain.handle("quota:refresh", async (_event, accountId) => {
  const quota = await refreshQuota(accountId);
  refreshTrayMenu();
  return quota;
});
ipcMain.handle("account:switch", async (_event, accountId) => {
  const result = await switchAccount(accountId);
  refreshTrayMenu();
  return result;
});
ipcMain.handle("account:delete", async (_event, accountId) => {
  const store = loadStore();
  store.accounts = store.accounts.filter((account) => account.id !== accountId);
  if (store.currentAccountId === accountId) {
    store.currentAccountId = null;
  }
  saveStore(store);
  await keychainDelete(ACCOUNT_TOKEN_SERVICE, accountId);
  refreshTrayMenu();
  return true;
});
ipcMain.handle("codex:open-home", async () => openCodexHome());
