const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('licenseAPI', {
  getMachineId: () => ipcRenderer.invoke('license-get-machine-id'),
  activate: (serial) => ipcRenderer.invoke('license-activate', serial),
  quit: () => ipcRenderer.send('license-quit'),
  openEmail: (mailtoUrl) => ipcRenderer.send('license-open-email', mailtoUrl)
});
