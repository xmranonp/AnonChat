// Counts exit relays as seen by your own running anon.
// Usage: node tools/exit-count.mjs [--save file]   (--save also dumps anon's raw reply)
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
process.env.ANON_DIR  ||= path.join(base, 'anonchat', 'anon');
process.env.DATA_DIR  ||= path.join(base, 'anonchat', 'data');
if (!process.env.ANON_CTRL_PORT) {
  try {
    const rc = require('node:fs').readFileSync(path.join(process.env.ANON_DIR, 'anonrc'), 'utf8');
    const m = /^ControlPort\s+(\d+)/m.exec(rc); if (m) process.env.ANON_CTRL_PORT = m[1];
  } catch {}
}

const circuits = require('../lib/circuits.js');

const saveAt = process.argv.indexOf('--save') > 0 ? process.argv[process.argv.indexOf('--save') + 1] : null;
if (saveAt) {
  const fs = require('node:fs'); const net = require('node:net');
  const raw = await new Promise((resolve, reject) => {
    const cookie = fs.readFileSync(path.join(process.env.ANON_DIR, 'control_auth_cookie')).toString('hex');
    const s = net.connect(Number(process.env.ANON_CTRL_PORT || 9051), '127.0.0.1', () => s.write(`AUTHENTICATE ${cookie}\r\nGETINFO ns/all\r\nQUIT\r\n`));
    let d = ''; s.on('data', (c) => { d += c; }); s.on('end', () => resolve(d)); s.on('error', reject);
    setTimeout(() => { s.destroy(); reject(new Error('timeout')); }, 20000);
  }).catch((e) => { console.error('Could not read anon\'s reply: ' + e.message); process.exit(1); });
  fs.writeFileSync(saveAt, raw);
  console.log(`Saved anon's raw reply (${raw.length} bytes) to ${saveAt}. Count it yourself, with no AnonChat code involved:`);
  console.log(`  relays:             grep -c '^r ' ${saveAt}`);
  console.log(`  with the Exit flag: grep '^s ' ${saveAt} | grep -cw Exit`);
  console.log(`  usable exits:       grep '^s ' ${saveAt} | grep -w Exit | grep -w Running | grep -w Valid | grep -vcw BadExit\n`);
}
const ep = require('../lib/exitpolicy.js');

let lookup = () => null, haveDb = false;
try {
  const relaygeo = require('../lib/relaygeo.js');
  if (relaygeo.databaseReady()) { lookup = (ip) => relaygeo.lookupCountry(ip); haveDb = true; }
} catch {}

let routers;
try { routers = await circuits.getRouterList(); }
catch (e) { console.error('Could not read the relay list from anon: ' + e.message + '\n(Is AnonChat running and fully bootstrapped?)'); process.exit(1); }

// Same rules as the app: real countries only, never RU/RS, at least MIN_EXITS exits.
let isCountry = () => true;
try { const relaygeo = require('../lib/relaygeo.js'); isCountry = (cc) => !!relaygeo.centroidFor(cc); } catch {}
const offered = (cc) => !ep.EXCLUDED_COUNTRIES.has(cc) && isCountry(cc);
const d = ep.describeRelays(routers, lookup, offered, ep.MIN_EXITS);
console.log('Relays in anon\'s consensus:         ' + d.relays);
console.log('  with the Exit flag:               ' + d.exitFlag);
console.log('    BadExit:                        ' + d.badExit);
console.log('    not Running:                    ' + d.notRunning);
console.log('    not Valid:                      ' + d.notValid);
console.log('  usable exits (what the app counts): ' + d.usable);
if (haveDb) {
  const shown = ep.summarize(routers, lookup, { minExits: ep.MIN_EXITS, isCountry: offered });
  const hidden = ep.summarize(routers, lookup).filter((c) => !shown.some((x) => x.code === c.code));
  console.log('    in countries the app offers:    ' + d.inOffered + '  (' + shown.length + ' countries)');
  console.log('    in countries it does not offer: ' + d.inHidden);
  console.log('    with no country data:           ' + d.unknownCountry);
  console.log('\nOffered, most exits first: ' + shown.slice(0, 15).map((c) => c.code + ' ' + c.count).join(', '));
  if (hidden.length) console.log('Not offered: ' + hidden.map((c) => c.code + ' ' + c.count).join(', ') + '  (fewer than ' + ep.MIN_EXITS + ' exits, not a country, or RU/RS)');
} else {
  console.log('(no country database yet, so no per-country breakdown)');
}
