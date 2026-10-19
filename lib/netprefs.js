'use strict';

// Network preferences (exit country, dynamic port) in <DATA_DIR>/network.json. Plain JSON: start.js reads it early and it holds nothing secret.

const fs = require('fs');
const path = require('path');

const DEFAULTS = Object.freeze({ exitCountry: null, dynamicPort: true });
const file = (dataDir) => path.join(dataDir, 'network.json');

function sanitize(p) {
  const o = (p && typeof p === 'object') ? p : {};
  const cc = typeof o.exitCountry === 'string' ? o.exitCountry.toUpperCase() : null;
  return {
    exitCountry: cc && /^[A-Z]{2}$/.test(cc) ? cc : DEFAULTS.exitCountry,
    dynamicPort: typeof o.dynamicPort === 'boolean' ? o.dynamicPort : DEFAULTS.dynamicPort,
  };
}

function load(dataDir) {
  try { return sanitize(JSON.parse(fs.readFileSync(file(dataDir), 'utf8'))); }
  catch { return { ...DEFAULTS }; }
}

function save(dataDir, prefs) {
  const clean = sanitize(prefs);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tmp = file(dataDir) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file(dataDir));
  return clean;
}

module.exports = { sanitize, load, save };
