// 1.0.9 (and 1.0.10), with the real backend, a fake Anyone control port and a fake SOCKS proxy (needs `npm install`):
//   1. a try that began before a sleep and fails after it: not counted against the contact, no descriptor fetch (it would be remembered
//      by the network for 15 minutes), no second try while the network isn't ready (the 1.0.8 audit's server-level gate);
//   2. call signalling while the network isn't ready after a wake: an answer at once ("network_not_ready"), no lookup;
//   3. removing a contact takes their queued messages out of the queue;
//   4. a contact that answers busy is reachable: nothing is asked of the network (1.0.10); then, failing, it gets no clear-out (NEWNYM)
//      until a fetch of its address details made during the failures has had time to help.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') { console.log('  (the backend is frozen with SIGSTOP, which Windows does not have: not run here)\n0 passed, 0 failed'); process.exit(0); }
const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SHIM = process.argv[3] || process.env.NODE_PATH || '';
const TOKEN = 'f'.repeat(64), ME = 'v'.repeat(56) + '.anyone';
const X = 'x'.repeat(56) + '.anyone', Y = 'y'.repeat(56) + '.anyone', Z = 'z'.repeat(56) + '.anyone';
const CTL = 6821, HTTP = 6822, UI = 6823, PUB = 6824, SOCKS = 6825;
const d = mkdtempSync(join(tmpdir(), 'afterwake-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + x + ']')); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await f()) return true; } catch {} await wait(300); } return false; };

// A SOCKS5 proxy that never reaches anything: each CONNECT is answered "host unreachable" after `hold` ms.
const busy = new Set();          // addresses that answer "503 busy, Retry-After 1" instead of being unreachable
const fine = new Set([ME]);      // addresses that answer 200: our own (the self-test looks it up, and would clear the network's memory when it fails)
let hold = 0, connects = 0; const hosts = {}; const seen = []; const to = (a) => hosts[a] || 0;          // connections per address asked for
const socks = net.createServer((c) => {
  let stage = 0, buf = Buffer.alloc(0); c.on('error', () => {});
  c.on('data', (x) => {
    buf = Buffer.concat([buf, x]);
    if (stage === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) { const m = buf.subarray(2, 2 + buf[1]).includes(2) ? 2 : 0; c.write(Buffer.from([5, m])); buf = buf.subarray(2 + buf[1]); stage = m === 2 ? 1 : 2; }
    if (stage === 1 && buf.length >= 2) { const ul = buf[1]; if (buf.length >= 3 + ul && buf.length >= 3 + ul + buf[2 + ul]) { buf = buf.subarray(3 + ul + buf[2 + ul]); c.write(Buffer.from([1, 0])); stage = 2; } }
    if (stage === 2 && buf.length >= 5 && buf.length >= 7 + buf[4]) { stage = 3; connects++; const h = buf.subarray(5, 5 + buf[4]).toString(); hosts[h] = (hosts[h] || 0) + 1; seen.push(Date.now() + ' ' + h.slice(0, 6));
      if (busy.has(h) || fine.has(h)) { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); stage = fine.has(h) ? 6 : 4; return; }
      setTimeout(() => { try { c.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); } catch {} }, hold); }
    if (stage === 6 && buf.includes('\r\n\r\n')) { stage = 7; const body = '{}'; c.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`); }
    if (stage === 4 && buf.length > 0 && buf.includes('\r\n\r\n')) { stage = 5; const body = '{"error":"busy"}'; c.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nRetry-After: 1\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`); }
  });
}).listen(SOCKS, '127.0.0.1');

const fk = spawn('node', [join(APP, 'tools/fake-control-port.mjs'), String(CTL), String(HTTP), d + '/anon'], { stdio: 'ignore' });
await wait(500);
const fake = (p, body) => fetch(`http://127.0.0.1:${HTTP}${p}`, { method: 'POST', body: JSON.stringify(body || {}) }).then((r) => r.json());
const newnyms = async () => (await fake('/counts'))['SIGNAL NEWNYM'] || 0;
const hsfetchesOf = async (a) => Object.entries(await fake('/counts')).filter(([k]) => k.startsWith('HSFETCH ' + a.slice(0, 20))).reduce((n, [, v]) => n + v, 0);
const hsfetches = async () => Object.entries(await fake('/counts')).filter(([k]) => k.startsWith('HSFETCH')).reduce((n, [, v]) => n + v, 0);
const startSrv = (extra = {}) => spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env, ...(SHIM ? { NODE_PATH: SHIM } : {}),
  PUBLIC_PORT: String(PUB), UI_PORT: String(UI), DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: String(CTL), PEERS: '{}',
  SOCKS: `socks5h://127.0.0.1:${SOCKS}`, ANONCHAT_WAIT_NETWORK: '1', WAKE_GAP_MS: '5000', HSFETCH_EVERY_MS: '1000', ...extra } });
let srv = startSrv();
const ui = (p, method = 'GET', body) => fetch(`http://127.0.0.1:${UI}${p}`, { method, headers: { 'X-AnonChat-Token': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
const net_ = async () => (await (await ui('/api/hs/health')).json()).network;
const queuedFor = async (a) => (await (await ui('/api/outbox')).json()).items.filter((i) => i.toAddress === a).length;
const env = { ct: 'Y3Q', dh: 'ZGg' };
for (let i = 0; i < 200; i++) { try { const r = await fetch(`http://127.0.0.1:${UI}/api/version`); if (r.status) break; } catch {} await wait(150); }
try {
  ok('ready after the start', await until(async () => (await net_()).ready === true, 15000), JSON.stringify(await net_()));
  await wait(1500);

  console.log('1. A try that began before a sleep and fails after it');
  hold = 6000; const c0 = to(X), h0 = await hsfetches();
  const sending = ui('/api/send', 'POST', { toAddress: X, envelope: env, offlineTtl: 3600 }).then((r) => r.json()).catch(() => null);
  await until(async () => to(X) > c0, 3000);                     // the first try is under way (its connection waits 6 s for an answer)
  srv.kill('SIGSTOP'); await wait(9000); srv.kill('SIGCONT');       // a sleep, during which the try fails
  await wait(3000);                                                 // inside the 10 s hold after the wake
  ok('after the wake: not ready (the hold)', (await net_()).ready === false, JSON.stringify(await net_()));
  ok('…the try that failed during the sleep fetched nothing (no HSFETCH: it says nothing about the contact)', (await hsfetches()) === h0, `${await hsfetches()} (was ${h0})`);
  ok('…and no second try went out while the network is not ready', to(X) === c0 + 1, `${to(X) - c0} tries to them; all: ${seen.slice(-6).join(', ')}`);
  ok('…the message is kept in the queue', (await sending) !== null && (await queuedFor(X)) === 1, String(await queuedFor(X)));
  hold = 0;

  console.log('2. Call signalling while the network is not ready after a wake');
  ok('ready again first', await until(async () => (await net_()).ready === true, 30000), JSON.stringify(await net_()));
  srv.kill('SIGSTOP'); await wait(9000); srv.kill('SIGCONT'); await wait(1500);
  const c1 = to(Z), t0 = Date.now();
  const r = await ui('/api/send', 'POST', { toAddress: Z, envelope: env, ephemeral: true }); const j = await r.json().catch(() => ({}));
  ok('a call signal right after a wake: answered at once with "network_not_ready" (503)', r.status === 503 && j.error === 'network_not_ready' && Date.now() - t0 < 2000, `${r.status} ${JSON.stringify(j)} ${Date.now() - t0} ms`);
  ok('…without a lookup', to(Z) === c1, `${to(Z) - c1}`);

  console.log('3. Removing a contact takes their queued messages out of the queue');
  ok('ready again', await until(async () => (await net_()).ready === true, 30000), JSON.stringify(await net_()));
  await ui('/api/send', 'POST', { toAddress: Y, envelope: env, offlineTtl: 3600 });
  await ui('/api/send', 'POST', { toAddress: Y, envelope: env, offlineTtl: 3600, queueOnly: true });
  ok('two messages to them are waiting', await until(async () => (await queuedFor(Y)) === 2, 5000), String(await queuedFor(Y)));
  const rr = await (await ui('/api/contacts', 'DELETE', { address: Y })).json();
  ok('removing them answers how many went', rr.ok === true && rr.dropped === 2, JSON.stringify(rr));
  ok('…and none is left in the queue', (await queuedFor(Y)) === 0, String(await queuedFor(Y)));
  ok('…messages to others are untouched', (await queuedFor(X)) === 1, String(await queuedFor(X)));
  const G1 = 'q'.repeat(56) + '.anyone', G2 = 'r'.repeat(56) + '.anyone';
  await ui('/api/groups', 'POST', { id: 'a'.repeat(32), name: 'still in', members: [{ address: G1, petname: 'g1' }] });
  await ui('/api/groups', 'POST', { id: 'b'.repeat(32), name: 'removed from', members: [{ address: G2, petname: 'g2' }], removedMe: { by: G2, at: Date.now() } });
  await ui('/api/send', 'POST', { toAddress: G1, envelope: env, offlineTtl: 3600, queueOnly: true });
  await ui('/api/send', 'POST', { toAddress: G2, envelope: env, offlineTtl: 3600, queueOnly: true });
  await until(async () => (await queuedFor(G1)) === 1 && (await queuedFor(G2)) === 1, 5000);
  const r1 = await (await ui('/api/contacts', 'DELETE', { address: G1 })).json(), r2 = await (await ui('/api/contacts', 'DELETE', { address: G2 })).json();
  ok('someone still in a group with us keeps their queue (group messages wait there too)', r1.dropped === 0 && (await queuedFor(G1)) === 1, `${JSON.stringify(r1)} ${await queuedFor(G1)}`);
  ok('…but a group an admin removed us from does not count', r2.dropped === 1 && (await queuedFor(G2)) === 0, `${JSON.stringify(r2)} ${await queuedFor(G2)}`);

  console.log('4. Fetch first: no clear-out before a fetch made during the failures has had time to help');
  srv.kill(); await wait(1500);
  mkdirSync(d + '/data4');                                         // a fresh data folder: nothing queued from the sections above (their ladders would fire too)
  srv = startSrv({ DATA_DIR: d + '/data4', HSFETCH_EVERY_MS: '20000', STALE_LADDER_MS: '6000,6000', STALE_CAP_MS: '1000', STALE_FETCH_GRACE_MS: '3000' });
  for (let i = 0; i < 200; i++) { try { const r = await fetch(`http://127.0.0.1:${UI}/api/version`); if (r.status) break; } catch {} await wait(150); }
  ok('ready after the start', await until(async () => (await net_()).ready === true, 15000), JSON.stringify(await net_()));
  await wait(12000);                                                // past the 10 s limit after the start's own clear-out
  const W = 'w'.repeat(56) + '.anyone'; busy.add(W);
  const hb = await hsfetchesOf(W);
  await ui('/api/send', 'POST', { toAddress: W, envelope: env, offlineTtl: 3600 });
  ok('they answer "busy": a try was made', await until(async () => to(W) >= 1, 5000), String(to(W)));
  await wait(3000);
  ok('…they are reachable, so nothing is asked of the network: no fetch of their address details (1.0.10)', (await hsfetchesOf(W)) === hb, `${await hsfetchesOf(W) - hb}`);
  busy.delete(W);                                                   // now they can't be reached at all
  const n0 = await newnyms(), w0 = to(W);
  ok('then their messages start failing', await until(async () => to(W) > w0, 20000), String(to(W) - w0));
  // Watch the order: when did a fetch made during the failures go, and when did the first clear-out go?
  let tFetch = null, tClear = null, fetchesAtClear = null; const tw = Date.now();
  while (Date.now() - tw < 60000 && tClear === null) {
    const [f, n] = [await hsfetchesOf(W), await newnyms()];
    if (tFetch === null && f >= hb + 1) tFetch = Date.now();
    if (n > n0) { tClear = Date.now(); fetchesAtClear = f - hb; }
    await wait(250);
  }
  ok('a clear-out comes in the end (they keep failing)', tClear !== null, 'none in 60 s');
  ok('…not before a fetch made during the failures', fetchesAtClear !== null && fetchesAtClear >= 1, `fetches when it came: ${fetchesAtClear}`);
  ok('…and only once the fetch made during the failures had its time (3 s here)', tFetch !== null && tClear !== null && tClear - tFetch >= 2500, `fetch at +${tFetch && tFetch - tw} ms, clear-out at +${tClear && tClear - tw} ms`);
} finally { srv.kill('SIGCONT'); srv.kill(); fk.kill(); socks.close(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
