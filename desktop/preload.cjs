const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('flussoDesktop', Object.freeze({
  status: () => ipcRenderer.invoke('flusso:status'),
  // Only a boolean, synchronously acknowledged before a subsequent native Quit.
  setDraftDirty: dirty => { if (typeof dirty !== 'boolean') return false; return ipcRenderer.sendSync('flusso:draft-dirty', dirty); },
  checkUpdates: () => ipcRenderer.invoke('flusso:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('flusso:download-update'),
  installUpdate: () => ipcRenderer.invoke('flusso:install-update'),
  setupModel: () => ipcRenderer.invoke('flusso:setup-model'),
  setStartOnLogin: enabled => ipcRenderer.invoke('flusso:start-on-login', enabled),
  openAccountSettings: () => ipcRenderer.invoke('flusso:account-settings'),
  onStatus: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('flusso:status-changed', listener); return () => ipcRenderer.removeListener('flusso:status-changed', listener); },
}));
