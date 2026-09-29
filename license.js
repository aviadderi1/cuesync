// ---------------------------------------------------------------------
// Offline, machine-locked license system.
//
// How it works:
//  - Every machine has a stable "Hardware ID" derived from its network
//    adapter's MAC address (falls back to hostname if none is found).
//  - A valid Serial for a given machine is an HMAC-SHA256 of that Hardware
//    ID, keyed with a secret embedded in this file, truncated and
//    formatted for readability. This means a Serial generated for one
//    machine will NOT validate on any other machine.
//  - Everything is fully offline — no server, no internet connection
//    required, ever. The hidden Serial Generator tool (opened via
//    Ctrl+Alt+Shift+G) computes the same formula to mint new serials for
//    a customer's Hardware ID.
//  - The activated license (machine ID + serial) is stored in the app's
//    userData folder. It survives normal use/relaunches, but a fresh
//    reinstall (or a wiped userData folder) will require re-activation.
// ---------------------------------------------------------------------

const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

// The secret lives in license-secret.js, which is deliberately NOT in
// version control (see license-secret.example.js). It still ends up
// inside the shipped app, since the build runs with asar: false — this
// offline scheme is meant to stop casual copying between machines, not
// to be unbreakable DRM. Keeping it out of the public repo simply means
// serials cannot be minted straight from the source listing.
let LICENSE_SECRET;
try {
  LICENSE_SECRET = require('./license-secret');
} catch (err) {
  throw new Error(
    'license-secret.js is missing. Copy license-secret.example.js to ' +
    'license-secret.js and set the real secret before building or running. ' +
    '(' + err.message + ')'
  );
}
if (typeof LICENSE_SECRET !== 'string' || !LICENSE_SECRET || LICENSE_SECRET === 'REPLACE-WITH-REAL-SECRET') {
  throw new Error('license-secret.js still holds the placeholder value — set the real secret.');
}

function formatGroups(hex, groupSize) {
  const groups = [];
  for (let i = 0; i < hex.length; i += groupSize) {
    groups.push(hex.slice(i, i + groupSize));
  }
  return groups.join('-');
}

function normalize(str) {
  return (str || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// On macOS, reads the Hardware UUID — a permanent identifier tied to the
// physical logic board/chip, unaffected by network changes, reboots, or
// even OS reinstalls. Tries two independent system commands (in case one
// is unavailable or behaves unexpectedly on a given machine) and uses
// full explicit paths rather than relying on PATH resolution, since GUI
// -launched macOS apps (as opposed to Terminal-launched ones) sometimes
// get a more restricted PATH environment that can cause `execSync` calls
// to silently fail to find a command that works fine in a normal shell.
// Returns null only if BOTH methods fail, in which case the caller falls
// back to the network-MAC method (see getHardwareId below).
function getMacHardwareUUID() {
  const { execFileSync } = require('child_process');

  try {
    const output = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 4000 });
    const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (match && match[1]) {
      logHardwareIdDiagnostic('ioreg succeeded: ' + match[1]);
      return match[1];
    }
    logHardwareIdDiagnostic('ioreg ran but IOPlatformUUID not found in output');
  } catch (e) {
    logHardwareIdDiagnostic('ioreg failed: ' + (e && e.message ? e.message : String(e)));
  }

  // Fallback method: system_profiler's Hardware UUID field, independent
  // of ioreg — different underlying implementation, so a problem
  // affecting one is unlikely to affect both.
  try {
    const output = execFileSync('/usr/sbin/system_profiler', ['SPHardwareDataType'], { encoding: 'utf8', timeout: 4000 });
    const match = output.match(/Hardware UUID:\s*([0-9A-Fa-f-]+)/);
    if (match && match[1]) {
      logHardwareIdDiagnostic('system_profiler fallback succeeded: ' + match[1]);
      return match[1].trim();
    }
    logHardwareIdDiagnostic('system_profiler ran but Hardware UUID not found in output');
  } catch (e) {
    logHardwareIdDiagnostic('system_profiler fallback failed: ' + (e && e.message ? e.message : String(e)));
  }

  return null;
}

// Writes a small diagnostic trail to the userData folder so a genuinely
// unresolved machine-ID problem can actually be diagnosed after the fact,
// instead of silently falling back to the less-stable network-MAC method
// with no record of why. Never throws — a logging failure must never be
// allowed to affect activation itself.
function logHardwareIdDiagnostic(line) {
  try {
    const electron = require('electron');
    const logPath = path.join(electron.app.getPath('userData'), 'hardware-id-diagnostic.log');
    const stamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${stamp}] ${line}\n`, 'utf8');
  } catch (e) {
    // Best-effort only.
  }
}

// A stable per-machine fingerprint based on the first real network
// adapter's MAC address (doesn't change across reinstalls/OS updates on
// the same physical machine), combined with platform/arch for a little
// extra entropy. Falls back to hostname if no adapter is found (e.g. some
// virtual machines).
//
// On macOS specifically, network MAC addresses are NOT reliably stable:
// Apple's Private Wi-Fi Address feature can rotate the connected Wi-Fi
// adapter's MAC, and ephemeral interfaces (utun* VPN tunnels, awdl0 for
// AirDrop, etc.) can appear/disappear or shift the "first" interface found
// between launches — this previously caused the app to see a "new machine"
// on every single launch on some Macs. To avoid this, macOS uses the
// Hardware UUID instead, which has none of these problems.
function getHardwareId() {
  if (os.platform() === 'darwin') {
    const macUUID = getMacHardwareUUID();
    if (macUUID) {
      const normalizedUUID = macUUID.trim().toUpperCase();
      const hash = crypto.createHash('sha256').update(normalizedUUID + '|darwin').digest('hex').toUpperCase();
      return formatGroups(hash.slice(0, 16), 4);
    }
    logHardwareIdDiagnostic('Both ioreg and system_profiler failed — falling back to network-MAC method (less stable on macOS)');
  }
  const interfaces = os.networkInterfaces();
  let mac = null;
  const names = Object.keys(interfaces).sort(); // stable ordering
  for (const name of names) {
    for (const iface of interfaces[name] || []) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        mac = iface.mac;
        break;
      }
    }
    if (mac) break;
  }
  const raw = (mac || os.hostname()) + '|' + os.platform() + '|' + os.arch();
  const hash = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  return formatGroups(hash.slice(0, 16), 4); // e.g. "A1B2-C3D4-E5F6-0718"
}

// Deterministically computes the one valid Serial for a given Hardware ID.
function computeSerialForMachine(machineId) {
  const cleanId = normalize(machineId);
  const hmac = crypto.createHmac('sha256', LICENSE_SECRET).update(cleanId).digest('hex').toUpperCase();
  return 'LSD-' + formatGroups(hmac.slice(0, 20), 4); // e.g. "LSD-1F2A-9B71-EE03-4C88-A012"
}

function validateSerial(machineId, enteredSerial) {
  if (!enteredSerial) return false;
  const expected = computeSerialForMachine(machineId);
  return normalize(expected) === normalize(enteredSerial);
}

// The activation record lives inside the installation folder, NOT in
// userData. userData survives uninstalling, which is why the app used to
// stay activated across reinstalls; keeping the record beside the executable
// means a fresh install starts unactivated and must be activated again.
function licenseFilePath() {
  const electron = require('electron');
  try {
    const installDir = path.dirname(electron.app.getPath('exe'));
    // Confirm we can actually write there before committing to it — some
    // machines put the app somewhere locked down, and silently failing to
    // save would leave the user re-activating on every launch.
    fs.accessSync(installDir, fs.constants.W_OK);
    return path.join(installDir, 'activation.dat');
  } catch (err) {
    return path.join(electron.app.getPath('userData'), 'license.json');
  }
}

// Returns true if a valid, activated license for THIS machine already
// exists on disk.
function hasValidLicense() {
  try {
    const data = JSON.parse(fs.readFileSync(licenseFilePath(), 'utf8'));
    const currentId = getHardwareId();
    if (data.machineId !== currentId) return false; // license was for a different machine
    return validateSerial(currentId, data.serial);
  } catch (err) {
    return false;
  }
}

function saveLicense(machineId, serial) {
  fs.writeFileSync(licenseFilePath(), JSON.stringify({ machineId, serial, activatedAt: new Date().toISOString() }), 'utf8');
}

module.exports = {
  getHardwareId,
  computeSerialForMachine,
  validateSerial,
  hasValidLicense,
  saveLicense
};
