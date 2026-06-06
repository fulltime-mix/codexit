const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  ACTIVE_ACCOUNT_REFRESH_INTERVAL_MS,
  ALL_ACCOUNTS_REFRESH_INTERVAL_MS,
  INITIAL_ACTIVE_ACCOUNT_REFRESH_DELAY_MS,
  QuotaRefreshScheduler
} = require("../src/quota-refresh-scheduler");

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(options = {}) {
  const accounts = options.accounts || [];
  const refreshCalls = [];
  const notifications = [];
  const intervals = [];
  const timeouts = [];
  const clearedIntervals = [];
  const clearedTimeouts = [];
  let currentAccountId = options.currentAccountId || null;
  const failures = new Set(options.failures || []);

  const scheduler = new QuotaRefreshScheduler({
    listAccounts: () => accounts.slice(),
    getCurrentAccountId: () => currentAccountId,
    refreshQuota:
      options.refreshQuota ||
      (async (accountId) => {
        refreshCalls.push(accountId);
        if (failures.has(accountId)) {
          throw new Error(`${accountId} failed`);
        }
        return { accountId };
      }),
    notifyAccountsChanged: (payload) => {
      notifications.push(payload);
    },
    setIntervalFn: (callback, delay) => {
      const timer = { callback, delay };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => {
      clearedIntervals.push(timer);
    },
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay };
      timeouts.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      clearedTimeouts.push(timer);
    }
  });

  return {
    scheduler,
    refreshCalls,
    notifications,
    intervals,
    timeouts,
    clearedIntervals,
    clearedTimeouts,
    setCurrentAccountId: (accountId) => {
      currentAccountId = accountId;
    }
  };
}

test("refreshes only the current account for the active-account strategy", async () => {
  const { scheduler, refreshCalls, notifications } = createHarness({
    currentAccountId: "acct_current",
    accounts: [{ id: "acct_other" }, { id: "acct_current" }]
  });

  const result = await scheduler.refreshCurrentAccount();

  assert.deepEqual(result, {
    refreshedCount: 1,
    failedCount: 0,
    skippedCount: 0
  });
  assert.deepEqual(refreshCalls, ["acct_current"]);
  assert.deepEqual(
    notifications.map((payload) => [payload.accountId, payload.ok]),
    [["acct_current", true]]
  );
});

test("skips active-account refresh when there is no current account", async () => {
  const { scheduler, refreshCalls, notifications } = createHarness({
    accounts: [{ id: "acct_one" }]
  });

  const result = await scheduler.refreshCurrentAccount();

  assert.deepEqual(result, {
    refreshedCount: 0,
    failedCount: 0,
    skippedCount: 1
  });
  assert.deepEqual(refreshCalls, []);
  assert.deepEqual(notifications, []);
});

test("refreshes all accounts and continues after single-account failures", async () => {
  const { scheduler, refreshCalls, notifications } = createHarness({
    accounts: [{ id: "acct_one" }, { id: "acct_two" }, { id: "acct_three" }],
    failures: ["acct_two"]
  });

  const result = await scheduler.refreshAllAccounts();

  assert.deepEqual(result, {
    refreshedCount: 2,
    failedCount: 1,
    skippedCount: 0
  });
  assert.deepEqual(refreshCalls, ["acct_one", "acct_two", "acct_three"]);
  assert.deepEqual(
    notifications.map((payload) => [payload.accountId, payload.ok]),
    [
      ["acct_one", true],
      ["acct_two", false],
      ["acct_three", true]
    ]
  );
});

test("reuses an in-flight refresh for the same account", async () => {
  const deferred = createDeferred();
  const refreshCalls = [];
  const { scheduler, notifications } = createHarness({
    refreshQuota: (accountId) => {
      refreshCalls.push(accountId);
      return deferred.promise;
    }
  });

  const firstRefresh = scheduler.refreshAccount("acct_one");
  const secondRefresh = scheduler.refreshAccount("acct_one");
  await Promise.resolve();

  assert.equal(firstRefresh, secondRefresh);
  assert.deepEqual(refreshCalls, ["acct_one"]);

  deferred.resolve({ remaining: 42 });
  await Promise.all([firstRefresh, secondRefresh]);

  assert.equal(notifications.length, 1);

  await scheduler.refreshAccount("acct_one");
  assert.deepEqual(refreshCalls, ["acct_one", "acct_one"]);
});

test("notifies after successful and failed account refreshes", async () => {
  const { scheduler, notifications } = createHarness({
    failures: ["acct_failed"]
  });

  await scheduler.refreshAccount("acct_ok");
  await assert.rejects(
    () => scheduler.refreshAccount("acct_failed"),
    /acct_failed failed/
  );

  assert.deepEqual(
    notifications.map((payload) => [payload.accountId, payload.ok]),
    [
      ["acct_ok", true],
      ["acct_failed", false]
    ]
  );
});

test("start registers the configured timers and stop clears them", () => {
  const {
    scheduler,
    intervals,
    timeouts,
    clearedIntervals,
    clearedTimeouts
  } = createHarness();

  scheduler.start();
  scheduler.start();

  assert.deepEqual(
    timeouts.map((timer) => timer.delay),
    [INITIAL_ACTIVE_ACCOUNT_REFRESH_DELAY_MS]
  );
  assert.deepEqual(
    intervals.map((timer) => timer.delay),
    [
      ACTIVE_ACCOUNT_REFRESH_INTERVAL_MS,
      ALL_ACCOUNTS_REFRESH_INTERVAL_MS
    ]
  );

  scheduler.stop();

  assert.deepEqual(clearedTimeouts, timeouts);
  assert.deepEqual(clearedIntervals, intervals);
});
