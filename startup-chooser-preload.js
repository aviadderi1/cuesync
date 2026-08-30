const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('startupAPI', {
  chooseNewProject: () => ipcRenderer.send('startup-choice', 'new'),
  chooseOpenProject: () => ipcRenderer.send('startup-choice', 'open'),
  chooseOpenRecent: () => ipcRenderer.send('startup-choice', 'recent')
});
