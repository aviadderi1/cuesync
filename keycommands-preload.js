// keycommands-preload.js
// Preload for the Key Commands window. Exposes a minimal API that relays
// binding requests / changes through the main process to the primary app
// window (which is the one that actually owns the KEY_COMMANDS list and
// applies the shortcuts).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('keyCmdAPI', {
  requestBindings: () => ipcRenderer.invoke('keycmd-get-bindings'),
  setBinding: (id, key) => ipcRenderer.send('keycmd-set-binding', { id, key }),
  resetBinding: (id) => ipcRenderer.send('keycmd-set-binding', { id, reset: true })
});
