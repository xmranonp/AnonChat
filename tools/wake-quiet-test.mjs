// After a wake from sleep, nothing goes out until the network is ready again (needs `npm install`): the real backend, a fake Anyone
// control port, a fake SOCKS port that counts every lookup of an .anyone address, one contact. The backend is frozen (SIGSTOP, as in a sleep) while a
// presence re-check is due; when let go it must not try that contact (or anyone) while it waits for a working circuit, and must not mark
// them offline for it; once a circuit works, checks go out again.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
if (process.platform === 'win32') { console.log('  (the backend is frozen with SIGSTOP, which Windows does not have: not run here)\n0 passed, 0 failed'); process.exit(0); }
const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SHIM = process.argv[3] || process.env.NODE_PATH || '';
const TOKEN = 'b'.repeat(64), ME = 'q'.repeat(56) + '.anyone', FRIEND = 'f'.repeat(56) + '.anyone';
const CTL = 6811, HTTP = 6812, UI = 6813, PUB = 6814;
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + String(x).slice(0, 300) + ']')); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let connects = 0, friendTries = 0;          // connections to .anyone addresses (lookups), and to the contact; other downloads (country data) are not counted
const socks = net.createServer((c) => {
  let step = 0, buf = Buffer.alloc(0);
  c.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (step === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) { buf = buf.subarray(2 + buf[1]); c.write(Buffer.from([5, 0])); step = 1; }
    if (step === 1 && buf.length >= 5 && buf[3] === 3 && buf.length >= 7 + buf[4]) { step = 2; const host = buf.subarray(5, 5 + buf[4]).toString(); if (host.endsWith('.anyone')) connects++; if (host === FRIEND) friendTries++; c.end(Buffer.from([5, 0xF0, 0, 1, 0, 0, 0, 0, 0, 0])); }   // never found
  });
  c.on('error', () => {});
});
await new Promise((r) => socks.listen(0, '127.0.0.1', r));
const d = mkdtempSync(join(tmpdir(), 'wakeq-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
writeFileSync(join(d, 'data', 'contacts.json'), JSON.stringify([{ address: FRIEND, petname: 'Friend', ecdhPub: 'K1', ratchetPub: 'R1' }]));
const fk = spawn('node', [join(APP, 'tools/fake-control-port.mjs'), String(CTL), String(HTTP), d + '/anon'], { stdio: 'ignore' });
await wait(500);
const fake = (p, body) => fetch(`http://127.0.0.1:${HTTP}${p}`, { method: 'POST', body: JSON.stringify(body || {}) }).then((r) => r.json());
const srv = spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env, ...(SHIM ? { NODE_PATH: SHIM } : {}),
  PUBLIC_PORT: String(PUB), UI_PORT: String(UI), DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: String(CTL), PEERS: '{}',
  SOCKS: `socks5h://127.0.0.1:${socks.address().port}`, ANONCHAT_WAIT_NETWORK: '1', WAKE_GAP_MS: '5000',
  PRESENCE_FIRST_MS: '1000', PRESENCE_INTERVAL_MS: '60000', PRESENCE_RECHECK_MS: '6000', PRESENCE_STAGGER_MS: '100' } });
const ui = (p) => fetch(`http://127.0.0.1:${UI}${p}`, { headers: { 'X-AnonChat-Token': TOKEN } }).then((r) => r.json());
const until = async (f, ms) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await f()) return true; } catch {} await wait(200); } return false; };
for (let i = 0; i < 200; i++) { try { const r = await fetch(`http://127.0.0.1:${UI}/api/version`); if (r.status) break; } catch {} await wait(150); }
try {
  await fake('/state', { published: true });
  ok('the first presence check of the contact goes out (and fails: the contact is away)', await until(() => friendTries >= 1, 20000), String(friendTries));
  // a re-check is now due in 6 s; the computer sleeps through it, and no circuit works yet when it wakes
  await fake('/circuit', { up: false });
  srv.kill('SIGSTOP'); await wait(9000); const c0 = connects, f0 = friendTries; srv.kill('SIGCONT');
  await wait(8000);
  ok('after the wake, while the network is not ready: no .anyone address is looked up (not the re-check that was due, nor anything else)', connects === c0, `${connects - c0} lookup(s)`);
  const friend = (await ui('/api/contacts')).find((c) => c.address === FRIEND);
  ok('…and the contact is not marked offline for it', friend && friend.online !== false, JSON.stringify(friend));
  await fake('/circuit', { up: true });
  ok('a circuit works again: the contact is checked again', await until(() => friendTries > f0, 25000), String(friendTries - f0));
} finally { srv.kill('SIGCONT'); srv.kill(); fk.kill(); socks.close(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
