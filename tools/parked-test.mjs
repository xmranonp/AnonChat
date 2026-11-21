// Parked messages in the backend (1.0.11, lib/store.js park): kept apart from the others, not handed out with them, outside every inbox
// allowance, at most 2,000 per sender (the oldest go), 512 MB together, 7 days; kept across a restart. Then the two endpoints with the real
// backend (needs `npm install`). Run: node tools/parked-test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SHIM = process.argv[3] || process.env.NODE_PATH || '';
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + x + ']')); };
const A = 'a'.repeat(56) + '.anyone', B = 'b'.repeat(56) + '.anyone';

console.log('1. lib/store.js');
{
  const data = mkdtempSync(join(tmpdir(), 'parked-'));
  process.env.DATA_DIR = data; process.env.PARK_TOTAL_BYTES = String(2 * 1024 * 1024);
  const require = createRequire(import.meta.url);
  const load = () => { for (const k of Object.keys(require.cache)) if (k.includes('/lib/')) delete require.cache[k]; return require(join(APP, 'lib/store.js')); };
  let store = load();
  const t0 = Date.now() - 1000; let k = 0;
  const add = (from, size = 100, ts = t0 + (++k)) => store.addToInbox({ id: 'id' + k, from, dh: 'x', n: k, ct: 'A'.repeat(size), receivedAt: ts }, { force: true }).id;
  const a1 = add(A), a2 = add(A), b1 = add(B);
  ok('park: the id is parked', JSON.stringify(store.park([a2])) === JSON.stringify([a2]));
  ok('parked messages are not handed out with the others', store.getInbox().items.map((e) => e.id).join() === [a1, b1].join());
  ok('…they are listed for their sender, and who has any', store.getParked(A).items.map((e) => e.id).join() === a2 && JSON.stringify(store.getParked(null).senders) === JSON.stringify({ [A]: 1 }));
  ok('parking it again is fine; an unknown id is not parked', JSON.stringify(store.park([a2, 'nope'])) === JSON.stringify([a2]));
  const u = store.inboxUsage(new Set([A]), A);
  ok('a parked message counts against no allowance', u.fromCount === 1 && u.totalCount === 2, JSON.stringify(u));
  store = load();
  ok('kept across a restart (the file is renamed .parked)', store.getParked(A).items.length === 1 && store.getInbox().items.length === 2 && readdirSync(join(data, 'inbox')).filter((n) => n.endsWith('.parked')).length === 1);
  store.deleteFromInbox([a2]);
  ok('acked: gone', store.getParked(A).items.length === 0 && !readdirSync(join(data, 'inbox')).some((n) => n.endsWith('.parked')));
  const many = []; for (let i = 0; i < 2005; i++) many.push(add(B, 10));
  store.park(many);
  const pb = store.getParked(B).items.map((e) => e.id);
  ok('at most 2,000 from one sender: the oldest go', pb.length === 2000 && pb[0] === many[5] && pb.at(-1) === many[2004], `${pb.length} ${pb[0]}`);
  const old = add(A, 10, Date.now() - 8 * 86400000); store.park([old]);
  ok('…older than 7 days: dropped', store.getParked(A).items.length === 0);
  const big = add(A, 700 * 1024);          // the room is 2 MB here (512 MB in the app); what is parked already counts too
  const big2 = add(A, 700 * 1024), big3 = add(A, 700 * 1024);
  const got = store.park([big, big2, big3]);
  ok('a room of its own for all parked messages (512 MB): beyond it, not parked (the window tries it as before)', got.length === 2 && !got.includes(big3), JSON.stringify(got));
}

console.log('2. The backend endpoints');
{
  const ME = 'q'.repeat(56) + '.anyone', S = 's'.repeat(56) + '.anyone', TOKEN = 'f'.repeat(64);
  const d = mkdtempSync(join(tmpdir(), 'parkedsrv-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
  writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
  const srv = spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env, ...(SHIM ? { NODE_PATH: SHIM } : {}),
    PUBLIC_PORT: '6222', UI_PORT: '6221', DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: '1', PEERS: '{}' } });
  for (let i = 0; i < 200; i++) { try { const r = await fetch('http://127.0.0.1:6221/api/version'); if (r.status) break; } catch {} await new Promise((r) => setTimeout(r, 150)); }
  const post = (env) => new Promise((res, rej) => {
    const data = JSON.stringify(env);
    const r = http.request({ host: '127.0.0.1', port: 6222, path: '/api/inbox', method: 'POST', headers: { Host: ME, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (resp) => { resp.resume(); resp.on('end', () => res(resp.statusCode)); });
    r.on('error', rej); r.end(data);
  });
  const ui = (p, m = 'GET', body) => fetch('http://127.0.0.1:6221' + p, { method: m, headers: { 'X-AnonChat-Token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    for (let i = 0; i < 3; i++) await post({ from: S, ct: randomBytes(30).toString('base64'), dh: 'x', n: i, pn: 0 });
    const ids = (await (await ui('/api/messages')).json()).map((e) => e.id);
    const r = await (await ui('/api/messages/park', 'POST', { ids: [ids[1], 'unknown'] })).json();
    ok('POST /api/messages/park parks what exists', JSON.stringify(r.parked) === JSON.stringify([ids[1]]));
    ok('GET /api/messages leaves it out', (await (await ui('/api/messages')).json()).map((e) => e.id).join() === [ids[0], ids[2]].join());
    ok('GET /api/messages/parked?from= gives it', (await (await ui('/api/messages/parked?from=' + S)).json()).map((e) => e.id).join() === ids[1]);
    ok('GET /api/messages/parked says who has any', JSON.stringify((await (await ui('/api/messages/parked')).json()).senders) === JSON.stringify({ [S]: 1 }));
    ok('a bad address is refused', (await ui('/api/messages/parked?from=nope')).status === 400);
    ok('without the window\'s token: refused', (await fetch('http://127.0.0.1:6221/api/messages/parked')).status === 401 || (await fetch('http://127.0.0.1:6221/api/messages/parked')).status === 403);
    await ui('/api/messages/ack', 'POST', { ids: [ids[1]] });
    ok('acked: gone', (await (await ui('/api/messages/parked?from=' + S)).json()).length === 0);
  } finally { srv.kill(); }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
