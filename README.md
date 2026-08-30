# Cue Sync — Installers for Windows and Mac

**Good news: the Windows and Mac installers are already built for you** — look for
`CueSync-Setup-Windows.exe`, `CueSync-Mac-Intel.zip`, and
`CueSync-Mac-AppleSilicon.zip` alongside this project. No build steps needed.

## Auto-updates via GitHub Releases

The app now checks GitHub for new versions automatically:
- **On launch**, it silently checks a few seconds in. If there's an update, it asks
  you before doing anything; if not, it says nothing.
- **"Cue Sync" menu → "Check for Updates…"** lets you check any time, and
  always tells you the result (up to date / update found / error).

When it finds a newer version, it downloads the new `index.html` from that release
and swaps it into the running app, then restarts automatically. No reinstall, no
`npm install` — this uses the same "index.html is a plain file" setup described
below, just automated.

### One-time setup: point it at your GitHub repo

Open `updater.js` and edit these two lines near the top:

```js
const GITHUB_OWNER = 'YOUR_GITHUB_USERNAME';
const GITHUB_REPO = 'YOUR_REPO_NAME';
```

Replace them with your actual GitHub username and repository name (the ones in your
repo's URL, e.g. `github.com/<owner>/<repo>`). Then rebuild the installers (steps
further down) once with this change — after that, all future updates happen through
GitHub Releases without rebuilding again.

### Publishing an update

Each time you want to ship an update:

1. On GitHub, go to your repo → **Releases** → **Draft a new release**.
2. Set the **tag** to the new version, e.g. `v1.0.1` (must be higher than the last
   one — the app compares these numerically).
3. Attach the updated **`index.html`** file as a release asset (drag it into the
   "Attach binaries" area). The file must be named exactly `index.html`.
4. Publish the release.

That's it — anyone with the app open will get the update prompt next time they
launch it (or immediately if they use "Check for Updates…").

### Notes on the update mechanism
- Version tracking lives in a small `version.txt` file next to `index.html` inside
  the installed app (not in `package.json`), since updates only touch `index.html`.
  It's created automatically on first run and updated after each successful update.
- The check uses GitHub's public API and needs no token for a public repo. If your
  repo is private, this simple approach won't authenticate — ask me and I can add
  token support.
- If writing the new file fails (e.g. a permissions issue), you'll see an error
  dialog instead of a silent failure.

## Updating the app WITHOUT reinstalling (manual alternative)

This build is set up so the app's page (`index.html`) sits as a **plain, loose file**
inside the installed app — not locked inside a compressed archive. That means you can
also update by hand any time, without waiting on the auto-updater: just replace that
one file.

**Windows** — find the folder you installed to (you chose it during setup), then go to:
```
<install folder>\resources\app\index.html
```
Replace it with the new `index.html`, then relaunch the app. Done.

**Mac** — right-click (Control-click) **Cue Sync.app** in Applications →
**Show Package Contents** → navigate to:
```
Contents/Resources/app/index.html
```
Replace it with the new `index.html`, then relaunch the app. Done.

### When you *would* still need to reinstall
Only if something changes outside `index.html` — for example the app icon, the window
behavior in `main.js`/`updater.js`, or the app name/version. Those cases are rare;
when they come up, rebuild using the steps below and reinstall as normal (it upgrades
cleanly over the old install, no need to uninstall first).

## Important: Mac builds must run on a Mac (if you ever need to rebuild)

Apple's tooling for building/signing Mac apps only works on macOS itself — it can't be
cross-built from Windows or Linux. So if you ever need a fresh `.app`/`.zip`, run the
build on a Mac.

## What you need (one-time, per machine)
Install **Node.js** (LTS version) from https://nodejs.org — just run the installer,
default settings are fine.

## Steps — Windows (only needed for the rare full rebuild)

1. Extract this folder anywhere on the PC.
2. Open **PowerShell** inside the folder (Shift + right-click on empty space in the
   folder → "Open PowerShell window here").
3. Run:
   ```
   npm install
   ```
4. Run:
   ```
   npm run dist:win
   ```
5. The installer appears inside the `dist` folder, named something like:
   ```
   Cue Sync Setup 1.0.0.exe
   ```
   Running it installs "Cue Sync" with a Start Menu and Desktop shortcut.

## Steps — Mac (only needed for the rare full rebuild)

1. Extract this folder anywhere on the Mac.
2. Open **Terminal**, then `cd` into the folder (you can drag the folder onto the
   Terminal window after typing `cd ` to auto-fill the path).
3. Run:
   ```
   npm install
   ```
4. Run:
   ```
   npm run dist:mac
   ```
5. The archive appears inside the `dist` folder, named something like:
   ```
   Cue Sync-1.0.0-mac.zip
   ```
   Unzip it and drag the `.app` into Applications.

   **Note:** since the app isn't code-signed with an Apple Developer certificate,
   macOS Gatekeeper will likely block it on first open with an "unidentified
   developer" warning. To open it anyway: right-click (or Control-click) the app in
   Applications → **Open** → confirm **Open** in the dialog. You only need to do this
   once.

## Quick test without building an installer
From either platform, after `npm install`, you can run:
```
npm start
```
This opens the app in an Electron window directly, without producing an installer —
useful for a fast check before doing the full build.

## Notes
- `icon.png` is a simple placeholder app icon (1024×1024). Replace it with your own
  square PNG (same filename) before building if you want a custom icon — electron-
  builder will generate the platform-specific icon formats from it automatically.
- You do not need to repeat `npm install` for every rebuild — only when you first set
  up the project on a given machine, or after an Electron version update.
