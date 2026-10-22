// Why messages are waiting, in the Status log (lib/deliverylog.js), and the Service line's introduction points (needs `npm install`).
// Unit part: each kind of failure in plain words, one line per reason and at most one a minute while it stays the same, a line when a
// message gets through, short addresses, the network's log and ours in time order. End to end: a fake Anyone SOCKS port answers with the
// network's own reply codes (ExtendedErrors) and the backend's Status log says why; the count of introduction points comes from the
// open introduction circuits (the descriptor's list is encrypted).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';
const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(join(APP, 'server.js'));
const DL = require('./lib/deliverylog.js');
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + String(x).slice(0, 300) + ']')); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Unit ----
const A = 'abcdefghij' + 'k'.repeat(44) + 'qd.anyone';
{
  const socksErr = (name) => new Error('Socks5 proxy rejected connection - ' + name);
  const r = (e) => DL.reasonFor(e);
  ok('descriptor not found', /address not found on the network/.test(r(socksErr('HsDescNotFound')).text) && r(socksErr('HsDescNotFound')).term === 'descriptor not found');
  ok('descriptor unreadable', r(socksErr('HsDescInvalid')).term === 'descriptor invalid');
  ok('introduction failed / timed out / rendezvous failed', r(socksErr('HsIntroFailed')).term === 'introduction failed' && r(socksErr('HsIntroTimedOut')).term === 'introduction timed out' && r(socksErr('HsRendFailed')).term === 'rendezvous failed');
  ok('a plain timeout', r(Object.assign(new Error('timeout of 45000ms exceeded'), { code: 'ECONNABORTED' })).key === 'timeout');
  ok('the network program not running', r(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9050'), { code: 'ECONNREFUSED' })).key === 'socks-down');
  const http = (status, error) => Object.assign(new Error('Request failed'), { response: { status, data: { error } } });
  ok('their app: slow down / inbox full / keys not ready', /slow down/.test(r(http(429, 'rate limited')).text) && /inbox is full/.test(r(http(503, 'inbox full, retry later')).text) && /keys not ready/.test(r(http(503, 'retry later')).text));
  ok('their app refused it', /refused/.test(r(http(400, 'malformed envelope')).text) && r(http(400)).term === 'HTTP 400');
  ok('a short address: start and end only', DL.shortAddress(A) === 'abcdef…qd.anyone', DL.shortAddress(A));
}
{
  let now = new Date(2026, 9, 22, 9, 15, 12, 0).getTime();
  const log = DL.create({ now: () => now });
  const nf = new Error('Socks5 proxy rejected connection - HsDescNotFound');
  log.failed(A, nf);
  let l = log.lines();
  ok('first failure: one line, time like the network log, the reason and its term', l.length === 1 && l[0].text === 'Oct 22 09:15:12.000 [AnonChat] To abcdef…qd.anyone: address not found on the network (descriptor not found). Retrying.', l[0] && l[0].text);
  ok('…the full address is never in it', !l[0].text.includes(A));
  for (let i = 0; i < 4; i++) { now += 10000; log.failed(A, nf); }
  ok('the same reason again within a minute: no new line', log.lines().length === 1);
  now += 25000; log.failed(A, nf);
  l = log.lines();
  ok('…a minute on: one more, with the tries so far', l.length === 2 && /\(6 tries so far\)/.test(l[1].text), l[1] && l[1].text);
  now += 1000; log.failed(A, new Error('Socks5 proxy rejected connection - HsIntroFailed'));
  ok('a different reason: a line at once', log.lines().length === 3 && /introduction failed/.test(log.lines()[2].text));
  now += 1000; log.delivered(A);
  ok('delivered: one line with the number of tries', /To abcdef…qd\.anyone: delivered after 8 tries\./.test(log.lines()[3].text), log.lines()[3] && log.lines()[3].text);
  log.delivered(A);
  ok('…and nothing for a message that got through at once', log.lines().length === 4);
  const B = 'z'.repeat(56) + '.anyone';
  for (let i = 0; i < 300; i++) { now += 61000; log.failed(B, nf); }
  ok('the log keeps the last 100 lines', log.lines().length === 100);
}
{
  const netLines = ['Oct 22 09:14:05.000 [notice] Bootstrapped 100% (done): Done', 'Oct 22 09:16:30.120 [warn] HSDesc parsing failed!', 'continued line', 'Oct 22 09:18:00.000 [notice] later'];
  const ours = ['Oct 22 09:15:12.000 [AnonChat] A', 'Oct 22 09:17:44.000 [AnonChat] B'];
  const m = DL.merge(netLines, ours);
  ok('the network log and ours in time order; an untimed line stays after its own', JSON.stringify(m) === JSON.stringify([netLines[0], ours[0], netLines[1], netLines[2], ours[1], netLines[3]]), JSON.stringify(m));
  ok('…keeping the last 200', DL.merge(Array.from({ length: 300 }, (_, i) => `Oct 22 10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000 x`), []).length === 200);
}

// ---- The SOCKS library now names the network's codes, through the very agent the backend uses ----
const replies = new Map();     // first letter of the address -> SOCKS reply code (0 = connect to the inbox server below)
const inbox = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); }); });
await new Promise((r) => inbox.listen(0, '127.0.0.1', r));
const socks = net.createServer((c) => {
  let step = 0, buf = Buffer.alloc(0);
  c.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (step === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) { const n = 2 + buf[1]; buf = buf.subarray(n); c.write(Buffer.from([5, 0])); step = 1; }
    if (step === 1 && buf.length >= 5 && buf[3] === 3 && buf.length >= 7 + buf[4]) {
      const host = buf.subarray(5, 5 + buf[4]).toString(); buf = buf.subarray(7 + buf[4]); step = 2;
      const code = replies.has(host[0]) ? replies.get(host[0]) : 0xF0;
      if (code) { c.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      const up = net.connect(inbox.address().port, '127.0.0.1', () => { c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); if (buf.length) up.write(buf); c.pipe(up).pipe(c); });
      up.on('error', () => c.destroy());
    }
  });
  c.on('error', () => {});
});
await new Promise((r) => socks.listen(0, '127.0.0.1', r));
const SOCKS_PORT = socks.address().port;
{
  const axios = require('axios'); const { SocksProxyAgent } = require('socks-proxy-agent');
  const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${SOCKS_PORT}`);
  const ax = axios.create({ httpAgent: agent, httpsAgent: agent, proxy: false, adapter: 'http', timeout: 8000 });
  replies.set('a', 0xF0); replies.set('b', 0xF2); replies.set('c', 0xF7);
  const err = async (host) => { try { await ax.post(`http://${host}/api/inbox`, {}); return null; } catch (e) { return e; } };
  const e1 = await err('a'.repeat(56) + '.anyone'), e2 = await err('b'.repeat(56) + '.anyone'), e3 = await err('c'.repeat(56) + '.anyone');
  ok('the network’s “descriptor not found” reaches the backend by name', /HsDescNotFound/.test(e1 && e1.message) && DL.reasonFor(e1).term === 'descriptor not found', e1 && e1.message);
  ok('…“introduction failed” and “introduction timed out” too', DL.reasonFor(e2).term === 'introduction failed' && DL.reasonFor(e3).term === 'introduction timed out', (e2 && e2.message) + ' | ' + (e3 && e3.message));
  const src = readFileSync(join(APP, 'server.js'), 'utf8');
  const TRANSIENT = new Function('return ' + /const TRANSIENT = (\/.*\/i);/.exec(src)[1])();
  ok('a call’s signal still gets its second try on these (the old names are gone from the message)', TRANSIENT.test(e1.message) && TRANSIENT.test(e2.message));
}
{
  const src = readFileSync(join(APP, 'start.js'), 'utf8');
  ok('anonrc asks the network for its own reply codes (ExtendedErrors on the SOCKS port)', /^SocksPort 127\.0\.0\.1:\$\{ports\.socks\} ExtendedErrors$/m.test(src));
}

// ---- End to end: the backend's Status log and the Service line ----
const TOKEN = 'f'.repeat(64), ME = 'n'.repeat(56) + '.anyone', TO = 'a'.repeat(56) + '.anyone';
const CTL = 6741, HTTP = 6742, UI = 6743, PUB = 6744;
const d = mkdtempSync(join(tmpdir(), 'dlog-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
writeFileSync(d + '/anon/anon.log', 'Jan 01 00:00:01.000 [notice] Bootstrapped 100% (done): Done\n');
const fk = spawn('node', [join(APP, 'tools/fake-control-port.mjs'), String(CTL), String(HTTP), d + '/anon'], { stdio: 'ignore' });
await wait(500);
const fake = (p, body) => fetch(`http://127.0.0.1:${HTTP}${p}`, { method: 'POST', body: JSON.stringify(body) });
const srv = spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env,
  PUBLIC_PORT: String(PUB), UI_PORT: String(UI), DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: String(CTL),
  SOCKS: `socks5h://127.0.0.1:${SOCKS_PORT}`, PEERS: '{}' } });
const ui = (p, body) => fetch(`http://127.0.0.1:${UI}${p}`, { method: body ? 'POST' : 'GET', headers: { 'X-AnonChat-Token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
for (let i = 0; i < 200; i++) { try { const r = await fetch(`http://127.0.0.1:${UI}/api/version`); if (r.status) break; } catch {} await wait(150); }
try {
  replies.set('a', 0xF0);
  const env = { dh: 'A'.repeat(87) + '=', n: 0, pn: 0, ct: 'Q'.repeat(40) };
  const sent = await ui('/api/send', { toAddress: TO, envelope: env, offlineTtl: 3600 });
  ok('a message to an address the network can’t find waits (⏳)', sent.queued === true, JSON.stringify(sent));
  let logs = await ui('/api/logs');
  const mine = logs.lines.filter((l) => l.includes('[AnonChat]'));
  ok('the Status log says why, once, with the short address', mine.length === 1 && mine[0].includes('To aaaaaa…aa.anyone: address not found on the network (descriptor not found). Retrying.'), JSON.stringify(mine));
  ok('…after the network’s own lines', logs.lines.indexOf(mine[0]) > logs.lines.findIndex((l) => l.includes('Bootstrapped')));
  ok('…and the full address never appears', !logs.lines.some((l) => l.includes(TO)));
  replies.set('a', 0);
  await ui('/api/outbox/flush', {});
  let got = null;
  for (let i = 0; i < 40 && !got; i++) { await wait(250); logs = await ui('/api/logs'); got = logs.lines.find((l) => /delivered after \d+ tries/.test(l)); }
  ok('once it gets through: “delivered after N tries”', got && got.includes('To aaaaaa…aa.anyone: delivered after 4 tries.'), got || JSON.stringify(logs.lines.slice(-3)));

  const intro = (id, state) => `${id} BUILT $${'A'.repeat(40)}~g,$${'B'.repeat(40)}~m,$${'C'.repeat(40)}~i BUILD_FLAGS=IS_INTERNAL,NEED_CAPACITY,NEED_UPTIME PURPOSE=HS_SERVICE_INTRO HS_STATE=${state} TIME_CREATED=2026-01-01T00:00:00`;
  await fake('/state', { published: true, circuits: [intro(1, 'HSSI_ESTABLISHED'), intro(2, 'HSSI_ESTABLISHED'), intro(3, 'HSSI_ESTABLISHED'), intro(4, 'HSSI_CONNECTING')] });
  let h = await ui('/api/hs/health');
  ok('Service line: the introduction points in place are counted (3 of 4 circuits; the one still connecting isn’t)', h.detail === 'reachable' && h.introPoints === 3, JSON.stringify(h));
  await fake('/state', { published: true, circuits: [intro(5, 'HSSI_CONNECTING')] });
  h = await ui('/api/hs/health');
  ok('…none in place yet: “Published, no introduction points”, 0', h.detail === 'published-no-intro' && h.introPoints === 0, JSON.stringify(h));
  await fake('/state', { published: false, circuits: [] });
  h = await ui('/api/hs/health');
  ok('…not published: no count shown', h.detail === 'not-published' && h.introPoints === null, JSON.stringify(h));
} finally { srv.kill(); fk.kill(); socks.close(); inbox.close(); }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
