// Backend: group members who aren't contacts get their own inbox allowance, aren't affected by "requests off", and /api/peers only
// fetches keys for someone in one of our groups. Starts a real server.js (needs `npm install`).
// Run: node tools/group-allowance-test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import http from 'node:http';
const pubReq = (p, m, body) => new Promise((res, rej) => { const data = body ? JSON.stringify(body) : ''; const r = http.request({ host: '127.0.0.1', port: 6102, path: p, method: m, headers: { Host: ME, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (resp) => { let b = ''; resp.on('data', (c) => b += c); resp.on('end', () => res({ status: resp.statusCode, body: b ? JSON.parse(b) : null })); }); r.on('error', rej); r.end(data); });
const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SHIM = process.argv[3] || process.env.NODE_PATH || '';
const require = createRequire(join(APP, 'x.js'));
const pow = require(join(APP, 'lib/pow.js'));
const stamp = require(join(APP, 'lib/stamp.js'));
const K_MEMBER = require('crypto').randomBytes(32).toString('base64');
const ME = 'a'.repeat(56) + '.anyone', MEMBER = 'm'.repeat(56) + '.anyone', STRANGER = 's'.repeat(56) + '.anyone';
const d = mkdtempSync(join(tmpdir(), 'srvg-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
const TOKEN = 'f'.repeat(64);
const srv = spawn('node', [join(APP, 'server.js')], { cwd: APP, env: { ...process.env, ...(SHIM ? { NODE_PATH: SHIM } : {}), PUBLIC_PORT: '6102', UI_PORT: '6101', DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: '1', INBOX_BURST: '10000', INBOX_PER_MIN_IP: '100000', INBOX_PER_MIN_FROM: '100000', PEERS: '{}' }, stdio: 'ignore' });
// Until the server answers (a fixed wait was too short on a slower machine, a Windows VM say), at most 30 s.
for (let i = 0; i < 200; i++) { try { const r = await fetch('http://127.0.0.1:6101/api/version'); if (r.status) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
const ui = (p, m = 'GET', body) => fetch('http://127.0.0.1:6101' + p, { method: m, headers: { 'X-AnonChat-Token': TOKEN, 'Content-Type': 'application/json', Host: '127.0.0.1:6101' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
let n = 0;
async function drop(from) {
  const ct = 'ct' + (++n) + '-' + Math.random();
  const ch = (await pubReq('/api/pow-challenge', 'GET')).body;
  const nonce = pow.solve({ challenge: ch.challenge, from, ct, bits: ch.bits });
  const env = { id: 'id' + n + Math.random(), from, ct, dh: 'x', n: 0, pn: 0, pow: { c: ch.challenge, n: nonce } };
  if (from === MEMBER) env.stamp = stamp.make(K_MEMBER, env, from, ME);      // as the member's own app would
  return (await pubReq('/api/inbox', 'POST', env)).status;
}
const count = async (from) => (await ui('/api/messages')).body.filter((e) => e.from === from).length;
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + x + ']')); };
try {
  await ui('/api/groups', 'POST', { id: 'g1', name: 'G', adminAddr: ME, members: [{ address: ME, petname: 'me' }, { address: MEMBER, petname: 'M' }] });
  const p1 = await ui('/api/peers', 'POST', { address: STRANGER });
  ok('/api/peers refuses someone in none of our groups', p1.status === 403, p1.status);
  ok('a group member whose key we don\u2019t have yet is asked to retry (not trusted, not stored)', (await drop(MEMBER)) === 503 && (await count(MEMBER)) === 0);
  await ui('/api/mailbox-keys', 'POST', { replace: true, keys: [{ address: MEMBER, key: K_MEMBER }] });
  await ui('/api/settings', 'POST', { acceptRequests: false });
  await drop(MEMBER); await drop(STRANGER);
  ok('requests off: a group member still gets through', (await count(MEMBER)) === 1);
  ok('requests off: a stranger is dropped', (await count(STRANGER)) === 0);
  await ui('/api/settings', 'POST', { acceptRequests: true });
  for (let i = 0; i < 25; i++) await drop(STRANGER);
  ok('a stranger is capped at 20 waiting', (await count(STRANGER)) === 20, await count(STRANGER));
  for (let i = 0; i < 40; i++) await drop(MEMBER);
  ok('a group member is not held to the stranger cap', (await count(MEMBER)) === 41, await count(MEMBER));
} finally { srv.kill(); }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
