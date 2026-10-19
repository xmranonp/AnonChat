'use strict';

// Checks that the pure-JS libloc reader agrees with the official `location` CLI on a set of IPs.
// Usage: node tools/verify-libloc.js [dbPath] [ip ...]

const { execFileSync } = require('child_process');
const fs = require('fs');
const { Libloc } = require('../lib/libloc');

const argIps = process.argv.slice(3);
const candidates = [
  process.argv[2],
  '/var/lib/location/database.db',
  '/usr/share/location/database.db',
  process.env.HOME && `${process.env.HOME}/.local/share/anonchat/geo/location.db`,
].filter(Boolean);
const dbPath = candidates.find(p => { try { return fs.statSync(p).size > 0; } catch { return false; } });
if (!dbPath) {
  console.error('No libloc database found. Looked in:\n  ' + candidates.join('\n  '));
  console.error('\nDownload it first, then re-run:');
  console.error('  sudo location update          # writes /var/lib/location/database.db');
  console.error('or pass a path:  node tools/verify-libloc.js /path/to/database.db');
  process.exit(2);
}
const ips = argIps.length ? argIps : [
  '1.1.1.1', '8.8.8.8', '9.9.9.9', '193.99.144.85', '5.9.0.0',
  '213.61.10.10', '185.220.101.1', '204.13.164.1', '139.130.4.5',
  '104.16.0.1', '151.101.0.1', '2a07:1c44:5800::1', '2606:4700::1111',
];

function countryIndex() {
  const idx = {};
  try {
    const out = execFileSync('location', ['list-countries', '--show-name'], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*([A-Za-z]{2})\b[\s:]+(.+?)\s*$/);
      if (m) idx[m[1].toUpperCase()] = m[2].trim();
    }
  } catch {}
  return idx;
}
function cliCountry(ip) {
  try {
    const out = execFileSync('location', ['lookup', ip], { encoding: 'utf8' });
    const line = out.split('\n').find(l => /^\s*Country\b/i.test(l));
    const m = line && line.match(/:\s*(.+?)\s*$/);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

const db = Libloc.open(dbPath);
const names = countryIndex();
console.log('DB: %s  (%d nodes, %d networks)\n', dbPath, db.nodeCount, db.networkCount);

let pass = 0, fail = 0;
for (const ip of ips) {
  const jsCode = db.lookup(ip);
  const jsName = jsCode ? (names[jsCode] || jsCode) : null;
  const cli    = cliCountry(ip);
  const ok = (cli == null && jsCode == null) ||
             (cli != null && (cli === jsCode || cli.toLowerCase() === (jsName || '').toLowerCase()));
  ok ? pass++ : fail++;
  console.log('  %s %-18s  js=%-4s (%s)   cli=%s',
    ok ? 'OK ' : 'XX ', ip, jsCode || '—', jsName || '—', cli || '—');
}
console.log('\n%s  %d/%d agree', fail === 0 ? '✅ PASS' : '❌ FAIL', pass, pass + fail);
process.exit(fail === 0 ? 0 : 1);
