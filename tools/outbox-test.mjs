// Offline queue (lib/outbox.js) with a fake network: what each answer from the recipient does to a queued message.
// Run: node tools/outbox-test.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'outbox-'));
process.env.OUTBOX_ROUND_WAIT_MS = '400';    // a round waits at most this long for a slow recipient (60 s in the app)
const require = createRequire(import.meta.url);
require(join(APP, 'lib/sealed.js')).setKey(randomBytes(32));
const outbox = require(join(APP, 'lib/outbox.js'));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  [' + detail + ']')); };
const httpErr = (status, data = {}) => Object.assign(new Error('Request failed with status code ' + status), { response: { status, data } });

let answer = () => ({});                 // what the recipient does with the next POST
const posted = [];
const onion = () => ({ post: async (url, body) => { posted.push(body); const a = await answer(body); if (a instanceof Error) throw a; return { data: a }; } });
let key = null;
outbox.init({ onion, pow: { solveAsync: async () => 'nonce' }, myAddress: () => 'me.anyone',
  stamp: (env, from, to) => { const { stamp: _s, ...plain } = env; return key ? { ...plain, stamp: key + ':' + to } : plain; } });
const events = [];
for (const e of ['delivered', 'expired', 'queued']) outbox.on(e, (x) => events.push(e + ':' + x.id));
const TO = 'b'.repeat(56) + '.anyone';

// 409: an earlier attempt already arrived → delivered, not retried for a week
let id = outbox.enqueue(TO, { ct: 'c1', dh: 'd' }, 'me.anyone');
answer = () => httpErr(409);
await outbox._flush();
ok('409 (already received) counts as delivered', events.includes('delivered:' + id) && !outbox.list().some((i) => i.id === id), events);

// 400: never acceptable → given up at once
id = outbox.enqueue(TO, { ct: 'c2', dh: 'd' }, 'me.anyone');
answer = () => httpErr(400);
await outbox._flush();
ok('400 (malformed) is given up at once', events.includes('expired:' + id) && !outbox.list().some((i) => i.id === id), events);

// 503: kept and retried
id = outbox.enqueue(TO, { ct: 'c3', dh: 'd' }, 'me.anyone');
answer = () => httpErr(503);
await outbox._flush();
ok('503 (busy) keeps the message for later', outbox.list().some((i) => i.id === id));

// queued without a stamp key, the key turns up: the next attempt carries a stamp
posted.length = 0; key = 'K';
answer = () => ({ ok: true });
await outbox._flush();
ok('a message queued before the stamp key was known is stamped when it goes out', posted.length === 1 && posted[0].stamp === 'K:' + TO && posted[0].from === 'me.anyone', JSON.stringify(posted));
ok('…and delivered', events.includes('delivered:' + id));

// proof of work, then 409 on the paid retry
id = outbox.enqueue(TO, { ct: 'c4', dh: 'd', stamp: 'forged' }, 'me.anyone');
posted.length = 0;
let n = 0; answer = () => (n++ === 0 ? httpErr(402, { challenge: 'ch', bits: 8 }) : httpErr(409));
await outbox._flush();
ok('proof of work then 409 counts as delivered', events.includes('delivered:' + id), events);
ok('a stamp set by the window is never sent as is', posted.every((p) => p.stamp === 'K:' + TO) && posted[1].pow && posted[1].pow.n === 'nonce', JSON.stringify(posted));


// one recipient offline with three waiting, another online: one attempt for the offline one per round, and the online one isn't held up
for (const i of outbox.list()) outbox.remove(i.id);
const OFF = 'o'.repeat(56) + '.anyone', ON = 'n'.repeat(56) + '.anyone';
for (let k = 0; k < 3; k++) outbox.enqueue(OFF, { ct: 'off' + k, dh: 'd' }, 'me.anyone');
const onId = outbox.enqueue(ON, { ct: 'on1', dh: 'd' }, 'me.anyone');
posted.length = 0;
let deliveredAt = null; const t0 = Date.now();
outbox.once('delivered', (x) => { if (x.id === onId) deliveredAt = Date.now() - t0; });
answer = (body) => (body.ct.startsWith('off') ? new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), {})), 300)) : ({ ok: true }));
const onionSlow = () => ({ post: async (url, body) => { posted.push(body); const a = await answer(body); return { data: a }; } });
outbox._onion = onionSlow;
await outbox._flush();
ok('an offline recipient gets one attempt per round, not one per waiting message', posted.filter((p) => p.ct.startsWith('off')).length === 1, posted.map((p) => p.ct).join());
ok('…and doesn’t hold up a recipient who is online', deliveredAt !== null && deliveredAt < 200, deliveredAt);
ok('the offline recipient’s messages stay queued, in order', outbox.list().filter((i) => i.toAddress === OFF).length === 3);
// they reach us: flushTo sends everything waiting for them, oldest first
posted.length = 0; answer = () => ({ ok: true });
await outbox.flushTo(OFF);
ok('flushTo sends everything waiting for that recipient, oldest first', posted.map((p) => p.ct).join() === 'off0,off1,off2' && !outbox.list().length, posted.map((p) => p.ct).join());

// Busy with a short Retry-After (a burst limit): retried after that delay, not at the next 15 s round, still in order
const BUSY = 'c'.repeat(56) + '.anyone';
outbox._onion = onion;
for (let i = 0; i < 3; i++) outbox.enqueue(BUSY, { ct: 'busy' + i, dh: 'd' }, 'me.anyone');
posted.length = 0;
let first = true;
answer = () => { if (first) { first = false; return Object.assign(httpErr(429), { response: { status: 429, data: {}, headers: { 'retry-after': '1' } } }); } return { ok: true }; };
await outbox.flushTo(BUSY);
ok('a busy answer leaves the rest waiting behind the first', outbox.list().filter((i) => i.toAddress === BUSY).length === 3 && posted.length === 1);
await new Promise((r) => setTimeout(r, 1600));
ok('…and they go out after its Retry-After (1 s), oldest first', !outbox.list().some((i) => i.toAddress === BUSY) && posted.map((p) => p.ct).join() === 'busy0,busy0,busy1,busy2', posted.map((p) => p.ct).join());

// One message the recipient keeps refusing (an error that isn't "busy") doesn't hold up the ones behind it
const STUCK = 'd'.repeat(56) + '.anyone';
outbox.enqueue(STUCK, { ct: 'bad', dh: 'd' }, 'me.anyone'); outbox.enqueue(STUCK, { ct: 'good', dh: 'd' }, 'me.anyone');
posted.length = 0;
answer = (b) => (b.ct === 'bad' ? httpErr(500) : { ok: true });
await outbox.flushTo(STUCK);
ok('a message refused with 500 doesn’t block the next one', posted.map((p) => p.ct).join() === 'bad,good' && outbox.queue.filter((i) => i.toAddress === STUCK).map((i) => i.envelope.ct).join() === 'bad', posted.map((p) => p.ct).join());

// ---- Sending a new message (deliverNow): written to the queue before the first try, one run per recipient ----
const { readFileSync, existsSync } = await import('node:fs');
const sealed = require(join(APP, 'lib/sealed.js'));
// What a restart would find: the index, and each message from its own file.
const queueOnDisk = () => {
  const f = join(process.env.DATA_DIR, 'outbox.json');
  if (!existsSync(f)) return [];
  return JSON.parse(sealed.open(readFileSync(f), 'outbox').toString()).items.map((i) => {
    const e = join(process.env.DATA_DIR, 'outbox', i.id + '.env');
    return { ...i, envelope: existsSync(e) ? JSON.parse(sealed.open(readFileSync(e), 'outbox-env').toString()) : null };
  });
};
const NEW = 'e'.repeat(56) + '.anyone';
let release; const hold = new Promise((r) => { release = r; });
let seenOnDisk = null;
answer = (b) => { if (b.ct === 'first') { seenOnDisk = queueOnDisk().some((i) => i.envelope.ct === 'first'); return hold; } return { ok: true }; };
outbox._onion = () => ({ post: async (url, body) => { posted.push(body); const a = await answer(body); if (a instanceof Error) throw a; return { data: a }; } });
posted.length = 0;
const q1 = outbox.enqueue(NEW, { ct: 'first', dh: 'd' }, 'me.anyone', 86400000, 'msg-1');
const p1 = outbox.deliverNow(q1, { gapMs: 10 });
await new Promise((r) => setTimeout(r, 30));
ok('a new message is on disk before its first try ends (closing the app can’t lose it)', seenOnDisk === true, seenOnDisk);
const q2 = outbox.enqueue(NEW, { ct: 'second', dh: 'd' }, 'me.anyone', 86400000, 'msg-2');
const p2 = outbox.deliverNow(q2, { gapMs: 10 });
await new Promise((r) => setTimeout(r, 30));
ok('a second message doesn’t wait for the first one’s try to finish (each try is a new connection)', posted.map((p) => p.ct).join() === 'first,second', posted.map((p) => p.ct).join());
release({ ok: true });
const [r1, r2] = await Promise.all([p1, p2]);
ok('…both delivered', r1 === 'delivered' && r2 === 'delivered', [r1, r2]);
// Once a message to someone is waiting in the queue (its first tries failed), a later one goes behind it, in the background: the window
// isn't kept waiting, and they arrive in the order written when the recipient is back
{
  const LANE = 'h'.repeat(56) + '.anyone';
  let up = false; posted.length = 0;
  answer = (b) => (up ? { ok: true } : new Error('connect ECONNREFUSED'));
  const qa = outbox.enqueue(LANE, { ct: 'lane-a', dh: 'd' }, 'me.anyone', 86400000);
  const ra = await outbox.deliverNow(qa, { tries: 1, gapMs: 1 });
  up = true;
  const qb = outbox.enqueue(LANE, { ct: 'lane-b', dh: 'd' }, 'me.anyone', 86400000);
  const t0 = Date.now();
  const rb = await outbox.deliverNow(qb, { gapMs: 1 });
  ok('after a message has fallen back to the queue, the next one goes behind it at once (the window isn’t kept waiting)', ra === 'queued' && rb === 'queued' && Date.now() - t0 < 50, [ra, rb, Date.now() - t0]);
  for (let k = 0; k < 100 && outbox.list().some((i) => i.toAddress === LANE); k++) await new Promise((r) => setTimeout(r, 5));
  ok('…and both go out in the background, the older one first', posted.map((p) => p.ct).join() === 'lane-a,lane-a,lane-b' && !outbox.list().some((i) => i.toAddress === LANE), posted.map((p) => p.ct).join());
}
const evs = []; const onDel = (x) => evs.push(x); outbox.on('delivered', onDel);
const q3 = outbox.enqueue(NEW, { ct: 'third', dh: 'd' }, 'me.anyone', null, 'msg-3');
await outbox.deliverNow(q3, { gapMs: 10 });
outbox.off('delivered', onDel);
ok('the delivered event carries the window’s message id', evs.some((e) => e.id === q3 && e.msgId === 'msg-3'), JSON.stringify(evs));

// Network failures: a few tries a moment apart, then kept for the background retry; a busy answer is not retried inline
posted.length = 0; let tries = 0;
answer = () => { tries++; return new Error('connect ECONNREFUSED'); };
const q4 = outbox.enqueue(NEW, { ct: 'offline', dh: 'd' }, 'me.anyone', 86400000);
const r4 = await outbox.deliverNow(q4, { gapMs: 10 });
ok('an unreachable recipient: 3 tries, then queued', r4 === 'queued' && tries === 3 && outbox.list().some((i) => i.id === q4), [r4, tries]);
outbox.remove(q4);
tries = 0; answer = () => { tries++; return Object.assign(httpErr(429), { response: { status: 429, data: {}, headers: { 'retry-after': '5' } } }); };
const q5 = outbox.enqueue(NEW, { ct: 'busy', dh: 'd' }, 'me.anyone', 86400000);
const r5 = await outbox.deliverNow(q5, { gapMs: 10 });
ok('a busy recipient: one try, then queued (Retry-After is honoured in the background)', r5 === 'queued' && tries === 1, [r5, tries]);
outbox.remove(q5);
answer = () => httpErr(413);
const q6 = outbox.enqueue(NEW, { ct: 'huge', dh: 'd' }, 'me.anyone', 86400000);
const r6 = await outbox.deliverNow(q6, { gapMs: 10 });
ok('refused outright (413): failed at once and taken out of the queue', r6 === 'failed' && !outbox.list().some((i) => i.id === q6), r6);

// ---- Disk use and restarts (batch 6) ----
const { statSync, readdirSync } = await import('node:fs');
const BIG = 'f'.repeat(56) + '.anyone';
for (const q of outbox.list()) outbox.remove(q.id);
answer = () => new Error('connect ECONNREFUSED');
const big = 'A'.repeat(3 * 1024 * 1024);
const bigIds = [0, 1, 2].map((k) => outbox.enqueue(BIG, { ct: big + k, dh: 'd' }, 'me.anyone', 86400000, 'big-' + k));
const idxFile = join(process.env.DATA_DIR, 'outbox.json'), envDir = join(process.env.DATA_DIR, 'outbox');
const before = { idx: statSync(idxFile).mtimeMs, env: readdirSync(envDir).map((f) => statSync(join(envDir, f)).mtimeMs).join() };
await new Promise((r) => setTimeout(r, 20));
for (let k = 0; k < 3; k++) await outbox._flush();
ok('retry rounds rewrite nothing: not the index, not the waiting messages', statSync(idxFile).mtimeMs === before.idx && readdirSync(envDir).map((f) => statSync(join(envDir, f)).mtimeMs).join() === before.env);
ok('…the index stays small (no attachments in it)', statSync(idxFile).size < 4096, statSync(idxFile).size);
const reloaded = outbox._load();
ok('a restart finds every waiting message, attachment included', bigIds.every((id) => reloaded.some((i) => i.id === id && i.envelope.ct.length === big.length + 1)));
// No try cap: still tried while its waiting time lasts
const capped = outbox.queue.find((i) => i.id === bigIds[0]);
capped.attempts = 6000;
await outbox._flush();
ok('6,000 tries in, a message with waiting time left is still queued (the old cap was 5,000)', outbox.list().some((i) => i.id === bigIds[0]));
// Outcomes kept for a window that wasn't connected, and across a restart
answer = () => ({ ok: true });
await outbox.flushTo(BIG);
const oc = outbox.outcomes().filter((o) => bigIds.includes(o.id));
ok('delivered messages are listed with the window’s message id', oc.length === 3 && oc.every((o) => o.outcome === 'delivered' && /^big-/.test(o.msgId)), JSON.stringify(oc));
ok('…and their files are gone', !readdirSync(envDir).some((f) => bigIds.some((id) => f.startsWith(id))));
outbox._outcomes.clear(); outbox._load();
ok('…the outcomes survive a restart', bigIds.every((id) => outbox._outcomes.get(id)?.outcome === 'delivered'));

// Back online with a backlog: they take the first, one try on a bad route fails, and the rest go a moment later, not at the next round
{
  const BACK = 'k'.repeat(56) + '.anyone';
  answer = () => new Error('connect ECONNREFUSED');
  for (let k = 0; k < 4; k++) outbox.enqueue(BACK, { ct: 'back' + k, dh: 'd' }, 'me.anyone', 86400000);
  posted.length = 0; let n = 0;
  answer = (b) => (b.ct === 'back1' && n++ === 0 ? new Error('socket hang up') : { ok: true });
  const t0 = Date.now();
  await outbox.flushTo(BACK);
  ok('a backlog: one failed try after they took one stops the run there', outbox.list().filter((i) => i.toAddress === BACK).length === 3);
  for (let k = 0; k < 200 && outbox.list().some((i) => i.toAddress === BACK); k++) await new Promise((r) => setTimeout(r, 25));
  const took = Date.now() - t0;
  ok('…and the rest go a few seconds later, in order, not at the next 15 s round', !outbox.list().some((i) => i.toAddress === BACK) && took < 5000 && posted.map((p) => p.ct).join() === 'back0,back1,back1,back2,back3', [took, posted.map((p) => p.ct).join()]);
}

// A recipient that starts answering and never finishes (one byte now and then) must not hold up the retry rounds for everyone else.
{
  const SLOW = 's'.repeat(56) + '.anyone', OTHER = 'o'.repeat(56) + '.anyone';
  let release; const hang = new Promise((r) => { release = r; });
  posted.length = 0;
  answer = (b) => (b.ct === 'slow' ? hang : { ok: true });
  const idSlow = outbox.enqueue(SLOW, { ct: 'slow', dh: 'd' }, 'me.anyone', 86400000);
  const idOther = outbox.enqueue(OTHER, { ct: 'fine', dh: 'd' }, 'me.anyone', 86400000);
  const t0 = Date.now();
  await outbox._flush();
  const took = Date.now() - t0;
  ok('a recipient that never finishes answering doesn\'t hold up the round: it ends after the round wait', took >= 350 && took < 3000, took);
  ok('…and the other recipient\'s message went out', !outbox.list().some((i) => i.id === idOther));
  const idOther2 = outbox.enqueue(OTHER, { ct: 'fine2', dh: 'd' }, 'me.anyone', 86400000);
  await outbox._flush();
  ok('the next round still delivers to others while that one is going', !outbox.list().some((i) => i.id === idOther2));
  ok('…and doesn\'t try the slow one a second time meanwhile', posted.filter((p) => p.ct === 'slow').length === 1, posted.map((p) => p.ct).join());
  release({ ok: true });
  for (let k = 0; k < 40 && outbox.list().some((i) => i.id === idSlow); k++) await new Promise((r) => setTimeout(r, 25));
  ok('when it finally answers, its message is done', !outbox.list().some((i) => i.id === idSlow));
}

// The failed-try hook gets the error (1.0.8): without an answer they could not be reached; with one (busy, a proof of work refused) they were
{
  const T2 = 'c'.repeat(56) + '.anyone', seen = [];
  outbox._onRetryFail = (addr, err) => { if (addr === T2) seen.push(err ? (err.response ? 'answered:' + err.response.status : 'unreached') : 'none'); };
  const unreached = () => Object.assign(new Error('Socks5 proxy rejected connection - HostUnreachable'), { code: 'ESOCKS' });
  const idA = outbox.enqueue(T2, { ct: 'h1', dh: 'd' }, 'me.anyone');
  answer = unreached; await outbox._flush();
  ok('a try that reaches nobody: the hook gets an error without an answer', seen.at(-1) === 'unreached', seen);
  answer = () => httpErr(503); for (const i of outbox.queue) i.retryAfter = null; await outbox._flush();
  ok('a busy answer (503): the hook gets the answer', seen.at(-1) === 'answered:503', seen);
  let n = 0; answer = () => (n++ % 2 === 0 ? httpErr(402, { challenge: 'c', bits: 1 }) : unreached());
  for (const i of outbox.queue) i.retryAfter = null; await outbox._flush();
  ok('a proof of work whose send then reaches nobody: counted as not reached', seen.at(-1) === 'unreached', seen);
  const realPow = outbox._pow; outbox._pow = { solveAsync: async () => { throw new Error('too much work'); } };
  answer = () => httpErr(402, { challenge: 'c', bits: 40 }); for (const i of outbox.queue) i.retryAfter = null; await outbox._flush();
  ok('a proof of work we could not do: their 402 answer goes along (they were reached)', seen.at(-1) === 'answered:402', seen);
  outbox._pow = realPow; outbox._onRetryFail = null;
  for (const i of [...outbox.queue]) if (i.toAddress === T2) outbox._drop(i);
}

// The computer sleeps in the middle of a send (1.0.8 audit): no more tries, and the failure hook is told when the try began
{
  const T3 = 'd'.repeat(56) + '.anyone', calls = []; let ready = true, ep = 1;
  const unreached = () => Object.assign(new Error('Socks5 proxy rejected connection - HostUnreachable'), { code: 'ESOCKS' });
  outbox._ready = () => ready; outbox._epoch = () => ep; outbox._onRetryFail = (addr, err, e) => { if (addr === T3) calls.push(e); };
  const idZ = outbox.enqueue(T3, { ct: 'z1', dh: 'd' }, 'me.anyone');
  let tries = 0; answer = async () => { tries++; if (tries === 1) { ready = false; ep = 2; } return unreached(); };          // the lid closes during the first try
  const r = await outbox.deliverNow(idZ, { tries: 3, gapMs: 20 });
  ok('a send in progress when the network stops being ready makes no second try', tries === 1 && r === 'queued', tries + ' ' + r);
  ok('the failure hook is given the number from when the try began (not the later one)', calls.length === 1 && calls[0] === 1, calls.join());
  tries = 0; answer = async () => { tries++; return unreached(); };
  await outbox._flushAddr(T3);
  ok('a round does not try while the network is not ready', tries === 0, String(tries));
  ready = true; await outbox._flushAddr(T3);
  ok('…and goes on when it is ready again', tries === 1, String(tries));
  outbox._ready = null; outbox._epoch = null; outbox._onRetryFail = null;
  for (const i of [...outbox.queue]) if (i.toAddress === T3) outbox._drop(i);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
