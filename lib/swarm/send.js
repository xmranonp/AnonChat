'use strict';
// Sending to contacts' mailbox peers (design sections 9, 11 and 12). This module is the only owner of a mailbox message's final outcome:
// the outbox's events for such a message are inputs here, and the outcome goes back through outbox.complete().
//
// A message                route   held (waiting for the mailbox) · released (also sent directly) · direct-first (media, contact online)
//                                  · direct+bg (all peers suspect: direct now, mailbox in the background) · copy (a call invite's copy)
// A copy at one peer       state   pending → sending → accepted → collected | discarded | expired | unknown
//                                  or refused | unreachable | busy | full | given-up
// Shown in the window              ⏳ waiting · 📮 in their mailbox · ✓ delivered · ⚠ (not confirmed, not delivered, failed); computed
//                                  from the record each time, never stored apart
//
// Rules (tools/swarm-send-test.mjs checks them with random event sequences):
//   - a held message is never sent directly (the outbox checks at every try, not only at the scan);
//   - every message reaches an outcome by its end plus one status round;
//   - a released message is never held again;
//   - a held message with no live copy and no usable peer is released;
//   - a photo or file at one peer gets a second copy when that peer has been unreachable for 2 hours, answers unknown or 404 for it, or
//     is no longer in the contact's details;
//   - delivered replaces any other outcome, and nothing replaces it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const sealedFiles = require('../sealed');
const { sealDrop, fromB64u } = require('./seal');

const HOUR = 3600 * 1000, DAY = 24 * HOUR, MAX_KEEP_S = 7 * 86400;
const LIVE = new Set(['pending', 'sending', 'accepted', 'collected']);
const FINAL_COPY = new Set(['collected', 'discarded', 'expired', 'unknown', 'refused', 'given-up']);
const RETRYABLE = new Set(['unreachable', 'busy', 'full']);
const TIMING = {
  retry: [15e3, 30e3, 60e3, 120e3, 300e3],          // a suspect peer: 15 s, 30 s, 1 min, 2 min, then every 5 min
  tickMs: 1000,
  perPeer: 4,                                        // drops at a time per peer
  busyMs: 30e3, fullMs: 30 * 60e3,
  secondCopyMs: 2 * HOUR,                            // a photo's only peer unreachable this long: a second copy
  onlineFor: { text: 30e3, media: 10 * 60e3 },       // collection isn't working: sent directly after the recipient has been online this long
  presenceEveryMs: 30e3, presencePool: 4,
  recentMs: 60e3, quickCheckMs: 10e3,                // media goes directly when the contact answered in the last minute (or a quick check says so)
  statusWait: 50, livePollMs: DAY, maxLivePolls: 8, quickAnswerMs: 1500, quickPauseMs: 5000, laterEveryMs: 30 * 60e3, afterOnlineMs: 45e3, statusRetry: [15e3, 30e3, 60e3],
  saveDelayMs: 250,
};

function create({ dataDir, outbox, contacts, clientFor, payloadFor, presence = {}, ready = () => true, now = Date.now, log = () => {}, timing = {} }) {
  const T = { ...TIMING, ...timing };
  const FILE = path.join(dataDir, 'swarm-send.json'), BODIES = path.join(dataDir, 'swarm-drops');
  const ev = new EventEmitter();
  const msgs = new Map();          // qid -> record
  const peers = new Map();          // peer address -> { suspect, failAt, idx, nextAt, lastOk, inflight }
  const since = new Map();          // `${peer} ${token}` -> the status cursor
  const lastCollected = new Map();          // `${to} ${peer}` -> when one of our messages to them was last collected through that peer
  const polls = new Map();          // peer -> the running live status loop
  let tick = null, saveT = null, stopped = false, presenceT = null;

  // ---------------------------------------------------------------- the record
  const peerOf = (a) => { let p = peers.get(a); if (!p) { p = { suspect: false, failAt: null, idx: 0, nextAt: 0, lastOk: 0, inflight: 0 }; peers.set(a, p); } return p; };
  function shown(m) {
    if (m.outcome === 'delivered') return 'delivered';
    if (m.outcome) return m.outcome;          // not-confirmed, not-delivered, failed: ⚠
    if (Object.values(m.copies).some((c) => c.state === 'accepted' || c.state === 'collected')) return 'mailbox';
    return 'waiting';
  }
  const view = (m) => ({ id: m.qid, msgId: m.msgId || null, toAddress: m.to, route: m.route, shown: shown(m),
    keepUntil: Math.max(0, ...Object.values(m.copies).map((c) => c.keepUntil || 0)) || null });
  function changed(m, why) {
    const s = shown(m);
    if (s !== m._shown) { m._shown = s; if (m.route !== 'copy') ev.emit('state', view(m)); }
    save();
    if (why) log(`[swarm] ${why}`);
  }

  // ---------------------------------------------------------------- persistence (bodies in their own sealed files)
  const bodyPath = (m, peer) => path.join(BODIES, `${m.qid}-${crypto.createHash('sha256').update(peer).digest('hex').slice(0, 8)}.drop`);
  function writeBody(m, peer, body) {
    try {
      fs.mkdirSync(BODIES, { recursive: true, mode: 0o700 });
      const p = bodyPath(m, peer), tmp = p + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, sealedFiles.seal(body, 'swarm-drop'), { mode: 0o600 });
      fs.renameSync(tmp, p);
    } catch (e) { throw Object.assign(new Error('the sealed drop could not be written: ' + (e.code || e.message)), { kind: 'local-disk' }); }
  }
  const readBody = (m, peer) => { try { return sealedFiles.open(fs.readFileSync(bodyPath(m, peer)), 'swarm-drop'); } catch { return null; } };
  const dropBody = (m, peer) => { try { fs.unlinkSync(bodyPath(m, peer)); } catch {} };
  function save() {
    if (saveT) return;
    saveT = setTimeout(() => { saveT = null; saveNow(); }, T.saveDelayMs); saveT.unref?.();
  }
  function saveNow() {
    clearTimeout(saveT); saveT = null;
    try {
      const strip = ({ _shown, _ended, ...m }) => ({ ...m, copies: Object.fromEntries(Object.entries(m.copies).map(([a, c]) => [a, { ...c, state: c.state === 'sending' ? 'pending' : c.state }])) });
      const j = JSON.stringify({ v: 1, msgs: [...msgs.values()].map(strip), since: [...since], lastCollected: [...lastCollected] });
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const tmp = FILE + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, sealedFiles.seal(j, 'swarm-send'), { mode: 0o600 });
      fs.renameSync(tmp, FILE);
    } catch (e) { log('[swarm] saving the mailbox sending state failed: ' + e.message); }
  }
  function load() {
    let buf; try { buf = fs.readFileSync(FILE); } catch { return; }
    try {
      const j = JSON.parse(sealedFiles.open(buf, 'swarm-send').toString('utf8'));
      for (const m of j.msgs || []) if (m && typeof m.qid === 'string' && m.copies && typeof m.copies === 'object') { msgs.set(m.qid, m); m._shown = shown(m); }
      for (const [k, v] of j.since || []) since.set(k, v);
      for (const [k, v] of j.lastCollected || []) lastCollected.set(k, v);
    } catch (e) {
      log('[swarm] the mailbox sending state is unreadable, set aside: ' + (e.code || e.message));
      try { fs.renameSync(FILE, FILE + '.unreadable'); } catch {}
    }
    // Bodies nothing points to (the app stopped between writing one and the state).
    try {
      const want = new Set(); for (const m of msgs.values()) for (const a of Object.keys(m.copies)) want.add(path.basename(bodyPath(m, a)));
      for (const f of fs.readdirSync(BODIES)) if (!want.has(f)) fs.unlinkSync(path.join(BODIES, f));
    } catch {}
  }

  // ---------------------------------------------------------------- deciding the route
  const expiryFor = (to, ttlS, chosen) => {
    const d = contacts.get(to);
    let wait = Math.min(d ? d.keepFor : MAX_KEEP_S, MAX_KEEP_S);
    if (chosen && Number.isInteger(ttlS) && ttlS > 0) wait = Math.min(wait, ttlS);
    return Math.ceil((now() / 1000 + wait) / 3600) * 3600;
  };
  const usable = (a) => { const p = peers.get(a); return !p || !p.suspect; };
  // Before the outbox: how this message goes. {mode:'direct'} (not ours: today's path), or {mode, expiry, held}.
  async function plan({ to, cls = 'text', route = 'swarm-ok', ttlS = null, ttlChosen = false }) {
    if (route !== 'swarm-ok') return { mode: 'direct' };
    const d = contacts.get(to);
    if (!d) return { mode: 'direct' };
    const expiry = expiryFor(to, ttlS, ttlChosen);
    if (!d.peers.some((p) => usable(p.address))) return { mode: 'direct+bg', expiry, held: false };
    if (cls === 'media' && !(presence.mobile && presence.mobile(to))) {
      let online = !!(presence.recent && presence.recent(to, T.recentMs));
      if (!online && presence.check) online = await Promise.race([presence.check(to).then(Boolean, () => false), new Promise((r) => setTimeout(() => r(false), T.quickCheckMs).unref?.())]);
      if (online) return { mode: 'direct-first', expiry, held: false };
    }
    return { mode: 'held', expiry, held: true };
  }
  // After the outbox has the message (qid): the record, and the drops start.
  function track({ qid, to, msgId = null, cls = 'text', mode, expiry }) {
    if (msgs.has(qid)) return;
    const m = { qid, to, msgId, cls: cls === 'media' ? 'media' : 'text', route: mode, expiry, at: now(), copies: {} };
    msgs.set(qid, m);
    changed(m);
    pump();
  }
  // A call invite or cancel: sent directly as always, and a copy left at the peers for the missed-call record. Nobody waits on it.
  function copy({ to, payload }) {
    const d = contacts.get(to); if (!d) return null;
    const qid = 'copy-' + crypto.randomUUID();
    const m = { qid, to, cls: 'text', route: 'copy', expiry: expiryFor(to, null, false), at: now(), copies: {}, payload };
    msgs.set(qid, m); save(); pump();
    return qid;
  }
  // A direct-first photo whose direct upload didn't make it: into the mailbox.
  function directFailed(qid) {
    const m = msgs.get(qid); if (!m || m.outcome || m.route !== 'direct-first') return;
    m.route = 'held'; outbox.hold(qid);
    changed(m, 'a photo or file that could not go directly goes to the mailbox'); pump();
  }
  function release(m, why) {
    if (m.route === 'held' || m.route === 'direct-first') {
      m.route = 'released';
      outbox.release(m.qid);
      changed(m, 'a message is also sent directly: ' + why);
    }
  }

  // ---------------------------------------------------------------- outcomes
  function finish(m, outcome) {
    if (m.outcome === 'delivered') return;
    if (m.outcome === outcome) return;
    m.outcome = outcome;
    if (m.route !== 'copy') outbox.complete(m.qid, outcome, { msgId: m.msgId, toAddress: m.to });
    for (const a of Object.keys(m.copies)) dropBody(m, a);
    changed(m);
    forget(m);          // its final status round is over: nothing can change it now
  }
  function forget(m) { for (const a of Object.keys(m.copies)) dropBody(m, a); msgs.delete(m.qid); save(); }
  // Outbox events for messages we own.
  outbox.on('delivered', (e) => { const m = msgs.get(e.id); if (m && !m.outcome && e.via !== 'mailbox') { m.directDone = true; finish(m, 'delivered'); } });
  // Taken out of the outbox without an outcome (the window sent it again on a new session, the contact was removed): forgotten here too,
  // so an old copy can't later report ✓ or ⚠ for the message that replaced it.
  outbox.on('removed', (e) => { const m = msgs.get(e.id); if (m && !m.outcome) forget(m); });
  outbox.on('ended', (e) => {
    const m = msgs.get(e.id); if (!m) return;
    m.directEnded = e.reason;          // expired, failed (refused while sending), refused (400)
    changed(m); settle(m);
  });
  // The message's end: what it ends as, once nothing can change it.
  function endAt(m) {
    const ks = Object.values(m.copies).filter((c) => c.state === 'accepted').map((c) => c.keepUntil || 0);
    return Math.max(m.expiry * 1000, ...ks);
  }
  function settle(m) {
    if (m.outcome) return;
    const cs = Object.values(m.copies);
    if (cs.some((c) => c.state === 'collected')) return finish(m, 'delivered');
    const t = now();
    const accepted = cs.some((c) => c.state === 'accepted');
    if (m.route === 'copy') { if (t >= m.expiry * 1000) forget(m); return; }
    if (t < endAt(m)) {
      // Before the end: a direct path that ended badly decides only when no copy is live and none can be made.
      if (m.directEnded && !accepted && !cs.some((c) => LIVE.has(c.state) || RETRYABLE.has(c.state)) && !untried(m).length)
        finish(m, m.directEnded === 'expired' ? 'not-delivered' : 'failed');
      return;
    }
    if (!m.finalRound && accepted) { m.finalRound = true; save(); statusOnce(m).finally(() => settle(m)); return; }          // one more status round
    if (Object.values(m.copies).some((c) => c.state === 'collected')) return finish(m, 'delivered');
    if (Object.values(m.copies).some((c) => c.state === 'accepted')) return finish(m, 'not-confirmed');
    if (m.directEnded === 'failed' || m.directEnded === 'refused' || (cs.length && cs.every((c) => c.state === 'refused' || c.state === 'discarded'))) return finish(m, 'failed');
    finish(m, 'not-delivered');
  }

  // ---------------------------------------------------------------- which copies to make
  const listed = (m) => { const d = contacts.get(m.to); return d ? d.peers : []; };
  const untried = (m) => listed(m).filter((p) => !m.copies[p.address]);
  function plannedCopies(m) {
    if (m.outcome) return;
    const ps = listed(m);
    const cs = Object.entries(m.copies);
    const anyAccepted = cs.some(([, c]) => c.state === 'accepted' || c.state === 'collected');
    if (m.cls === 'text') {
      if (!anyAccepted || m.route === 'copy') for (const p of untried(m)) m.copies[p.address] = newCopy(p);
      return;
    }
    // A photo or file: one peer at a time, the one that worked most recently first.
    if (m.route === 'direct-first') return;
    const live = cs.filter(([, c]) => c.state === 'pending' || c.state === 'sending' || c.state === 'accepted' || c.state === 'collected');
    if (live.length) {
      // A second copy when the only one is in trouble (its peer unreachable 2 hours, no longer listed).
      if (live.length === 1 && live[0][1].state === 'accepted') {
        const [a] = live[0]; const p = peers.get(a);
        const gone = !ps.some((x) => x.address === a), stuck = p && p.failAt && now() - p.failAt >= T.secondCopyMs;
        if (gone || stuck) secondCopy(m, gone ? 'its peer is no longer listed' : 'its peer has been unreachable for 2 hours');
      }
      return;
    }
    const next = untried(m).filter((p) => usable(p.address)).sort((x, y) => peerOf(y.address).lastOk - peerOf(x.address).lastOk)[0]
      || untried(m)[0];
    if (next) m.copies[next.address] = newCopy(next);
  }
  function secondCopy(m, why) {
    if (m.second) return;
    m.second = true;
    const other = untried(m)[0];
    if (other) { m.copies[other.address] = newCopy(other); changed(m, 'a second copy of a photo or file: ' + why); }
    else release(m, why);
  }
  const newCopy = (p) => ({ state: 'pending', kid: p.kid, tries: 0, nextAt: 0 });

  // ---------------------------------------------------------------- the pump: drops that are due
  // A copy that is at the peer or on its way there (pending at a suspect peer is not: it waits for the peer's next try).
  const liveCopy = (a, c) => c.state === 'accepted' || c.state === 'collected' || c.state === 'sending' || (c.state === 'pending' && usable(a));
  function due(m, a, c) {
    if (c.state === 'pending') return (c.nextAt || 0) <= now() && (usable(a) || peerOf(a).nextAt <= now());
    if (RETRYABLE.has(c.state)) return c.nextAt <= now() && (c.state !== 'unreachable' || peerOf(a).nextAt <= now());
    return false;
  }
  function pump() {
    if (stopped) return;
    if (!ready()) return;
    for (const m of msgs.values()) {
      if (m.outcome) continue;
      // A photo that was going directly: into the mailbox once a direct try has failed (including a retry round after a restart)
      if (m.route === 'direct-first') { const it = outbox.get(m.qid); if (it && !it._busy && it.attempts >= 1 && it.lastError) directFailed(m.qid); }
      plannedCopies(m);
      for (const [a, c] of Object.entries(m.copies)) {
        if (!due(m, a, c)) continue;
        const p = peerOf(a);
        if (p.inflight >= T.perPeer) continue;
        sendCopy(m, a, c);
      }
      // Released when nothing can take it: no live copy and no usable peer.
      if (m.route === 'held' && !Object.entries(m.copies).some(([a, c]) => liveCopy(a, c)) && !untried(m).some((p) => usable(p.address))) release(m, 'no peer took it');
      settle(m);
    }
    for (const a of peersWaiting()) livePolls(a);
  }
  async function sendCopy(m, a, c) {
    const p = peerOf(a);
    const det = listed(m).find((x) => x.address === a);
    c.state = 'sending'; c.tries++; p.inflight++;
    try {
      let body = readBody(m, a);
      if (!body || c.reseal) {
        if (!det) { c.state = 'given-up'; return; }
        const payload = m.payload || payloadFor(m.qid);
        if (!payload) { c.state = 'given-up'; return; }
        // Never sealed without its stamp (design section 6): the stamp key for this contact isn't known yet; tried again shortly.
        if (typeof payload.stamp !== 'string' || !payload.stamp) { c.state = 'pending'; c.nextAt = now() + T.busyMs; return; }          // still on its way: not a reason to go directly
        const exp = c.expiry || m.expiry;
        ({ body } = sealDrop({ env: payload, peerAddress: a, pk: fromB64u(det.pk), expiry: exp }));
        c.kid = det.kid; c.expiry = exp; delete c.reseal;
        writeBody(m, a, body);
      }
      const cl = clientFor(a);
      const r = await cl.drop({ token: det ? det.token : c.token, kid: c.kid, expiry: c.expiry || m.expiry, body });
      if (det) c.token = det.token;
      ok(a);
      // keepUntil comes from the peer: never later than the drop's own expiry or 7 days from now (a peer saying "kept for ever" must not
      // keep a message from reaching its outcome).
      c.id = r.id; c.acceptedAt = now();
      c.keepUntil = Math.min(cl.toLocal(r.keepUntil * 1000), (c.expiry || m.expiry) * 1000 + HOUR, now() + MAX_KEEP_S * 1000 + HOUR);
      c.state = r.state === 'collected' ? 'collected' : r.state === 'held' ? 'accepted' : r.state;
      if (c.state === 'collected') collected(m, a);
      else if (c.state !== 'accepted') afterLoss(m, a, c);
      changed(m);
    } catch (e) { failed(m, a, c, e); }
    finally { p.inflight--; if (!stopped) setImmediate(pump); }
  }
  function ok(a) { const p = peerOf(a); p.suspect = false; p.failAt = null; p.idx = 0; p.nextAt = 0; p.lastOk = now(); }
  function unreachable(a) {
    const p = peerOf(a);
    p.suspect = true; if (!p.failAt) p.failAt = now();
    p.nextAt = now() + T.retry[Math.min(p.idx, T.retry.length - 1)]; p.idx++;
  }
  function failed(m, a, c, e) {
    if (e && e.kind === 'answer') {
      ok(a);
      const s = e.status;
      if (s === 403 || s === 404 || s === 409) {
        c.state = 'refused';
        const asked = contacts.wantFresh(m.to);
        if (asked) ev.emit('want-details', { toAddress: m.to });
        // said to the person only when it matters: not while fresh details were just asked for (an old token after they rotated or
        // switched), and not while another of their peers holds this message
        const heldElsewhere = Object.entries(m.copies).some(([b, x]) => b !== a && (x.state === 'accepted' || x.state === 'collected'));
        if (m.route !== 'copy' && !asked && !heldElsewhere) ev.emit('refused', { toAddress: m.to });
        if (m.route !== 'copy') release(m, `their peer answered ${s}`);
      } else if (s === 410) {
        // Expired on the peer's clock. Only the clocks disagree when ours says there is time left: sealed again once, on its clock.
        const left = m.expiry * 1000 - now();
        if (left > 0 && !c.resealed) {
          const cl = clientFor(a), peerNowS = (now() + (cl.clockOffset() || 0)) / 1000;
          c.expiry = Math.ceil((peerNowS + left / 1000) / 3600) * 3600; c.reseal = true; c.resealed = true; c.state = 'pending'; dropBody(m, a);
        } else c.state = 'given-up';
      } else if (s === 413) { c.state = 'refused'; }
      else if (s === 429 || (s === 503 && e.code !== 'full')) { c.state = 'busy'; c.nextAt = now() + (e.retryAfter ? e.retryAfter * 1000 : T.busyMs); }
      else if (s === 503) { c.state = 'full'; c.nextAt = now() + T.fullMs; ev.emit('full', { toAddress: m.to }); }
      else c.state = 'given-up';
    } else if (e && e.kind === 'local') { c.state = 'given-up'; log('[swarm] a drop could not be made: ' + e.message); }
    else if (e && e.kind === 'local-disk') { c.state = 'pending'; c.nextAt = now() + 60e3; log('[swarm] ' + e.message + ': tried again in a minute'); }          // our disk, not the peer
    else { unreachable(a); c.state = 'unreachable'; c.nextAt = peerOf(a).nextAt; }
    // A photo or file moves on to the next peer; a held message no peer can take goes directly (pump).
    if (FINAL_COPY.has(c.state)) dropBody(m, a);
    changed(m);
  }
  function collected(m, a) {
    lastCollected.set(`${m.to} ${a}`, now());
    finish(m, 'delivered');
  }
  // A copy the peer no longer has (unknown, discarded, expired before collection): sent directly, and for a photo a second copy.
  function afterLoss(m, a, c) {
    dropBody(m, a);
    if (m.route === 'copy') return;
    if (c.state === 'unknown' && m.cls === 'media') secondCopy(m, 'its peer lost it');
    if (c.state === 'unknown' || c.state === 'discarded') release(m, `their peer said ${c.state}`);
  }

  // ---------------------------------------------------------------- status: when copies are collected
  function waitingAt(a) {
    const out = [];
    for (const m of msgs.values()) { const c = m.copies[a]; if (c && c.state === 'accepted' && c.id && !c.noStatus) out.push([m, c]); }
    return out;
  }
  function peersWaiting() { const s = new Set(); for (const m of msgs.values()) for (const [a, c] of Object.entries(m.copies)) if (c.state === 'accepted' && c.id && !c.noStatus) s.add(a); return s; }
  function applyStatus(a, list) {
    const byId = new Map(waitingAt(a).map(([m, c]) => [c.id, [m, c]]));
    for (const d of list) {
      const hit = byId.get(d.id); if (!hit) continue;
      const [m, c] = hit;
      if (d.state === 'held' || d.state === c.state) continue;
      if (!['collected', 'discarded', 'expired', 'unknown'].includes(d.state)) continue;          // states only move forward
      c.state = d.state;
      if (d.state === 'collected') collected(m, a);
      else { afterLoss(m, a, c); changed(m); settle(m); }
    }
  }
  function handleStatusError(a, e, items) {
    if (e && e.kind === 'answer') {
      if (e.status === 403) for (const [, c] of items) c.noStatus = true;          // stop asking for those drops
      else if (e.status === 404) applyStatus(a, items.map(([, c]) => ({ id: c.id, state: 'unknown' })));
      return e.retryAfter ? e.retryAfter * 1000 : 0;
    }
    unreachable(a);
    return null;
  }
  // One live long-poll per peer while copies younger than a day wait there (up to 8 contacts' tokens in one).
  // One live long-poll per (peer, contact) while copies younger than a day wait there: one contact's token per request, so the peer
  // can't link our contacts to one another; at most T.maxLivePolls per peer (the others are asked by the later rounds). An answer that
  // comes back quickly with nothing new (a peer ignoring wait) is followed by a pause, so a peer can't make us ask without end.
  const sleepMs = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
  function livePolls(a) {
    const toks = [...new Set(waitingAt(a).filter(([, c]) => now() - (c.acceptedAt || 0) < T.livePollMs).map(([, c]) => c.token).filter(Boolean))];
    let running = [...polls.keys()].filter((k) => k.startsWith(a + ' ')).length;
    for (const tok of toks) { if (running >= T.maxLivePolls) break; if (!polls.has(`${a} ${tok}`)) { livePoll(a, tok); running++; } }
  }
  function livePoll(a, tok) {
    const key = `${a} ${tok}`;
    if (polls.has(key) || stopped) return;
    const run = (async () => {
      let fails = 0, quick = 0;
      while (!stopped && ready()) {
        const items = waitingAt(a).filter(([, c]) => c.token === tok && now() - (c.acceptedAt || 0) < T.livePollMs);
        if (!items.length) break;
        const sinceKey = since.get(key) || '0';
        const t0 = Date.now();
        try {
          const r = await clientFor(a).status([tok], { since: sinceKey, wait: T.statusWait });
          fails = 0; ok(a);
          since.set(key, r.next || sinceKey);
          const before = items.map(([, c]) => c.state).join();
          applyStatus(a, r.drops); save();
          const moved = waitingAt(a).filter(([, c]) => c.token === tok).map(([, c]) => c.state).join() !== before;
          if (Date.now() - t0 < T.quickAnswerMs && !moved) await sleepMs(T.quickPauseMs * Math.min(8, 2 ** quick++));
          else quick = 0;
        } catch (e) {
          const back = handleStatusError(a, e, items);
          await sleepMs(back !== null ? Math.max(back, 5000) : T.statusRetry[Math.min(fails++, T.statusRetry.length - 1)]);
        }
      }
    })().finally(() => polls.delete(key));
    polls.set(key, run);
  }
  // A one-shot status by ids: for older copies, at start, after the contact comes online, and as a message's final round.
  async function statusFor(a, items) {
    for (let i = 0; i < items.length; i += 64) {
      const part = items.slice(i, i + 64);
      const byTok = new Map(); for (const it of part) { const t = it[1].token; if (!byTok.has(t)) byTok.set(t, []); byTok.get(t).push(it); }
      for (const [, group] of byTok) {
        const tokens = [group[0][1].token];
        try { const r = await clientFor(a).status(tokens, { ids: group.map(([, c]) => c.id) }); ok(a); applyStatus(a, r.drops); }
        catch (e) { handleStatusError(a, e, group); }
      }
    }
  }
  function statusOnce(m) {
    return Promise.allSettled(Object.entries(m.copies).filter(([, c]) => c.state === 'accepted' && c.id && !c.noStatus).map(([a, c]) => statusFor(a, [[m, c]])));
  }
  function laterRound() {
    const t = now();
    for (const a of peersWaiting()) {
      const older = waitingAt(a).filter(([, c]) => t - (c.acceptedAt || 0) >= T.livePollMs && t - (c.lastAsked || 0) >= T.laterEveryMs);
      for (const [, c] of older) c.lastAsked = t;
      if (older.length) statusFor(a, older).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- sending directly when collection isn't working (design section 11)
  // A message still 📮 goes directly too once the recipient has been online for T (30 s text, 10 min media) since the later of the drop
  // and their coming online, and nothing of ours to them was collected through the peers holding it meanwhile.
  function collectionCheck() {
    const t = now();
    for (const m of msgs.values()) {
      if (m.outcome || m.route !== 'held') continue;
      const acc = Object.entries(m.copies).filter(([, c]) => c.state === 'accepted');
      if (!acc.length) continue;
      if (m.cls === 'media' && presence.mobile && presence.mobile(m.to)) continue;          // media to a phone: never this way
      const on = presence.onlineSince ? presence.onlineSince(m.to) : null;
      if (!on) continue;
      const from = Math.max(on, ...acc.map(([, c]) => c.acceptedAt || 0));
      if (t - from < T.onlineFor[m.cls]) continue;
      if (acc.some(([a]) => (lastCollected.get(`${m.to} ${a}`) || 0) > from)) continue;
      release(m, 'they are online but did not collect it');
    }
  }
  let presenceBusy = 0;
  function presenceSweep() {
    if (!presence.check || !ready()) return;
    const want = new Set();
    for (const m of msgs.values()) if (!m.outcome && m.route === 'held' && Object.values(m.copies).some((c) => c.state === 'accepted')) want.add(m.to);
    for (const a of want) {
      if (presenceBusy >= T.presencePool) break;
      presenceBusy++;
      Promise.resolve().then(() => presence.check(a)).catch(() => {}).finally(() => { presenceBusy--; collectionCheck(); });
    }
  }

  // ---------------------------------------------------------------- contacts and the network
  contacts.onChange && contacts.onChange((addr) => {
    for (const m of msgs.values()) {
      if (m.to !== addr || m.outcome) continue;
      const ps = new Set(listed(m).map((p) => p.address));
      for (const [a, c] of Object.entries(m.copies)) if ((c.state === 'pending' || RETRYABLE.has(c.state)) && !ps.has(a)) { delete m.copies[a]; dropBody(m, a); }
      if (!ps.size) release(m, 'they now take messages directly');
    }
    pump();
  });

  load();
  return Object.assign(ev, {
    plan, track, copy, directFailed,
    start() {
      stopped = false;
      // The outbox and this state are written apart: after a crash between the two, they are made to agree.
      const outs = new Map(outbox.outcomes().map((o) => [o.id, o]));
      for (const m of [...msgs.values()]) {
        if (m.route === 'copy' || outbox.get(m.qid)) continue;
        const o = outs.get(m.qid);
        if (!o || o.outcome === 'delivered') forget(m);
        else if (!m.directEnded) m.directEnded = o.outcome === 'expired' ? 'expired' : 'failed';
      }
      for (const i of outbox.list()) if (i.held && !msgs.has(i.id)) outbox.release(i.id);          // held, and nothing here to carry it
      // A photo that was going directly when the app quit: into the mailbox (design section 9)
      for (const m of [...msgs.values()]) if (m.route === 'direct-first' && !m.outcome && outbox.get(m.qid)) directFailed(m.qid);
      tick = setInterval(() => { pump(); laterRound(); }, T.tickMs); tick.unref?.();
      presenceT = setInterval(() => { presenceSweep(); collectionCheck(); }, T.presenceEveryMs); presenceT.unref?.();
      // At start: one status round for everything waiting.
      setTimeout(() => { for (const a of peersWaiting()) statusFor(a, waitingAt(a)).catch(() => {}); pump(); }, 0).unref?.();
    },
    stop() { stopped = true; clearInterval(tick); clearInterval(presenceT); saveNow(); },
    // The network is back (or the computer woke): suspect peers are tried again at once.
    kick() { for (const p of peers.values()) { p.idx = 0; p.nextAt = 0; } for (const m of msgs.values()) for (const c of Object.values(m.copies)) if (RETRYABLE.has(c.state) && c.state === 'unreachable') c.nextAt = 0; pump(); },
    // A contact just came online: a one-shot status 45 s later for what waits for them.
    cameOnline(addr) {
      setTimeout(() => { for (const a of peersWaiting()) { const items = waitingAt(a).filter(([m]) => m.to === addr); if (items.length) statusFor(a, items).catch(() => {}); } }, T.afterOnlineMs).unref?.();
      collectionCheck();
    },
    removeContact(addr) { for (const m of [...msgs.values()]) if (m.to === addr) forget(m); },
    owns: (qid) => msgs.has(qid),
    states: () => [...msgs.values()].filter((m) => m.route !== 'copy').map(view),
    stateOf: (qid) => { const m = msgs.get(qid); return m ? view(m) : null; },
    // For quitting: drops still being sent or due, text first (the caller waits up to its limit).
    // Only drops that can leave now count (not one waiting for a suspect peer's next try or for a stamp key), so quitting with a peer down
    // doesn't wait the whole time for nothing.
    pending: () => [...msgs.values()].filter((m) => !m.outcome && Object.entries(m.copies).some(([a, c]) => c.state === 'sending' || (c.state === 'pending' && due(m, a, c)))).length,
    _pump: () => pump(), _collectionCheck: () => collectionCheck(), _laterRound: () => laterRound(), _settleAll: () => { for (const m of [...msgs.values()]) settle(m); },
    _debug: () => ({ msgs: [...msgs.values()], peers: Object.fromEntries(peers) }),
    saveNow,
  });
}

module.exports = { create, TIMING };
