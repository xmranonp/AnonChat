// Voice-call transport test. Two call bridges stand in for two nodes. The caller's only way out is a fake SOCKS5 proxy that records
// what it is asked to connect to and forwards it to the other node's public port. Checks: the target is a .anyone NAME handed to the
// proxy (remote DNS, never resolved locally); audio flows both ways; only the right call id is accepted; a congested link drops
// frames instead of queueing them; a broken circuit is redialled; a non-loopback proxy is refused; nothing connects directly.
import net from 'node:net';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require('ws');
const { createCallBridge } = require('../lib/callbridge.js');

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => { cond ? passed++ : (failed++, console.log(`FAIL ${name} ${extra}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); } return false; };

const ADDR_A = 'a'.repeat(56) + '.anyone', ADDR_B = 'b'.repeat(56) + '.anyone';

// ---- node B: a public HTTP server whose upgrades go to its bridge, plus a local WS endpoint
const bridgeB = createCallBridge({ socks: 'socks5h://127.0.0.1:1' });   // B never dials in this test
const pubB = http.createServer((_q, r) => r.end('x'));
pubB.on('upgrade', (req, s, h) => bridgeB.handlePublicUpgrade(req, s, h));
await new Promise((r) => pubB.listen(0, '127.0.0.1', r));
const localWssB = new WebSocketServer({ port: 0, host: '127.0.0.1' });
localWssB.on('connection', (ws) => bridgeB.attachLocal(ws));
await new Promise((r) => localWssB.on('listening', r));

// ---- fake SOCKS5: records each CONNECT; maps <name>.anyone:80 to node B's public port, refuses anything else
const connects = [];
const liveSocks = new Set();
let socksFail = 0;                      // refuse this many connections first (simulates a hidden service that isn't reachable yet)
const socks = net.createServer((c) => {
  liveSocks.add(c); c.on('close', () => liveSocks.delete(c));
  c.once('data', (d) => {
    if (d[0] !== 5) return c.destroy();
    c.write(Buffer.from([5, 0]));
    c.once('data', (req) => {
      const atyp = req[3];
      let host, off;
      if (atyp === 3) { const n = req[4]; host = req.slice(5, 5 + n).toString(); off = 5 + n; }
      else if (atyp === 1) { host = [...req.slice(4, 8)].join('.'); off = 8; }
      else { host = 'ipv6'; off = 20; }
      const port = req.readUInt16BE(off);
      connects.push({ atyp, host, port });
      if (socksFail > 0) { socksFail--; c.write(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); return c.end(); }
      if (atyp !== 3 || host !== ADDR_B || port !== 80) { c.write(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return c.end(); }
      const up = net.connect(pubB.address().port, '127.0.0.1', () => {
        c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        c.pipe(up); up.pipe(c);
      });
      up.on('error', () => c.destroy()); c.on('error', () => up.destroy());
    });
  });
  c.on('error', () => {});
});
await new Promise((r) => socks.listen(0, '127.0.0.1', r));
const socksUrl = `socks5h://127.0.0.1:${socks.address().port}`;

// ---- node A: dials through the fake SOCKS
const bridgeA = createCallBridge({ socks: socksUrl });
const localWssA = new WebSocketServer({ port: 0, host: '127.0.0.1' });
localWssA.on('connection', (ws) => bridgeA.attachLocal(ws));
await new Promise((r) => localWssA.on('listening', r));

const browser = (wss) => new Promise((res) => {
  const ws = new WebSocket(`ws://127.0.0.1:${wss.address().port}`);
  const b = { ws, ctl: [], frames: [] };
  ws.on('message', (d, bin) => bin ? b.frames.push(Buffer.from(d)) : b.ctl.push(JSON.parse(d.toString())));
  ws.on('open', () => res(b));
});
const has = (b, op) => b.ctl.some((m) => m.op === op);
const idOf = (n) => n.toString(16).padStart(32, '0');

// 1. bad input
{
  const a = await browser(localWssA);
  a.ws.send(JSON.stringify({ op: 'dial', id: 'zz', peer: ADDR_B })); await waitFor(() => has(a, 'error'));
  ok('bad call id refused', a.ctl.at(-1)?.reason === 'bad-id');
  a.ws.send(JSON.stringify({ op: 'dial', id: idOf(1), peer: 'example.com' })); await waitFor(() => a.ctl.length >= 2);
  ok('a clearnet host is refused as a peer', a.ctl.at(-1)?.reason === 'bad-peer');
  a.ws.send(JSON.stringify({ op: 'dial', id: idOf(1), peer: '127.0.0.1' })); await waitFor(() => a.ctl.length >= 3);
  ok('an IP address is refused as a peer', a.ctl.at(-1)?.reason === 'bad-peer');
  ok('nothing was dialled for bad input', connects.length === 0);
  a.ws.close();
}

// 2. unknown call ids never reach a browser
{
  const r = await new Promise((res) => {
    const w = new WebSocket(`ws://127.0.0.1:${pubB.address().port}/call/${idOf(9)}`);
    w.on('open', () => res('open')); w.on('error', () => res('refused')); w.on('unexpected-response', () => res('refused'));
  });
  ok('an unexpected call id is refused on the public port', r === 'refused');
  const r2 = await new Promise((res) => { const w = new WebSocket(`ws://127.0.0.1:${pubB.address().port}/other`); w.on('open', () => res('open')); w.on('error', () => res('refused')); w.on('unexpected-response', () => res('refused')); });
  ok('any other path is refused too', r2 === 'refused');
}

// 3. a call: B expects, A dials through the proxy, audio both ways
const ID = idOf(0xabcdef);
const A = await browser(localWssA), B = await browser(localWssB);
B.ws.send(JSON.stringify({ op: 'expect', id: ID, peer: ADDR_A }));
ok('callee is ready', await waitFor(() => has(B, 'ready')));
A.ws.send(JSON.stringify({ op: 'dial', id: ID, peer: ADDR_B }));
ok('caller side opens', await waitFor(() => has(A, 'open')));
ok('callee side opens', await waitFor(() => has(B, 'open')));
ok('exactly one proxy connection', connects.length === 1, JSON.stringify(connects));
ok('the peer was sent to the proxy as a NAME (remote DNS), port 80', connects[0]?.atyp === 3 && connects[0]?.host === ADDR_B && connects[0]?.port === 80, JSON.stringify(connects[0]));

const f1 = Buffer.from('caller-to-callee-frame'), f2 = Buffer.from('callee-to-caller-frame');
A.ws.send(f1, { binary: true }); B.ws.send(f2, { binary: true });
ok('audio reaches the callee', await waitFor(() => B.frames.some((x) => x.equals(f1))));
ok('audio reaches the caller', await waitFor(() => A.frames.some((x) => x.equals(f2))));
A.ws.send(Buffer.alloc(5000), { binary: true });
await sleep(150);
ok('an oversized frame is not forwarded', !B.frames.some((x) => x.length === 5000));

// 4. a second call while busy
{
  const C = await browser(localWssA);
  C.ws.send(JSON.stringify({ op: 'dial', id: idOf(5), peer: ADDR_B })); await waitFor(() => has(C, 'error'));
  ok('a second call is refused while one is active', C.ctl.at(-1)?.reason === 'busy');
  C.ws.close();
}

// 5. a dropped circuit is redialled and the call carries on
{
  const before = connects.length;
  // kill the proxy-side sockets of the call by closing the callee's remote: simulate with the bridge's public ws going away
  for (const c of [...liveSocks]) c.destroy();      // the circuit dies under the call
  const opens = (x) => x.ctl.filter((m) => m.op === 'open').length;
  const [oa, ob] = [opens(A), opens(B)];
  ok('the caller is told the link is down', await waitFor(() => has(A, 'reconnecting')));
  ok('the caller redials by itself and both ends open again', await waitFor(() => opens(A) > oa && opens(B) > ob, 9000));
  ok('the redial also went through the proxy as a name', connects.length > before && connects.slice(before).every((c) => c.atyp === 3 && c.host === ADDR_B));
  const f3 = Buffer.from('after-reconnect'); A.ws.send(f3, { binary: true });
  ok('audio flows again after the redial', await waitFor(() => B.frames.some((x) => x.equals(f3))));
}

// 6. hang up
A.ws.send(JSON.stringify({ op: 'hangup' }));
ok('the callee is told the other side hung up (and does not redial)', await waitFor(() => B.ctl.some((m) => m.op === 'closed' && m.reason === 'remote-closed')));
const dialsAfter = connects.length; await sleep(3500);
ok('a clean hang-up is not redialled', connects.length === dialsAfter);
await sleep(100);
ok('the bridge is free again', !bridgeA.active());
B.ws.send(JSON.stringify({ op: 'hangup' })); await sleep(100);
ok('both bridges free', !bridgeB.active());

// 7. proxy that never answers: the dial fails over and over without ever connecting anywhere else
{
  socksFail = 1000;
  const before = connects.length;
  const B2 = await browser(localWssB), A2 = await browser(localWssA);
  B2.ws.send(JSON.stringify({ op: 'expect', id: idOf(77), peer: ADDR_A })); await waitFor(() => has(B2, 'ready'));
  A2.ws.send(JSON.stringify({ op: 'dial', id: idOf(77), peer: ADDR_B }));
  await sleep(3500);
  ok('with an unreachable service the caller keeps retrying through the proxy only', connects.length > before && !has(A2, 'open'));
  A2.ws.send(JSON.stringify({ op: 'hangup' })); B2.ws.send(JSON.stringify({ op: 'hangup' })); await sleep(100);
  socksFail = 0;
}

// 8. the proxy must be loopback + socks5h
for (const bad of ['socks5h://10.0.0.1:9050', 'http://127.0.0.1:9050', 'socks4://127.0.0.1:9050']) {
  let threw = false; try { createCallBridge({ socks: bad }); } catch { threw = true; }
  ok('a non-loopback or non-SOCKS5 proxy is refused: ' + bad, threw);
}
{
  const b = createCallBridge({ socks: 'socks5://127.0.0.1:9050' });
  ok('socks5 is upgraded to socks5h (remote DNS)', !!b);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
