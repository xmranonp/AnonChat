// Talking to a mailbox peer (lib/swarm/peerclient.js, lib/swarm/answers.js), through a SOCKS5 server like the network's
// (tools/swarm-socks.mjs). Part 1: a peer that misbehaves in every way the soak test and the design list. Part 2, with MAILBOX_PEER_DIR
// set to a mailbox-peer source folder: every request against the real peer. Needs `npm install`. Run: node tools/swarm-client-test.mjs
import http from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { startSocks } from './swarm-socks.mjs';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PC = require(join(APP, 'lib/swarm/peerclient.js')), S = require(join(APP, 'lib/swarm/seal.js')), H = require(join(APP, 'lib/swarm/hpke.js'));
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + String(x).slice(0, 300) + ']')); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };
const A32 = 'abcdefghijklmnopqrstuvwxyz234567';
const addr = (c) => c.repeat(56) + '.anyone';
const FAST = { connectMs: 1000, connectColdMs: 1000, baseMs: 1500, perMiBMs: 200 };          // short, for the tests; generous enough for a busy machine

// ---- part 1: a scripted peer --------------------------------------------------------------------------------------------------
console.log('1. A peer that misbehaves');
let script = () => ({ status: 200, json: { versions: ['1.0'] } });
const hits = [];
const fake = http.createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    hits.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    const s = script(req);
    if (s.raw) return s.raw(req, res);
    const body = s.buf || Buffer.from(JSON.stringify(s.json));
    const h = { 'Content-Type': s.ctype || 'application/json', 'Content-Length': body.length, ...(s.noTime ? {} : { 'X-Swarm-Time': String(s.time || Date.now()) }), ...(s.headers || {}) };
    res.writeHead(s.status, h); res.end(body);
  });
});
fake.keepAliveTimeout = 60000;
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE = { port: fake.address().port, host: '127.0.0.1' };
const P1 = addr('m'), P2 = addr('n'), P3 = addr('o');
const route = { [P1]: FAKE, [P2]: 'refuse', [P3]: 'hang' };
const socks = await startSocks((h) => route[h]);
const fetched = [];
const mk = (a, t = {}) => PC.create({ address: a, socksUrl: socks.url, hsFetch: (x) => fetched.push(x), timing: { ...FAST, ...t } });
const HELLO = { versions: ['1.0'], features: [], maxKeep: 604800, steps: S.STEPS, limits: { maxDrop: S.MAX_DROP, mailboxQuota: 167772160, perContact: 83886080, maxTokens: 2000, wait: 50, liveWaits: 4, inline: 65536 } };
{
  const c = mk(P1);
  script = () => ({ status: 200, json: HELLO, time: Date.now() + 600000 });
  const h = await c.hello();
  ok('hello: a well-formed answer comes through, checked', h.versions[0] === '1.0' && h.limits.wait === 50);
  ok('the peer\'s clock: an offset of 10 minutes is seen and converted', Math.abs(c.clockOffset() - 600000) < 2000 && Math.abs(c.toLocal(Date.now() + 600000) - Date.now()) < 2000);
  ok('every request is on a route of its own for (peer, purpose): user name swarm-owner-<8 hex>', /^swarm-owner-[0-9a-f]{8}$/.test(socks.seen.at(-1).user));
  script = () => ({ status: 200, json: HELLO, noTime: true });
  let e = await err(c.hello());
  ok('an answer without X-Swarm-Time is malformed', e && e.kind === 'malformed', e && e.message);
  script = () => ({ status: 200, json: { ...HELLO, versions: ['2.0'] } });
  e = await err(c.hello()); ok('hello without version 1: malformed', e && e.kind === 'malformed');
  script = () => ({ status: 503, json: { error: 'busy', retryAfter: 30 }, headers: { 'Retry-After': '30' } });
  const before = fetched.length;
  e = await err(c.drop({ token: 'x'.repeat(43), kid: 'a'.repeat(16), expiry: S.expiryAfter(3600), body: Buffer.alloc(4096) }));
  ok('busy: an answer with its code and Retry-After', e && e.kind === 'answer' && e.status === 503 && e.code === 'busy' && e.retryAfter === 30, JSON.stringify(e));
  ok('…which costs no fetch of the address details', fetched.length === before);
  script = () => ({ status: 403, json: { error: 'unknown-token' } });
  e = await err(c.status(['t'.repeat(43)])); ok('403 unknown-token comes back as such', e && e.code === 'unknown-token' && e.reached);
  script = () => ({ status: 418, json: { error: 'something-new' } });
  e = await err(c.info({ mailbox: 'a'.repeat(32), secret: 's'.repeat(43) })); ok('an unknown error code is kept as "other"; the status decides', e && e.status === 418 && e.code === 'other');
  script = () => ({ status: 200, json: { drops: [{ id: 'a'.repeat(32), state: 'teleported', at: 1 }], next: '5' } });
  e = await err(c.status(['t'.repeat(43)])); ok('a status with an unknown state: malformed', e && e.kind === 'malformed');
  script = () => ({ status: 200, buf: Buffer.from('<html>hi</html>'), ctype: 'text/html' });
  e = await err(c.info({ mailbox: 'a'.repeat(32), secret: 's'.repeat(43) })); ok('HTML instead of JSON: malformed', e && e.kind === 'malformed');
  script = () => ({ status: 202, json: { id: 'b'.repeat(32), state: 'held', keepUntil: 1800000000 } });
  const d = await c.drop({ token: 'x'.repeat(43), kid: 'a'.repeat(16), expiry: S.expiryAfter(3600), body: Buffer.alloc(4096, 1) });
  const lastHit = hits.at(-1);
  ok('a drop: 202 with id and keepUntil', d.id === 'b'.repeat(32) && d.keepUntil === 1800000000);
  ok('…sent with its token, kid, expiry and the body\'s exact length, no chunked encoding', lastHit.headers['x-swarm-token'] === 'x'.repeat(43) && lastHit.headers['x-swarm-kid'] === 'a'.repeat(16)
    && lastHit.headers['content-length'] === '4096' && !lastHit.headers['transfer-encoding'] && lastHit.body.length === 4096);
  ok('…on the swarm-drop route', /^swarm-drop-/.test(socks.seen.filter((x) => x.host === P1).at(-1).user));

  // frames
  const frame = (entries, bodies, extra = {}) => { const head = Buffer.from(JSON.stringify({ drops: entries, more: false, prevCollectAt: 5, cursor: '9', ...extra })); const l = Buffer.alloc(4); l.writeUInt32BE(head.length); return Buffer.concat([l, head, ...bodies]); };
  const ent = (i, inline, offset) => ({ id: String(i).repeat(32), kid: 'a'.repeat(16), expiry: 1800000000, size: 4096, receivedAt: 1, token: 'c'.repeat(64), inline, ...(inline ? { offset } : {}) });
  const O = { mailbox: 'a'.repeat(32), secret: 's'.repeat(43) };
  script = () => ({ status: 200, buf: frame([ent(1, true, 0), ent(2, false), ent(3, true, 4096)], [Buffer.alloc(4096, 1), Buffer.alloc(4096, 3)]), ctype: 'application/x-anonchat-swarm' });
  const f = await c.collect(O, { cursor: '0' });
  ok('a frame: drops, bodies where the header says, cursor', f.drops.length === 3 && f.drops[0].body[0] === 1 && f.drops[2].body[0] === 3 && !f.drops[1].body && f.cursor === '9');
  const bad = [
    ['a body out of place', frame([ent(1, true, 10)], [Buffer.alloc(4096)])],
    ['bytes after the last body', frame([ent(1, true, 0)], [Buffer.alloc(4097)])],
    ['a body cut short', frame([ent(1, true, 0)], [Buffer.alloc(4000)])],
    ['a size that isn\'t a step', frame([{ ...ent(1, true, 0), size: 4000 }], [Buffer.alloc(4000)])],
    ['an expiry that isn\'t whole hours', frame([{ ...ent(1, false), expiry: 1800000001 }], [])],
    ['the same drop twice', frame([ent(1, false), ent(1, false)], [])],
    ['a header longer than the answer', Buffer.from([0, 0, 1, 0, 1, 2])],
  ];
  for (const [what, buf] of bad) { script = () => ({ status: 200, buf, ctype: 'application/x-anonchat-swarm' }); const e2 = await err(c.collect(O, {})); ok(`frame with ${what}: malformed`, e2 && e2.kind === 'malformed', e2 && e2.message); }
  script = () => ({ status: 200, json: { closed: 'superseded', prevCollectAt: 7 } });
  ok('wait: "superseded" is understood', (await c.wait(O, {})).closed === 'superseded');
  script = () => ({ status: 200, buf: Buffer.alloc(2 * 1024 * 1024, 0x20), ctype: 'application/json' });
  e = await err(c.info(O)); ok('an answer bigger than its limit is cut off and malformed', e && e.kind === 'malformed' && /too big/.test(e.message));

  // cut and hanging answers: the deadline ends them
  script = () => ({ raw: (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 1000, 'X-Swarm-Time': String(Date.now()) }); res.write('{"ok":'); setTimeout(() => res.destroy(), 100); } });
  e = await err(c.ack(O, [])); ok('an answer cut off in the middle is an error ("cut"), never a short answer', e && e.kind === 'cut', e && e.kind);
  script = () => ({ raw: (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 1000, 'X-Swarm-Time': String(Date.now()) }); res.write('{'); } });
  const t0 = Date.now(); e = await err(c.ack(O, []));
  ok('an answer that stops coming: ended by the deadline', e && e.kind === 'deadline' && Date.now() - t0 < 4000, `${e && e.kind} after ${Date.now() - t0} ms`);
  script = () => ({ raw: () => {} });
  e = await err(c.info(O)); ok('no answer at all: ended by the deadline', e && e.kind === 'deadline');
  c.close();
}
{
  const before = fetched.length;
  const c = mk(P2);
  for (let i = 0; i < 4; i++) await err(c.hello());
  ok('a peer that can\'t be reached: errors of kind "network"', (await err(c.hello())).kind === 'network');
  ok('…its address details are fetched again after 2 failures in a row', fetched.length - before >= 2 && fetched.at(-1) === P2, String(fetched.length - before));
  const passes = new Set(socks.seen.filter((x) => x.host === P2 && x.user.startsWith('swarm-owner')).map((x) => x.pass));
  ok('…and after 4 in a row the route is new (another SOCKS password: another route)', passes.size >= 2, [...passes].join(','));
  const c3 = mk(P3);
  const t0 = Date.now(), e = await err(c3.hello());
  ok('a route that never comes up: ended at the connect deadline', e && e.kind === 'network' && Date.now() - t0 < 2000, `${e && e.kind} ${Date.now() - t0}`);
  c.close(); c3.close();
}
{
  // a kept-alive socket the peer closed meanwhile: sent again once on a new one
  const c = mk(P1, { baseMs: 3000 });
  let n = 0;
  script = () => ({ raw: (req, res) => { n++; const b = Buffer.from('{"ok":true}'); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'X-Swarm-Time': String(Date.now()) }); res.end(b); } });
  await c.ack({ mailbox: 'a'.repeat(32), secret: 's'.repeat(43) }, []);
  const conns = socks.seen.filter((x) => x.host === P1).length;
  script = () => ({ raw: (req, res) => { n++; if (n === 2) { req.socket.destroy(); return; } const b = Buffer.from('{"ok":true}'); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'X-Swarm-Time': String(Date.now()) }); res.end(b); } });
  let res2 = null; const r = await err((async () => { res2 = await c.ack({ mailbox: 'a'.repeat(32), secret: 's'.repeat(43) }, []); })());
  ok('a reused connection that fails before any answer: sent again once, on a new connection', r === null && n === 3 && socks.seen.filter((x) => x.host === P1).length === conns + 1, `${r && r.message} n=${n}`);
  ok('…and the result says it was sent again (the peer may have done it twice)', res2 && res2.resent === true);
  c.close();
}
{
  console.log('1b. The independent review\'s cases (22 November)');
  const O = { mailbox: 'a'.repeat(32), secret: 's'.repeat(43) };
  const okJson = (req, res, delay = 0) => setTimeout(() => { const b = Buffer.from('{"ok":true}'); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'X-Swarm-Time': String(Date.now()) }); res.end(b); }, delay);
  // more than 6 slow requests at once: the 7th waits for a place, which is no failure and no reason for a new route
  let served = 0; script = () => ({ raw: (req, res) => { served++; okJson(req, res, 1500); } });
  const c = mk(P1, { connectMs: 1000, connectColdMs: 1000, baseMs: 4000 });
  const f0 = fetched.length;
  const all = await Promise.all(Array.from({ length: 12 }, () => err(c.ack(O, []))));
  ok('12 slow requests at once to a healthy peer: all 12 answered (6 at a time)', all.every((e) => e === null) && served === 12, all.map((e) => e && e.message).join('|') + ' served=' + served);
  ok('…no route counted as failed, no address details fetched', JSON.stringify(c._fails()) === '{"swarm-owner":0}' && fetched.length === f0, JSON.stringify(c._fails()));
  c.close();
  // a new route while requests are on their way: they finish on the old one
  let refuse = false; route[P1] = FAKE;
  const sw = await startSocks((h) => (h === P1 ? (refuse ? 'refuse' : FAKE) : 'refuse'));
  const c2 = PC.create({ address: P1, socksUrl: sw.url, hsFetch: () => {}, timing: { ...FAST, baseMs: 6000 } });
  script = () => ({ raw: (req, res) => okJson(req, res, 2500) });
  const slow = [c2.ack(O, []), c2.ack(O, [])];
  await wait(400); refuse = true;
  for (let i = 0; i < 4; i++) await err(c2.ack(O, []));
  const sr = await Promise.all(slow.map(err));
  ok('after 4 failures in a row, the two requests on their way on the old route still finish', sr.every((e) => e === null), sr.map((e) => e && e.message).join('|'));
  refuse = false; script = () => ({ raw: (req, res) => okJson(req, res) });
  const r5 = await err(c2.ack(O, []));
  const passes = new Set(sw.seen.filter((x) => x.user.startsWith('swarm-owner')).map((x) => x.pass));
  ok('…and new requests go on a new route (another SOCKS password)', r5 === null && passes.size === 2 && sw.seen.at(-1).pass.endsWith('-1'), [...passes].join(','));
  c2.close(); sw.close();
  // routes that hang: given up within the handshake limit, so they hold no place once the route works again
  let hang = true; const sh = await startSocks((h) => (hang ? 'hang' : FAKE));
  const c3 = PC.create({ address: P1, socksUrl: sh.url, hsFetch: () => {}, timing: { ...FAST, rotateAfter: 100 } });
  await Promise.all(Array.from({ length: 6 }, () => err(c3.ack(O, []))));
  hang = false; await wait(800);
  const after = []; for (let i = 0; i < 3; i++) after.push(await err(c3.ack(O, [])));
  ok('6 connections left hanging, then the route works: the next requests get through (no place is held)', after.every((e) => e === null), after.map((e) => e && e.message).join('|'));
  c3.close(); sh.close();
  // the peer's clock is read when the headers come, not after a slow body
  const c4 = mk(P1, { baseMs: 5000 });
  script = () => ({ raw: (req, res) => { const b = Buffer.from('{"ok":true}'); res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'X-Swarm-Time': String(Date.now()) }); res.write(b.subarray(0, 2)); setTimeout(() => res.end(b.subarray(2)), 2000); } });
  await c4.ack(O, []);
  ok('a body that takes 2 s to come: the clock offset is still about 0', Math.abs(c4.clockOffset()) < 500, String(c4.clockOffset()));
  script = () => ({ status: 200, json: { ok: true }, time: 9999999999999999 });
  let e = await err(c4.ack(O, [])); ok('an X-Swarm-Time years away: malformed (and not taken as the clock)', e && e.kind === 'malformed' && Math.abs(c4.clockOffset()) < 500);
  script = () => ({ raw: (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'X-Swarm-Time': String(Date.now()) }); res.end('{"ok":true}'); } });
  e = await err(c4.ack(O, [])); ok('an answer without Content-Length: malformed', e && e.kind === 'malformed', e && e.message);
  script = () => ({ raw: (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 5 * 1024 * 1024, 'X-Swarm-Time': String(Date.now()) }); res.write('{'); } });
  e = await err(c4.ack(O, [])); ok('an answer that says it is bigger than its limit: refused before it is read', e && e.kind === 'malformed' && /too big/.test(e.message));
  // bad values from the caller: refused before anything is sent, and never counted against the route
  const before = hits.length, fb = fetched.length;
  for (const bad of [() => c4.info({ mailbox: 'a'.repeat(32) }), () => c4.info({ mailbox: 'x', secret: 's'.repeat(43) }), () => c4.ack({ mailbox: 'a'.repeat(32), secret: 'a\r\nX: y' + 'a'.repeat(35) }, []),
    () => c4.drop({ token: 't'.repeat(43), kid: 'a'.repeat(16), expiry: NaN, body: Buffer.alloc(4096) }), () => c4.drop({ token: 't'.repeat(43), kid: 'a'.repeat(16), expiry: 7200, body: Buffer.alloc(4000) }),
    () => c4.status([]), () => c4.status(['t'.repeat(43)], { since: 'x' }), () => c4.ack(O, [{ id: 'nope', result: 'stored' }])]) {
    const r = await err(bad()); if (!r || r.kind !== 'local') { ok('a bad value is refused locally', false, r && r.message); }
  }
  ok('8 bad values: each refused locally (kind "local"), nothing sent, no failure counted', hits.length === before && fetched.length === fb && JSON.stringify(c4._fails()).match(/:0/g)?.length === Object.keys(c4._fails()).length);
  ok('…and no secret in the error messages', !(await err(c4.ack({ mailbox: 'a'.repeat(32), secret: 'SECRET\r\n' }, []))).message.includes('SECRET'));
  c4.close();
}
socks.close(); fake.close();

// ---- part 2: the real mailbox peer ----------------------------------------------------------------------------------------------
const PEER = process.env.MAILBOX_PEER_DIR;
if (PEER && existsSync(join(PEER, 'test/helpers.mjs'))) {
  console.log('2. The real mailbox peer (' + PEER + ')');
  const ph = await import(pathToFileURL(join(PEER, 'test/helpers.mjs')).href);
  const clock = { t: Date.now() };
  const h = await ph.startPeer({ clock, waitMax: 2 });
  const PA = ph.ADDR;          // the address the peer's helpers use
  const socks2 = await startSocks((host) => (host === PA ? { path: h.sock } : 'refuse'));
  const c = PC.create({ address: PA, socksUrl: socks2.url, timing: { ...FAST, baseMs: 5000 } });
  try {
    const hello = await c.hello();
    ok('hello', hello.versions.includes('1.0') && hello.steps.length === S.STEPS.length);
    const inv = await h.store.createInvite({});
    const secret = S.newSecret(), owner = { secret: S.b64u(secret) };
    owner.mailbox = (await c.join(inv.invite, S.sha256hex(secret))).mailbox;
    ok('join: a mailbox', /^[0-9a-f]{32}$/.test(owner.mailbox));
    ok('join again with the same invite and owner hash: the same mailbox (safe to repeat)', (await c.join(inv.invite, S.sha256hex(secret))).mailbox === owner.mailbox);
    const keys = H.generateKeyPair(), kid = S.kidOf(PA, keys.pk);
    const tok = S.newSecret(), token = S.b64u(tok);
    const t = await c.tokens(owner, { add: [S.sha256hex(tok)], kids: [kid] });
    ok('tokens and kid registered', t.tokens === 1 && t.kids.includes(kid));
    const env = { from: addr('z'), ct: 'AAAA', dh: 'x', n: 1, pn: 0, stamp: 's' };
    const expiry = S.expiryAfter(86400, clock.t);
    const sealed = S.sealDrop({ env, peerAddress: PA, pk: keys.pk, expiry });
    const d = await c.drop({ token, kid, expiry, body: sealed.body });
    ok('a sealed drop is accepted (202)', d.state === 'held' && /^[0-9a-f]{32}$/.test(d.id));
    ok('the same drop again: the same id (repeats are harmless)', (await c.drop({ token, kid, expiry, body: sealed.body })).id === d.id);
    const st = await c.status([token], { ids: [d.id] });
    ok('status: held', st.drops[0].state === 'held');
    const f = await c.collect(owner, { cursor: '0' });
    ok('collect: the drop, inline', f.drops.length === 1 && f.drops[0].inline && f.drops[0].id === d.id);
    ok('…it opens to the envelope sent', JSON.stringify(S.openDrop({ body: f.drops[0].body, peerAddress: PA, sk: keys.sk, pk: keys.pk, expiry: f.drops[0].expiry })) === JSON.stringify(env));
    await c.ack(owner, [{ id: d.id, result: 'stored' }]);
    ok('ack, then status says collected', (await c.status([token], { ids: [d.id] })).drops[0].state === 'collected');
    const w0 = Date.now(), w = await c.wait(owner, { cursor: f.cursor });
    ok('wait with nothing new: an empty frame after the peer\'s wait', w.drops.length === 0 && Date.now() - w0 >= 1500, `${w.drops.length} after ${Date.now() - w0}`);
    const pw = c.wait(owner, { cursor: f.cursor });
    await wait(300);
    const d2 = await c.drop({ token, kid, expiry, body: S.sealDrop({ env: { ...env, n: 2 }, peerAddress: PA, pk: keys.pk, expiry }).body });
    const w2 = await pw;
    ok('wait wakes when a drop arrives, and brings it inline', w2.drops.length === 1 && w2.drops[0].id === d2.id && w2.drops[0].inline);
    const info = await c.info(owner);
    ok('info', info.heldDrops === 1 && info.kids.includes(kid));
    let e = await err(c.drop({ token, kid: 'f'.repeat(16), expiry, body: sealed.body }));
    ok('a drop for a kid the peer doesn\'t accept: 409 kid-not-accepted', e && e.status === 409 && e.code === 'kid-not-accepted');
    e = await err(c.drop({ token: S.b64u(S.newSecret()), kid, expiry, body: sealed.body }));
    ok('an unknown token: 403 unknown-token', e && e.status === 403 && e.code === 'unknown-token');
    e = await err(c.info({ mailbox: owner.mailbox, secret: S.b64u(S.newSecret()) }));
    ok('a wrong owner secret: 401 unauthorized', e && e.status === 401 && e.code === 'unauthorized');
    await c.leave(owner);
    e = await err(c.info(owner)); ok('after leave: 404 no-mailbox', e && e.status === 404 && e.code === 'no-mailbox');
    ok('status still answers for 30 days after leave', (await c.status([token], { ids: [d.id] })).drops.length === 1);
    // a second mailbox for the rest: long-poll status, wait carrying acks, collect by ids, paging with "more"
    const inv2 = await h.store.createInvite({}); const sec2 = S.newSecret(), o2 = { secret: S.b64u(sec2) };
    o2.mailbox = (await c.join(inv2.invite, S.sha256hex(sec2))).mailbox;
    const k2 = H.generateKeyPair(), kid2 = S.kidOf(PA, k2.pk), tk2 = S.newSecret(), token2 = S.b64u(tk2);
    await c.tokens(o2, { add: [S.sha256hex(tk2)], kids: [kid2] });
    const big = (i) => S.sealDrop({ env: { ...env, n: 100 + i, pad: 'p'.repeat(600000) }, peerAddress: PA, pk: k2.pk, expiry }).body;          // 1 MiB step
    const ids = []; for (let i = 0; i < 12; i++) ids.push((await c.drop({ token: token2, kid: kid2, expiry, body: big(i) })).id);
    const page1 = await c.collect(o2, { cursor: '0' });
    ok('collect pages: at most 9 MiB, then "more"', page1.more === true && page1.drops.length === 9 && page1.drops.every((x) => x.inline), `${page1.drops.length} more=${page1.more}`);
    const page2 = await c.collect(o2, { cursor: page1.cursor });
    ok('…the next page from its cursor has the rest', !page2.more && page2.drops.length === 3);
    const byIds = await c.collect(o2, { ids: [ids[11], ids[0]] });
    ok('collect by ids: those, without a cursor', byIds.drops.length === 2 && byIds.cursor === undefined && byIds.drops.map((x) => x.id).sort().join() === [ids[0], ids[11]].sort().join());
    const lp = c.status([token2], { ids: [ids[0]], wait: 10 });
    const lpAll = c.status([token2], { since: '0', wait: 10 });
    ok('a long-poll status goes on the swarm-status route', (await lpAll).drops.length >= 1 && socks2.seen.some((x) => x.user.startsWith('swarm-status-')));
    await lp;
    const wf = await c.wait(o2, { cursor: page2.cursor, acks: ids.map((id) => ({ id, result: 'stored' })) });
    ok('wait carries acks: afterwards every drop reads "collected"', wf.drops.length === 0 && (await c.status([token2], { ids: ids.slice(0, 12) })).drops.every((x) => x.state === 'collected'));
    const users = new Set(socks2.seen.map((x) => x.user.replace(/-[0-9a-f]{8}$/, '')));
    ok('the purposes used their own routes', ['swarm-owner', 'swarm-drop', 'swarm-wait', 'swarm-status'].every((u) => users.has(u)), [...users].join(','));
    ok('and no request went out without isolation', socks2.seen.every((x) => x.user && x.pass));
  } finally { c.close(); socks2.close(); await h.stop(); }
} else console.log('2. (the real mailbox peer: set MAILBOX_PEER_DIR to a mailbox-peer source folder to run it)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
