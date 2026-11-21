// Copies of a message (1.0.11): lib/dupes.js remembers (sender, ciphertext) for 9 days in sealed daily files, and the backend stores a
// copy that arrives after a restart only once. Non-canonical base64 is refused. Needs `npm install` for the backend part.
// Run: node tools/dupes-test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SHIM = process.argv[3] || process.env.NODE_PATH || '';
const require = createRequire(import.meta.url);
const { create } = require(join(APP, 'lib/dupes.js'));
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + x + ']')); };
const DAY = 86400000;

console.log('1. lib/dupes.js');
{
  const dir = mkdtempSync(join(tmpdir(), 'dupes-')); const clock = { t: Date.parse('2026-11-20T10:00:00Z') };
  const seal = (b, aad) => Buffer.concat([Buffer.from('S:' + aad + ':'), b]), open = (b, aad) => { const p = 'S:' + aad + ':'; if (!b.subarray(0, p.length).equals(Buffer.from(p))) throw new Error('not sealed'); return b.subarray(p.length); };
  let d = create({ dir, seal, open, now: () => clock.t, flushMs: 10 });
  ok('a new message is not a copy', d.add('A', 'ct1') === false && d.has('A', 'ct1'));
  ok('the same ciphertext again from the same sender is a copy', d.add('A', 'ct1') === true);
  ok('the same ciphertext from another sender is not', d.add('B', 'ct1') === false);
  d.flush();
  const files = readdirSync(dir);
  ok('one sealed file per day', files.length === 1 && files[0] === '2026-11-20' && readFileSync(join(dir, files[0])).subarray(0, 8).toString() === 'S:dupes:', files.join(','));
  ok('…holding hashes, not the ciphertext or the sender', !readFileSync(join(dir, files[0])).toString().includes('ct1') && !readFileSync(join(dir, files[0])).toString().includes('"A"'));
  d = create({ dir, seal, open, now: () => clock.t });
  ok('after a restart the copy is still recognised', d.has('A', 'ct1') && d.add('A', 'ct1') === true);
  clock.t += 8 * DAY; d.add('C', 'ct2'); d.flush();
  ok('8 days later: still recognised', d.has('A', 'ct1'));
  clock.t += 1 * DAY; d.add('C', 'ct3'); d.flush();
  ok('after 9 days it is forgotten, and its file is gone', !d.has('A', 'ct1') && !readdirSync(dir).includes('2026-11-20'), readdirSync(dir).join(','));
  writeFileSync(join(dir, '2026-11-29'), 'damaged');
  d = create({ dir, seal, open, now: () => clock.t });
  ok('a damaged day file is set aside, not fatal', d.has('C', 'ct3') === true || d.has('C', 'ct3') === false);
  ok('…renamed .damaged', readdirSync(dir).some((n) => n.endsWith('.damaged')), readdirSync(dir).join(','));
  const capped = create({ dir: mkdtempSync(join(tmpdir(), 'dupes-')), now: () => clock.t, maxPerDay: 3 });
  for (let i = 0; i < 10; i++) capped.add('F', 'x' + i);
  ok('a day keeps at most its cap (a flood is held by the inbox limits instead)', capped.size() === 3);
  const noKey = create({ dir, open: () => { throw Object.assign(new Error('no key'), { code: 'NO_KEY' }); }, now: () => clock.t });
  noKey.has('A', 'x');
  ok('before the data key is given nothing is read or set aside', !readdirSync(dir).some((n) => n.startsWith('2026-12-')) && readdirSync(dir).filter((n) => n.endsWith('.damaged')).length === 1);
}

console.log('2. The backend: a copy after a restart is not stored again');
{
  const ME = 'a'.repeat(56) + '.anyone', S = 's'.repeat(56) + '.anyone', T = 't'.repeat(56) + '.anyone', TOKEN = 'f'.repeat(64);
  const d = mkdtempSync(join(tmpdir(), 'dupesrv-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
  writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
  const start = () => spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env, ...(SHIM ? { NODE_PATH: SHIM } : {}),
    PUBLIC_PORT: '6212', UI_PORT: '6211', DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: '1', PEERS: '{}' } });
  const up = async () => { for (let i = 0; i < 200; i++) { try { const r = await fetch('http://127.0.0.1:6211/api/version'); if (r.status) return; } catch {} await new Promise((r) => setTimeout(r, 150)); } };
  const post = (env) => new Promise((res, rej) => {
    const data = JSON.stringify(env);
    const r = http.request({ host: '127.0.0.1', port: 6212, path: '/api/inbox', method: 'POST', headers: { Host: ME, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (resp) => { resp.resume(); resp.on('end', () => res(resp.statusCode)); });
    r.on('error', rej); r.end(data);
  });
  const ui = (p, m = 'GET', body) => fetch('http://127.0.0.1:6211' + p, { method: m, headers: { 'X-AnonChat-Token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
  const ct = randomBytes(48).toString('base64');
  let srv = start(); await up();
  try {
    ok('a message is stored', (await post({ from: S, ct, dh: 'x', n: 0, pn: 0 })) === 200 && (await ui('/api/messages')).length === 1);
    const ids = (await ui('/api/messages')).map((e) => e.id); await ui('/api/messages/ack', 'POST', { ids });
    ok('the same message again: answered as usual, not stored', (await post({ from: S, ct, dh: 'x', n: 0, pn: 0 })) === 200 && (await ui('/api/messages')).length === 0);
    srv.kill(); await new Promise((r) => setTimeout(r, 800)); srv = start(); await up();
    ok('after a restart, the same message again: not stored', (await post({ from: S, ct, dh: 'x', n: 0, pn: 0 })) === 200 && (await ui('/api/messages')).length === 0);
    ok('the same ciphertext claimed by another sender is a message of its own', (await post({ from: T, ct, dh: 'x', n: 0, pn: 0 })) === 200 && (await ui('/api/messages')).length === 1);
    const ct2 = randomBytes(10).toString('base64');          // ends in "=", padding needed
    ok('non-canonical base64 (padding left out) is refused as malformed', (await post({ from: S, ct: ct2.replace(/=+$/, ''), dh: 'x', n: 0, pn: 0 })) === 400);
    ok('…and so is base64url', (await post({ from: S, ct: randomBytes(30).toString('base64url') + '-_', dh: 'x', n: 0, pn: 0 })) === 400);
    ok('…and other characters', (await post({ from: S, ct: 'not base64!', dh: 'x', n: 0, pn: 0 })) === 400);
  } finally { srv.kill(); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
