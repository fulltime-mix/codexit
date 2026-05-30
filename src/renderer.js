const state = {
  accounts: [],
  activeLoginId: null,
  reauthAccountId: null,
  busy: false,
  autoRefreshing: false
};

const AUTO_REFRESH_INTERVAL_MS = 60 * 1000;

const ICONS = {
  refresh:
    '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-13.65 5.65"/><path d="M4 12A8 8 0 0 1 17.65 6.35"/><path d="M17 2.75v4h4"/><path d="M7 21.25v-4H3"/></svg>',
  reauth:
    '<svg viewBox="0 0 24 24"><path d="M7.75 10V8.25a4.25 4.25 0 0 1 8.5 0V10"/><path d="M6.5 10h11A1.5 1.5 0 0 1 19 11.5v6A1.5 1.5 0 0 1 17.5 19h-11A1.5 1.5 0 0 1 5 17.5v-6A1.5 1.5 0 0 1 6.5 10Z"/><path d="M12 14v1.75"/></svg>',
  switch:
    '<svg viewBox="0 0 24 24"><path d="M4 7.5h12.5"/><path d="m13 4 3.5 3.5L13 11"/><path d="M20 16.5H7.5"/><path d="M11 13l-3.5 3.5L11 20"/></svg>',
  delete:
    '<svg viewBox="0 0 24 24"><path d="M5 7h14"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"/><path d="M8 10.5V18a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-7.5"/><path d="M10.5 11.5v5"/><path d="M13.5 11.5v5"/></svg>'
};

const nodes = {
  summary: document.getElementById("summary"),
  accountCount: document.getElementById("accountCount"),
  currentAccount: document.getElementById("currentAccount"),
  attentionCount: document.getElementById("attentionCount"),
  accountList: document.getElementById("accountList"),
  emptyState: document.getElementById("emptyState"),
  status: document.getElementById("status"),
  statusText: document.getElementById("statusText"),
  addAccountBtn: document.getElementById("addAccountBtn"),
  emptyAddBtn: document.getElementById("emptyAddBtn"),
  refreshAllBtn: document.getElementById("refreshAllBtn"),
  openHomeBtn: document.getElementById("openHomeBtn")
};

function icon(name) {
  return `<span class="button-icon" aria-hidden="true">${ICONS[name]}</span>`;
}

function setStatus(message, isError = false) {
  nodes.statusText.textContent = message || "准备就绪";
  nodes.status.classList.toggle("error", Boolean(isError));
}

function formatError(error) {
  if (!error) {
    return "未知错误";
  }
  return error.message || String(error);
}

function formatTime(timestamp) {
  if (!timestamp) {
    return "-";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp * 1000));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function formatPlan(account) {
  return account.planType || "OpenAI";
}

function accountInitials(email) {
  const name = String(email || "?").split("@")[0].replace(/[._-]+/g, " ").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase() || "?";
}

function accountDomain(email) {
  return String(email || "").split("@")[1] || "OpenAI account";
}

function formatAccountError(account) {
  const message = account.reauthReason || account.quotaError?.message;
  if (!message) {
    return "";
  }
  const trimmed = String(message).replace(/\s+/g, " ").trim();
  return trimmed.length > 220 ? `${trimmed.slice(0, 220)}...` : trimmed;
}

function quotaValue(quota, key) {
  const windowInfo = quota?.[key];
  if (!windowInfo || windowInfo.remainingPercent === null) {
    return {
      remaining: 0,
      label: "-",
      reset: "-",
      tone: "muted"
    };
  }
  const remaining = Math.round(
    Math.max(0, Math.min(100, windowInfo.remainingPercent))
  );
  const tone = remaining <= 20 ? "danger" : remaining <= 45 ? "caution" : "good";
  return {
    remaining,
    label: `${remaining}% 剩余`,
    reset: formatTime(windowInfo.resetAt),
    tone
  };
}

function setBusy(busy) {
  state.busy = busy;
  for (const button of document.querySelectorAll("button")) {
    button.disabled = busy;
  }
}

async function withBusy(message, action) {
  try {
    setBusy(true);
    setStatus(message);
    return await action();
  } catch (error) {
    setStatus(formatError(error), true);
    throw error;
  } finally {
    setBusy(false);
  }
}

function renderQuota(account, key, title) {
  const value = quotaValue(account.quota, key);
  return `
    <div class="quota-row">
      <div class="quota-label">
        <span>${title}</span>
        <span>${value.label} · ${value.reset}</span>
      </div>
      <div class="bar ${value.tone}">
        <span style="--value: ${value.remaining}%"></span>
      </div>
    </div>
  `;
}

function renderAccount(account) {
  const lastUsed = account.lastUsedAt ? `上次使用 ${formatTime(account.lastUsedAt)}` : "";
  const quotaUpdated = account.quota?.updatedAt
    ? `额度更新 ${formatTime(account.quota.updatedAt)}`
    : "额度未刷新";
  const accountError = formatAccountError(account);
  const reauthBadge = account.requiresReauth
    ? '<span class="badge warn">需重新登录</span>'
    : accountError
      ? '<span class="badge warn">需处理</span>'
    : "";
  const currentBadge = account.isCurrent ? '<span class="badge current">当前</span>' : "";
  const classes = [
    "account",
    account.isCurrent ? "is-current" : "",
    accountError ? "needs-auth" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return `
    <article class="${classes}" data-account-id="${escapeAttribute(account.id)}">
      <div class="account-head">
        <div class="identity-wrap">
          <div class="avatar" aria-hidden="true">${escapeHtml(accountInitials(account.email))}</div>
          <div class="identity">
            <div class="email">${escapeHtml(account.email)}</div>
            <div class="meta">${escapeHtml(formatPlan(account))} · ${escapeHtml(accountDomain(account.email))}<br>${escapeHtml(quotaUpdated)}${lastUsed ? ` · ${escapeHtml(lastUsed)}` : ""}</div>
          </div>
        </div>
        <div class="badges">
          ${currentBadge}
          ${reauthBadge}
        </div>
      </div>
      <div class="quota">
        ${renderQuota(account, "fiveHour", "5 小时")}
        ${renderQuota(account, "weekly", "周额度")}
      </div>
      ${accountError ? `<div class="account-error">${escapeHtml(accountError)}</div>` : ""}
      <div class="account-actions">
        <button class="button quiet" data-action="refresh" type="button">${icon("refresh")}<span>刷新</span></button>
        <button class="button quiet" data-action="reauth" type="button">${icon("reauth")}<span>登录</span></button>
        <button class="button primary" data-action="switch" type="button">${icon("switch")}<span>切换并重启</span></button>
        <button class="button danger" data-action="delete" type="button">${icon("delete")}<span>删除</span></button>
      </div>
    </article>
  `;
}

function render() {
  const current = state.accounts.find((account) => account.isCurrent);
  const attention = state.accounts.filter((account) => formatAccountError(account)).length;
  const intervalMinutes = Math.round(AUTO_REFRESH_INTERVAL_MS / 60000);

  nodes.summary.textContent =
    state.accounts.length === 0
      ? "本地账号管理器"
      : `${state.accounts.length} 个账号 · 自动刷新 ${intervalMinutes} 分钟`;
  nodes.accountCount.textContent = String(state.accounts.length);
  nodes.currentAccount.textContent = current?.email || "未切换";
  nodes.attentionCount.textContent = attention > 0 ? `${attention} 个需处理` : "正常";
  nodes.emptyState.classList.toggle("hidden", state.accounts.length !== 0);
  nodes.accountList.classList.toggle("hidden", state.accounts.length === 0);
  nodes.accountList.innerHTML = state.accounts.map(renderAccount).join("");
}

async function loadAccounts() {
  state.accounts = await window.codexit.listAccounts();
  render();
}

async function addAccount() {
  await withBusy("正在打开独立 OpenAI 登录窗口...", async () => {
    const response = await window.codexit.startOAuth();
    state.activeLoginId = response.loginId;
    state.reauthAccountId = null;
    setStatus("请在独立登录窗口中完成 OpenAI 登录。");
  });
}

async function reauthAccount(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  await withBusy("正在打开独立 OpenAI 登录窗口...", async () => {
    const response = await window.codexit.startOAuthReauth(accountId);
    state.activeLoginId = response.loginId;
    state.reauthAccountId = accountId;
    setStatus(`请重新登录 ${account?.email || "该账号"}。`);
  });
}

async function completeOAuth(loginId) {
  if (state.activeLoginId && state.activeLoginId !== loginId) {
    return;
  }
  await withBusy("正在保存账号...", async () => {
    const account = await window.codexit.completeOAuth(loginId);
    state.activeLoginId = null;
    const wasReauth = Boolean(state.reauthAccountId);
    state.reauthAccountId = null;
    await loadAccounts();
    setStatus(wasReauth ? `已重新登录 ${account.email}` : `已添加 ${account.email}`);
    try {
      await window.codexit.refreshQuota(account.id);
      await loadAccounts();
    } catch (error) {
      setStatus(`账号已添加，额度稍后可刷新：${formatError(error)}`);
    }
  });
}

async function refreshAccountsInBackground({ announce = false } = {}) {
  if (state.busy || state.autoRefreshing || state.accounts.length === 0) {
    return;
  }

  state.autoRefreshing = true;
  const accounts = state.accounts.slice();
  let refreshedCount = 0;
  let failedCount = 0;

  try {
    for (const account of accounts) {
      try {
        await window.codexit.refreshQuota(account.id);
        refreshedCount += 1;
      } catch (error) {
        failedCount += 1;
        console.warn(`Auto refresh failed for ${account.email}:`, error);
      }
    }
    if (refreshedCount > 0 || failedCount > 0) {
      await loadAccounts();
      if (announce && refreshedCount > 0 && nodes.statusText.textContent === "准备就绪") {
        setStatus("额度已自动刷新。");
      }
    }
  } finally {
    state.autoRefreshing = false;
  }
}

function startAutoRefresh() {
  window.setTimeout(() => {
    refreshAccountsInBackground({ announce: true }).catch((error) =>
      console.warn("Initial auto refresh failed:", error)
    );
  }, 1500);

  window.setInterval(() => {
    refreshAccountsInBackground().catch((error) =>
      console.warn("Auto refresh failed:", error)
    );
  }, AUTO_REFRESH_INTERVAL_MS);
}

async function refreshAccount(accountId) {
  try {
    await withBusy("正在刷新额度...", async () => {
      await window.codexit.refreshQuota(accountId);
      await loadAccounts();
      setStatus("额度已刷新。");
    });
  } catch {
    await loadAccounts();
  }
}

async function refreshAll() {
  await withBusy("正在刷新全部额度...", async () => {
    for (const account of state.accounts) {
      try {
        await window.codexit.refreshQuota(account.id);
      } catch (error) {
        setStatus(`${account.email}: ${formatError(error)}`, true);
      }
    }
    await loadAccounts();
    if (!nodes.status.classList.contains("error")) {
      setStatus("全部额度已刷新。");
    }
  });
}

async function switchAccount(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  try {
    await withBusy("正在切换账号并重启 Codex...", async () => {
      await window.codexit.switchAccount(accountId);
      await loadAccounts();
      setStatus(`已切换到 ${account?.email || "目标账号"}。`);
    });
  } catch {
    await loadAccounts();
  }
}

async function deleteAccount(accountId) {
  const account = state.accounts.find((item) => item.id === accountId);
  if (!window.confirm(`删除 ${account?.email || "这个账号"}？`)) {
    return;
  }
  await withBusy("正在删除账号...", async () => {
    await window.codexit.deleteAccount(accountId);
    await loadAccounts();
    setStatus("账号已删除。");
  });
}

nodes.addAccountBtn.addEventListener("click", addAccount);
nodes.emptyAddBtn.addEventListener("click", addAccount);
nodes.refreshAllBtn.addEventListener("click", refreshAll);
nodes.openHomeBtn.addEventListener("click", async () => {
  await withBusy("正在打开 Codex 目录...", async () => {
    await window.codexit.openCodexHome();
    setStatus("目录已打开。");
  });
});

nodes.accountList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || state.busy) {
    return;
  }
  const account = button.closest(".account");
  const accountId = account?.dataset.accountId;
  if (!accountId) {
    return;
  }
  const action = button.dataset.action;
  if (action === "refresh") {
    await refreshAccount(accountId);
  } else if (action === "reauth") {
    await reauthAccount(accountId);
  } else if (action === "switch") {
    await switchAccount(accountId);
  } else if (action === "delete") {
    await deleteAccount(accountId);
  }
});

window.codexit.onOAuthCompleted(({ loginId }) => {
  completeOAuth(loginId).catch(() => {});
});

loadAccounts()
  .then(startAutoRefresh)
  .catch((error) => setStatus(formatError(error), true));
