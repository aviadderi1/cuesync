// remote-info-preload.js
// Preload for the small "Remote Control" info window that shows the phone
// connection URL(s). Main process pushes the info once the window loads.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remoteInfoAPI', {
  onRemoteInfo: (callback) => ipcRenderer.on('remote-info', (event, info) => callback(info))
});
