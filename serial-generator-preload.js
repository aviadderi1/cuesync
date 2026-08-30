const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serialGenAPI', {
  getOwnMachineId: () => ipcRenderer.invoke('license-get-machine-id'),
  generate: (machineId) => ipcRenderer.invoke('serialgen-generate', machineId)
});
