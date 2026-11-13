// A contact whose messages keep failing and who stays silent, with the real backend, a fake Anyone SOCKS port and a fake control port
// (needs `npm install`): the network's memory is cleared (SIGNAL NEWNYM) after the first failures and again on the ladder, not within
// moments of a circuit the user built by hand, and a message that gets through ends the series. The times are shortened by settings.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';
const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SHIM = process.argv[3] || process.env.NODE_PATH || '';
const TOKEN = 'd'.repeat(64), ME = 'n'.repeat(56) + '.anyone', TO = 'a'.repeat(56) + '.anyone', BUSY = 'b'.repeat(56) + '.anyone';
const CTL = 6801, HTTP = 6802, UI = 6803, PUB = 6804;
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + String(x).slice(0, 300) + ']')); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let code = 0xF0;          // what the fake network answers for every address: 0 = reaches the contact
const inbox = http.createServer((req, res) => { req.resume(); req.on('end', () => {
  res.setHeader('Content-Type', 'application/json');
  if (String(req.headers.host || '').startsWith('b')) { res.statusCode = 503; res.setHeader('Retry-After', '1'); return res.end('{"error":"busy"}'); }   // reachable, but busy
  res.end('{"ok":true}'); }); });
await new Promise((r) => inbox.listen(0, '127.0.0.1', r));
const socks = net.createServer((c) => {
  let step = 0, buf = Buffer.alloc(0);
  c.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (step === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) { const n = 2 + buf[1]; buf = buf.subarray(n); c.write(Buffer.from([5, 0])); step = 1; }
    if (step === 1 && buf.length >= 5 && buf[3] === 3 && buf.length >= 7 + buf[4]) {
      const host = buf.subarray(5, 5 + buf[4]).toString(); buf = buf.subarray(7 + buf[4]); step = 2;
      // our own address is always found: the backend's self-test stays quiet and every clear-out counted is the one under test
      if (host[0] !== 'n' && host[0] !== 'b' && code) { c.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      const up = net.connect(inbox.address().port, '127.0.0.1', () => { c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); if (buf.length) up.write(buf); c.pipe(up).pipe(c); });
      up.on('error', () => c.destroy());
    }
  });
  c.on('error', () => {});
});
await new Promise((r) => socks.listen(0, '127.0.0.1', r));
const d = mkdtempSync(join(tmpdir(), 'stale-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
writeFileSync(d + '/anon/anon.log', 'Jan 01 00:00:01.000 [notice] Bootstrapped 100% (done): Done\n');
const fk = spawn('node', [join(APP, 'tools/fake-control-port.mjs'), String(CTL), String(HTTP), d + '/anon'], { stdio: 'ignore' });
await wait(500);
const fake = (p, body) => fetch(`http://127.0.0.1:${HTTP}${p}`, { method: 'POST', body: JSON.stringify(body || {}) }).then((r) => r.json());
const TEST_SETTINGS = { STALE_LADDER_MS: '8000,4000,4000', STALE_CAP_MS: '3000', STALE_USER_QUIET_MS: '22000', HSFETCH_EVERY_MS: '1000' };
const start = (dataDir, extra) => spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env, ...(SHIM ? { NODE_PATH: SHIM } : {}),
  PUBLIC_PORT: String(PUB), UI_PORT: String(UI), DATA_DIR: dataDir, ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: String(CTL),
  SOCKS: `socks5h://127.0.0.1:${socks.address().port}`, PEERS: '{}', ...TEST_SETTINGS, ...extra } });
let srv = start(d + '/data', {});
const up = async () => { for (let i = 0; i < 200; i++) { try { const r = await fetch(`http://127.0.0.1:${UI}/api/version`); if (r.status) return; } catch {} await wait(150); } };
const ui = (p, body) => fetch(`http://127.0.0.1:${UI}${p}`, { method: body ? 'POST' : 'GET', headers: { 'X-AnonChat-Token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
const newnyms = async () => (await fake('/counts'))['SIGNAL NEWNYM'] || 0;
// the queue's own retry is every 15 s; the flush makes a try now, so failures come every second
const failing = async (ms) => { const t = Date.now(); while (Date.now() - t < ms) { await ui('/api/outbox/flush', {}); await wait(1000); } };
const failingUntil = async (t) => { while (Date.now() < t) { await ui('/api/outbox/flush', {}); await wait(1000); } };          // the series starts at the send itself: it makes its own tries
await up();
const env = { dh: 'A'.repeat(87) + '=', n: 0, pn: 0, ct: 'Q'.repeat(40) };
try {
  await fake('/state', { published: true });
  await wait(1500);
  console.log('0. A contact who answers, but busy (503), is reachable: no clear-out for them');
  const nb = await newnyms(); const tb = Date.now(); const sb = await ui('/api/send', { toAddress: BUSY, envelope: env, offlineTtl: 3600 });
  ok('a message to a busy contact waits', sb.queued === true, JSON.stringify(sb));
  await failingUntil(tb + 12500); ok('12.5 s of busy answers (8 s would do for a failing one): no clear-out', (await newnyms()) === nb, `${await newnyms()} (was ${nb})`);
  for (const it of (await ui('/api/outbox')).items) await fetch(`http://127.0.0.1:${UI}/api/outbox/${it.id}`, { method: 'DELETE', headers: { 'X-AnonChat-Token': TOKEN } });
  await wait(1000);
  const n0 = await newnyms();
  const tSend = Date.now(); const sent = await ui('/api/send', { toAddress: TO, envelope: env, offlineTtl: 3600 });
  ok('a message to a contact the network can’t reach waits', sent.queued === true, JSON.stringify(sent));
  console.log('1. The first clear-out');
  await failingUntil(tSend + 5500); ok('5.5 s after the first failure: nothing cleared yet (8 s are needed)', (await newnyms()) === n0, `${await newnyms()} (was ${n0})`);
  await failingUntil(tSend + 10500); const c1 = await newnyms(); ok('10.5 s after it: the network’s memory was cleared once', c1 === n0 + 1, `${c1} (was ${n0})`);
  { const lg = await fake('/log'); const i = lg.lastIndexOf('SIGNAL NEWNYM');
    ok('…on one control connection with the descriptor fetch, the clear-out first', i > 0 && lg[i - 1].startsWith('AUTHENTICATE') && String(lg[i + 1]).startsWith('HSFETCH ' + 'a'.repeat(20)), JSON.stringify(lg.slice(Math.max(0, i - 1), i + 3))); }
  console.log('2. A hand-built circuit keeps it away for a while');
  const renew = await ui('/api/circuit/renew', {}); ok('the user builds a circuit by hand', renew && renew.ok === true, JSON.stringify(renew));
  // (the backend itself never clears more than once in 10 s, so the quiet time is longer than that: a clear-out is due every 4 s)
  await failing(14000); ok('14 s later, although a clear-out is due every 4 s: none', (await newnyms()) === c1, `${await newnyms()} (was ${c1})`);
  await failing(10000); const c2 = await newnyms(); ok('after the quiet time (22 s): it goes on', c2 > c1, `${c2} (was ${c1})`);
  console.log('3. A message that gets through ends the series');
  code = 0; await ui('/api/outbox/flush', {}); await wait(1500);
  ok('the queue is empty after the delivery', (await ui('/api/outbox')).items.length === 0, JSON.stringify((await ui('/api/outbox')).items));
  await wait(3500);                         // the cap between clear-outs passes
  code = 0xF0; const c3 = await newnyms(); const tSend2 = Date.now(); await ui('/api/send', { toAddress: TO, envelope: env, offlineTtl: 3600 });
  await failingUntil(tSend2 + 5500); ok('a new series starts from nothing: 5.5 s after its first failure, no clear-out', (await newnyms()) === c3, `${await newnyms()} (was ${c3})`);
  await failingUntil(tSend2 + 10500); ok('…and by 10.5 s it comes, once', (await newnyms()) === c3 + 1, `${await newnyms()} (was ${c3})`);
  console.log('3b. Deleting the queued message ends the series too');
  for (const it of (await ui('/api/outbox')).items) await fetch(`http://127.0.0.1:${UI}/api/outbox/${it.id}`, { method: 'DELETE', headers: { 'X-AnonChat-Token': TOKEN } });
  await wait(3500);                         // the cap between clear-outs passes
  const c4 = await newnyms(); const tSend3 = Date.now(); await ui('/api/send', { toAddress: TO, envelope: env, offlineTtl: 3600 });
  await failingUntil(tSend3 + 5500); ok('the user deleted the message and wrote another: a new series, 5.5 s in there is no clear-out (the old one was at its 4 s step)', (await newnyms()) === c4, `${await newnyms()} (was ${c4})`);
  console.log('4. The installed app (NODE_ENV=production) ignores the test settings');
  srv.kill(); await wait(1500);
  mkdirSync(d + '/data2'); srv = start(d + '/data2', { NODE_ENV: 'production' }); await up(); await wait(1500);
  code = 0xF0; const p0 = await newnyms(); const tp = Date.now(); await ui('/api/send', { toAddress: TO, envelope: env, offlineTtl: 3600 });
  await failingUntil(tp + 12500); ok('12.5 s of failing with the test settings present: no clear-out (the real first step is 3 minutes)', (await newnyms()) === p0, `${await newnyms()} (was ${p0})`);
} finally { srv.kill(); fk.kill(); socks.close(); inbox.close(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
