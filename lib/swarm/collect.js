'use strict';
// Collecting from our own peers (design section 10).
//
//   live      one `wait` open per peer while the network is ready: small drops arrive inline, the rest are fetched by id at once
//   sessions  at start: everything still held (cursor 0: what was acked is gone, so this is exactly what we haven't taken yet), up to
//             16 pages; when the network comes back, after a join and every 5 minutes: from the live cursor
//   later     drops that couldn't be taken yet (no stamp key, inbox full) are remembered per peer and skipped; they are fetched again by
//             id only when new stamp keys arrive, the network comes back, or every 5 minutes, never downloaded again in every session
//   each drop opened with the key its kid names (unknown kid: discarded); one whose expiry passed more than an hour ago on the peer's
//             clock is discarded unopened; then accept(envelope) decides, with the same checks as a direct message:
//             'stored' (or a copy) → ack stored · 'discarded' → ack discarded (the sender sends directly) · 'later' → not acked
const EventEmitter = require('events');
const S = require('./seal');

const TIMING = { sessionEveryMs: 5 * 60e3, retry: [5e3, 15e3, 30e3, 60e3], pages: 16, laterMs: 30e3, otherInstallMs: 120e3,
  quickAnswerMs: 1500, quickPauseMs: 5000, maxPauseMs: 60e3, staleLocalMs: 3 * 86400e3 };

function create({ own, clientFor, accept, ready = () => true, now = Date.now, log = () => {}, timing = {} }) {
  const T = { ...TIMING, ...timing };
  const ev = new EventEmitter();
  const live = new Map();          // peer -> running wait loop
  const cursors = new Map();          // peer -> live cursor (memory: a session at start covers what came while we were away)
  const busy = new Map();          // peer -> running session
  const ownCollectAt = new Map();          // peer -> when we last collected (to tell another install's collections from ours)
  const later = new Map();          // peer -> Set of drop ids not taken yet
  let stopped = true, timer = null;
  const laterOf = (peer) => { let s = later.get(peer); if (!s) { s = new Set(); later.set(peer, s); } return s; };
  const sleep = (ms) => new Promise((res) => { const t = setTimeout(res, ms); t.unref?.(); });

  // One drop: 'stored' | 'discarded' | 'later'.
  async function take(peer, cl, d) {
    if (d.expiry * 1000 < now() + (cl.clockOffset() || 0) - 3600e3) return 'discarded';          // long expired on the peer's clock: unopened
    if (d.expiry * 1000 < now() - T.staleLocalMs) return 'discarded';          // and on ours, whatever the peer's clock says (an old drop replayed)
    const key = own.secretKey(peer, d.kid);
    if (!key) return 'discarded';
    let env;
    try { env = S.openDrop({ body: d.body, peerAddress: peer, sk: key.sk, pk: key.pk, expiry: d.expiry }); }
    catch { return 'discarded'; }
    try { return await accept(env, { writtenAt: cl.toLocal(d.receivedAt), peer }); }
    catch (e) { log('[swarm] a collected message could not be taken in yet: ' + e.message); return 'later'; }
  }
  // A frame's drops: inline ones taken at once, the others fetched by id (up to 256 at a time). Returns the acks.
  async function takeFrame(peer, cl, o, f, { retryLater = false } = {}) {
    const acks = [], waiting = laterOf(peer);
    if (!retryLater) f = { ...f, drops: f.drops.filter((d) => !waiting.has(d.id)) };          // known not takeable yet: not fetched again
    const missing = f.drops.filter((d) => !d.inline).map((d) => d.id);
    const bodies = new Map(f.drops.filter((d) => d.inline).map((d) => [d.id, d]));
    for (let i = 0; i < missing.length; i += 256) {
      const g = await cl.collect(o, { ids: missing.slice(i, i + 256) });
      for (const d of g.drops) bodies.set(d.id, d);
    }
    for (const d of f.drops) {
      const full = bodies.get(d.id); if (!full) { waiting.delete(d.id); continue; }          // gone meanwhile (expired, or another install took it)
      const r = await take(peer, cl, full);
      if (r === 'later') { if (waiting.size < 5000) waiting.add(d.id); continue; }
      waiting.delete(d.id);
      acks.push({ id: d.id, result: r });
    }
    noteCollect(peer, f.prevCollectAt ? cl.toLocal(f.prevCollectAt) : 0);
    return acks;
  }
  // Another install of the same identity collecting from the same mailbox (design section 13): said, never blocked.
  function noteCollect(peer, prevAt) {
    const mine = ownCollectAt.get(peer);
    if (mine && prevAt && prevAt > mine + T.otherInstallMs) ev.emit('other-install', { peer });
    ownCollectAt.set(peer, now());
    own.noteHealth && own.noteHealth(peer, true);
    own.collected(peer);
  }
  async function ack(cl, o, acks) { for (let i = 0; i < acks.length; i += 1000) await cl.ack(o, acks.slice(i, i + 1000)); }

  // Drops not taken earlier: fetched by id (at most 256 at a time) and tried again.
  async function retryLater(peer, o) {
    const ids = [...laterOf(peer)]; if (!ids.length) return;
    const cl = clientFor(peer);
    for (let i = 0; i < ids.length; i += 256) {
      const part = ids.slice(i, i + 256);
      const f = await cl.collect(o, { ids: part });
      const got = new Set(f.drops.map((d) => d.id));
      for (const id of part) if (!got.has(id)) laterOf(peer).delete(id);          // no longer held there
      const acks = await takeFrame(peer, cl, o, { ...f, drops: f.drops.map((d) => ({ ...d, inline: true })) }, { retryLater: true });
      if (acks.length) await ack(cl, o, acks);
    }
  }
  async function session(peer, o, { fromStart = false, withLater = false } = {}) {
    if (busy.has(peer)) return busy.get(peer);
    const run = (async () => {
      const cl = clientFor(peer);
      if (withLater) await retryLater(peer, o);
      let cursor = fromStart || !cursors.has(peer) ? '0' : cursors.get(peer), moreLeft = false;
      for (let page = 0; page < T.pages; page++) {
        const f = await cl.collect(o, { cursor });
        const acks = await takeFrame(peer, cl, o, f);
        if (acks.length) await ack(cl, o, acks);
        if (!cursors.has(peer) || BigInt(f.cursor) > BigInt(cursors.get(peer))) cursors.set(peer, f.cursor);
        cursor = f.cursor;
        moreLeft = f.more;
        if (!f.more) break;
      }
      ev.emit('session', { peer });
      // true only when it went through to the end and nothing is left that couldn't be taken
      return !moreLeft && !laterOf(peer).size;
    })().catch((e) => {
      log(`[swarm] collecting from a peer failed (${e.kind || ''} ${e.status || ''})`);
      if (e.kind !== 'answer' || e.status >= 500) own.noteHealth && own.noteHealth(peer, false);
      return false;
    }).finally(() => busy.delete(peer));
    busy.set(peer, run);
    return run;
  }
  function liveLoop(peer, o) {
    if (live.has(peer)) return;
    const run = (async () => {
      let fails = 0, quick = 0;
      while (!stopped && ready() && own.peers().some((p) => p.address === peer)) {
        const cl = clientFor(peer);
        try {
          if (!cursors.has(peer)) await session(peer, o, { fromStart: true });
          const t0 = Date.now();
          const r = await cl.wait(o, { cursor: cursors.get(peer) || '0' });
          if (stopped) break;          // stopped meanwhile: not taken (the next start's session takes it)
          fails = 0; own.noteHealth && own.noteHealth(peer, true);
          // A peer answering at once with nothing (ignoring wait, or "superseded" again and again) can't make us ask without end.
          const nothing = r.closed || !r.drops.filter((d) => !laterOf(peer).has(d.id)).length;
          if (r.closed || (nothing && Date.now() - t0 < T.quickAnswerMs)) { await sleep(Math.min(T.maxPauseMs, (r.closed ? 1000 : T.quickPauseMs) * 2 ** Math.min(6, quick++))); if (r.closed) continue; }
          else quick = 0;
          const acks = await takeFrame(peer, cl, o, r);
          if (acks.length) await ack(cl, o, acks);
          if (BigInt(r.cursor) > BigInt(cursors.get(peer) || '0')) cursors.set(peer, r.cursor);
          if (r.drops.length) ev.emit('collected', { peer, count: acks.filter((a) => a.result === 'stored').length });
        } catch (e) {
          if (e.kind === 'answer' && (e.status === 401 || (e.status === 404 && e.code === 'no-mailbox'))) {
            own.markLost && own.markLost(peer);
            ev.emit('mailbox-gone', { peer }); log('[swarm] a peer no longer knows our mailbox'); break;
          }
          if (e.kind !== 'answer' || e.status >= 500) own.noteHealth && own.noteHealth(peer, false);          // unreachable, or failing
          const w = T.retry[Math.min(fails++, T.retry.length - 1)];
          await new Promise((res) => setTimeout(res, (e.retryAfter ? e.retryAfter * 1000 : 0) || w).unref?.());
        }
      }
    })().finally(() => live.delete(peer));
    live.set(peer, run);
  }
  function pump() {
    if (stopped || !ready()) return;
    for (const p of own.peers()) liveLoop(p.address, p.owner);
  }
  return Object.assign(ev, {
    start() {
      stopped = false;
      for (const p of own.peers()) session(p.address, p.owner, { fromStart: true });
      pump();
      timer = setInterval(() => pump(), T.laterMs); timer.unref?.();
      const t2 = setInterval(() => { for (const p of own.peers()) session(p.address, p.owner, { withLater: true }); }, T.sessionEveryMs); t2.unref?.();
      ev._t2 = t2;
    },
    stop() { stopped = true; clearInterval(timer); clearInterval(ev._t2); },
    // A peer added (joined, switched to): its live wait starts now, not at the next round.
    pump: () => pump(),
    // The network is back, we woke up, new stamp keys arrived, or we just joined: what came since, and what couldn't be taken before.
    kick() { if (stopped) return; for (const p of own.peers()) session(p.address, p.owner, { withLater: true }); pump(); },
    // everything still held there, from the start (a last collection before a peer is left)
    // Resolves true only when everything held there was taken (false: unreachable, or something couldn't be taken yet). A session already
    // running is waited for first, then this one runs on its own terms.
    sessionNow: async (peer) => {
      const p = own.peers().find((x) => x.address === peer); if (!p) return true;
      for (let i = 0; i < 5 && busy.get(peer); i++) await busy.get(peer).catch(() => {});
      return session(p.address, p.owner, { fromStart: true, withLater: true });
    },
  });
}

module.exports = { create, TIMING };
