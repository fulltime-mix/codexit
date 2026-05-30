const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexit", {
  listAccounts: () => ipcRenderer.invoke("accounts:list"),
  startOAuth: () => ipcRenderer.invoke("oauth:start"),
  startOAuthReauth: (accountId) => ipcRenderer.invoke("oauth:reauth", accountId),
  completeOAuth: (loginId) => ipcRenderer.invoke("oauth:complete", loginId),
  refreshQuota: (accountId) => ipcRenderer.invoke("quota:refresh", accountId),
  switchAccount: (accountId) => ipcRenderer.invoke("account:switch", accountId),
  deleteAccount: (accountId) => ipcRenderer.invoke("account:delete", accountId),
  openCodexHome: () => ipcRenderer.invoke("codex:open-home"),
  onOAuthCompleted: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("oauth:completed", listener);
    return () => ipcRenderer.removeListener("oauth:completed", listener);
  }
});
