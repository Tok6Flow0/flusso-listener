const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('flussoDesktop', Object.freeze({
  status: () => ipcRenderer.invoke('flusso:status'),
  checkUpdates: () => ipcRenderer.invoke('flusso:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('flusso:download-update'),
  installUpdate: () => ipcRenderer.invoke('flusso:install-update'),
  setupModel: () => ipcRenderer.invoke('flusso:setup-model'),
  setStartOnLogin: enabled => ipcRenderer.invoke('flusso:start-on-login', enabled),
  openAccountSettings: () => ipcRenderer.invoke('flusso:account-settings'),
  onStatus: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('flusso:status-changed', listener); return () => ipcRenderer.removeListener('flusso:status-changed', listener); },
}));
