// F-4: a stranger can't learn from the inbox's answers whether an address is one of our contacts, a group member, someone we blocked,
// a contact whose key isn't loaded yet, or nobody: every probe sequence gets the same answers. Against a real server.js (needs `npm install`).
// Run: node tools/inbox-oracle-test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const A = (c) => c.repeat(56) + '.anyone';
const ME = A('a'), CONTACT = A('c'), NOKEY = A('n'), BLOCKED = A('b'), MEMBER = A('m'), STRANGER = A('s');
const TOKEN = 'e'.repeat(64);
// A fresh backend for every probe, so rate limits and the flood guard start from the same state each time and only the address differs.
let port = 6230;
async function backend(requests) {
  const d = mkdtempSync(join(tmpdir(), 'oracle-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
  writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
  writeFileSync(join(d, 'data', 'contacts.json'), JSON.stringify([
    { address: CONTACT, petname: 'C', ecdhPub: 'IK-CONTACT', ratchetPub: 'R1' }, { address: NOKEY, petname: 'N', ecdhPub: 'IK-NOKEY', ratchetPub: 'R2' }]));
  writeFileSync(join(d, 'data', 'groups.json'), JSON.stringify([{ id: 'g1', name: 'G', members: [{ address: ME }, { address: MEMBER }] }]));
  const ports = { ui: ++port, pub: ++port };
  const srv = spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env,
    PUBLIC_PORT: String(ports.pub), UI_PORT: String(ports.ui), DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: '1', PEERS: '{}' } });
  const ui = (p, m = 'GET', body) => req(ports.ui, p, m, body, { 'X-AnonChat-Token': TOKEN, Host: '127.0.0.1:' + ports.ui });
  for (let i = 0; i < 60; i++) { try { if ((await ui('/api/whoami')).status === 200) break; } catch {} await sleep(250); }
  await ui('/api/mailbox-keys', 'POST', { replace: true, keys: [{ address: CONTACT, key: randomBytes(32).toString('base64') }, { address: MEMBER, key: randomBytes(32).toString('base64') }] });
  const blocked = (await ui('/api/blocked', 'POST', { address: BLOCKED })).status === 200;
  await ui('/api/settings', 'POST', { acceptRequests: requests });
  return { srv, blocked, inbox: (env) => req(ports.pub, '/api/inbox', 'POST', env, { Host: ME }) };
}
const req = (port, p, m = 'GET', body, headers = {}) => new Promise((res, rej) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port, path: p, method: m, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
    (resp) => { let b = ''; resp.on('data', (c) => b += c); resp.on('end', () => res({ status: resp.statusCode, body: b })); });
  r.on('error', rej); r.end(data);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + x + ']')); };

// The probe from the 1.0.2 audit: the same fake envelope twice, then a follow-up without x3dh twice; and a handshake with a foreign key.
async function probe(from, requests) {
  const { srv, blocked, inbox } = await backend(requests);
  if (!blocked) { srv.kill(); return 'setup failed'; }
  const ct = 'probe-' + randomBytes(8).toString('hex');
  const e1 = { from, ct, dh: 'dh', n: 0, pn: 0, x3dh: { ik: 'IK-ATTACKER', ek: 'EK' } };
  const e2 = { from, ct: ct + '-2', dh: 'dh', n: 1, pn: 0 };
  const out = [];
  for (const e of [e1, e1, e2, e2]) { const r = await inbox(e); out.push(r.status + ' ' + r.body); await sleep(80); }
  srv.kill();
  return out.join(' | ');
}
for (const requests of [true, false]) {
  const ans = {};
  for (const [name, addr] of [['contact', CONTACT], ['contact without key yet', NOKEY], ['group member', MEMBER], ['blocked', BLOCKED], ['stranger', STRANGER]]) ans[name] = await probe(addr, requests);
  const ref = ans.stranger;
  for (const [name, a] of Object.entries(ans)) if (name !== 'stranger') ok(`requests ${requests ? 'on' : 'off'}: ${name} answers exactly like a stranger`, a === ref, `${a}  vs  ${ref}`);
  ok(`requests ${requests ? 'on' : 'off'}: no 409 or 503 in any answer`, !/\b(409|503)\b/.test(Object.values(ans).join()) && !/setup failed/.test(Object.values(ans).join()), JSON.stringify(ans));
}
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
