// Backend inbox limits: proof of work only during a flood, X-Forwarded-For ignored, contacts unaffected by a stranger flood, strangers'
// messages kept small, and a full inbox asks senders to retry instead of dropping what is waiting. Starts a real server.js with the
// default rate limits (needs `npm install`). Run: node tools/inbox-limits-test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SHIM = process.argv[3] || process.env.NODE_PATH || '';
const ME = 'a'.repeat(56) + '.anyone', FRIEND = 'f'.repeat(56) + '.anyone';
const stamp = createRequire(import.meta.url)(join(APP, 'lib/stamp.js'));
const K_FRIEND = randomBytes(32).toString('base64');
const A32 = 'abcdefghijklmnopqrstuvwxyz234567';
const addr = (i) => { let s = ''; let x = i + 1000; for (let k = 0; k < 56; k++) { s += A32[x % 32]; x = Math.floor(x / 32) + k * 7 + i; } return s + '.anyone'; };

const d = mkdtempSync(join(tmpdir(), 'lim-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
// The contact is written straight into the store: adding one through the app would fetch its keys over the Anyone network, which a test
// machine may not have.
writeFileSync(join(d, 'data', 'contacts.json'), JSON.stringify([{ address: FRIEND, petname: 'Friend', ecdhPub: 'K1', ratchetPub: 'R1' }]));
const TOKEN = 'f'.repeat(64);
const srv = spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env, ...(SHIM ? { NODE_PATH: SHIM } : {}),
  PUBLIC_PORT: '6202', UI_PORT: '6201', DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: '1', PEERS: '{}', MAX_INBOX: '40' } });
// Until the server answers (a fixed wait was too short on a slower machine, a Windows VM say), at most 30 s.
for (let i = 0; i < 200; i++) { try { const r = await fetch('http://127.0.0.1:6201/api/version'); if (r.status) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }

const pubPost = (env, extra = {}) => new Promise((res, rej) => {
  const data = JSON.stringify(env);
  const r = http.request({ host: '127.0.0.1', port: 6202, path: '/api/inbox', method: 'POST', headers: { Host: ME, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...extra } },
    (resp) => { let b = ''; resp.on('data', (c) => b += c); resp.on('end', () => res(resp.statusCode)); });
  r.on('error', rej); r.end(data);
});
const ui = (p, m = 'GET', body) => fetch('http://127.0.0.1:6201' + p, { method: m, headers: { 'X-AnonChat-Token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
let n = 0;
const env = (from, ct) => {
  const e = { id: 'x', from, ct: ct || ('ct-' + (++n) + '-' + Math.random()), dh: 'x', n: 0, pn: 0 };
  if (from === FRIEND) e.stamp = stamp.make(K_FRIEND, e, from, ME);       // the contact's own app stamps its messages
  return e;
};
const waiting = async (from) => (await ui('/api/messages')).body.filter((e) => e.from === from).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + x + ']')); };
try {
  await ui('/api/mailbox-keys', 'POST', { replace: true, keys: [{ address: FRIEND, key: K_FRIEND }] });
  const s0 = addr(0);
  ok('quiet: a stranger’s message gets in without proof of work', (await pubPost(env(s0))) === 200 && (await waiting(s0)) === 1);
  ok('a stranger’s oversized message (600 KB) is not kept', (await pubPost(env(addr(1), 'x'.repeat(600 * 1024)))) === 200 && (await waiting(addr(1))) === 0);

  // Ten a second is the shared burst for non-contacts; a new X-Forwarded-For on every message must not open a new allowance.
  const codes = [];
  for (let i = 0; i < 14; i++) codes.push(await pubPost(env(addr(10 + i)), { 'X-Forwarded-For': `10.0.0.${i}` }));
  ok('X-Forwarded-For is ignored: the shared burst limit still applies', codes.includes(429), codes.join(','));
  await sleep(1100);

  // Push past ~30 non-contact messages in a minute: that's a flood, and proof of work is now asked for.
  let sent = 0;
  while (sent < 26) { for (let k = 0; k < 9 && sent < 26; k++, sent++) await pubPost(env(addr(100 + sent))); await sleep(1050); }
  const s402 = await pubPost(env(addr(500)));
  ok('during a flood, a stranger must solve proof of work (402)', s402 === 402, s402);

  // A contact during that flood: no proof of work, not slowed down.
  const fc = await pubPost(env(FRIEND));
  ok('a contact still gets straight through during the flood', fc === 200 && (await waiting(FRIEND)) === 1, fc);

  // A full inbox (40 here) asks everyone to retry later; nothing already waiting is removed.
  const before = (await ui('/api/messages')).body.length;
  let codesFull = [];
  for (let i = 0; i < 70 && codesFull.filter((c) => c === 503).length < 1; i++) { codesFull.push(await pubPost(env(FRIEND))); if (i % 8 === 7) await sleep(1050); }
  const after = (await ui('/api/messages')).body;
  ok('a full inbox answers “retry later” (503) to a contact', codesFull.includes(503), codesFull.join(','));
  ok('…and keeps everything already waiting', after.length >= before && after.length <= 40, `${before} -> ${after.length}`);
} finally { srv.kill(); }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
