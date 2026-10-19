// Network status shown in the window (/api/whoami "network", /api/logs "bootstrap"), with a fake Anyone control port (needs `npm install`).
// The network's own answer counts; a query left unanswered doesn't turn a connected network into "connecting" for a minute; a real
// answer below 100 does at once; the bootstrap figure doesn't depend on the log. Also: the generated anonrc points to the country
// files that come with the anon binary.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SHIM = process.argv[3] || process.env.NODE_PATH || '';
const TOKEN = 'f'.repeat(64), ME = 'n'.repeat(56) + '.anyone';
const CTL = 6731, HTTP = 6732, UI = 6733, PUB = 6734;
const d = mkdtempSync(join(tmpdir(), 'net-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
writeFileSync(d + '/anon/anon.log', 'Oct 18 20:11:28.000 [notice] Bootstrapped 100% (done): Done\n' + 'Oct 18 20:12:00.000 [notice] something\n'.repeat(300));
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + x + ']')); };
const fk = spawn('node', [join(APP, 'tools/fake-control-port.mjs'), String(CTL), String(HTTP), d + '/anon'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const fake = (p, body) => fetch(`http://127.0.0.1:${HTTP}${p}`, { method: 'POST', body: JSON.stringify(body) });
const srv = spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env, ...(SHIM ? { NODE_PATH: SHIM } : {}),
  PUBLIC_PORT: String(PUB), UI_PORT: String(UI), DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: String(CTL), PEERS: '{}' } });
const ui = (p) => fetch(`http://127.0.0.1:${UI}${p}`, { headers: { 'X-AnonChat-Token': TOKEN } }).then((r) => r.json());
for (let i = 0; i < 200; i++) { try { const r = await fetch(`http://127.0.0.1:${UI}/api/version`); if (r.status) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  ok('the network answers 100%: ready', (await ui('/api/whoami')).network === 'ready');
  ok('the bootstrap figure comes from the network, not the log (its 100% line is long out of the last 200 lines)', (await ui('/api/logs')).bootstrap === 100);
  await fake('/bootstrap', { silent: true }); await wait(1700);
  const t0 = Date.now(); const w = await ui('/api/whoami');
  ok('the control port doesn’t answer in time: still ready (the last answer stands)', w.network === 'ready', w.network);
  ok('…and the window isn’t kept waiting', Date.now() - t0 < 2500, Date.now() - t0);
  ok('…the bootstrap figure stays 100', (await ui('/api/logs')).bootstrap === 100);
  await fake('/bootstrap', { silent: false, pct: 80 }); await wait(1700);
  ok('the network really reports less than 100: connecting at once', (await ui('/api/whoami')).network === 'connecting');
  ok('…and the figure says so', (await ui('/api/logs')).bootstrap === 80);
} finally { srv.kill(); fk.kill(); }
// anonrc: the country files next to the anon binary
{
  const bin = mkdtempSync(join(tmpdir(), 'bin-')); const anon = join(bin, process.platform === 'win32' ? 'anon.exe' : 'anon');
  writeFileSync(anon, ''); writeFileSync(join(bin, 'geoip'), ''); writeFileSync(join(bin, 'geoip6'), '');
  const src = readFileSync(join(APP, 'start.js'), 'utf8');
  const i = src.indexOf('  const geoLines = [];'), j = src.indexOf('  fs.writeFileSync(ANONRC', i);
  const lines = new Function('path', 'fs', 'ANON_BIN', src.slice(i, j) + '\nreturn geoLines;')(await import('node:path'), await import('node:fs'), anon);
  ok('anonrc names the geoip and geoip6 files that come with the anon binary', lines.length === 2 && lines[0] === 'GeoIPFile ' + join(bin, 'geoip') && lines[1] === 'GeoIPv6File ' + join(bin, 'geoip6'), JSON.stringify(lines));
  const none = new Function('path', 'fs', 'ANON_BIN', src.slice(i, j) + '\nreturn geoLines;')(await import('node:path'), await import('node:fs'), 'anon');
  ok('…and nothing when anon is found on the PATH (its own files are used)', none.length === 0);
}
{
  const src = readFileSync(join(APP, 'start.js'), 'utf8');
  ok('anonrc asks for connection padding always, route padding and distinct subnets', /^ConnectionPadding 1$/m.test(src) && /^CircuitPadding 1$/m.test(src) && /^EnforceDistinctSubnets 1$/m.test(src));
}
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
