const { app, BrowserWindow, Menu, ipcMain, dialog, globalShortcut, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
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
    width: 360,
    height: 360,
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
    height: 440,
    resizable: false,
    title: 'Serial Generator',
    backgroundColor: '#0d1015',
    icon: path.join(__dirname, 'icon.png'),
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
          label: 'Backup Project…',
          click: () => backupProjectToFolder(win)
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
          click: () => win.webContents.send('menu-toggle-panel', 'songLibrary')
        },
        {
          label: 'Cue Inspector',
          click: () => win.webContents.send('menu-toggle-panel', 'inspector')
        },
        {
          label: 'Cue Stack',
          click: () => win.webContents.send('menu-toggle-panel', 'cueStack')
        },
        {
          label: 'MSC / MIDI Defaults',
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
  }, 5000);
  // Safety net: the splash window has no close button by design. If, for
  // any reason, 'ready-to-show' never fires on a particular machine, this
  // would otherwise leave the splash stuck on screen forever with no way
  // to get past it. This hard timeout forces the swap regardless.
  setTimeout(() => trySwapToMainWindow(true), 9000);

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
      defaultPath: currentProjectPath || `cue-sync-project-${stamp}.cuesync`,
      // Projects now carry their own extension so Windows can give them the
      // Cue Sync icon. The contents are still plain JSON, so older .json
      // projects keep opening fine.
      filters: [
        { name: 'Cue Sync Project', extensions: ['cuesync'] },
        { name: 'Cue Sync Project (legacy JSON)', extensions: ['json'] }
      ]
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

// "Backup Project" — writes the project plus every media file it uses into
// one folder the user picks, keeping each song's own filename. Unlike Save,
// which references media in place, a backup is self-contained: it can be
// copied to another machine or drive and still open.
async function backupProjectToFolder(win) {
  const pick = await dialog.showOpenDialog(win, {
    title: 'Choose a folder for the backup',
    properties: ['openDirectory', 'createDirectory']
  });
  if (pick.canceled || !pick.filePaths || !pick.filePaths.length) return false;
  const targetDir = pick.filePaths[0];

  const payload = await requestProjectDataFromPage(win);
  if (!payload || payload === 'EMPTY') {
    dialog.showMessageBox(win, { type: 'info', message: 'There is nothing to back up yet.' });
    return false;
  }

  try {
    const manifest = payload.manifest;
    const embedded = new Map((payload.audioFiles || []).map(a => [a.id, a]));
    const used = new Set();
    const missing = [];

    const uniqueName = (wanted) => {
      // Two songs can share a filename; keep both by numbering the second.
      let base = path.basename(wanted);
      if (!used.has(base)) { used.add(base); return base; }
      const ext = path.extname(base), stem = path.basename(base, ext);
      let i = 2;
      while (used.has(`${stem} (${i})${ext}`)) i++;
      const out = `${stem} (${i})${ext}`;
      used.add(out);
      return out;
    };

    for (const song of manifest.songs) {
      let outName = null;
      if (song.originalPath && fs.existsSync(song.originalPath)) {
        outName = uniqueName(song.originalPath);
        fs.copyFileSync(song.originalPath, path.join(targetDir, outName));
      } else if (embedded.has(song.id)) {
        const af = embedded.get(song.id);
        const ext = song.audioExt || af.ext || 'wav';
        const stem = String(song.name || song.id).replace(/[\\/:*?"<>|]/g, '_');
        outName = uniqueName(stem.toLowerCase().endsWith('.' + ext.toLowerCase()) ? stem : `${stem}.${ext}`);
        fs.writeFileSync(path.join(targetDir, outName), Buffer.from(af.buffer));
      } else {
        missing.push(song.name || song.id);
      }
      // Point the backed-up project at its own copy, sitting alongside it.
      if (outName) { song.originalPath = outName; song.backupFile = outName; }
    }

    manifest.mediaFolder = '';
    manifest.isBackup = true;
    const projName = (currentProjectPath
      ? path.basename(currentProjectPath, path.extname(currentProjectPath))
      : 'cue-sync-project') + '.cuesync';
    fs.writeFileSync(path.join(targetDir, projName), JSON.stringify(manifest), 'utf8');

    dialog.showMessageBox(win, {
      type: missing.length ? 'warning' : 'info',
      message: missing.length
        ? `Backup finished, but ${missing.length} song(s) had no reachable audio file:\n` + missing.join('\n')
        : `Backup complete: ${manifest.songs.length} song(s) copied to\n${targetDir}`
    });
    return true;
  } catch (err) {
    dialog.showErrorBox('Backup Failed', String((err && err.message) || err));
    return false;
  }
}

// "Save As" — always prompts for a new name/location, regardless of
// whether this project already has a path.
async function saveProjectAsToFile(win) {
  return saveProjectToFile(win, true);
}

// ---------- Auto Save ----------
// Silent background save on a timer, configured from Preferences → General.
// Deliberately never shows a dialog: auto-save only writes to a project
// path that's already established (from a prior manual Save or an opened
// project) so it can never interrupt the operator with a "where do you
// want to save this?" prompt in the middle of a show, and it skips
// entirely rather than warning when there's nothing to save yet. Results
// (success or failure) are reported back to the renderer as a quiet toast
// instead of a modal dialog, for the same reason.
let autoSaveIntervalMinutes = 0; // 0 = off
let autoSaveTimer = null;

async function autoSaveProjectToFile(win) {
  if (!currentProjectPath) return; // never prompt for a location on its own
  if (!win || win.isDestroyed()) return;
  const payload = await requestProjectDataFromPage(win);
  if (payload === 'EMPTY') return; // nothing to save yet — stay silent
  if (payload === '__TIMEOUT__' || !payload) {
    win.webContents.send('autosave-result', { ok: false, message: 'Auto-save timed out.' });
    return;
  }
  if (typeof payload === 'string' && payload.startsWith('__ERROR__:')) {
    win.webContents.send('autosave-result', { ok: false, message: 'Auto-save failed: ' + payload.slice('__ERROR__:'.length) });
    return;
  }
  try {
    const jsonPath = currentProjectPath;
    const dir = path.dirname(jsonPath);
    const baseName = path.basename(jsonPath, path.extname(jsonPath));
    const mediaDirName = baseName + '_media';
    const mediaDir = path.join(dir, mediaDirName);
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
    win.webContents.send('autosave-result', { ok: true });
  } catch (err) {
    win.webContents.send('autosave-result', { ok: false, message: String((err && err.message) || err) });
  }
}

function stopAutoSaveTimer() {
  if (autoSaveTimer) {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
  }
}

function startAutoSaveTimer(minutes) {
  stopAutoSaveTimer();
  autoSaveIntervalMinutes = minutes || 0;
  if (!autoSaveIntervalMinutes) return;
  autoSaveTimer = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      autoSaveProjectToFile(mainWindow);
    }
  }, autoSaveIntervalMinutes * 60 * 1000);
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
async function loadProjectFromPath(win, jsonPath) {
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
    //
    // Candidates are tried in order so that a project stays loadable after it
    // and its media have been moved together (which is exactly what "Backup
    // Project" produces). A backup writes a BARE FILENAME into originalPath,
    // and a bare name passed to readFileSync would resolve against the
    // process working directory — never the folder holding the .cuesync file
    // — so it must be joined to `dir` explicitly.
    const candidates = [];
    // A path recorded on one OS may be read on the other, so the last path
    // segment is taken by splitting on BOTH separators. Node's path.basename
    // only knows the separator of the platform it is running on, and would
    // hand back a whole "C:\Users\...\song.wav" unchanged on macOS.
    const lastSegment = (p) => String(p).split(/[\\/]/).pop();

    if (sData.backupFile) candidates.push(path.join(dir, lastSegment(sData.backupFile)));
    if (sData.originalPath) {
      const op = sData.originalPath;
      const absolute = path.isAbsolute(op) || /^[a-zA-Z]:[\\/]/.test(op);
      if (absolute) {
        candidates.push(op);
      } else {
        candidates.push(path.resolve(dir, op));
      }
      // Last resort: a file of the same name sitting beside the project. This
      // rescues a backup whose manifest still carries absolute paths from the
      // machine it was made on, including one made on the other OS.
      candidates.push(path.join(dir, lastSegment(op)));
    }

    for (const candidate of candidates) {
      try {
        buf = fs.readFileSync(candidate);
        // Pin the manifest to where the file actually turned out to be, so a
        // later Save or Backup of this project works from a real location
        // rather than a bare name that only meant something next to the old
        // project file.
        sData.originalPath = candidate;
        break;
      } catch (readErr) {
        // Try the next candidate; the media-folder fallback below still applies.
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
      // Keep only the path/size here. The bytes are streamed separately
      // below — see the comment on the send() call.
      audioFiles.push({ id: sData.id, buf });
    } else {
      missingSongs.push(sData.name || sData.id);
      console.error('Missing audio file for song', sData.id, sData.name);
    }
  }

  // Audio is streamed to the page in chunks rather than bundled into one
  // IPC message. Every IPC payload is serialised by V8's ValueSerializer,
  // and a show with several songs could easily push hundreds of megabytes
  // through a single call — which overruns the serializer and takes the
  // whole app down with a SIGTRAP before the project ever opens.
  const AUDIO_CHUNK = 4 * 1024 * 1024;
  win.webContents.send('menu-open-project', {
    manifest,
    expectedAudio: audioFiles.map(a => ({ id: a.id, size: a.buf.length }))
  });
  for (const a of audioFiles) {
    const total = Math.max(1, Math.ceil(a.buf.length / AUDIO_CHUNK));
    for (let i = 0; i < total; i++) {
      const slice = a.buf.subarray(i * AUDIO_CHUNK, Math.min((i + 1) * AUDIO_CHUNK, a.buf.length));
      if (win.isDestroyed()) return;
      win.webContents.send('project-audio-chunk', {
        id: a.id, index: i, total, chunk: new Uint8Array(slice)
      });
      // Yield between chunks so the UI keeps breathing on big shows.
      await new Promise(r => setImmediate(r));
    }
  }
  if (!win.isDestroyed()) win.webContents.send('project-audio-done', {});
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

// "Open" — pick a .cuesync (or legacy .json) project file from disk and hand
// its contents to the page.
async function openProjectFromDisk(win) {
  const result = await dialog.showOpenDialog(win, {
    title: 'Open Project',
    filters: [
      { name: 'Cue Sync Project', extensions: ['cuesync', 'json'] },
      { name: 'All Files', extensions: ['*'] }
    ],
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
  wma: 'audio/x-ms-wma', mp4: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', mkv: 'video/x-matroska', m4v: 'video/x-m4v'
};

// "Import Songs…" — a native multi-select file dialog handled entirely in
// the main process (rather than proxying a click to the renderer's hidden
// <input type="file">), so it reliably opens regardless of the renderer's
// current focus/activation state.
async function importSongsFromDisk(win) {
  const result = await dialog.showOpenDialog(win, {
    title: 'Import Songs',
    filters: [
      { name: 'Audio & Video Files', extensions: Object.keys(AUDIO_MIME_BY_EXT) },
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
    width: 640,
    height: 520,
    resizable: true,
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

// The Preferences window asks for the current RSO mode; relay to the main
// app window (which owns the setting) and relay its reply back.
ipcMain.handle('prefs-get-rso-mode', () => {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve(null);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ipcMain.once('rso-mode-response', (event, data) => done(data));
    mainWindow.webContents.send('request-rso-mode');
    setTimeout(() => done(null), 4000);
  });
});

// The Preferences window changed the RSO mode — relay it to the main app
// window, which actually applies and persists it.
ipcMain.on('prefs-set-rso-mode', (event, msg) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('set-rso-mode', msg);
  }
});

// Same relay pattern as RSO mode above: the main app window (via
// localStorage) is the source of truth for the configured interval: the
// Preferences window asks for it here, and this process also owns the
// actual setInterval timer, restarting it whenever the value changes.
// ---------- MIDI Timecode settings ----------
// Kept in the main process and written to userData, so the setting survives
// restarts and is available before the page has finished loading.
function tcSettingsPath() { return path.join(app.getPath('userData'), 'timecode.json'); }
function readTcSettings() {
  try {
    const d = JSON.parse(fs.readFileSync(tcSettingsPath(), 'utf8'));
    return { enabled: !!d.enabled, fps: [24, 25, 29.97, 30].includes(d.fps) ? d.fps : 25 };
  } catch (e) { return { enabled: false, fps: 25 }; }
}
function writeTcSettings(st) {
  try { fs.writeFileSync(tcSettingsPath(), JSON.stringify(st), 'utf8'); } catch (e) {}
}
ipcMain.handle('tc-get-settings', () => readTcSettings());
ipcMain.on('tc-set-settings', (event, st) => {
  const clean = { enabled: !!(st && st.enabled), fps: [24, 25, 29.97, 30].includes(st && st.fps) ? st.fps : 25 };
  writeTcSettings(clean);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tc-settings', clean);
});

ipcMain.handle('prefs-get-autosave-interval', () => {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve(null);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    ipcMain.once('autosave-interval-response', (event, data) => done(data));
    mainWindow.webContents.send('request-autosave-interval');
    setTimeout(() => done(null), 4000);
  });
});
ipcMain.on('prefs-set-autosave-interval', (event, msg) => {
  const minutes = (msg && msg.minutes) || 0;
  startAutoSaveTimer(minutes);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('set-autosave-interval', msg);
  }
});
// The main app window reports its persisted interval once at startup so
// the timer here can be initialized to match, without waiting on the
// Preferences window ever having been opened.
ipcMain.on('autosave-interval-startup', (event, msg) => {
  startAutoSaveTimer((msg && msg.minutes) || 0);
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

// ---------- Video preview window ----------
// Created and owned entirely here in the main process, rather than via a
// renderer-side window.open() — a window.open() popup inherits the app's
// own menu bar on Windows/Linux, and stripping that after the fact via
// setWindowOpenHandler/did-create-window proved unreliable in practice
// (the menu could still flash or stick depending on timing). Building the
// BrowserWindow directly means the menu is removed synchronously, before
// the window is ever shown, so there's no window in which it could appear.
// The popup's HTML is written to a real temp file and loaded via
// loadFile() rather than a data: URL — a data: URL has an opaque origin
// that Chromium blocks from loading file:// media, which silently failed
// the video with a "no supported sources" error; a file:// origin can
// load another file:// resource without that restriction.
const videoPreviewWindows = new Map(); // songId -> BrowserWindow
const videoOutputWindows = new Map();  // songId -> fullscreen projector window

// ---------- Video output settings ----------
// Which display the video is projected on, and how it is scaled there.
function videoSettingsPath() { return path.join(app.getPath('userData'), 'video.json'); }
function readVideoSettings() {
  const def = { displayId: null, autoProject: true, scaling: 'fit', resolution: 'native' };
  try {
    const d = JSON.parse(fs.readFileSync(videoSettingsPath(), 'utf8'));
    return {
      displayId: (d.displayId === null || d.displayId === undefined) ? null : Number(d.displayId),
      autoProject: d.autoProject !== false,
      scaling: ['fit', 'fill', 'stretch'].includes(d.scaling) ? d.scaling : 'fit',
      resolution: ['native', '2160p', '1080p', '720p'].includes(d.resolution) ? d.resolution : 'native'
    };
  } catch (e) { return def; }
}
function writeVideoSettings(st) {
  try { fs.writeFileSync(videoSettingsPath(), JSON.stringify(st), 'utf8'); } catch (e) {}
}
function listDisplays() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    isPrimary: d.id === primary.id,
    width: d.size.width,
    height: d.size.height,
    scaleFactor: d.scaleFactor,
    label: d.id === primary.id ? 'This computer' : ('External display' + (screen.getAllDisplays().length > 2 ? ' ' + i : ''))
  }));
}
// The display the video should go to: the chosen one if it is still
// connected, otherwise the first non-primary display, otherwise none.
function resolveOutputDisplay() {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const st = readVideoSettings();
  if (st.displayId != null) {
    const chosen = all.find(d => d.id === st.displayId);
    if (chosen) return chosen;
  }
  return all.find(d => d.id !== primary.id) || null;
}
ipcMain.handle('video-get-displays', () => ({ displays: listDisplays(), settings: readVideoSettings() }));
ipcMain.on('video-set-settings', (event, st) => {
  const clean = {
    displayId: (st && st.displayId != null) ? Number(st.displayId) : null,
    autoProject: !(st && st.autoProject === false),
    scaling: ['fit', 'fill', 'stretch'].includes(st && st.scaling) ? st.scaling : 'fit',
    resolution: ['native', '2160p', '1080p', '720p'].includes(st && st.resolution) ? st.resolution : 'native'
  };
  writeVideoSettings(clean);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('video-settings', clean);
  // Re-apply scaling to anything already on screen.
  videoOutputWindows.forEach((win) => {
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript(videoScalingJs(clean)).catch(() => {});
  });
});
// Tell the renderer whenever displays are plugged in or removed.
function notifyDisplayChange() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('video-displays-changed', { displays: listDisplays() });
  }
}

function videoScalingJs(st) {
  const fit = st.scaling === 'fill' ? 'cover' : (st.scaling === 'stretch' ? 'fill' : 'contain');
  const res = { '2160p': [3840, 2160], '1080p': [1920, 1080], '720p': [1280, 720] }[st.resolution];
  return [
    'var v = document.getElementById("v");',
    'if (v) {',
    '  v.style.objectFit = "' + fit + '";',
    res ? ('  v.style.width = "' + res[0] + 'px"; v.style.height = "' + res[1] + 'px";'
           + ' v.style.maxWidth = "100vw"; v.style.maxHeight = "100vh";')
        : '  v.style.width = "100vw"; v.style.height = "100vh"; v.style.maxWidth = ""; v.style.maxHeight = "";',
    '}'
  ].join('\n');
}

// Fullscreen projector on the second display. Separate from the small
// floating preview, which stays available from the row icon.
function createVideoOutputWindow(songId, videoPath, extraTempFiles) {
  try {
    const st = readVideoSettings();
    const display = resolveOutputDisplay();
    if (!display) { reportVideoPreviewStatus(songId, false, 'No second display detected — video is not being projected.'); return; }
    if (!fs.existsSync(videoPath)) { reportVideoPreviewStatus(songId, false, 'Video file not found at: ' + videoPath); return; }

    const existing = videoOutputWindows.get(songId);
    if (existing && !existing.isDestroyed()) { existing.show(); return; }

    const b = display.bounds;
    const win = new BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      show: false, frame: false, fullscreen: true, backgroundColor: '#000000',
      skipTaskbar: true, autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    win.setMenu(null);
    win.setMenuBarVisibility(false);

    const fileUrl = pathToFileURL(videoPath).href;
    const tempHtmlPath = path.join(app.getPath('temp'), 'cuesync-video-output-' + songId + '.html');
    fs.writeFileSync(tempHtmlPath, buildVideoPreviewHtml(fileUrl), 'utf-8');
    win.loadFile(tempHtmlPath);
    win.once('ready-to-show', () => {
      win.setFullScreen(true);
      win.show();
      win.webContents.executeJavaScript(videoScalingJs(st)).catch(() => {});
    });
    setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 1500);
    win.on('closed', () => {
      videoOutputWindows.delete(songId);
      [tempHtmlPath].concat(extraTempFiles || []).forEach(f => { try { fs.unlinkSync(f); } catch (e) {} });
    });
    videoOutputWindows.set(songId, win);
    reportVideoPreviewStatus(songId, true, 'Projecting on ' + display.size.width + '×' + display.size.height + ' display.');
  } catch (err) {
    reportVideoPreviewStatus(songId, false, 'Could not project the video: ' + ((err && err.message) || err));
  }
}
ipcMain.on('open-video-output', (event, payload) => {
  const { songId, videoPath } = payload || {};
  if (!songId || !videoPath) return;
  createVideoOutputWindow(songId, videoPath, []);
});
ipcMain.on('open-video-output-from-bytes', (event, payload) => {
  const { songId, bytes, ext } = payload || {};
  if (!songId || !bytes) return;
  try {
    const tempVideoPath = path.join(app.getPath('temp'), 'cuesync-video-out-' + songId + (ext || '.mp4'));
    fs.writeFileSync(tempVideoPath, Buffer.from(bytes));
    createVideoOutputWindow(songId, tempVideoPath, [tempVideoPath]);
  } catch (err) {
    reportVideoPreviewStatus(songId, false, 'Could not prepare the video for projection: ' + ((err && err.message) || err));
  }
});
ipcMain.on('close-video-output', (event, payload) => {
  const { songId } = payload || {};
  const win = videoOutputWindows.get(songId);
  if (win && !win.isDestroyed()) win.close();
});
ipcMain.handle('video-has-second-display', () => !!resolveOutputDisplay());

function buildVideoPreviewHtml(fileUrl) {
  return '<!DOCTYPE html><html><head><style>' +
    'html,body{margin:0;height:100%;background:#000;overflow:hidden;}' +
    'video{width:100%;height:100%;object-fit:contain;display:block;}' +
    '</style></head><body>' +
    '<video id="v" src="' + fileUrl + '" muted></video>' +
    '</body></html>';
}

function reportVideoPreviewStatus(songId, success, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('video-preview-status', { songId, success, message });
  }
}

function createVideoPreviewWindow(songId, videoPath, title, extraTempFiles) {
  try {
    const existing = videoPreviewWindows.get(songId);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      reportVideoPreviewStatus(songId, true, 'Reused existing preview window.');
      return;
    }
    if (!fs.existsSync(videoPath)) {
      reportVideoPreviewStatus(songId, false, 'Video file not found at: ' + videoPath);
      return;
    }

    const videoWin = new BrowserWindow({
      width: 960,
      height: 600,
      show: false,
      backgroundColor: '#000000',
      title: title || 'Video Preview',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    // Belt-and-suspenders: remove the menu synchronously, immediately,
    // before any content loads or the window is shown — this is the step
    // that a window.open()-created window can't reliably do this early.
    videoWin.setMenu(null);
    videoWin.setMenuBarVisibility(false);
    videoWin.setAlwaysOnTop(true, 'floating');

    const fileUrl = pathToFileURL(videoPath).href;
    const tempHtmlPath = path.join(app.getPath('temp'), 'cuesync-video-preview-' + songId + '.html');
    try {
      fs.writeFileSync(tempHtmlPath, buildVideoPreviewHtml(fileUrl), 'utf-8');
    } catch (e) {
      if (videoWin && !videoWin.isDestroyed()) videoWin.close();
      reportVideoPreviewStatus(songId, false, 'Could not write a temporary file (' + (app.getPath('temp')) + '): ' + e.message);
      return;
    }

    let shown = false;
    videoWin.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      reportVideoPreviewStatus(songId, false, 'The preview window failed to load its content: ' + errorDescription + ' (' + errorCode + ')');
    });
    videoWin.loadFile(tempHtmlPath).catch((e) => {
      reportVideoPreviewStatus(songId, false, 'loadFile() failed: ' + e.message);
    });

    videoWin.once('ready-to-show', () => {
      if (videoWin.isDestroyed()) return;
      videoWin.setMenu(null);
      videoWin.setMenuBarVisibility(false);
      videoWin.setAlwaysOnTop(true, 'floating');
      videoWin.show();
      shown = true;
      reportVideoPreviewStatus(songId, true, 'Preview window opened.');
    });
    // Some content (rare, but possible depending on how the page finishes
    // loading) never fires ready-to-show — show it anyway after a short
    // delay rather than leaving it invisible forever.
    setTimeout(() => {
      if (!videoWin.isDestroyed() && !shown) {
        videoWin.setMenu(null);
        videoWin.setMenuBarVisibility(false);
        videoWin.setAlwaysOnTop(true, 'floating');
        videoWin.show();
        shown = true;
        reportVideoPreviewStatus(songId, true, 'Preview window opened (fallback timer).');
      }
    }, 1500);

    videoWin.on('closed', () => {
      videoPreviewWindows.delete(songId);
      try { fs.unlinkSync(tempHtmlPath); } catch (e) {}
      (extraTempFiles || []).forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('video-preview-closed', songId);
      }
    });

    videoPreviewWindows.set(songId, videoWin);
  } catch (e) {
    reportVideoPreviewStatus(songId, false, 'Unexpected error opening the preview: ' + e.message);
  }
}

ipcMain.on('open-video-preview', (event, payload) => {
  const { songId, videoPath, title } = payload || {};
  if (!songId || !videoPath) {
    reportVideoPreviewStatus(songId, false, 'Missing song ID or video path in the request.');
    return;
  }
  createVideoPreviewWindow(songId, videoPath, title, []);
});

// Fallback for when the renderer's File object has no usable .path — this
// is actually the common case for a native drag-and-drop, since the
// renderer reads dropped files through the FileSystemEntry API to support
// dropped folders and multi-file drags, and that returns a freshly
// constructed File object without Electron's usual .path injection. The
// renderer instead hands over the raw bytes, which get written to a temp
// video file here so the exact same window-creation path can be used.
ipcMain.on('open-video-preview-from-bytes', (event, payload) => {
  const { songId, bytes, fileName, title } = payload || {};
  if (!songId || !bytes || !bytes.length) {
    reportVideoPreviewStatus(songId, false, 'No video data received from the app window.');
    return;
  }
  const ext = (fileName && path.extname(fileName)) || '.mp4';
  const tempVideoPath = path.join(app.getPath('temp'), 'cuesync-video-src-' + songId + ext);
  try {
    fs.writeFileSync(tempVideoPath, Buffer.from(bytes));
  } catch (e) {
    reportVideoPreviewStatus(songId, false, 'Could not write the video to a temp file: ' + e.message);
    return;
  }
  createVideoPreviewWindow(songId, tempVideoPath, title, [tempVideoPath]);
});

// Mirrors the app's own play/pause/seek state onto an open preview window,
// so the video always matches whatever the audio is doing.
ipcMain.on('sync-video-preview', (event, payload) => {
  const { songId, action, time } = payload || {};
  const targets = [videoPreviewWindows.get(songId), videoOutputWindows.get(songId)]
    .filter(w => w && !w.isDestroyed());
  if (!targets.length) return;
  const js = [
    'var v = document.getElementById("v");',
    'if (v) {',
    (typeof time === 'number') ? ('  if (Math.abs(v.currentTime - ' + time + ') > 0.15) { try { v.currentTime = ' + time + '; } catch(e) {} }') : '',
    (action === 'play') ? '  if (v.paused) { v.play().catch(function(){}); }' : '',
    (action === 'pause') ? '  if (!v.paused) { v.pause(); }' : '',
    '}'
  ].join('\n');
  targets.forEach(w => w.webContents.executeJavaScript(js).catch(() => {}));
});

app.whenReady().then(async () => {
  screen.on('display-added', notifyDisplayChange);
  screen.on('display-removed', notifyDisplayChange);

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
