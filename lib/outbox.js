'use strict';
// Offline delivery queue with retries and per-message expiry, sealed with the data key like the rest of the store.
// Each waiting message is its own file (outbox/<id>.env), written once when queued and removed when it is done; outbox.json is a small
// index (who, when, until when) plus the recent outcomes, so a retry round never rewrites attachments that are waiting.

const fs           = require('fs');
const path         = require('path');
const EventEmitter = require('events');
const crypto       = require('crypto');
const sealed       = require('./sealed');

const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'outbox.json');
const ENV_DIR    = path.join(DATA_DIR, 'outbox');
const RETRY_MS   = 15_000;   // Retry queued messages every 15 s: hidden-service descriptors propagate slowly.
const ROUND_WAIT_MS = Number(process.env.OUTBOX_ROUND_WAIT_MS) || 60_000;  // the longest a retry round waits for its slowest recipient (each request has a 45 s deadline)
const MAX_AGE_MS   = 7 * 24 * 60 * 60 * 1000;   // a message queued without a waiting time (receipts, reactions, group notices)
// What happened to recent messages, kept so a window that was closed or reloading meanwhile can still show it (GET /api/outbox/outcomes).
const OUTCOME_KEEP_MS = 14 * 24 * 60 * 60 * 1000, OUTCOME_KEEP_MAX = 1000;
const ID_OK = /^[A-Za-z0-9-]{1,80}$/;

class Outbox extends EventEmitter {
  constructor() {
    super();
    this.queue   = [];             // loaded in init(), once the data key is known
    this._timer  = null;
    this._inflight = new Map();     // recipient -> the run trying them right now (one at a time per recipient, so order is kept)
    this._soon = new Set();         // recipients with a short retry already scheduled (after a busy answer)
    this._sentTo = new Map();       // recipient -> messages delivered to them so far (in this run of the app)
    this._outcomes = new Map();     // queue id -> { outcome: 'delivered' | 'expired' | 'failed', msgId, toAddress, at }
    this._savedIndex = null;        // the index as last written: unchanged, it isn't written again
    this._onion  = null;
    this._pow    = null;
    this._myAddr = null;
  }

  init({ onion, pow, myAddress, onRetryFail, stamp, ready }) {
    // Until the network is ready (lib/netready.js) nothing is tried: a try made too early is remembered by the network for 15 minutes.
    this._ready  = typeof ready === 'function' ? ready : null;
    this._onion  = onion;
    // Stamps each attempt with the current mailbox key (lib/stamp.js): a message queued before the key was known still arrives as ours.
    this._stamp  = typeof stamp === 'function' ? stamp : null;
    this._pow    = pow;
    this._myAddr = myAddress;
    // Called when a delivery attempt fails; used to force a fresh descriptor fetch so a peer that restarted becomes reachable again.
    this._onRetryFail = typeof onRetryFail === 'function' ? onRetryFail : null;
    this.queue = this._load();
    this._purgeOld();
    if (this.queue.length) {
      setTimeout(() => this._flush(), 5000);
    }
    this._schedule();
  }

  // msgId: the window's id for the message, so it can match the outcome even if it never saw the queue id (closed or reloading meanwhile).
  enqueue(toAddress, envelope, from, ttlMs = null, msgId = null) {
    const item = {
      id: crypto.randomUUID(), toAddress, envelope, from,
      queuedAt: Date.now(), attempts: 0, lastAttempt: null, lastError: null,
      expiresAt: (ttlMs && ttlMs > 0) ? Date.now() + ttlMs : null,
      ...(typeof msgId === 'string' && ID_OK.test(msgId) ? { msgId } : {}),
    };
    this._writeEnvelope(item);           // the message itself first, then the index that points to it
    this.queue.push(item);
    this._save();
    this._schedule();
    return item.id;
  }

  _effectiveExpiry(item) {
    return item.expiresAt || (item.queuedAt + MAX_AGE_MS);
  }

  list() {
    return this.queue.map(i => ({
      id: i.id, msgId: i.msgId || null, toAddress: i.toAddress, queuedAt: i.queuedAt,
      ek: (i.envelope && i.envelope.x3dh && typeof i.envelope.x3dh.ek === 'string') ? i.envelope.x3dh.ek : null,   // the session it was written on, while new
      attempts: i.attempts, lastError: i.lastError,
      expiresAt: this._effectiveExpiry(i),
    }));
  }
  // Recent outcomes, newest last: { id, msgId, toAddress, outcome, at }.
  outcomes() { return [...this._outcomes].map(([id, o]) => ({ id, ...o })); }

  countFor(address) { return this.queue.filter(i => i.toAddress === address).length; }
  // For the connection test: how many are waiting for them and the last HTTP answer their app gave to one (null when tries failed on the network).
  stateFor(address) {
    const w = this.queue.filter(i => i.toAddress === address);
    const last = w.filter(i => i.lastAttempt).sort((a, b) => b.lastAttempt - a.lastAttempt)[0];
    return { count: w.length, lastStatus: last ? last.lastStatus || null : null };
  }
  // Messages to them are waiting because tries failed on the network (not because they said "busy").
  failingFor(address) { return this.queue.some(i => i.toAddress === address && (i.fails || 0) > 0 && !i.lastStatus); }
  remove(id)        { const i = this.queue.find(x => x.id === id); if (i) this._drop(i); this._save(); }
  // Out of the queue, and its file off the disk.
  _drop(item) {
    this.queue = this.queue.filter(i => i !== item);
    try { fs.unlinkSync(this._envPath(item.id)); } catch {}
  }

  _networkReady() { return !this._ready || this._ready(); }
  // The network has just become ready: whatever waits goes now.
  kick() { if (this.queue.length) this._flush().catch(() => {}); }

  _schedule() {
    if (this._timer || !this.queue.length || !this._onion) return;
    this._timer = setTimeout(() => { this._timer = null; this._flush(); }, RETRY_MS);
  }

  // Each recipient is tried on its own, oldest message first, one at a time: a recipient that is offline costs one attempt per round
  // (not one per waiting message), and never holds up messages to someone who is online.
  async _flush() {
    if (!this._networkReady()) { if (this.queue.length) this._schedule(); return; }
    const now = Date.now();
    const byAddr = new Map();
    for (const i of this.queue) {
      if (now >= this._effectiveExpiry(i)) continue;
      if (!byAddr.has(i.toAddress)) byAddr.set(i.toAddress, []);
      byAddr.get(i.toAddress).push(i);
    }
    // A recipient that answers slowly doesn't hold up the round for everyone else: after ROUND_WAIT_MS the round ends and the next is
    // scheduled; that recipient's run carries on, and the next round passes over it while it does (_flushAddr).
    const runs = Promise.allSettled([...byAddr.keys()].map((addr) => this._flushAddr(addr)));
    let waitT = null;
    await Promise.race([runs, new Promise((r) => { waitT = setTimeout(r, ROUND_WAIT_MS); waitT.unref?.(); })]);
    clearTimeout(waitT);
    this._purgeOld();
    this._save();
    if (this.queue.length) this._schedule();
  }
  // Now, for one recipient (they just reached us, so they are reachable).
  async flushTo(address) {
    if (!this._networkReady()) return;
    if (!this.queue.some(i => i.toAddress === address && this._live(i))) return;
    await this._flushAddr(address);
    this._save();
    if (this.queue.length) this._schedule();
  }
  // Tried until its waiting time runs out, however many tries that takes (one per 15 s round while the recipient is offline).
  _live(i, now = Date.now()) { return now < this._effectiveExpiry(i); }
  // Runs fn as the only delivery run for this recipient; whoever comes next waits for it (see deliverNow).
  _exclusive(addr, fn) {
    const run = Promise.resolve().then(fn);
    this._inflight.set(addr, run);
    run.then(() => {}, () => {}).then(() => { if (this._inflight.get(addr) === run) this._inflight.delete(addr); });
    return run;
  }
  // Everything waiting for one recipient, oldest first, one at a time. Returns the message that stopped the run (unreachable or busy:
  // the rest wait behind it, in order), or null.
  async _tryInOrder(addr) {
    const now = Date.now();
    for (const i of this.queue.filter(x => x.toAddress === addr && this._live(x, now))) {
      if (!this.queue.includes(i)) continue;              // delivered or removed meanwhile
      if (i._busy) return i;                              // its first tries are running (deliverNow): the ones behind it wait
      if (await this._attempt(i, Date.now())) continue;
      // The recipient answered, but with an error that isn't "busy": this one message has a problem, not the connection. Don't let it
      // hold up the ones behind it.
      if (i.hardFail) continue;
      return i;
    }
    return null;
  }
  async _flushAddr(addr) {
    if (this._inflight.has(addr)) return;                 // a run for this recipient is going already; it takes these too
    await this._exclusive(addr, async () => {
      const sentBefore = this._sentTo.get(addr) || 0;
      let blocked = await this._tryInOrder(addr);
      // Messages queued while this run was going (the recipient is answering): take them too, instead of leaving them for the next round.
      for (let k = 0; !blocked && k < 20 && this.queue.some(i => i.toAddress === addr && !i._busy && !i.hardFail && this._live(i)); k++) blocked = await this._tryInOrder(addr);
      // Busy, and it said how long to wait (a burst limit is a second or two): try this recipient again then, not at the next round.
      // They took some of these and then one try failed: they are reachable, it was one bad route. Try again in a moment, not at the
      // next round, so a backlog after they come back doesn't crawl out one 15 s round at a time.
      const tookSome = blocked && !blocked.lastStatus && (this._sentTo.get(addr) || 0) > sentBefore;
      const wait = blocked && (blocked.retryAfter || (tookSome ? 2.5 : 0));
      if (wait && wait < RETRY_MS / 1000 && !this._soon.has(addr)) {
        this._soon.add(addr);
        setTimeout(() => { this._soon.delete(addr); this.flushTo(addr).catch(() => {}); }, wait * 1000 + 200).unref?.();
      }
    });
  }
  // A message just written to the queue (so it survives the app closing at any moment): tried now, a few times on a fresh circuit when
  // the network fails (a hidden service that just republished often fails the first attempt), as the build of 16 October did.
  // Each message goes out on its own, alongside any other whose first tries are running: each try is a new connection through the
  // network, and lining them up made every message wait a whole round trip for the one before it, so delays stacked up.
  // Only when older messages to this recipient are already waiting in the queue (their first tries failed) does this one go behind
  // them, sent in the background in the order written, and the window isn't kept waiting.
  // Returns 'delivered'; 'failed' (the recipient refused this message: it is taken out of the queue); or 'queued' (kept, retried later).
  async deliverNow(id, { tries = 3, gapMs = 2500 } = {}) {
    const gone = () => (this._outcomes.get(id)?.outcome === 'delivered' ? 'delivered' : 'failed');
    const item = this.queue.find(i => i.id === id);
    if (!item) return gone();
    const addr = item.toAddress;
    if (!this._networkReady()) { this._schedule(); return 'queued'; }          // kept; goes out when the network is ready
    const pos = this.queue.indexOf(item);
    const waitingAhead = this.queue.some((i, k) => k < pos && i.toAddress === addr && !i._busy && this._live(i));
    if (waitingAhead) {
      setImmediate(() => this.flushTo(addr).catch(() => {}));
      return 'queued';
    }
    item._busy = true;
    let res;
    try {
      for (let t = 1; ; t++) {
        if (await this._attempt(item, Date.now())) { res = gone(); break; }
        if (item.hardFail) { this._drop(item); this._remember(item, 'failed'); res = 'failed'; break; }
        if (item.lastStatus || t >= tries) { res = 'queued'; break; }
        await new Promise(r => setTimeout(r, gapMs));
      }
    } finally { item._busy = false; }
    this._save();
    // They answered: anything still waiting for them goes now rather than at the next round.
    if (res === 'delivered' && this.queue.some(i => i.toAddress === addr && !i._busy)) setImmediate(() => this.flushTo(addr).catch(() => {}));
    this._schedule();
    return res;
  }
  _remember(item, outcome) {
    this._outcomes.delete(item.id);
    this._outcomes.set(item.id, { outcome, msgId: item.msgId || null, toAddress: item.toAddress, at: Date.now() });
    this._pruneOutcomes();
  }
  _pruneOutcomes(now = Date.now()) {
    for (const [id, o] of this._outcomes) if (now - o.at > OUTCOME_KEEP_MS) this._outcomes.delete(id);
    while (this._outcomes.size > OUTCOME_KEEP_MAX) this._outcomes.delete(this._outcomes.keys().next().value);
  }

  async _attempt(item, now) {
    item.attempts++; item.lastAttempt = now;
    const from    = this._myAddr();
    const env     = this._stamp ? this._stamp(item.envelope, from, item.toAddress) : item.envelope;
    const payload = { ...env, from };
    const done = () => {
      this._sentTo.set(item.toAddress, (this._sentTo.get(item.toAddress) || 0) + 1);
      if (this._sentTo.size > 5000) this._sentTo.clear();
      this._drop(item);
      this._remember(item, 'delivered');
      this.emit('delivered', { id: item.id, msgId: item.msgId, toAddress: item.toAddress, queuedAt: item.queuedAt, attempts: item.attempts });
    };
    try {
      await this._onion().post(`http://${item.toAddress}/api/inbox`, payload);
      done();
      return true;
    } catch (err) {
      const status = err.response?.status;
      const data   = err.response?.data;
      const ra = parseInt(err.response?.headers?.['retry-after'] || '', 10);
      item.retryAfter = (status === 429 || status === 503) && ra > 0 ? ra : null;
      item.hardFail = !!status && status !== 429 && status !== 503 && status !== 402;
      item.lastStatus = status || null;
      // 409: the recipient already has this very message (an earlier attempt arrived but its answer was lost on the way back).
      if (status === 409) { done(); return true; }
      // 400: the recipient can never accept it; retrying for days would only end in the same "not delivered".
      if (status === 400) {
        this._drop(item);
        this._remember(item, 'expired');
        this.emit('expired', { id: item.id, msgId: item.msgId, toAddress: item.toAddress, attempts: item.attempts });
        return true;
      }
      if (status === 402 && data?.challenge) {
        try {
          const nonce = await this._pow.solveAsync({ challenge: data.challenge, from, ct: env.ct, bits: data.bits || 18 });
          await this._onion().post(`http://${item.toAddress}/api/inbox`, { ...payload, pow: { c: data.challenge, n: nonce } });
          done();
          return true;
        } catch (e2) {
          if (e2.response?.status === 409) { done(); return true; }
          item.lastError = e2.message;
          this.emit('tryFailed', { toAddress: item.toAddress, error: e2 });
        }
      } else { item.lastError = err.message; this.emit('tryFailed', { toAddress: item.toAddress, error: err }); }
      if (this._onRetryFail) { try { this._onRetryFail(item.toAddress); } catch {} }
      item.fails = (item.fails || 0) + 1;
      this.emit('queued', { id: item.id, toAddress: item.toAddress, attempts: item.attempts, error: item.lastError });
      return false;
    }
  }

  _purgeOld() {
    const now = Date.now();
    const gone = this.queue.filter(i => now >= this._effectiveExpiry(i));
    for (const i of gone) {
      this._drop(i);
      this._remember(i, 'expired');
      this.emit('expired', { id: i.id, msgId: i.msgId, toAddress: i.toAddress, attempts: i.attempts });
    }
    if (gone.length) this._save();
  }

  _envPath(id) { return path.join(ENV_DIR, id + '.env'); }
  _writeEnvelope(item) {
    fs.mkdirSync(ENV_DIR, { recursive: true, mode: 0o700 });
    const tmp = this._envPath(item.id) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, sealed.seal(JSON.stringify(item.envelope), 'outbox-env'), { mode: 0o600 });
    fs.renameSync(tmp, this._envPath(item.id));
  }

  // The index, and each message from its own file. A message whose file is missing or can't be read is dropped and reported as not
  // delivered; a whole index that can't be read is set aside, never overwritten, and the queue starts empty.
  _load() {
    let buf;
    try { buf = fs.readFileSync(QUEUE_FILE); } catch { return []; }
    let idx;
    try { idx = JSON.parse(sealed.open(buf, 'outbox').toString('utf8')); }
    catch (e) {
      console.error('[outbox] queue unreadable, set aside:', e.message);
      try { fs.renameSync(QUEUE_FILE, QUEUE_FILE + '.unreadable'); } catch {}
      return [];
    }
    if (!idx || typeof idx !== 'object' || !Array.isArray(idx.items)) return [];
    for (const o of Array.isArray(idx.outcomes) ? idx.outcomes : []) {
      if (o && typeof o.id === 'string' && ID_OK.test(o.id) && ['delivered', 'expired', 'failed'].includes(o.outcome) && Number.isFinite(o.at))
        this._outcomes.set(o.id, { outcome: o.outcome, msgId: typeof o.msgId === 'string' ? o.msgId : null, toAddress: o.toAddress, at: o.at });
    }
    this._pruneOutcomes();
    const items = [];
    for (const m of idx.items) {
      if (!m || typeof m.id !== 'string' || !ID_OK.test(m.id)) continue;
      try {
        const envelope = JSON.parse(sealed.open(fs.readFileSync(this._envPath(m.id)), 'outbox-env').toString('utf8'));
        items.push({ ...m, envelope, attempts: 0, lastAttempt: null, lastError: null });
      } catch (e) {
        console.error('[outbox] a queued message could not be read and is dropped:', e.code || e.message);
        this._remember(m, 'failed');
      }
    }
    // Message files the index doesn't know (the app stopped between writing one and the index): nothing points to them.
    try { for (const f of fs.readdirSync(ENV_DIR)) if (!items.some((i) => f === i.id + '.env')) fs.unlinkSync(path.join(ENV_DIR, f)); } catch {}
    return items;
  }
  // Only what changes when a message comes or goes: tries and errors stay in memory, so a retry round writes nothing.
  _save() {
    try {
      const index = JSON.stringify({
        v: 2,
        items: this.queue.map((i) => ({ id: i.id, toAddress: i.toAddress, from: i.from, queuedAt: i.queuedAt, expiresAt: i.expiresAt, ...(i.msgId ? { msgId: i.msgId } : {}) })),
        outcomes: this.outcomes(),
      });
      if (index === this._savedIndex) return;
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      const tmp = QUEUE_FILE + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, sealed.seal(index, 'outbox'), { mode: 0o600 });
      fs.renameSync(tmp, QUEUE_FILE);
      this._savedIndex = index;
    }
    catch (e) { console.error('[outbox] save failed:', e.message); }
  }
}

module.exports = new Outbox();
