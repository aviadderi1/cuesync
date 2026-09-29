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
  onProjectAudioChunk: (callback) => ipcRenderer.on('project-audio-chunk', (event, part) => callback(part)),
  onProjectAudioDone: (callback) => ipcRenderer.on('project-audio-done', () => callback()),

  // Native Panel menu (toggles the same panels as the toolbar's PANELS dropdown)
  onMenuTogglePanel: (callback) => ipcRenderer.on('menu-toggle-panel', (event, panelKey) => callback(panelKey)),

  // Preferences window bridge (relayed through main.js)
  onRequestDeviceLists: (callback) => ipcRenderer.on('request-device-lists', callback),
  sendDeviceLists: (lists) => ipcRenderer.send('device-lists-response', lists),
  onSetDevice: (callback) => ipcRenderer.on('set-device', (event, msg) => callback(msg)),
  onRequestRsoMode: (callback) => ipcRenderer.on('request-rso-mode', callback),
  sendRsoMode: (data) => ipcRenderer.send('rso-mode-response', data),
  onSetRsoMode: (callback) => ipcRenderer.on('set-rso-mode', (event, msg) => callback(msg)),

  onRequestAutoSaveInterval: (callback) => ipcRenderer.on('request-autosave-interval', callback),
  sendAutoSaveInterval: (data) => ipcRenderer.send('autosave-interval-response', data),
  onSetAutoSaveInterval: (callback) => ipcRenderer.on('set-autosave-interval', (event, msg) => callback(msg)),
  sendAutoSaveIntervalStartup: (data) => ipcRenderer.send('autosave-interval-startup', data),
  onAutoSaveResult: (callback) => ipcRenderer.on('autosave-result', (event, msg) => callback(msg)),
  openVideoOutput: (payload) => ipcRenderer.send('open-video-output', payload),
  openVideoOutputFromBytes: (payload) => ipcRenderer.send('open-video-output-from-bytes', payload),
  closeVideoOutput: (payload) => ipcRenderer.send('close-video-output', payload),
  hasSecondDisplay: () => ipcRenderer.invoke('video-has-second-display'),
  onVideoSettings: (cb) => ipcRenderer.on('video-settings', (e, st) => cb(st)),
  onVideoDisplaysChanged: (cb) => ipcRenderer.on('video-displays-changed', (e, d) => cb(d)),
  getTimecodeSettings: () => ipcRenderer.invoke('tc-get-settings'),
  onTimecodeSettings: (callback) => ipcRenderer.on('tc-settings', (event, st) => callback(st)),

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
  onMenuImportSongs: (callback) => ipcRenderer.on('menu-import-songs', (event, files) => callback(files)),

  // Video preview popup — created and owned entirely by main.js (a plain
  // window.open() from here couldn't reliably shed the app's menu bar or
  // stay always-on-top on every platform), so the renderer only ever asks
  // for it and sends it play/pause/seek updates to mirror.
  openVideoPreview: (payload) => ipcRenderer.send('open-video-preview', payload),
  openVideoPreviewFromBytes: (payload) => ipcRenderer.send('open-video-preview-from-bytes', payload),
  syncVideoPreview: (payload) => ipcRenderer.send('sync-video-preview', payload),
  onVideoPreviewStatus: (callback) => ipcRenderer.on('video-preview-status', (event, status) => callback(status)),
  onVideoPreviewClosed: (callback) => ipcRenderer.on('video-preview-closed', (event, songId) => callback(songId)),

  // Small always-visible version label in the header, so a build can be
  // identified at a glance without opening the About window — added after
  // a long troubleshooting thread where the user kept re-running an old
  // cached installer without realizing it.
  getAppVersion: () => ipcRenderer.invoke('about-get-info')
});
