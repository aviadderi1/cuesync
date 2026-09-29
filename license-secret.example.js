// ---------------------------------------------------------------------
// Template for license-secret.js — the real file is NOT in this repo.
//
// To build the app you need a file named `license-secret.js` next to
// this one, exporting the project's licence key as a plain string:
//
//     cp license-secret.example.js license-secret.js
//
// then replace the placeholder below with the real secret. Without it
// the app refuses to start with a clear error rather than silently
// accepting or rejecting every serial.
//
// The real secret is held by the project owner. Never commit it — it is
// what makes a serial valid, so anyone holding it can mint serials for
// any machine.
// ---------------------------------------------------------------------

module.exports = 'REPLACE-WITH-REAL-SECRET';
