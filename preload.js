const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),

  // Used when the app is closing: main.js asks the page to build its
  // project data, and the page replies via sendProjectData().
  onRequestProjectData: (callback) => ipcRenderer.on('request-project-data', callback),
  sendProjectData: (jsonStringOrNull) => ipcRenderer.send('project-data-response', jsonStringOrNull),

  // Remote control (phone on the same WiFi network)
  startRemoteServer: () => ipcRenderer.invoke('remote-start'),
  sendRemoteState: (state) => ipcRenderer.send('remote-state-update', state),
  sendRemoteLevel: (level) => ipcRenderer.send('remote-level-update', level),
  onRemoteCommand: (callback) => ipcRenderer.on('remote-command', (event, command) => callback(command)),

  // Native File menu (New / Save / Open)
  onMenuNewProject: (callback) => ipcRenderer.on('menu-new-project', callback),
  onMenuSaveProject: (callback) => ipcRenderer.on('menu-save-project', callback),
  onMenuOpenProject: (callback) => ipcRenderer.on('menu-open-project', (event, jsonString) => callback(jsonString)),

  // Native Panel menu (toggles the same panels as the toolbar's PANELS dropdown)
  onMenuTogglePanel: (callback) => ipcRenderer.on('menu-toggle-panel', (event, panelKey) => callback(panelKey)),

  // Preferences window bridge (relayed through main.js)
  onRequestDeviceLists: (callback) => ipcRenderer.on('request-device-lists', callback),
  sendDeviceLists: (lists) => ipcRenderer.send('device-lists-response', lists),
  onSetDevice: (callback) => ipcRenderer.on('set-device', (event, msg) => callback(msg)),

  // Key Commands window bridge (relayed through main.js)
  onRequestKeyBindings: (callback) => ipcRenderer.on('request-key-bindings', callback),
  sendKeyBindings: (data) => ipcRenderer.send('key-bindings-response', data),
  onSetKeyBinding: (callback) => ipcRenderer.on('set-key-binding', (event, msg) => callback(msg)),

  // Button password protection bridge (relayed through main.js, set from
  // the Preferences window)
  onRequestPasswordStatus: (callback) => ipcRenderer.on('request-password-status', callback),
  sendPasswordStatus: (data) => ipcRenderer.send('password-status-response', data),
  onSetButtonPassword: (callback) => ipcRenderer.on('set-button-password', (event, msg) => callback(msg)),
  onSetViewMode: (callback) => ipcRenderer.on('set-view-mode', (event, mode) => callback(mode)),
  notifyViewModeChanged: (mode) => ipcRenderer.send('view-mode-changed', mode),

  // Native File menu: Import Songs — main.js reads the files directly and
  // hands over their raw bytes (path is included for save-by-reference).
  onMenuImportSongs: (callback) => ipcRenderer.on('menu-import-songs', (event, files) => callback(files))
});
