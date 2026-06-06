const ACTIVE_ACCOUNT_REFRESH_INTERVAL_MS = 10 * 1000;
const ALL_ACCOUNTS_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const INITIAL_ACTIVE_ACCOUNT_REFRESH_DELAY_MS = 1500;

class QuotaRefreshScheduler {
  constructor({
    listAccounts,
    getCurrentAccountId,
    refreshQuota,
    notifyAccountsChanged,
    logBackgroundError = () => {},
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    activeAccountRefreshIntervalMs = ACTIVE_ACCOUNT_REFRESH_INTERVAL_MS,
    allAccountsRefreshIntervalMs = ALL_ACCOUNTS_REFRESH_INTERVAL_MS,
    initialActiveAccountRefreshDelayMs = INITIAL_ACTIVE_ACCOUNT_REFRESH_DELAY_MS
  }) {
    this.listAccounts = listAccounts;
    this.getCurrentAccountId = getCurrentAccountId;
    this.refreshQuota = refreshQuota;
    this.notifyAccountsChanged = notifyAccountsChanged;
    this.logBackgroundError = logBackgroundError;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.activeAccountRefreshIntervalMs = activeAccountRefreshIntervalMs;
    this.allAccountsRefreshIntervalMs = allAccountsRefreshIntervalMs;
    this.initialActiveAccountRefreshDelayMs = initialActiveAccountRefreshDelayMs;
    this.accountRefreshes = new Map();
    this.initialActiveAccountTimer = null;
    this.activeAccountTimer = null;
    this.allAccountsTimer = null;
  }

  start() {
    if (this.activeAccountTimer || this.allAccountsTimer) {
      return;
    }

    this.initialActiveAccountTimer = this.setTimeoutFn(() => {
      this.initialActiveAccountTimer = null;
      this.runBackgroundTask(() => this.refreshCurrentAccount());
    }, this.initialActiveAccountRefreshDelayMs);
    this.activeAccountTimer = this.setIntervalFn(
      () => this.runBackgroundTask(() => this.refreshCurrentAccount()),
      this.activeAccountRefreshIntervalMs
    );
    this.allAccountsTimer = this.setIntervalFn(
      () => this.runBackgroundTask(() => this.refreshAllAccounts()),
      this.allAccountsRefreshIntervalMs
    );
  }

  stop() {
    if (this.initialActiveAccountTimer) {
      this.clearTimeoutFn(this.initialActiveAccountTimer);
      this.initialActiveAccountTimer = null;
    }
    if (this.activeAccountTimer) {
      this.clearIntervalFn(this.activeAccountTimer);
      this.activeAccountTimer = null;
    }
    if (this.allAccountsTimer) {
      this.clearIntervalFn(this.allAccountsTimer);
      this.allAccountsTimer = null;
    }
  }

  async refreshCurrentAccount() {
    const accountId = this.getCurrentAccountId();
    if (!accountId) {
      return { refreshedCount: 0, failedCount: 0, skippedCount: 1 };
    }

    try {
      await this.refreshAccount(accountId);
      return { refreshedCount: 1, failedCount: 0, skippedCount: 0 };
    } catch {
      return { refreshedCount: 0, failedCount: 1, skippedCount: 0 };
    }
  }

  async refreshAllAccounts() {
    const accounts = this.listAccounts();
    let refreshedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const account of accounts) {
      if (!account.id) {
        skippedCount += 1;
        continue;
      }
      try {
        await this.refreshAccount(account.id);
        refreshedCount += 1;
      } catch {
        failedCount += 1;
      }
    }

    return { refreshedCount, failedCount, skippedCount };
  }

  refreshAccount(accountId) {
    if (!accountId) {
      return Promise.reject(new Error("账号不存在"));
    }

    const existingRefresh = this.accountRefreshes.get(accountId);
    if (existingRefresh) {
      return existingRefresh;
    }

    const refresh = Promise.resolve()
      .then(() => this.refreshQuota(accountId))
      .then(
        (quota) => {
          this.notifyRefreshFinished(accountId, null);
          return quota;
        },
        (error) => {
          this.notifyRefreshFinished(accountId, error);
          throw error;
        }
      )
      .finally(() => {
        if (this.accountRefreshes.get(accountId) === refresh) {
          this.accountRefreshes.delete(accountId);
        }
      });
    this.accountRefreshes.set(accountId, refresh);
    return refresh;
  }

  notifyRefreshFinished(accountId, error) {
    try {
      this.notifyAccountsChanged({
        accountId,
        ok: !error,
        error: error || null
      });
    } catch (notifyError) {
      this.logBackgroundError(notifyError);
    }
  }

  runBackgroundTask(task) {
    Promise.resolve()
      .then(task)
      .catch((error) => {
        this.logBackgroundError(error);
      });
  }
}

module.exports = {
  ACTIVE_ACCOUNT_REFRESH_INTERVAL_MS,
  ALL_ACCOUNTS_REFRESH_INTERVAL_MS,
  INITIAL_ACTIVE_ACCOUNT_REFRESH_DELAY_MS,
  QuotaRefreshScheduler
};
