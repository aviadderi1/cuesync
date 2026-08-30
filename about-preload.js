// about-preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aboutAPI', {
  getInfo: () => ipcRenderer.invoke('about-get-info')
});
