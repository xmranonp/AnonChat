// Waking from sleep, with the real backend and a fake Anyone control port (needs `npm install`). The backend process is frozen for a
// few seconds (SIGSTOP, as in a sleep) and let go: it must notice, wait for the network as after a start (not ready for 10 s, then until a
// circuit works), then clear the network's memory (SIGNAL NEWNYM) once and go on. A short stall is not a sleep.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') { console.log('  (the backend is frozen with SIGSTOP, which Windows does not have: not run here)\n0 passed, 0 failed'); process.exit(0); }
const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SHIM = process.argv[3] || process.env.NODE_PATH || '';
const TOKEN = 'e'.repeat(64), ME = 'w'.repeat(56) + '.anyone';
const CTL = 6791, HTTP = 6792, UI = 6793, PUB = 6794;
const d = mkdtempSync(join(tmpdir(), 'wake-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + x + ']')); };
const fk = spawn('node', [join(APP, 'tools/fake-control-port.mjs'), String(CTL), String(HTTP), d + '/anon'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 500));
const fake = (p, body) => fetch(`http://127.0.0.1:${HTTP}${p}`, { method: 'POST', body: JSON.stringify(body || {}) }).then((r) => r.json());
const start = (extra = {}) => spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env, ...(SHIM ? { NODE_PATH: SHIM } : {}),
  PUBLIC_PORT: String(PUB), UI_PORT: String(UI), DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: String(CTL), PEERS: '{}',
  ANONCHAT_WAIT_NETWORK: '1', WAKE_GAP_MS: '5000', ...extra } });
let srv = start();
const ui = (p) => fetch(`http://127.0.0.1:${UI}${p}`, { headers: { 'X-AnonChat-Token': TOKEN } }).then((r) => r.json());
const net = async () => (await ui('/api/hs/health')).network;
const newnyms = async () => (await fake('/counts'))['SIGNAL NEWNYM'] || 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await f()) return true; } catch {} await wait(300); } return false; };
for (let i = 0; i < 200; i++) { try { const r = await fetch(`http://127.0.0.1:${UI}/api/version`); if (r.status) break; } catch {} await wait(150); }
try {
  ok('ready after the start (100%, a current relay list)', await until(async () => (await net()).ready === true, 15000), JSON.stringify(await net()));
  await wait(1500); const n0 = await newnyms();
  ok('the clear-out ran once on becoming ready', n0 === 1, String(n0));

  console.log('1. A short stall is not a sleep');
  srv.kill('SIGSTOP'); await wait(3500); srv.kill('SIGCONT'); await wait(4500);
  ok('a 3.5 s stall: still ready, no new clear-out', (await net()).ready === true && (await newnyms()) === n0, JSON.stringify(await net()));

  console.log('2. A sleep, the connection comes back at once');
  srv.kill('SIGSTOP'); await wait(9000); srv.kill('SIGCONT');
  ok('after the wake it is not ready (the hold)', await until(async () => { const n = await net(); return n.ready === false && n.reason === 'resumed'; }, 6000), JSON.stringify(await net()));
  ok('…and the clear-out has not run yet', (await newnyms()) === n0);
  ok('…then ready again, as "resumed"', await until(async () => { const n = await net(); return n.ready === true && n.reason === 'resumed'; }, 20000), JSON.stringify(await net()));
  await wait(1500); ok('…and the network’s memory was cleared once for the sleep', (await newnyms()) === n0 + 1, String(await newnyms()));
  { const logs = await ui('/api/logs'); const mine = logs.lines.filter((l) => l.includes('[AnonChat]')); ok('the Status log says the computer woke and the app waits for the network, once', mine.filter((l) => /woke from sleep/.test(l)).length === 1, JSON.stringify(mine.slice(-3))); }
  ok('…after asking whether a circuit works', ((await fake('/counts'))['GETINFO status/circuit-established'] || 0) > 0);

  console.log('3. A sleep, no circuit yet');
  const n1 = await newnyms(); await fake('/circuit', { up: false });
  srv.kill('SIGSTOP'); await wait(9000); srv.kill('SIGCONT');
  ok('not ready, and still not after the hold while no circuit works', await until(async () => (await net()).reason === 'resumed', 6000) && (await wait(13000), (await net()).ready === false && (await net()).reason === 'no-circuit'), JSON.stringify(await net()));
  ok('…no clear-out meanwhile', (await newnyms()) === n1);
  await fake('/circuit', { up: true });
  ok('a circuit works: ready again', await until(async () => (await net()).ready === true, 10000), JSON.stringify(await net()));
  await wait(1500); ok('…one clear-out', (await newnyms()) === n1 + 1, String(await newnyms()));
  console.log('5. The installed app (NODE_ENV=production) ignores the test setting for the wake gap');
  srv.kill(); await wait(1500); srv = start({ NODE_ENV: 'production' });
  for (let i = 0; i < 200; i++) { try { const r = await fetch(`http://127.0.0.1:${UI}/api/version`); if (r.status) break; } catch {} await wait(150); }
  ok('ready after the start', await until(async () => (await net()).ready === true, 15000), JSON.stringify(await net()));
  srv.kill('SIGSTOP'); await wait(9000); srv.kill('SIGCONT'); await wait(6000);
  { const logs = await ui('/api/logs'); ok('a 9 s stall is not a sleep there (the real threshold is 20 s): no wake, still ready', (await net()).ready === true && !logs.lines.some((l) => /woke from sleep/.test(l)), JSON.stringify(await net())); }
} finally { srv.kill('SIGCONT'); srv.kill(); fk.kill(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
