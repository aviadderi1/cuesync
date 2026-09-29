// preferences-preload.js
// Preload for the small Preferences window. Exposes a minimal API that
// relays device list requests / selections through the main process to the
// primary app window (which is the one that actually talks to MIDI/audio).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prefsAPI', {
  // Shown in the Preferences footer so the running build is identifiable
  // at a glance, right where settings are being checked.
  getAppVersion: () => ipcRenderer.invoke('about-get-info'),
  requestDeviceLists: () => ipcRenderer.invoke('prefs-get-devices'),
  setDevice: (kind, id) => ipcRenderer.send('prefs-set-device', { kind, id }),

  requestRsoMode: () => ipcRenderer.invoke('prefs-get-rso-mode'),
  setRsoMode: (mode) => ipcRenderer.send('prefs-set-rso-mode', { mode }),

  requestAutoSaveInterval: () => ipcRenderer.invoke('prefs-get-autosave-interval'),
  setAutoSaveInterval: (minutes) => ipcRenderer.send('prefs-set-autosave-interval', { minutes }),
  getVideoDisplays: () => ipcRenderer.invoke('video-get-displays'),
  setVideoSettings: (st) => ipcRenderer.send('video-set-settings', st),
  getTimecode: () => ipcRenderer.invoke('tc-get-settings'),
  setTimecode: (st) => ipcRenderer.send('tc-set-settings', st),

  requestPasswordStatus: () => ipcRenderer.invoke('prefs-get-password-status'),
  setPassword: (password) => ipcRenderer.send('prefs-set-password', { password }),
  clearPassword: () => ipcRenderer.send('prefs-set-password', { clear: true })
});
