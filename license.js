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

// NOTE: this secret is embedded in the shipped app. Anyone with strong
// reverse-engineering skills and access to the installed app could
// theoretically extract it. This offline scheme is meant to stop casual
// copying/sharing between machines, not to be unbreakable DRM.
const LICENSE_SECRET = 'LuchySyncDeck-ADSoundLighting-v1-8f3a9c2e7b41';

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

// A stable per-machine fingerprint based on the first real network
// adapter's MAC address (doesn't change across reinstalls/OS updates on
// the same physical machine), combined with platform/arch for a little
// extra entropy. Falls back to hostname if no adapter is found (e.g. some
// virtual machines).
function getHardwareId() {
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

function licenseFilePath() {
  return path.join(require('electron').app.getPath('userData'), 'license.json');
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
