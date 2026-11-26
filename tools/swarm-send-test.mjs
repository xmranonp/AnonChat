// Sending to contacts' mailbox peers (lib/swarm/send.js with lib/outbox.js and lib/swarm/contacts.js): the routes, every answer a peer
// can give, the second copy, sending directly when collection isn't working, the outcomes, a restart, and the state rules under random
// event sequences. Part 2, with MAILBOX_PEER_DIR set to a mailbox-peer source folder: end to end against the real peer, with a test owner
// collecting. Run: node tools/swarm-send-test.mjs
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { startSocks } from './swarm-socks.mjs';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DATA = process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'swarm-send-'));
process.env.OUTBOX_ROUND_WAIT_MS = '300';
const require = createRequire(import.meta.url);
require(join(APP, 'lib/sealed.js')).setKey(randomBytes(32));
const outbox = require(join(APP, 'lib/outbox.js'));
const Contacts = require(join(APP, 'lib/swarm/contacts.js'));
const Send = require(join(APP, 'lib/swarm/send.js'));
const S = require(join(APP, 'lib/swarm/seal.js')), H = require(join(APP, 'lib/swarm/hpke.js'));
const { SwarmError } = require(join(APP, 'lib/swarm/peerclient.js'));

let pass = 0, fail = 0;
const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + String(x).slice(0, 400) + ']')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addr = (ch) => ch.repeat(56) + '.anyone';
const ME = addr('m');
const clock = { t: Date.now() };
const now = () => clock.t;

// ---------------------------------------------------------------- the direct path (the outbox's network)
let direct = 'down';          // 'up': the recipient's app takes it; 'down': no connection; 'refuse': 400
const posted = [];          // what went directly: { ct, held } (held: was it held at that moment? must never be true)
const onion = () => ({ post: async (_url, body) => {
  const it = outbox.queue.find((i) => i.envelope.ct === body.ct);
  posted.push({ ct: body.ct, held: !!(it && it.held) });
  if (direct === 'up') return { data: { ok: true } };
  if (direct === 'refuse') throw Object.assign(new Error('400'), { response: { status: 400, data: {} } });
  throw new Error('connect ETIMEDOUT');
} });
outbox.init({ onion, pow: { solveAsync: async () => 'n' }, myAddress: () => ME, stamp: (e) => e });

// ---------------------------------------------------------------- fake peers: each answer scripted
const fakes = new Map();
function fakePeer(a) {
  const P = { address: a, counter: 0, offset: 0, drops: new Map(), script: [], answer: 'ok', dropCalls: 0, statusCalls: 0, keys: null, keepS: 7 * 86400,
    toLocal: (ms) => ms - P.offset, clockOffset: () => P.offset,
    async drop({ token, kid, expiry, body }) {
      P.dropCalls++;
      const s = P.script.length ? P.script.shift() : P.answer;
      if (s === 'net') throw new SwarmError('network', 'no route');
      if (typeof s === 'number') throw new SwarmError('answer', `${s} x`, { status: s, code: s === 503 ? 'busy' : 'x' });
      if (s === 'full') throw new SwarmError('answer', '503 full', { status: 503, code: 'full' });
      if (s === 'expired410') throw new SwarmError('answer', '410 expired', { status: 410, code: 'expired' });
      const id = randomBytes(16).toString('hex');
      P.drops.set(id, { id, token, kid, expiry, body, state: 'held', c: ++P.counter });
      return { id, state: 'held', keepUntil: P.keepAnswer || Math.min(expiry, Math.floor((clock.t + P.offset) / 1000) + P.keepS) };
    },
    async status(tokens, { since, ids, wait } = {}) {
      P.statusCalls++;
      if (P.statusDown) throw new SwarmError('network', 'no route');
      const list = () => (ids ? ids.map((id) => { const d = P.drops.get(id); return d ? { id, state: d.state, at: 1 } : { id, state: 'unknown', at: 0 }; })
        : [...P.drops.values()].filter((d) => tokens.includes(d.token) && d.c > Number(since || 0)).map((d) => ({ id: d.id, state: d.state, at: 1, c: d.c })));
      if (wait && !ids) await sleep(25);
      const l = list();
      return { drops: l.map(({ c, ...x }) => x), next: String(Math.max(Number(since || 0), ...l.map((x) => x.c || 0))) };
    },
    set(id, state) { const d = P.drops.get(id); d.state = state; d.c = ++P.counter; },
    collectAll() { for (const d of P.drops.values()) if (d.state === 'held') P.set(d.id, 'collected'); },
  };
  fakes.set(a, P);
  return P;
}
const P1 = fakePeer(addr('a')), P2 = fakePeer(addr('b'));
const BOB = addr('c'), ANA = addr('d');
function detailsFor(peers, seq = Date.now()) {
  return { v: 1, seq, keepFor: 7 * 86400, peers: peers.map((P) => {
    P.keys = P.keys || H.generateKeyPair();
    P.token = P.token || S.b64u(S.newSecret());
    return { address: P.address, kid: S.kidOf(P.address, P.keys.pk), pk: S.b64u(P.keys.pk), token: P.token };
  }) };
}

// ---------------------------------------------------------------- the module under test
let noStamp = false;
let online = { recent: false, since: null, mobile: false };
const contacts = Contacts.create({ dataDir: DATA, now });
const fast = { tickMs: 60000, presenceEveryMs: 60000, saveDelayMs: 1, statusRetry: [20, 20, 20], afterOnlineMs: 10, quickCheckMs: 30, quickPauseMs: 20 };
const events = [];
function makeSend() {
  const s = Send.create({ dataDir: DATA, outbox, contacts, now, timing: fast, clientFor: (a) => fakes.get(a),
    payloadFor: (qid) => { const i = outbox.get(qid); return i ? { ...i.envelope, from: ME, ...(noStamp ? {} : { stamp: 'st' }) } : null; },
    presence: { recent: () => online.recent, check: async () => online.recent, onlineSince: () => online.since, mobile: () => online.mobile } });
  for (const e of ['state', 'full', 'want-details', 'refused']) s.on(e, (x) => events.push({ e, ...x }));
  return s;
}
let send = makeSend();
async function sendMsg(to, cls = 'text', { ct = 'ct-' + randomBytes(6).toString('hex'), route = 'swarm-ok' } = {}) {
  const p = await send.plan({ to, cls, route });
  if (p.mode === 'direct') { const qid = outbox.enqueue(to, { ct }, ME, null, 'm-' + ct); await outbox.deliverNow(qid, { tries: 1 }); return { qid, ct, p }; }
  const qid = outbox.enqueue(to, { ct }, ME, p.expiry * 1000 - Date.now(), 'm-' + ct, { held: p.held, owned: true });
  send.track({ qid, to, msgId: 'm-' + ct, cls, mode: p.mode, expiry: p.expiry });
  if (!p.held) { const r = await outbox.deliverNow(qid, { tries: 1 }); if (r === 'queued' && p.mode === 'direct-first') send.directFailed(qid); }
  return { qid, ct, p };
}
const settle = async (n = 3) => { for (let i = 0; i < n; i++) { send._pump(); await sleep(15); } };
const stateOf = (qid) => send.stateOf(qid);
const outcomeOf = (qid) => outbox.outcomes().find((o) => o.id === qid);
const fresh = () => { send.removeContact(BOB); outbox.removeFor(BOB); P1.drops.clear(); P2.drops.clear(); P1.script = []; P2.script = []; P1.answer = P2.answer = 'ok'; P1.statusDown = P2.statusDown = false; events.length = 0; send.kick(); };
const neverHeldDirect = () => posted.every((p) => !p.held);

console.log('1. Contacts\' details');
{
  const d = detailsFor([P1, P2]);
  ok('a valid details frame is kept', contacts.setDetails(BOB, d) === 'updated' && contacts.get(BOB).peers.length === 2);
  ok('the same seq again is stale', contacts.setDetails(BOB, d) === 'stale');
  const bad = JSON.parse(JSON.stringify(d)); bad.seq++; bad.peers[0].kid = 'f'.repeat(16);
  ok('a kid that isn\'t its key\'s: the whole frame refused', contacts.setDetails(BOB, bad) === 'invalid');
  const bad2 = JSON.parse(JSON.stringify(d)); bad2.seq++; bad2.peers[0].pk = S.b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]));
  ok('a key that isn\'t a point on the curve: refused', contacts.setDetails(BOB, bad2) === 'invalid');
  const bad3 = JSON.parse(JSON.stringify(d)); bad3.seq = Date.now() + 400 * 86400000;
  ok('a seq more than a year ahead: refused', contacts.setDetails(BOB, bad3) === 'invalid');
  ok('keepFor out of range: refused', contacts.setDetails(BOB, { ...d, seq: d.seq + 1, keepFor: 30 * 86400 }) === 'invalid');
  ok('nobody without details: no mailbox', contacts.get(ANA) === null);
  ok('a request for fresh details at most once a day', contacts.wantFresh(BOB) === true && contacts.wantFresh(BOB) === false);
}

console.log('2. Text: held for the mailbox, to every peer');
{
  const { qid, p } = await sendMsg(BOB, 'text');
  await settle();
  ok('held: the outbox never tries it directly', p.mode === 'held' && outbox.get(qid).held && !posted.length);
  await outbox._flush();
  ok('…not even at a retry round', !posted.length);
  ok('one drop at each peer', P1.drops.size === 1 && P2.drops.size === 1);
  ok('shown 📮 once a peer took it', stateOf(qid).shown === 'mailbox' && events.some((e) => e.e === 'state' && e.id === qid && e.shown === 'mailbox'));
  ok('the expiry is whole hours and at most 7 days away', p.expiry % 3600 === 0 && p.expiry * 1000 - clock.t <= 7 * 86400000 + 3600000);
  const d1 = [...P1.drops.values()][0];
  const env = S.openDrop({ body: d1.body, peerAddress: P1.address, sk: P1.keys.sk, pk: P1.keys.pk, expiry: d1.expiry });
  ok('the drop opens at the peer\'s key to the envelope, with the sender', env.from === ME && env.ct === outbox.get(qid).envelope.ct);
  P1.collectAll();
  await sleep(120);
  ok('collected at one peer: delivered', outcomeOf(qid)?.outcome === 'delivered' && !outbox.get(qid) && !send.owns(qid), JSON.stringify(outcomeOf(qid)));
  ok('…and it never went directly', !posted.length);
  ok('…and its sealed bodies are gone from disk', !readdirSync(join(DATA, 'swarm-drops')).some((f) => f.startsWith(qid)));
}

console.log('3. Photos and files: to one peer, the next on failure');
{
  P1.drops.clear(); P2.drops.clear();
  const { qid, p } = await sendMsg(BOB, 'media');
  await settle();
  ok('the contact offline: into the mailbox at once', p.mode === 'held');
  ok('to one peer only', P1.drops.size + P2.drops.size === 1);
  const first = P1.drops.size ? P1 : P2, other = first === P1 ? P2 : P1;
  first.collectAll(); await sleep(120);
  ok('delivered', outcomeOf(qid)?.outcome === 'delivered');
  // the first peer fails on the network: the second takes it, and the first becomes suspect
  P1.drops.clear(); P2.drops.clear();
  P1.script = ['net']; P2.script = [];
  const pre = P1.dropCalls;
  // make P1 the most recently working peer, so it is chosen first
  const r2 = await sendMsg(BOB, 'media');
  await settle(5);
  const tried1 = P1.dropCalls > pre;
  ok('no route to the first: the next peer has it', (tried1 ? P2.drops.size === 1 : P1.drops.size === 1) && stateOf(r2.qid).shown === 'mailbox', `${P1.drops.size} ${P2.drops.size}`);
  ok('…and it is not sent directly', !posted.some((x) => x.ct === r2.ct));
  P1.collectAll(); P2.collectAll(); await sleep(120);
  ok('delivered', outcomeOf(r2.qid)?.outcome === 'delivered');
  void other;
}

console.log('4. Photos when both are online: directly first');
{
  online.recent = true; direct = 'up'; P1.drops.clear(); P2.drops.clear();
  const { qid, p, ct } = await sendMsg(BOB, 'media');
  ok('the contact answered in the last minute: direct first', p.mode === 'direct-first' && posted.some((x) => x.ct === ct) && outcomeOf(qid)?.outcome === 'delivered');
  ok('…no drop at all', P1.drops.size + P2.drops.size === 0);
  direct = 'down';
  const r = await sendMsg(BOB, 'media');
  await settle();
  ok('the direct upload failed: into the mailbox', r.p.mode === 'direct-first' && outbox.get(r.qid)?.held && P1.drops.size + P2.drops.size === 1);
  online.mobile = true;
  const r3 = await sendMsg(BOB, 'media');
  ok('to a phone: into the mailbox at once', r3.p.mode === 'held');
  online.mobile = false; online.recent = false;
  P1.collectAll(); P2.collectAll(); await sleep(120); await settle();
}

console.log('5. Answers from a peer');
{
  fresh();
  // 403 at one peer: fresh details asked for, and the message goes directly too
  P1.script = [403]; P2.script = [];
  clock.t += 25 * 3600 * 1000;          // a day after the last request for fresh details
  const r = await sendMsg(BOB, 'text');
  await settle(); await outbox._flush();
  ok('403: the message is released and tried directly', stateOf(r.qid)?.route === 'released' && posted.some((x) => x.ct === r.ct && !x.held), JSON.stringify(stateOf(r.qid)));
  ok('…the contact is asked for fresh details', events.some((e) => e.e === 'want-details' && e.toAddress === BOB));
  ok('…but the person isn\'t told "their mailbox refused it": fresh details were just asked for, and their other peer holds it', !events.some((e) => e.e === 'refused'));
  P2.collectAll(); await sleep(120);
  ok('collected at the other peer: delivered', outcomeOf(r.qid)?.outcome === 'delivered');
  // refused at both peers, with fresh details already asked for today: now it is said
  fresh(); P1.script = [403]; P2.script = [403];
  const rr = await sendMsg(BOB, 'text');
  await settle(); await outbox._flush();
  ok('refused at every peer of theirs, details already asked for: the window is told (it says so once in 6 hours)', events.some((e) => e.e === 'refused' && e.toAddress === BOB));
  ok('…and it went directly', stateOf(rr.qid)?.route === 'released');
  // 503 full: the chat is told, media goes to the next peer
  fresh();
  P1.script = ['full', 'full']; P2.script = ['full', 'full'];
  const r2 = await sendMsg(BOB, 'media');
  await settle(5);
  ok('503 full: the chat is told', events.some((e) => e.e === 'full' && e.toAddress === BOB));
  ok('…both peers full: sent directly (nothing lost)', stateOf(r2.qid)?.route === 'released');
  // 410 when only the clocks disagree: sealed again once on the peer's clock
  fresh(); P1.script = ['expired410']; P1.offset = 0;
  const r3 = await sendMsg(BOB, 'text');
  await settle(5);
  const d = [...P1.drops.values()].find((x) => x.body && S.openDrop({ body: x.body, peerAddress: P1.address, sk: P1.keys.sk, pk: P1.keys.pk, expiry: x.expiry }).ct === r3.ct);
  ok('410 with time left on our clock: resealed once and accepted', !!d, P1.dropCalls);
  // 429 busy: retried later, not given up
  fresh(); P1.script = [429]; P2.script = [429];
  const r4 = await sendMsg(BOB, 'text');
  await settle(3);
  ok('429 at both: busy, kept for a retry (and sent directly meanwhile)', Object.values(send._debug().msgs.find((m) => m.qid === r4.qid).copies).every((c) => c.state === 'busy'));
  P1.collectAll(); P2.collectAll(); await sleep(120); await settle();
}

{
  fresh(); noStamp = true;
  const r = await sendMsg(BOB, 'text'); await settle();
  ok('no stamp key for them yet: nothing is sealed or dropped', P1.drops.size + P2.drops.size === 0 && stateOf(r.qid)?.route === 'held');
  noStamp = false; clock.t += 31000; await settle();
  ok('…once the key is there, it goes to their peers', P1.drops.size === 1 && P2.drops.size === 1);
  P1.collectAll(); await sleep(120);
}
console.log('6. Suspect peers, the second copy, lost copies');
{
  fresh(); P1.answer = 'net'; P2.answer = 'net';
  const r = await sendMsg(BOB, 'text');
  await settle(3);
  ok('no peer reachable: the message goes directly at once', stateOf(r.qid)?.route === 'released');
  const r2 = await sendMsg(BOB, 'text');
  ok('while all their peers are suspect, new messages go directly at once (direct+bg)', r2.p.mode === 'direct+bg' && outbox.get(r2.qid) && !outbox.get(r2.qid).held);
  P1.answer = 'ok'; P2.answer = 'ok';
  send.kick(); await settle(5);
  ok('the network back: the peers are tried at once and take them', P1.drops.size >= 2 && P2.drops.size >= 2, `${P1.drops.size} ${P2.drops.size}`);
  P1.collectAll(); P2.collectAll(); await sleep(150); await settle();
  // a photo at one peer that loses it: a second copy, and sent directly
  P1.drops.clear(); P2.drops.clear();
  const r3 = await sendMsg(BOB, 'media');
  await settle();
  const holder = P1.drops.size ? P1 : P2, spare = holder === P1 ? P2 : P1;
  const id = [...holder.drops.keys()][0];
  holder.drops.delete(id);          // the peer has no record of it any more
  await send.cameOnline(BOB); await sleep(80); await settle(3);
  ok('"unknown" for an accepted photo: a second copy at the other peer', spare.drops.size === 1, `${spare.drops.size}`);
  ok('…and it is sent directly too', stateOf(r3.qid)?.route === 'released');
  spare.collectAll(); await sleep(120);
  ok('delivered once collected', outcomeOf(r3.qid)?.outcome === 'delivered');
  // a photo whose only peer has been unreachable 2 hours: a second copy
  fresh();
  const r4 = await sendMsg(BOB, 'media'); await settle();
  const h4 = P1.drops.size ? P1 : P2, s4 = h4 === P1 ? P2 : P1;
  h4.statusDown = true; h4.answer = 'net';
  await sleep(80);          // the live status fails: the peer is suspect
  clock.t += 2 * 3600 * 1000 + 1000;
  await settle(3);
  ok('its only peer unreachable for 2 hours: a second copy', s4.drops.size === 1, `${s4.drops.size}`);
  h4.statusDown = false; h4.answer = 'ok';
  s4.collectAll(); await sleep(150);
  ok('delivered from the second copy', outcomeOf(r4.qid)?.outcome === 'delivered');
}

console.log('7. Sending directly when collection isn\'t working');
{
  P1.drops.clear(); P2.drops.clear(); send.kick();
  const r = await sendMsg(BOB, 'text'); await settle();
  online.since = clock.t;
  send._collectionCheck();
  ok('online, but not long enough yet: still only in the mailbox', stateOf(r.qid)?.route === 'held');
  clock.t += 31000;
  send._collectionCheck(); await outbox._flush();
  ok('online 30 s and nothing collected: sent directly too', stateOf(r.qid)?.route === 'released' && posted.some((x) => x.ct === r.ct && !x.held));
  const rm = await sendMsg(BOB, 'media'); await settle();
  clock.t += 31000; send._collectionCheck();
  ok('a photo waits 10 minutes, not 30 s', stateOf(rm.qid)?.route === 'held');
  clock.t += 10 * 60000; send._collectionCheck();
  ok('…then goes directly too', stateOf(rm.qid)?.route === 'released');
  online.since = null;
  P1.collectAll(); P2.collectAll(); await sleep(150); await settle();
}

console.log('8. The end of a message');
{
  P1.drops.clear(); P2.drops.clear();
  const r = await sendMsg(BOB, 'text'); await settle();
  clock.t = (r.p.expiry * 1000) + 1000;
  send._settleAll(); await sleep(80); send._settleAll(); await sleep(30);
  ok('held at the peer until its end, never collected: "not confirmed"', outcomeOf(r.qid)?.outcome === 'not-confirmed', JSON.stringify(outcomeOf(r.qid)));
  P1.answer = 'net'; P2.answer = 'net';
  const r2 = await sendMsg(BOB, 'text'); await settle(3);
  outbox.get(r2.qid).expiresAt = Date.now() - 1; outbox._purgeOld();
  clock.t = r2.p.expiry * 1000 + 1000; send._settleAll(); await sleep(30);
  ok('no peer ever took it, the direct path ran out: "not delivered"', outcomeOf(r2.qid)?.outcome === 'not-delivered', JSON.stringify(outcomeOf(r2.qid)));
  P1.answer = 'ok'; P2.answer = 'ok'; send.kick();
  // delivered is never replaced
  const r3 = await sendMsg(BOB, 'text'); await settle();
  P1.collectAll(); await sleep(120);
  outbox.complete(r3.qid, 'not-confirmed');
  ok('nothing replaces delivered', outcomeOf(r3.qid)?.outcome === 'delivered');
}

console.log('9. A restart');
{
  P1.drops.clear(); P2.drops.clear();
  const r = await sendMsg(BOB, 'text'); await settle();
  send.stop();
  send = makeSend(); send.start(); await sleep(50);
  ok('after a restart the message is still in the mailbox state', stateOf(r.qid)?.shown === 'mailbox');
  P1.collectAll(); await sleep(150);
  ok('…and its collection is still seen', outcomeOf(r.qid)?.outcome === 'delivered');
  // a held message whose state was lost: released, never stuck
  const q = outbox.enqueue(BOB, { ct: 'orphan' }, ME, 3600000, 'm-orphan', { held: true });
  send.stop(); send = makeSend(); send.start(); await sleep(30);
  ok('a held message with nothing to carry it is released at start', !outbox.get(q)?.held);
}

console.log('9b. A peer that lies or floods, and the outbox\'s own changes (the audit\'s findings)');
{
  fresh(); P1.keepAnswer = 9e12; P2.keepAnswer = 9e12;
  const r = await sendMsg(BOB, 'text'); await settle();
  const kept = Math.max(...Object.values(send._debug().msgs.find((m) => m.qid === r.qid).copies).map((c) => c.keepUntil || 0));
  ok('a peer saying "kept for ever": clamped to the message\'s own expiry', kept <= r.p.expiry * 1000 + 3600e3, kept);
  clock.t = r.p.expiry * 1000 + 2 * 3600e3; send._settleAll(); await sleep(80); send._settleAll(); await sleep(30);
  ok('…so it still reaches an outcome at its end', outcomeOf(r.qid)?.outcome === 'not-confirmed', JSON.stringify(outcomeOf(r.qid)));
  P1.keepAnswer = P2.keepAnswer = 0;
  // a peer that ignores wait and answers at once: the live status pauses instead of asking without end
  fresh(); const r2 = await sendMsg(BOB, 'text'); await settle();
  const s0 = P1.statusCalls + P2.statusCalls; await sleep(1000);
  const n = P1.statusCalls + P2.statusCalls - s0;
  ok('a peer answering status at once with nothing new: a handful of requests a second, not thousands', n < 40, n);
  // the window takes a held message out of the outbox (sent again on a new session): forgotten here, no late ✓ or ⚠ for it
  outbox.remove(r2.qid); await sleep(20);
  ok('a held message removed from the outbox is forgotten by the mailbox sending', !send.owns(r2.qid));
  P1.collectAll(); await sleep(100);
  ok('…and its collection later reports nothing', !outcomeOf(r2.qid));
  // quitting with a peer down: copies waiting for that peer's next try don't count as leaving now
  fresh(); P1.answer = 'net'; P2.answer = 'net';
  await sendMsg(BOB, 'text'); await settle(3);
  ok('quit flush: nothing counted as about to leave when every peer is waiting for its next try', send.pending() === 0, send.pending());
  P1.answer = P2.answer = 'ok'; send.kick(); await settle();
  // a photo that was going directly when the app quit: into the mailbox at the next start
  fresh(); online.recent = true; direct = 'down';
  const pl = await send.plan({ to: BOB, cls: 'media' });
  const qid = outbox.enqueue(BOB, { ct: 'dfq' }, ME, pl.expiry * 1000 - Date.now(), 'm-dfq', { owned: true });
  send.track({ qid, to: BOB, msgId: 'm-dfq', cls: 'media', mode: pl.mode, expiry: pl.expiry });
  online.recent = false;
  send.stop(); send = makeSend(); send.start(); await sleep(50); await settle();
  ok('a photo still going directly when the app quit goes to the mailbox at the next start', pl.mode === 'direct-first' && outbox.get(qid)?.held && P1.drops.size + P2.drops.size === 1, `${pl.mode} ${outbox.get(qid)?.held}`);
  P1.collectAll(); P2.collectAll(); await sleep(120); await settle();
}

console.log('10. The rules, under random event sequences');
{
  const rnd = (n) => Math.floor(Math.random() * n);
  let violations = [];
  for (let run = 0; run < 25; run++) {
    P1.drops.clear(); P2.drops.clear(); posted.length = 0;
    const answers = ['ok', 'ok', 'ok', 'net', 403, 404, 409, 413, 429, 'full', 'expired410'];
    const qids = [];
    for (let k = 0; k < 6; k++) {
      P1.script = [answers[rnd(answers.length)]]; P2.script = [answers[rnd(answers.length)]];
      direct = ['up', 'down', 'down', 'refuse'][rnd(4)];
      online.recent = rnd(3) === 0; online.since = rnd(2) ? clock.t - rnd(700000) : null;
      const r = await sendMsg(BOB, rnd(2) ? 'text' : 'media'); qids.push(r);
      for (let s = 0; s < 3; s++) {
        const ev2 = rnd(6);
        if (ev2 === 0) P1.collectAll(); else if (ev2 === 1) P2.collectAll();
        else if (ev2 === 2) clock.t += rnd(3600000);
        else if (ev2 === 3) send._collectionCheck();
        else if (ev2 === 4) await outbox._flush();
        else send.kick();
        await settle(2);
      }
    }
    // the end of every message plus one status round
    direct = 'down';
    for (const { qid } of qids) { const i = outbox.get(qid); if (i) i.expiresAt = Date.now() - 1; }
    outbox._purgeOld();
    clock.t += 8 * 86400 * 1000;
    send._settleAll(); await sleep(60); send._settleAll(); await sleep(30);
    for (const { qid } of qids) {
      const o = outcomeOf(qid);
      if (!o) violations.push('no outcome for ' + qid + ' ' + JSON.stringify(send.stateOf(qid)));
    }
    if (!neverHeldDirect()) violations.push('a held message went directly');
    if (outbox.queue.some((i) => i.held)) violations.push('a held message left in the queue');
  }
  ok('a held message never went directly, and every message reached an outcome (25 runs, 150 messages)', !violations.length, violations.slice(0, 3).join(' | '));
}
send.stop();

// ---------------------------------------------------------------- part 2: the real peer
const PEER = process.env.MAILBOX_PEER_DIR;
if (PEER && existsSync(join(PEER, 'test/helpers.mjs'))) {
  console.log('11. End to end against the real mailbox peer (' + PEER + ')');
  const PC = require(join(APP, 'lib/swarm/peerclient.js'));
  const ph = await import(pathToFileURL(join(PEER, 'test/helpers.mjs')).href);
  const pclock = { t: Date.now() };
  const h = await ph.startPeer({ clock: pclock, waitMax: 2 });
  const PA = ph.ADDR;
  const socks = await startSocks((host) => (host === PA ? { path: h.sock } : 'refuse'));
  const FAST = { connectMs: 2000, connectColdMs: 3000, baseMs: 5000 };
  const owner = PC.create({ address: PA, socksUrl: socks.url, timing: FAST });
  const sender = PC.create({ address: PA, socksUrl: socks.url, timing: FAST });
  const realT = { t: Date.now() };
  try {
    // Bob joins the peer (the owner's side is phase 3; here by hand) and gives Ana his details
    const inv = await h.store.createInvite({});
    const sec = S.newSecret(), o = { secret: S.b64u(sec) };
    o.mailbox = (await owner.join(inv.invite, S.sha256hex(sec))).mailbox;
    const keys = H.generateKeyPair(), kid = S.kidOf(PA, keys.pk), tok = S.newSecret();
    await owner.tokens(o, { add: [S.sha256hex(tok)], kids: [kid] });
    const DATA2 = mkdtempSync(join(tmpdir(), 'swarm-send2-'));
    const c2 = Contacts.create({ dataDir: DATA2 });
    const BOB2 = addr('e');
    ok('Bob\'s details are taken', c2.setDetails(BOB2, { v: 1, seq: Date.now(), keepFor: 7 * 86400, peers: [{ address: PA, kid, pk: S.b64u(keys.pk), token: S.b64u(tok) }] }) === 'updated');
    const s2 = Send.create({ dataDir: DATA2, outbox, contacts: c2, now: () => Date.now(), clientFor: () => sender, timing: { tickMs: 200, saveDelayMs: 1, statusWait: 2 },
      payloadFor: (qid) => { const i = outbox.get(qid); return i ? { ...i.envelope, from: ME, stamp: 'st' } : null; }, presence: {} });
    const states = []; s2.on('state', (x) => states.push(x.shown));
    s2.start();
    direct = 'down';
    const p = await s2.plan({ to: BOB2, cls: 'text' });
    const env = { ct: 'real-peer-' + randomBytes(4).toString('hex'), dh: 'x', n: 1, pn: 0 };
    const qid = outbox.enqueue(BOB2, env, ME, p.expiry * 1000 - Date.now(), 'm-real', { held: true });
    s2.track({ qid, to: BOB2, msgId: 'm-real', cls: 'text', mode: p.mode, expiry: p.expiry });
    for (let i = 0; i < 50 && s2.stateOf(qid)?.shown !== 'mailbox'; i++) await sleep(50);
    ok('Ana\'s message is in Bob\'s mailbox (📮)', s2.stateOf(qid)?.shown === 'mailbox');
    const f = await owner.collect(o, { cursor: '0' });
    const got = f.drops.length === 1 && S.openDrop({ body: f.drops[0].body, peerAddress: PA, sk: keys.sk, pk: keys.pk, expiry: f.drops[0].expiry });
    ok('Bob collects it and it opens to Ana\'s envelope', got && got.ct === env.ct && got.from === ME);
    await owner.ack(o, [{ id: f.drops[0].id, result: 'stored' }]);
    for (let i = 0; i < 100 && !outcomeOf(qid); i++) await sleep(50);
    ok('Ana sees ✓ through the live status, and nothing went directly', outcomeOf(qid)?.outcome === 'delivered' && !posted.some((x) => x.ct === env.ct), JSON.stringify(outcomeOf(qid)));
    ok('the states went ⏳ → 📮 → ✓', states.join(',') === 'waiting,mailbox,delivered', states.join(','));
    // a photo-sized message: the 1 MiB step, collected by id
    const big = { ct: 'B'.repeat(700000), dh: 'x', n: 2, pn: 0 };
    const pm = await s2.plan({ to: BOB2, cls: 'media' });
    const q2 = outbox.enqueue(BOB2, big, ME, pm.expiry * 1000 - Date.now(), 'm-big', { held: true });
    s2.track({ qid: q2, to: BOB2, msgId: 'm-big', cls: 'media', mode: pm.mode, expiry: pm.expiry });
    for (let i = 0; i < 100 && s2.stateOf(q2)?.shown !== 'mailbox'; i++) await sleep(50);
    const f2 = await owner.collect(o, { cursor: f.cursor });
    ok('a 700 kB message is dropped in the 1 MiB step', f2.drops.length === 1 && f2.drops[0].size === 1048576);
    await owner.ack(o, [{ id: f2.drops[0].id, result: 'stored' }]);
    for (let i = 0; i < 100 && !outcomeOf(q2); i++) await sleep(50);
    ok('…and is delivered', outcomeOf(q2)?.outcome === 'delivered');
    // Bob discards one (say, he blocked Ana): Ana sends it directly
    const q3 = outbox.enqueue(BOB2, { ct: 'disc', dh: 'x' }, ME, 3600000, 'm-disc', { held: true });
    s2.track({ qid: q3, to: BOB2, msgId: 'm-disc', cls: 'text', mode: 'held', expiry: S.expiryAfter(3600) });
    for (let i = 0; i < 100 && s2.stateOf(q3)?.shown !== 'mailbox'; i++) await sleep(50);
    const f3 = await owner.collect(o, { cursor: f2.cursor });
    await owner.ack(o, [{ id: f3.drops[0].id, result: 'discarded' }]);
    for (let i = 0; i < 100 && s2.stateOf(q3)?.route !== 'released'; i++) await sleep(50);
    ok('discarded by the recipient: released to the direct path', s2.stateOf(q3)?.route === 'released');
    // a token the peer doesn't know (Bob removed Ana): 403, fresh details asked for, sent directly
    let wanted = false; s2.on('want-details', () => { wanted = true; });
    c2.setDetails(BOB2, { v: 1, seq: Date.now() + 5, keepFor: 7 * 86400, peers: [{ address: PA, kid, pk: S.b64u(keys.pk), token: S.b64u(S.newSecret()) }] });
    const q4 = outbox.enqueue(BOB2, { ct: 'tok', dh: 'x' }, ME, 3600000, 'm-tok', { held: true });
    s2.track({ qid: q4, to: BOB2, msgId: 'm-tok', cls: 'text', mode: 'held', expiry: S.expiryAfter(3600) });
    for (let i = 0; i < 100 && s2.stateOf(q4)?.route !== 'released'; i++) await sleep(50);
    ok('an unknown token: 403, fresh details asked for, sent directly', s2.stateOf(q4)?.route === 'released' && wanted);
    s2.stop();
    void realT;
  } finally { owner.close(); sender.close(); socks.close(); await h.stop(); }
} else console.log('11. (the real mailbox peer: set MAILBOX_PEER_DIR to a mailbox-peer source folder to run it)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
