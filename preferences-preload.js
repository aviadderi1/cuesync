// preferences-preload.js
// Preload for the small Preferences window. Exposes a minimal API that
// relays device list requests / selections through the main process to the
// primary app window (which is the one that actually talks to MIDI/audio).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prefsAPI', {
  requestDeviceLists: () => ipcRenderer.invoke('prefs-get-devices'),
  setDevice: (kind, id) => ipcRenderer.send('prefs-set-device', { kind, id }),

  requestPasswordStatus: () => ipcRenderer.invoke('prefs-get-password-status'),
  setPassword: (password) => ipcRenderer.send('prefs-set-password', { password }),
  clearPassword: () => ipcRenderer.send('prefs-set-password', { clear: true })
});
