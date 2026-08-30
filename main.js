const { app, BrowserWindow, Menu, ipcMain, dialog, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { checkForUpdates, getCurrentVersion } = require('./updater');
const remote = require('./remote');
const license = require('./license');

// ---------- "Open Recent" tracking ----------
// Remembers the path of the most recently saved/opened project file across
// app restarts, in a tiny JSON file in the app's userData folder.
function recentProjectFilePath() {
  return path.join(app.getPath('userData'), 'recent-project.json');
}
function getRecentProjectPath() {
  try {
    const data = JSON.parse(fs.readFileSync(recentProjectFilePath(), 'utf8'));
    return data && typeof data.path === 'string' ? data.path : null;
  } catch (e) {
    return null;
  }
}
function setRecentProjectPath(jsonPath) {
  try {
    fs.writeFileSync(recentProjectFilePath(), JSON.stringify({ path: jsonPath }), 'utf8');
  } catch (e) {
    // Non-critical — worst case "Open Recent" just won't have anything to open.
  }
}

// Prevent multiple copies of the app running at once. Without this, if the
// app is launched twice (e.g. double-clicked twice while it's still
// starting up), each copy tries to bind the same remote-control network
// port and read/write the same project files at the same time — which can
// make the app appear to "freeze" shortly after opening as the two
// instances contend with each other. Instead, a second launch just focuses
// the already-running window and exits immediately.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  return;
}
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Allow audio to play without requiring an explicit click first — since we
// no longer have an in-page "Enter" gesture screen (replaced by the native
// splash window below), Chromium's autoplay restriction would otherwise
// block Web Audio playback until some other click happened first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let prefsWindow = null;
let remoteInfoWindow = null;
let aboutWindow = null;
let splashWindow = null;
let keyCommandsWindow = null;

function createSplashWindow() {
  const win = new BrowserWindow({
    width: 300,
    height: 340,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    center: true,
    show: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenu(null);
  win.loadFile('splash.html');
  win.once('ready-to-show', () => win.show());
  return win;
}

let licenseGateWindow = null;
let licenseGateResolve = null;

// Shown before anything else if this machine doesn't have a valid,
// matching activation on file. Blocks app startup until a correct serial
// (specific to this machine's Hardware ID) is entered.
let startupChooserWindow = null;

// Shown right after license validation (and before the splash/main window),
// letting the user pick how to begin the session — mirrors the license
// gate's promise-based pattern.
function createStartupChooserWindow() {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 460,
      height: 320,
      resizable: false,
      minimizable: false,
      maximizable: false,
      center: true,
      show: false,
      title: 'Cue Sync',
      backgroundColor: '#12151a',
      webPreferences: {
        preload: path.join(__dirname, 'startup-chooser-preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    win.setMenu(null);
    win.loadFile('startup-chooser.html');
    win.once('ready-to-show', () => win.show());
    let settled = false;
    ipcMain.once('startup-choice', (event, choice) => {
      settled = true;
      win.close();
      resolve(choice);
    });
    win.on('closed', () => {
      startupChooserWindow = null;
      if (!settled) resolve('new'); // window closed without a pick — default to New Project
    });
    startupChooserWindow = win;
  });
}

function createLicenseGateWindow() {
  return new Promise((resolve) => {
    licenseGateResolve = resolve;
    const win = new BrowserWindow({
      width: 460,
      height: 620,
      resizable: false,
      minimizable: false,
      maximizable: false,
      center: true,
      show: false,
      title: 'Activate Cue Sync',
      backgroundColor: '#12151a',
      webPreferences: {
        preload: path.join(__dirname, 'license-gate-preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    win.setMenu(null);
    win.loadFile('license-gate.html');
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => {
      licenseGateWindow = null;
      // If the window was closed without a successful activation (e.g. via
      // the Quit link, or the OS close button), quit the app entirely —
      // there's nothing else it can legitimately show.
      if (licenseGateResolve) { licenseGateResolve(false); licenseGateResolve = null; }
    });
    licenseGateWindow = win;
  });
}

let serialGeneratorWindow = null;

// Hidden vendor-only tool — never linked from any visible menu. Opened via
// the undocumented Ctrl/Cmd+Alt+Shift+G shortcut. Mints a valid serial for
// any Machine ID typed in, using the same formula the app itself checks
// against.
function createSerialGeneratorWindow() {
  if (serialGeneratorWindow && !serialGeneratorWindow.isDestroyed()) {
    serialGeneratorWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 420,
    height: 400,
    resizable: false,
    title: 'Serial Generator',
    backgroundColor: '#0d1015',
    webPreferences: {
      preload: path.join(__dirname, 'serial-generator-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenu(null);
  win.loadFile('serial-generator.html');
  win.on('closed', () => { serialGeneratorWindow = null; });
  serialGeneratorWindow = win;
}

ipcMain.handle('license-get-machine-id', () => license.getHardwareId());

ipcMain.handle('license-activate', (event, serial) => {
  const machineId = license.getHardwareId();
  const ok = license.validateSerial(machineId, serial);
  if (ok) {
    license.saveLicense(machineId, serial);
    if (licenseGateWindow && !licenseGateWindow.isDestroyed()) {
      const resolveFn = licenseGateResolve;
      licenseGateResolve = null; // don't treat this programmatic close as a cancel
      licenseGateWindow.close();
      if (resolveFn) resolveFn(true);
    }
  }
  return { ok };
});

ipcMain.on('license-quit', () => {
  app.quit();
});

ipcMain.on('license-open-email', (event, mailtoUrl) => {
  shell.openExternal(mailtoUrl);
});

ipcMain.handle('serialgen-generate', (event, machineId) => {
  return license.computeSerialForMachine(machineId);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Cue Sync',
    backgroundColor: '#08090b',
    icon: path.join(__dirname, 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow = win;

  // Defense-in-depth: dropping a file onto the window must never navigate
  // the app away from itself. The renderer already handles real song
  // imports via drag-and-drop, but if a drop ever reaches Electron's
  // default handling (e.g. missed by the renderer for any reason), this
  // guarantees it's a no-op instead of replacing/breaking the app.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://') || !url.endsWith('index.html')) {
      event.preventDefault();
    }
  });

  const menuTemplate = [
    {
      label: 'Cue Sync',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          click: () => handleMenuNew(win)
        },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => saveProjectToFile(win)
        },
        {
          label: 'Save As…',
          accelerator: 'Shift+CmdOrCtrl+S',
          click: () => saveProjectAsToFile(win)
        },
        {
          label: 'Open',
          click: () => openProjectFromDisk(win)
        },
        {
          label: 'Open Recent',
          click: () => openRecentProject(win)
        },
        {
          label: 'Import Songs…',
          click: () => importSongsFromDisk(win)
        },
        { type: 'separator' },
        {
          label: 'Preferences',
          click: () => openPreferencesWindow(win)
        },
        {
          label: 'Key Commands',
          click: () => openKeyCommandsWindow(win)
        }
      ]
    },
    {
      label: 'Panel',
      submenu: [
        {
          label: 'Song Library',
          type: 'checkbox',
          checked: false,
          click: () => win.webContents.send('menu-toggle-panel', 'songLibrary')
        },
        {
          label: 'Cue Inspector',
          type: 'checkbox',
          checked: false,
          click: () => win.webContents.send('menu-toggle-panel', 'inspector')
        },
        {
          label: 'Cue Stack',
          type: 'checkbox',
          checked: false,
          click: () => win.webContents.send('menu-toggle-panel', 'cueStack')
        },
        {
          label: 'MSC / MIDI Defaults',
          type: 'checkbox',
          checked: false,
          click: () => win.webContents.send('menu-toggle-panel', 'settings')
        }
      ]
    },
    {
      label: 'Remote',
      click: () => showRemoteConnectionWindow(win)
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Edit Mode',
          type: 'radio',
          checked: false,
          click: () => win.webContents.send('set-view-mode', 'edit')
        },
        {
          label: 'Show',
          type: 'radio',
          checked: true,
          click: () => win.webContents.send('set-view-mode', 'show')
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'User Manual',
          click: () => downloadUserManual(win)
        },
        {
          label: 'Update',
          click: () => checkForUpdates(false)
        },
        {
          label: 'About',
          click: () => openAboutWindow(win)
        }
      ]
    }
  ];
  const appMenu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(appMenu);

  // The renderer always starts in Show Mode by default and can also
  // change modes from other internal paths — it reports every change here
  // so the native menu's radio checkmark never drifts out of sync with
  // what's actually on screen.
  const viewMenu = appMenu.items.find(i => i.label === 'View');
  const viewModeItems = viewMenu ? {
    edit: viewMenu.submenu.items.find(i => i.label === 'Edit Mode'),
    show: viewMenu.submenu.items.find(i => i.label === 'Show')
  } : null;
  ipcMain.removeAllListeners('view-mode-changed');
  ipcMain.on('view-mode-changed', (event, mode) => {
    if (!viewModeItems) return;
    if (mode === 'show') {
      viewModeItems.show.checked = true;
    } else {
      viewModeItems.edit.checked = true;
    }
  });

  win.loadFile('index.html');

  // Keep the logo on screen for at least 5 seconds, and only swap to the
  // main window once the content has ALSO actually finished rendering
  // (whichever of the two takes longer) — so it never flashes past too
  // quickly, but also never lingers once the app is genuinely ready.
  let mainWindowReady = false;
  let minSplashTimeElapsed = false;
  let swappedAlready = false;
  function trySwapToMainWindow(force) {
    if (swappedAlready) return;
    if (!force && (!mainWindowReady || !minSplashTimeElapsed)) return;
    swappedAlready = true;
    win.show();
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy();
      splashWindow = null;
    }
  }
  win.once('ready-to-show', () => {
    mainWindowReady = true;
    trySwapToMainWindow();
  });
  setTimeout(() => {
    minSplashTimeElapsed = true;
    trySwapToMainWindow();
  }, 10000);
  // Safety net: the splash window has no close button by design. If, for
  // any reason, 'ready-to-show' never fires on a particular machine, this
  // would otherwise leave the splash stuck on screen forever with no way
  // to get past it. This hard timeout forces the swap regardless.
  setTimeout(() => trySwapToMainWindow(true), 15000);

  // ---------- Close confirmation: offer to save the project first ----------
  let closeConfirmed = false;

  win.on('close', (e) => {
    if (closeConfirmed) return; // already handled — let it actually close
    e.preventDefault();
    handleCloseRequest(win).then((shouldClose) => {
      if (shouldClose) {
        closeConfirmed = true;
        remote.stopServer();
        win.close();
      }
    });
  });

  return win;
}

// Returns a promise resolving to true if the window should actually close.
async function handleCloseRequest(win) {
  const choice = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Cue Sync',
    message: 'Do you want to save the project before closing?'
  });

  if (choice.response === 2) return false; // Cancel — stay open
  if (choice.response === 1) return true;  // Don't Save — close now

  const saved = await saveProjectToFile(win);
  return saved !== false; // if they cancelled the save dialog itself, stay open
}

// Shared "Save" logic used by both the File menu's Save action and the
// close-confirmation flow. Returns true if saved, false if the user backed
// out, or null if there was nothing to save.
// Tracks the on-disk path of the project currently open, if any — lets
// "Save" silently write back to the same file instead of always prompting,
// while "Save As" always asks for a new name/location.
let currentProjectPath = null;

async function saveProjectToFile(win, forceDialog) {
  const payload = await requestProjectDataFromPage(win);

  if (payload === 'EMPTY') {
    await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['OK'],
      title: 'Nothing to Save',
      message: "There's no project data to save right now (no songs added yet)."
    });
    return null;
  }
  if (payload === '__TIMEOUT__' || !payload) {
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: ['OK'],
      title: 'Save Timed Out',
      message: 'Preparing the project for saving took too long and timed out. This can happen with a very large library — please try again.'
    });
    return null;
  }
  if (typeof payload === 'string' && payload.startsWith('__ERROR__:')) {
    await dialog.showMessageBox(win, {
      type: 'error',
      buttons: ['OK'],
      title: 'Save Failed',
      message: 'Preparing the project for saving failed: ' + payload.slice('__ERROR__:'.length)
    });
    return null;
  }

  let jsonPath;
  if (currentProjectPath && !forceDialog) {
    jsonPath = currentProjectPath;
  } else {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const saveResult = await dialog.showSaveDialog(win, {
      title: forceDialog ? 'Save Project As' : 'Save Project',
      defaultPath: currentProjectPath || `cue-sync-project-${stamp}.json`,
      filters: [{ name: 'Cue Sync Project', extensions: ['json'] }]
    });
    if (saveResult.canceled || !saveResult.filePath) return false;
    jsonPath = saveResult.filePath;
  }

  try {
    const dir = path.dirname(jsonPath);
    const baseName = path.basename(jsonPath, path.extname(jsonPath));
    const mediaDirName = baseName + '_media';
    const mediaDir = path.join(dir, mediaDirName);

    // Most songs are saved by reference (their original file path) rather
    // than duplicated here — payload.audioFiles only contains songs where
    // no original path was available, so the media folder is created only
    // if there's actually something that needs embedding.
    if (payload.audioFiles.length > 0) {
      fs.mkdirSync(mediaDir, { recursive: true });
      for (const af of payload.audioFiles) {
        const filePath = path.join(mediaDir, `${af.id}.${af.ext}`);
        fs.writeFileSync(filePath, Buffer.from(af.buffer));
      }
    }

    const manifest = payload.manifest;
    manifest.mediaFolder = mediaDirName;
    fs.writeFileSync(jsonPath, JSON.stringify(manifest), 'utf8');
    setRecentProjectPath(jsonPath);
    currentProjectPath = jsonPath;
    return true;
  } catch (err) {
    dialog.showErrorBox('Save Failed', String((err && err.message) || err));
    return false;
  }
}

// "Save As" — always prompts for a new name/location, regardless of
// whether this project already has a path.
async function saveProjectAsToFile(win) {
  return saveProjectToFile(win, true);
}

// "New" — ask to save first (same pattern as closing), then clear the page.
async function handleMenuNew(win) {
  const choice = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'New Project',
    message: 'Save the current project before starting a new one?'
  });
  if (choice.response === 2) return; // Cancel
  if (choice.response === 0) {
    const saved = await saveProjectToFile(win);
    if (saved === false) return; // they backed out of the save dialog — don't lose it
  }
  currentProjectPath = null;
  win.webContents.send('menu-new-project');
}

// Shared logic for loading a manifest + its media folder from a known path,
// used by both "Open" (user picks a file) and "Open Recent" (last used path).
function loadProjectFromPath(win, jsonPath) {
  const manifest = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  const dir = path.dirname(jsonPath);
  const baseName = path.basename(jsonPath, path.extname(jsonPath));
  const mediaDirName = manifest.mediaFolder || (baseName + '_media');
  const mediaDir = path.join(dir, mediaDirName);

  const audioFiles = [];
  const missingSongs = [];
  for (const sData of (manifest.songs || [])) {
    const ext = sData.audioExt || 'bin';
    let buf = null;

    // Prefer reading straight from the song's original location on disk —
    // this is how most songs are saved now (by reference, not duplicated).
    if (sData.originalPath) {
      try {
        buf = fs.readFileSync(sData.originalPath);
      } catch (readErr) {
        // Original file moved/renamed/deleted — fall through to the media
        // folder below in case an older save also embedded a copy there.
      }
    }

    // Fallback: the project's own _media folder (songs saved without an
    // original path, or projects saved by an older version of the app).
    if (!buf) {
      const filePath = path.join(mediaDir, `${sData.id}.${ext}`);
      try {
        buf = fs.readFileSync(filePath);
      } catch (readErr) {
        // Not found here either — this song's audio couldn't be located.
      }
    }

    if (buf) {
      // Copy into a plain, dedicated Uint8Array rather than slicing Node's
      // Buffer.buffer directly — Buffer can share a pooled underlying
      // ArrayBuffer for some allocations, and a plain typed-array copy is
      // the most reliably portable shape to send across Electron's IPC.
      audioFiles.push({ id: sData.id, buffer: new Uint8Array(buf) });
    } else {
      missingSongs.push(sData.name || sData.id);
      console.error('Missing audio file for song', sData.id, sData.name);
    }
  }
  win.webContents.send('menu-open-project', { manifest, audioFiles });
  if (missingSongs.length > 0) {
    dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['OK'],
      title: 'Some Audio Files Are Missing',
      message: "Couldn't find the audio for: " + missingSongs.join(', ') +
        '. The original file(s) may have been moved, renamed, or deleted. Everything else (cues, settings) loaded normally.'
    });
  }
  setRecentProjectPath(jsonPath);
  currentProjectPath = jsonPath;
}

// "Open" — pick a .json project file from disk and hand its contents to the page.
async function openProjectFromDisk(win) {
  const result = await dialog.showOpenDialog(win, {
    title: 'Open Project',
    filters: [{ name: 'Cue Sync Project', extensions: ['json'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return;
  try {
    loadProjectFromPath(win, result.filePaths[0]);
  } catch (err) {
    dialog.showErrorBox('Open Failed', String((err && err.message) || err));
  }
}

const AUDIO_MIME_BY_EXT = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', flac: 'audio/flac', aif: 'audio/aiff', aiff: 'audio/aiff',
  wma: 'audio/x-ms-wma', mp4: 'video/mp4', mov: 'video/quicktime'
};

// "Import Songs…" — a native multi-select file dialog handled entirely in
// the main process (rather than proxying a click to the renderer's hidden
// <input type="file">), so it reliably opens regardless of the renderer's
// current focus/activation state.
async function importSongsFromDisk(win) {
  const result = await dialog.showOpenDialog(win, {
    title: 'Import Songs',
    filters: [
      { name: 'Audio Files', extensions: Object.keys(AUDIO_MIME_BY_EXT) },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled || !result.filePaths.length) return;

  const files = [];
  const failed = [];
  for (const filePath of result.filePaths) {
    try {
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).slice(1).toLowerCase();
      files.push({
        name: path.basename(filePath),
        path: filePath,
        mimeType: AUDIO_MIME_BY_EXT[ext] || 'audio/mpeg',
        buffer: new Uint8Array(buf)
      });
    } catch (err) {
      failed.push(path.basename(filePath));
    }
  }
  if (files.length > 0) {
    win.webContents.send('menu-import-songs', files);
  }
  if (failed.length > 0) {
    dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['OK'],
      title: 'Some Files Could Not Be Read',
      message: "Couldn't read: " + failed.join(', ')
    });
  }
}

// "Open Recent" — reopen the last project that was saved or opened, with no
// file picker at all.
async function openRecentProject(win) {
  const recentPath = getRecentProjectPath();
  if (!recentPath || !fs.existsSync(recentPath)) {
    await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['OK'],
      title: 'No Recent Project',
      message: recentPath
        ? "The most recent project file can't be found anymore (it may have been moved or deleted)."
        : "There's no recently saved project yet."
    });
    return;
  }
  try {
    loadProjectFromPath(win, recentPath);
  } catch (err) {
    dialog.showErrorBox('Open Failed', String((err && err.message) || err));
  }
}

function requestProjectDataFromPage(win) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ipcMain.once('project-data-response', (event, data) => done(data));
    win.webContents.send('request-project-data');
    // Safety timeout in case the page never responds for some reason.
    // Building the save payload (base64-encoding every song's audio and
    // JSON-serializing it) can legitimately take a while for a real
    // library, so this is generous — it should only ever fire if the page
    // is genuinely stuck, not just slow.
    setTimeout(() => done('__TIMEOUT__'), 120000);
  });
}

// ---------- Help: User Manual ----------
// The PDF manual is bundled with the app itself, so this works fully
// offline — the user just picks where on disk they'd like their own copy
// saved, exactly like a browser "Save As" download.
async function downloadUserManual(win) {
  const sourcePath = path.join(__dirname, 'Cue_Sync_User_Manual.pdf');
  const result = await dialog.showSaveDialog(win, {
    title: 'Save User Manual',
    defaultPath: 'Cue Sync - User Manual.pdf',
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
  });
  if (result.canceled || !result.filePath) return;
  try {
    fs.copyFileSync(sourcePath, result.filePath);
  } catch (err) {
    dialog.showErrorBox('Could Not Save Manual', String((err && err.message) || err));
  }
}

// ---------- About window ----------
function openAboutWindow(parentWin) {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return;
  }
  aboutWindow = new BrowserWindow({
    width: 380,
    height: 400,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: parentWin,
    title: 'About Cue Sync',
    backgroundColor: '#12151a',
    webPreferences: {
      preload: path.join(__dirname, 'about-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  aboutWindow.setMenu(null);
  aboutWindow.loadFile('about.html');
  aboutWindow.on('closed', () => { aboutWindow = null; });
}

ipcMain.handle('about-get-info', () => {
  const rawVersion = getCurrentVersion();
  const displayVersion = String(rawVersion).replace(/^v/i, '');
  return { version: displayVersion, name: app.getName() };
});

// ---------- Remote connection info window ----------
function showRemoteConnectionWindow(parentWin) {
  const info = remote.startServer((command) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remote-command', command);
    }
  });

  if (remoteInfoWindow && !remoteInfoWindow.isDestroyed()) {
    remoteInfoWindow.focus();
    remoteInfoWindow.webContents.send('remote-info', info);
    return;
  }

  remoteInfoWindow = new BrowserWindow({
    width: 420,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: parentWin,
    title: 'Remote Control',
    backgroundColor: '#12151a',
    webPreferences: {
      preload: path.join(__dirname, 'remote-info-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  remoteInfoWindow.setMenu(null);
  remoteInfoWindow.loadFile('remote-info.html');
  remoteInfoWindow.webContents.once('did-finish-load', () => {
    remoteInfoWindow.webContents.send('remote-info', info);
  });
  remoteInfoWindow.on('closed', () => { remoteInfoWindow = null; });
}

// ---------- Preferences window ----------
function openPreferencesWindow(parentWin) {
  if (prefsWindow && !prefsWindow.isDestroyed()) {
    prefsWindow.focus();
    return;
  }
  prefsWindow = new BrowserWindow({
    width: 420,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    parent: parentWin,
    title: 'Preferences',
    backgroundColor: '#12151a',
    webPreferences: {
      preload: path.join(__dirname, 'preferences-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  prefsWindow.setMenu(null);
  prefsWindow.loadFile('preferences.html');
  prefsWindow.on('closed', () => { prefsWindow = null; });
}

function openKeyCommandsWindow(parentWin) {
  if (keyCommandsWindow && !keyCommandsWindow.isDestroyed()) {
    keyCommandsWindow.focus();
    return;
  }
  keyCommandsWindow = new BrowserWindow({
    width: 460,
    height: 640,
    resizable: true,
    minimizable: false,
    maximizable: false,
    parent: parentWin,
    title: 'Key Commands',
    backgroundColor: '#12151a',
    webPreferences: {
      preload: path.join(__dirname, 'keycommands-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  keyCommandsWindow.setMenu(null);
  keyCommandsWindow.loadFile('keycommands.html');
  keyCommandsWindow.on('closed', () => { keyCommandsWindow = null; });
}

// The Key Commands window asks for the current command list + bindings; we
// relay that request to the main app window (which owns KEY_COMMANDS and
// the saved custom bindings) and relay its reply back.
ipcMain.handle('keycmd-get-bindings', () => {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve(null);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ipcMain.once('key-bindings-response', (event, data) => done(data));
    mainWindow.webContents.send('request-key-bindings');
    setTimeout(() => done(null), 4000);
  });
});

// The Key Commands window changed (or reset) a binding — relay it to the
// main app window, which actually applies and persists it.
ipcMain.on('keycmd-set-binding', (event, msg) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('set-key-binding', msg);
  }
});

// The Preferences window asks for the current device lists; we relay that
// request to the main app window (which is the one actually talking to
// MIDI/audio) and relay its reply back.
ipcMain.handle('prefs-get-devices', () => {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve(null);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ipcMain.once('device-lists-response', (event, lists) => done(lists));
    mainWindow.webContents.send('request-device-lists');
    setTimeout(() => done(null), 4000);
  });
});

// The Preferences window changed a device selection — relay it to the main
// app window, which actually applies it.
ipcMain.on('prefs-set-device', (event, msg) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('set-device', msg);
  }
});

ipcMain.handle('prefs-get-password-status', () => {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve(null);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ipcMain.once('password-status-response', (event, data) => done(data));
    mainWindow.webContents.send('request-password-status');
    setTimeout(() => done(null), 4000);
  });
});

// The Preferences window set or cleared the button password — relay it to
// the main app window, which actually stores it and enforces it on the
// PLAY ALL / Q-lock buttons.
ipcMain.on('prefs-set-password', (event, msg) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('set-button-password', msg);
  }
});

// The in-app "Check for Updates" button (in index.html) can't call Electron
// APIs directly — it sends this IPC message via preload.js instead.
ipcMain.on('check-for-updates', () => {
  checkForUpdates(false);
});

// ---------- Remote control (phone over local network) ----------
// The page pushes its current song list / active track here whenever it
// changes, so we can broadcast it to any connected phones.
ipcMain.on('remote-state-update', (event, state) => {
  remote.broadcastState(state);
});
ipcMain.on('remote-level-update', (event, level) => {
  remote.broadcastLevel(level);
});

// The renderer asks us to start the local server and report back the
// URL(s) a phone should open.
ipcMain.handle('remote-start', () => {
  const info = remote.startServer((command) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remote-command', command);
    }
  });
  return info;
});

app.whenReady().then(async () => {
  if (!license.hasValidLicense()) {
    const activated = await createLicenseGateWindow();
    if (!activated) {
      app.quit();
      return;
    }
  }

  splashWindow = createSplashWindow();
  const win = createWindow();

  // Show the startup chooser only once the main window has actually
  // finished its normal splash/loading sequence and become visible —
  // not before it.
  win.once('show', async () => {
    const startupChoice = await createStartupChooserWindow();
    if (startupChoice === 'open') {
      openProjectFromDisk(win);
    } else if (startupChoice === 'recent') {
      openRecentProject(win);
    }
    // New Project: no override needed — the app already defaults to Show
    // Mode on its own, and that default should always hold here too.
  });

  // Hidden, undocumented shortcut — opens the vendor-only Serial Generator
  // tool. Never shown in any menu.
  globalShortcut.register('CommandOrControl+Alt+Shift+G', () => {
    createSerialGeneratorWindow();
  });

  // Silent check a couple seconds after launch — only bothers the user if
  // an update is actually found.
  setTimeout(() => checkForUpdates(true), 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  remote.stopServer();
  if (process.platform !== 'darwin') app.quit();
});
