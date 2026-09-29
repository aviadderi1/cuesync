// updater.js
// Checks a GitHub repo's Releases for a newer version, and if found,
// downloads the "index.html" asset attached to that release and swaps it
// in place of the app's current index.html. Then relaunches the app.
//
// Requires no extra npm packages — uses Node's built-in https module.

const { app, dialog } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ================= CONFIGURE THIS =================
// Replace with your own GitHub username and repo name.
// Example: if your releases page is
//   https://github.com/aviadderi1/cuesync/releases
// then:
const GITHUB_OWNER = 'aviadderi1';
const GITHUB_REPO = 'cuesync';

// The exact file name you attach to each GitHub Release. Every release you
// publish should have a file with this exact name attached as an asset.
const ASSET_NAME = 'index.html';
// ====================================================

// Where we track "what version is currently installed here". This is
// separate from package.json's version, because updates only replace
// index.html (not package.json) — see version.txt below.
function versionFilePath() {
  return path.join(app.getAppPath(), 'version.txt');
}

function getCurrentVersion() {
  try {
    return fs.readFileSync(versionFilePath(), 'utf8').trim();
  } catch (e) {
    // No version.txt yet (first run after a fresh install) — fall back to
    // the version baked into package.json at install time.
    return require('./package.json').version;
  }
}

function setCurrentVersion(v) {
  fs.writeFileSync(versionFilePath(), v, 'utf8');
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'CueSync-Updater',
        'Accept': 'application/vnd.github+json'
      }
    };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsGetJson(res.headers.location));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('GitHub API returned HTTP ' + res.statusCode));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'CueSync-Updater',
        'Accept': 'application/octet-stream'
      }
    };
    https.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadFile(res.headers.location, destPath));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('Download failed: HTTP ' + res.statusCode));
      }
      const tmpPath = destPath + '.download';
      const file = fs.createWriteStream(tmpPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          try {
            fs.renameSync(tmpPath, destPath); // swap in as one quick step
            resolve();
          } catch (renameErr) {
            reject(renameErr);
          }
        });
      });
      file.on('error', reject);
    }).on('error', reject);
  });
}

// Basic version compare for tags like "v1.2.0" or "1.2.0".
function isNewerVersion(latest, current) {
  const a = String(latest).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const b = String(current).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

// silent=true: only speak up if an update was found (used for the automatic
// check on startup). silent=false: always show a result, including
// "you're up to date" or an error (used for a manual "Check for Updates").
async function checkForUpdates(silent) {
  try {
    const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
    const release = await httpsGetJson(apiUrl);
    if (!release || !release.tag_name) throw new Error('Could not read release info from GitHub');

    const latestVersion = release.tag_name;
    const currentVersion = getCurrentVersion();

    if (!isNewerVersion(latestVersion, currentVersion)) {
      if (!silent) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'Cue Sync',
          message: `You're already on the latest version (${currentVersion}).`
        });
      }
      return;
    }

    const asset = (release.assets || []).find(a => a.name === ASSET_NAME);
    if (!asset) throw new Error(`Release ${latestVersion} has no "${ASSET_NAME}" file attached`);

    const choice = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Update Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Available',
      message: `A new version (${latestVersion}) is available. You have ${currentVersion}.`,
      detail: 'The app will restart automatically after updating.'
    });
    if (choice.response !== 0) return;

    const targetPath = path.join(app.getAppPath(), 'index.html');
    await downloadFile(asset.browser_download_url, targetPath);
    setCurrentVersion(latestVersion);

    await dialog.showMessageBox({
      type: 'info',
      title: 'Update Complete',
      message: `Updated to ${latestVersion}. The app will now restart.`
    });
    app.relaunch();
    app.exit();

  } catch (err) {
    console.error('Update check failed:', err);
    if (!silent) {
      const code = err && err.code;
      let message = String((err && err.message) || err);
      if (code === 'EPERM' || code === 'EACCES') {
        message =
          "Couldn't write the update — Windows blocked the write because the app " +
          'is installed in a protected folder (like Program Files).\n\n' +
          'Fix options:\n' +
          '1) Right-click the app and choose "Run as Administrator", then try ' +
          'Check for Updates again — OR —\n' +
          '2) Uninstall and reinstall, accepting the default install location ' +
          '(under your user folder) instead of Program Files. That avoids this ' +
          'permanently.';
      }
      dialog.showErrorBox('Update Check Failed', message);
    }
  }
}

module.exports = { checkForUpdates, getCurrentVersion };
