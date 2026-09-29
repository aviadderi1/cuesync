# Cue Sync

Stage playback and MIDI Show Control cue tool for grandMA lighting operators.
Electron desktop app for Windows and macOS.

**Current version: 1.1.0**

This repository holds the app **source**. Installers are not committed here — they
are published as assets on the [Releases](../../releases) page.

## What's in 1.1.0

- **Show Mode** — NOW/NEXT and CUE/NEXT CUE panels, waveform zoom, free cue dragging,
  per-channel triangular volume wedge with colour zones and a percentage readout
- **Focus window** — floating per-channel strip with EQ, compressor (with GR meter)
  and a built-in RTA
- **MIDI Time Code (MTC)** — quarter-frame and full-frame output at 24 / 25 / 29.97 /
  30 fps, alongside the existing MSC GO cues. Works with grandMA2 and grandMA3.
- **Video** — a second display is detected automatically and video channels are
  projected full-screen on it; resolution and scaling are set in Preferences → Video
- **Cue Stack** — cues grouped under each song title, highlighted as the playhead
  passes them
- **Backup Project** (File menu) — copies the project plus every media file, under
  their original filenames, into a folder you choose
- **Phone remote** — installable PWA with CUE LOCK, current cue, and per-song
  countdown
- Project files save as `.cuesync`
- Large projects load in 4 MB chunks (fixes a crash on macOS with big audio sets)

## Auto-updates via GitHub Releases

The app checks this repository for new versions automatically:

- **On launch**, it checks silently a few seconds in. If there's an update it asks
  before doing anything; if not, it says nothing.
- **"Cue Sync" menu → "Check for Updates…"** checks on demand and always reports the
  result.

When it finds a newer version it downloads that release's `index.html` and swaps it
into the running app, then restarts. No reinstall, no `npm install`.

The repo it points at is set at the top of `updater.js`:

```js
const GITHUB_OWNER = 'aviadderi1';
const GITHUB_REPO  = 'cuesync';
```

### Publishing an update

1. Repo → **Releases** → **Draft a new release**.
2. Set the **tag** to the new version, e.g. `v1.1.1` — it must sort higher than the
   last one, the app compares these numerically.
3. Attach the updated **`index.html`** as a release asset. The filename must be
   exactly `index.html`.
4. Publish.

Anyone with the app installed gets the prompt on their next launch.

**Note:** this works because the repository is public — the updater uses GitHub's
public API and sends no token. Making the repo private would break auto-update
unless token support is added first.

### How version tracking works

The installed version lives in `version.txt` next to `index.html` inside the app, not
in `package.json`, because an auto-update only replaces `index.html`. It is created on
first run and rewritten after each successful update. Keep `version.txt` and
`package.json` in step when you cut a release.

## Updating by hand (without reinstalling)

The app ships with `asar: false`, so `index.html` sits as a plain file inside the
install. You can replace it directly at any time:

**Windows** — right-click the desktop shortcut → *Open file location*, then:
```
<install folder>\resources\app\index.html
```

**macOS** — Control-click **Cue Sync.app** in Applications → *Show Package Contents*:
```
Contents/Resources/app/index.html
```

Relaunch afterwards. A full reinstall is only needed when something outside
`index.html` changes — `main.js`, `updater.js`, `license.js`, the icons, or the
app name/version.

## Building installers

Requires **Node.js LTS** (https://nodejs.org). One-time per machine:

```
npm install
```

Then:

```
npm run dist:win    # Windows NSIS installer  → dist/
npm run dist:mac    # macOS zip (x64 + arm64) → dist/
```

`npm start` runs the app straight from source without building anything — the fastest
way to check a change.

### macOS: builds must be made on a Mac, and must be signed

Apple's tooling only runs on macOS, so a fresh `.app` cannot be cross-built from
Windows or Linux.

More importantly, **unsigned Apple Silicon (arm64) builds are hard-blocked** — macOS
reports them as damaged or as malware and may delete the download. An arm64 build has
to carry at least an ad-hoc signature:

```
codesign --force --deep --sign - "dist/mac-arm64/Cue Sync.app"
```

then re-zip the signed `.app`. Intel (x64) builds are more forgiving but should be
signed the same way. With only an ad-hoc signature Gatekeeper still shows an
"unidentified developer" warning on first open — Control-click the app → **Open** →
**Open**. That is needed once per machine.

## Licensing

The app is serial-locked per machine: `license.js` derives the expected serial from a
hardware ID using HMAC-SHA256. `installer.nsh` deletes `activation.dat` on install and
uninstall, so every fresh installation asks for a serial again.

### The secret is not in this repository

The key that makes a serial valid lives in **`license-secret.js`**, which is
gitignored. `license.js` requires it and refuses to load without it:

```
cp license-secret.example.js license-secret.js
```

then put the real secret in the copy. The project owner holds it — keep a backup
somewhere safe, because losing it makes every serial issued so far
unreproducible.

> **Scope of this protection.** The build runs with `asar: false`, so the secret
> still ships as readable text inside every installed copy of the app. Keeping it
> out of a public repo stops serials being minted from the source listing; it is
> not real DRM. If serial enforcement ever matters commercially, move validation
> to a server.

## Repository layout

| File | Purpose |
| --- | --- |
| `main.js` | Electron main process — windows, menus, IPC, project save/load, video output, timecode settings |
| `index.html` | The entire renderer — UI, audio engine, cue logic, Show/Edit modes |
| `preload.js` | Context bridge for the main window |
| `remote.js` | HTTP + WebSocket server for the phone remote |
| `updater.js` | GitHub Releases auto-update |
| `license.js` | Serial generation and validation |
| `preferences.html` | Preferences window (MIDI, Audio, RSO, General, Timecode, Video) |
| `splash.html`, `startup-chooser.html`, `about.html`, `keycommands.html`, `license-gate.html`, `remote-info.html`, `serial-generator.html` | Secondary windows, each with its own `-preload.js` |
| `installer.nsh` | NSIS hooks — clears activation on install/uninstall |
| `Cue_Sync_User_Manual.pdf` | Shipped manual, opened from Help → User Manual |
