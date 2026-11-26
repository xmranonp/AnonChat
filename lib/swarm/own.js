'use strict';
// Our own mailbox (design sections 6, 7 and 8): the peers we joined, an owner secret and a seal key per peer, a drop token per (contact,
// peer), the swarm frame we send our contacts, and which of them can read one. All of it sealed on disk; the window never stores any.
//
//   peer   { address, mailbox, secret, state: 'joining' | 'active' | 'leaving', key: {kid, pk, sk}, oldKey?: {kid, pk, sk, until},
//            tokens: { contact: { tok, reg } }, gone: [token hash, ...] (deletes not yet confirmed),
//            retiring: [{ h, until }] (tokens replaced by Rotate: deleted after 8 days), lastCollect, joinedAt }
//   A join is saved (with its invite and owner secret) before the peer is asked, and asked again until it answers: the peer accepts the
//   same invite again from the same owner, so a crash in between never loses the mailbox.
//   seq    a hybrid logical clock: max(last + 1, now in ms); never compared with a time
//   capable / sent   contacts that showed sw: 1, and the seq each was last sent
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const EventEmitter = require('events');
const sealed = require('../sealed');
const H = require('./hpke');
const S = require('./seal');

const ADDR = /^[a-z2-7]{56}\.anyone$/;
const ROTATE_KEEP_MS = 8 * 24 * 3600 * 1000;
const SEQ_AHEAD_MS = 366 * 24 * 3600 * 1000;
const KEEP_DEFAULT = 7 * 86400;
const MAX_PEERS = 4;

// A peer left by Switch or Turn off is still collected this long ("draining"), so contacts who haven't got the new details yet lose
// nothing; then a last collection, and the peer is told we left.
const DRAIN_MS = 8 * 24 * 3600 * 1000;
const GIVE_UP_MS = 30 * 24 * 3600 * 1000;
const GIVE_UP_TRIES = 30;          // a last collection or a leave that never gets an answer: given up after 30 days

function create({ dataDir, clientFor, contacts: listContacts, beforeLeave = async () => {}, ready = () => true, now = Date.now, log = () => {} }) {
  // A failure counts only while our own network is ready, and a saved one only once it is seen again in this run of the app (a blip
  // before quitting is not "a week without an answer" eight days later).
  const RUN = crypto.randomBytes(8).toString('hex');
  const FILE = path.join(dataDir, 'swarm-own.json');
  const ev = new EventEmitter();
  let st = { v: 1, seq: 0, keepFor: KEEP_DEFAULT, peers: [], capable: {}, sent: {} };
  let syncing = null;

  function load() {
    let buf; try { buf = fs.readFileSync(FILE); } catch { return; }
    try {
      const j = JSON.parse(sealed.open(buf, 'swarm-own').toString('utf8'));
      if (j && j.v === 1 && Array.isArray(j.peers)) st = { ...st, ...j };
    } catch (e) {
      log('[swarm] our mailbox details are unreadable, set aside: ' + (e.code || e.message));
      try { fs.renameSync(FILE, FILE + '.unreadable'); } catch {}
    }
  }
  function save() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, sealed.seal(JSON.stringify(st), 'swarm-own'), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  }
  const bump = () => {
    const t = now();
    st.seq = (st.seq > t + SEQ_AHEAD_MS) ? t : Math.max(st.seq + 1, t);          // a seq a year ahead (a clock that was far off) restarts
    save(); ev.emit('changed');
  };
  const owner = (p) => ({ mailbox: p.mailbox, secret: p.secret });
  const peer = (a) => st.peers.find((p) => p.address === a) || null;
  const newKey = (address) => { const k = H.generateKeyPair(); return { kid: S.kidOf(address, k.pk), pk: S.b64u(k.pk), sk: S.b64u(k.sk) }; };
  // The kids the peer should accept: ours, the old one while it lasts, and (for 8 days after a restore that found another install's keys
  // at the peer) theirs, so the restore doesn't cut that install off while the person is warned.
  const kidsOf = (p) => [...new Set([p.key.kid, ...(p.oldKey && p.oldKey.until > now() ? [p.oldKey.kid] : []),
    ...(p.keepKids && p.keepKids.until > now() ? p.keepKids.kids : [])])].slice(0, 8);

  // Tokens: one per (contact, peer), registered at the peer (only its SHA-256), deleted there when the contact goes. A contact's details
  // list only peers where their token is registered.
  async function syncPeer(p) {
    const want = new Set(listContacts());
    const add = [], gone = [];
    // a draining peer gets no tokens for new contacts (it isn't in anyone's new details), only keeps the ones contacts hold
    if (p.state !== 'draining') for (const c of want) if (!p.tokens[c]) p.tokens[c] = { tok: S.b64u(S.newSecret()), reg: false };
    for (const [c, t] of Object.entries(p.tokens)) {
      if (!want.has(c)) { if (t.reg) p.gone.push(S.sha256hex(S.fromB64u(t.tok))); delete p.tokens[c]; }
      else if (!t.reg) add.push(t);
    }
    if (p.oldKey && p.oldKey.until <= now()) { delete p.oldKey; p.kidsDue = true; }
    if (p.keepKids && p.keepKids.until <= now()) { delete p.keepKids; p.kidsDue = true; }
    for (const x of (p.retiring || []).filter((y) => y.until <= now())) p.gone.push(x.h);
    p.retiring = (p.retiring || []).filter((y) => y.until > now());
    if (!add.length && !p.gone.length && !p.kidsDue) return false;
    save();
    const cl = clientFor(p.address);
    const chunk = (xs) => { const out = []; for (let i = 0; i < xs.length; i += 1000) out.push(xs.slice(i, i + 1000)); return out.length ? out : [[]]; };
    let first = true;
    for (const part of chunk(add)) {
      const del = first ? p.gone.slice(0, 1000) : undefined;
      await cl.tokens(owner(p), { ...(part.length ? { add: part.map((t) => S.sha256hex(S.fromB64u(t.tok))) } : {}), ...(del && del.length ? { delete: del } : {}), kids: kidsOf(p) });
      for (const t of part) t.reg = true;
      if (del) p.gone = p.gone.slice(del.length);
      first = false;
    }
    delete p.kidsDue;
    save();
    return add.length > 0;
  }
  // Every peer, every contact: run after joining, at start, when contacts change, and every minute while anything is still owed (a
  // token not registered or not deleted, a peer not told we left, a join not answered). A change while it runs runs it once more.
  const owed = () => st.peers.some((p) => (p.state !== 'active' && !(p.state === 'draining' && p.drainUntil > now())) || p.gone.length || p.kidsDue || Object.values(p.tokens).some((t) => !t.reg)
    || (p.retiring || []).some((y) => y.until <= now()) || (p.oldKey && p.oldKey.until <= now()));
  let rerun = null;
  function sync() {
    // already running: it runs once more afterwards, and every caller waits for that run (which sees their change)
    if (syncing) { if (!rerun) rerun = syncing.catch(() => {}).then(() => { rerun = null; return sync(); }); return rerun; }
    syncing = (async () => {
      let added = false;
      // joins not answered yet (and cancelled ones: asked again only to learn the mailbox, so it can be left)
      for (const p of st.peers.filter((x) => x.state === 'joining' || (x.state === 'cancelled' && !x.mailbox))) {
        // never answered for 30 days (and at least 30 tries, so a clock jump alone can't do it): given up; an invite lasts 7 days anyway
        p.tries = (p.tries || 0) + 1;
        if (p.tries >= GIVE_UP_TRIES && sinceOk(p, 'joinedAt') >= GIVE_UP_MS) {
          st.peers = st.peers.filter((x) => x !== p); save();
          if (p.state === 'joining') ev.emit('join-failed', { address: p.address, code: 'gave-up' });
          continue;
        }
        try {
          const { mailbox } = await askJoin(p);
          if (activated(p, mailbox)) added = true;
        } catch (e) {
          if (e.kind === 'answer') { st.peers = st.peers.filter((x) => x !== p); save(); if (p.state === 'joining') ev.emit('join-failed', { address: p.address, code: e.code || e.status }); }
        }
      }
      // draining peers whose 8 days are over (or removed): a last collection that took everything, then they are left. Started here, not
      // waited for: one unreachable peer doesn't hold up tokens, leaves and joins.
      for (const p of st.peers.filter((x) => x.state === 'draining' && !x.restoreCheck)) {
        if (p.drainUntil > now() + DRAIN_MS) { p.drainUntil = now() + DRAIN_MS; save(); }          // the clock went back: never longer than 8 days
        if (p.drainUntil <= now() && !(p.nextFinishAt > now())) startFinish(p);
      }
      for (const p of st.peers.filter((x) => (x.state === 'active' || x.state === 'draining') && !x.restoreCheck && !x.lost)) {          // a restored peer is checked first (afterRestore); a lost one isn't asked
        try { if (await syncPeer(p)) added = true; } catch (e) { log(`[swarm] tokens at a peer not updated yet (${e.kind || ''} ${e.status || ''})`); }
      }
      for (const p of st.peers.filter((x) => x.state === 'leaving')) {
        if (!p.leavingSince || p.leavingSince > now()) { p.leavingSince = now(); save(); }
        p.leaveTries = (p.leaveTries || 0) + 1;
        try { await clientFor(p.address).leave(owner(p)); }
        catch (e) {
          const told = e.kind === 'answer' && (e.status === 404 || e.status === 401);
          // a peer that never answers: given up after 30 days and 30 tries (it forgets idle mailboxes on its own)
          if (!told && !(p.leaveTries >= GIVE_UP_TRIES && now() - p.leavingSince >= GIVE_UP_MS)) continue;
        }
        st.peers = st.peers.filter((x) => x !== p); save(); ev.emit('changed');
      }
      if (added) bump();
    })().finally(() => { syncing = null; });
    return syncing;
  }
  let retryT = null;
  // One join request at a time per peer, shared by join() and sync(): two answers can't both act on the same peer.
  const joinAsks = new Map();
  function askJoin(p) {
    if (joinAsks.has(p)) return joinAsks.get(p);
    const a = clientFor(p.address).join(p.invite, S.sha256hex(S.fromB64u(p.secret))).finally(() => joinAsks.delete(p));
    joinAsks.set(p, a);
    return a;
  }
  // Time since a saved moment, never negative and never counting a moment in the future (a clock that went back is reset to now).
  const sinceOk = (p, k) => { if (!p[k] || p[k] > now()) { p[k] = now(); save(); } return now() - p[k]; };
  const finishing = new Map();
  // a finished drain is told to the peer by the next sync, started at once
  function startFinish(p) { if (finishing.has(p)) return; finishing.set(p, finishDrain(p).then((done) => (done ? sync() : null)).catch(() => {}).finally(() => { finishing.delete(p); })); }
  // A join's answer: the peer becomes active, and if it was joined to replace another (Switch), that one drains from now. A join that
  // was cancelled meanwhile (Turn off, Remove) is left at once instead. Returns true when a peer became active.
  function activated(p, mailbox) {
    if (!st.peers.includes(p) || (p.state !== 'joining' && p.state !== 'cancelled')) return false;          // already acted on
    p.mailbox = mailbox; delete p.invite;
    if (p.state === 'cancelled') { p.state = 'leaving'; delete p.key.sk; save(); return false; }
    p.state = 'active';
    if (p.replaces) {
      const old = peer(p.replaces);
      if (old && old.state === 'active') { old.state = 'draining'; old.drainUntil = now() + DRAIN_MS; }
      delete p.replaces;
    }
    save();
    return true;
  }
  // The end of a drain: one last collection. Only once it took everything (or after 30 days of trying) is the peer told we left; until
  // then it stays draining and is tried again every minute, so nothing waiting there is lost because the peer was unreachable at the time.
  // Retries back off: 1, 2, 5, 15 minutes, then hourly; given up after 30 days and 30 tries (a clock jump alone never gives up).
  const FINISH_BACKOFF = [60e3, 120e3, 300e3, 900e3, 3600e3];
  async function finishDrain(p) {
    sinceOk(p, 'finishSince');
    p.finishTries = (p.finishTries || 0) + 1;
    let ok = false;
    try { ok = (await beforeLeave(p.address)) !== false; } catch { ok = false; }
    if (!ok && !(p.finishTries >= GIVE_UP_TRIES && now() - p.finishSince >= GIVE_UP_MS)) {
      const first = !p.collectPending;
      p.collectPending = true; p.nextFinishAt = now() + FINISH_BACKOFF[Math.min(p.finishTries - 1, FINISH_BACKOFF.length - 1)]; save();
      if (first) ev.emit('changed');          // said once, not at every try
      return false;
    }
    delete p.nextFinishAt;
    if (!st.peers.includes(p) || p.state !== 'draining') return false;
    p.state = 'leaving'; delete p.collectPending; delete p.restoreCheck; delete p.key.sk; if (p.oldKey) delete p.oldKey.sk; save(); ev.emit('changed');
    return true;
  }

  // Every hour, each peer's usage (held bytes of the quota) and how far its clock is from ours.
  // A lost mailbox is asked again once a day (a peer restored from its own backup knows it again: then it is used again).
  let polling = null;
  function pollInfo() {
    if (polling) return polling;
    polling = (async () => {
      if (!ready()) return;
      for (const p of st.peers.filter((x) => (x.state === 'active' || x.state === 'draining') && !x.restoreCheck)) {
        const h = p.health || (p.health = {});
        const every = p.lost ? 24 * 3600e3 : p.lostSuspect ? 2 * 60e3 : 3600e3;
        if (h.infoAt && now() - h.infoAt < every && h.infoAt <= now()) continue;
        const cl = clientFor(p.address);
        try {
          const inf = await cl.info(owner(p));
          h.infoAt = now(); h.heldBytes = inf.heldBytes; h.quota = inf.quota; h.clockOffset = cl.clockOffset() || 0; h.clockAt = now();
          if (p.lost || p.lostSuspect) { const was = p.lost; delete p.lost; delete p.lostSuspect; if (was) bump(); }
          api.noteHealth(p.address, true); save(); ev.emit('health');
        } catch (e) {
          h.infoAt = now();
          if (e.kind === 'answer' && (e.status === 401 || (e.status === 404 && e.code === 'no-mailbox'))) api.markLost(p.address);
          else if (e.kind !== 'answer' || e.status >= 500) api.noteHealth(p.address, false);
        }
      }
    })().finally(() => { polling = null; });
    return polling;
  }

  // After a restore, each peer in turn: does the mailbox still exist? (no: removed, and said); was another install active there since
  // the backup (its keys, or a collection after the backup was made)? (yes: the warning, and its keys kept 8 days); then the backup's
  // tokens are registered again (added, in chunks: tokens the other install made since are left alone, and each token counts as
  // registered only once its hash was sent) with our keys, and seq goes up, so contacts who read our details get them, naming that peer.
  // A peer that doesn't answer is asked again every minute; the others don't wait for it.
  let restoring = null;
  function afterRestore() {
    if (restoring) return restoring;
    restoring = (async () => {
      for (const p of st.peers.filter((x) => x.restoreCheck && x.state !== 'leaving')) {
        const cl = clientFor(p.address);
        try {
          const inf = await cl.info(owner(p));
          const mine = new Set([p.key.kid, ...(p.oldKey ? [p.oldKey.kid] : [])]);
          const theirs = (inf.kids || []).filter((k) => !mine.has(k));
          const lastCollect = Number.isFinite(inf.lastCollect) ? cl.toLocal(inf.lastCollect) : 0;
          if (theirs.length || (st.backupAt && lastCollect > st.backupAt + 3600e3)) {
            if (theirs.length) p.keepKids = { kids: theirs.slice(0, 6), until: now() + ROTATE_KEEP_MS };
            ev.emit('other-install', { peer: p.address });
            log('[swarm] after the restore: another install used this mailbox since the backup');
          }
          delete p.restoreCheck; p.kidsDue = true; save();
          await syncPeer(p);
          bump();
        } catch (e) {
          if (e.kind === 'answer' && (e.status === 401 || (e.status === 404 && e.code === 'no-mailbox'))) {
            st.peers = st.peers.filter((x) => x !== p); save();
            ev.emit('mailbox-gone', { peer: p.address });
            log('[swarm] after the restore, a peer no longer knows our mailbox: removed');
            bump();
          }
        }
      }
      if (!st.peers.some((x) => x.restoreCheck && x.state !== 'leaving') && st.restored) { delete st.restored; save(); }
    })().finally(() => { restoring = null; });
    return restoring;
  }
  // Until one restored peer has been checked, contacts get nothing from us (empty details would say "write to me directly").
  const quietAfterRestore = () => !!st.restored && !st.peers.some((p) => p.state === 'active' && !p.restoreCheck);

  load();
  const api = Object.assign(ev, {
    start() {
      (st.restored ? afterRestore() : Promise.resolve()).catch(() => {}).then(() => sync()).catch(() => {});
      retryT = setInterval(() => { if (st.restored) afterRestore().catch(() => {}); if (owed()) sync().catch(() => {}); pollInfo().catch(() => {}); }, 60e3); retryT.unref?.();
      setTimeout(() => pollInfo().catch(() => {}), 5000).unref?.();
    },
    // ---- backup and restore (design section 13; docs/BACKUP-FORMAT.md, the swarm field) ----
    // Everything a restore needs to keep the same mailboxes: each peer's address, mailbox, owner secret, seal keys and the token each
    // contact holds; seq and keep-for; who can read our details.
    backup() {
      // every token, registered or not yet (a contact holds it, or will): a restore registers them all again
      return { v: 1, at: now(), seq: st.seq, keepFor: st.keepFor, capable: Object.keys(st.capable),
        peers: st.peers.filter((p) => p.state !== 'cancelled' && (p.key.sk || p.state === 'leaving')).map((p) => ({ address: p.address, state: p.state, ...(p.mailbox ? { mailbox: p.mailbox } : {}),
          ...(p.state === 'draining' ? { drainUntil: p.drainUntil } : {}), ...(p.replaces ? { replaces: p.replaces } : {}),
          ...(p.invite ? { invite: p.invite } : {}), secret: p.secret, key: p.key, ...(p.oldKey && p.oldKey.until > now() ? { oldKey: p.oldKey } : {}),
          tokens: Object.fromEntries(Object.entries(p.tokens).map(([c, t]) => [c, t.tok])),
          retiring: (p.retiring || []).filter((y) => y.until > now()) })) };
    },
    // Puts a backup's mailboxes in place, on an install that has none. Checked whole; anything that doesn't fit is left out. After the
    // restart, each peer is asked whether the mailbox still exists, its token list is replaced with the backup's, and every contact who
    // can read our details gets them again (afterRestore).
    restore(b) {
      if (st.peers.length) return { restored: 0, error: 'not-fresh' };
      if (!b || typeof b !== 'object' || !Number.isInteger(b.v) || b.v < 1) return { restored: 0, error: 'invalid' };
      if (b.v > 1) return { restored: 0, error: 'too-new' };
      const B64U = (n) => new RegExp(`^[A-Za-z0-9_-]{${n}}$`), KID = /^[0-9a-f]{16}$/, MB = /^[0-9a-f]{32}$/;
      // a key pair: the kid its public key gives at that address, the public key a point on the curve, and the secret key its own
      const keyOk = (k, a) => {
        if (!k || typeof k !== 'object' || !KID.test(String(k.kid)) || !B64U(87).test(String(k.pk)) || !B64U(43).test(String(k.sk))) return false;
        try {
          const pk = S.fromB64u(k.pk);
          if (S.kidOf(a, pk) !== k.kid) return false;
          const e = crypto.createECDH('prime256v1'); e.setPrivateKey(S.fromB64u(k.sk));
          return e.getPublicKey().equals(pk);
        } catch { return false; }
      };
      const until8 = (x) => Math.min(Number(x), now() + ROTATE_KEEP_MS);
      const peers = [], seen = new Set();
      // at most 4 listed (active or joining) and 8 in all: a peer being drained or left never takes a listed one's place
      let listedN = 0;
      for (const p of Array.isArray(b.peers) ? b.peers.slice(0, MAX_PEERS * 4) : []) {
        if (peers.length >= MAX_PEERS * 2) break;
        const state = p && ['joining', 'leaving', 'draining'].includes(p.state) ? p.state : 'active';
        if ((state === 'active' || state === 'joining') && listedN >= MAX_PEERS) continue;
        // a peer being left needs only its mailbox and owner secret (to be told); its keys are gone already
        if (!p || !ADDR.test(String(p.address)) || seen.has(p.address) || !B64U(43).test(String(p.secret)) || (state !== 'leaving' && !keyOk(p.key, p.address))) continue;
        if (state === 'joining' ? !/^[0-9a-f]{32}$/.test(String(p.invite)) : !MB.test(String(p.mailbox))) continue;
        seen.add(p.address);
        if (state === 'active' || state === 'joining') listedN++;
        const tokens = {};
        const tk = p.tokens && typeof p.tokens === 'object' && !Array.isArray(p.tokens) ? p.tokens : {};
        for (const c of Object.keys(tk).slice(0, 10000)) if (ADDR.test(c) && B64U(43).test(String(tk[c]))) tokens[c] = { tok: tk[c], reg: false };
        const retiring = (Array.isArray(p.retiring) ? p.retiring.slice(0, 10000) : [])
          .filter((y) => y && /^[0-9a-f]{64}$/.test(String(y.h)) && Number.isFinite(y.until) && y.until > now()).map((y) => ({ h: y.h, until: until8(y.until) }));
        peers.push({ address: p.address, state, ...(state === 'joining' ? { invite: p.invite } : { mailbox: p.mailbox }), secret: p.secret,
          key: state === 'leaving' ? { kid: String(p.key?.kid || ''), pk: String(p.key?.pk || '') } : { kid: p.key.kid, pk: p.key.pk, sk: p.key.sk },
          ...(p.oldKey && keyOk(p.oldKey, p.address) && Number.isFinite(p.oldKey.until) && p.oldKey.until > now() ? { oldKey: { kid: p.oldKey.kid, pk: p.oldKey.pk, sk: p.oldKey.sk, until: until8(p.oldKey.until) } } : {}),
          ...(state === 'draining' ? { drainUntil: Number.isFinite(p.drainUntil) ? Math.min(p.drainUntil, now() + DRAIN_MS) : now() + DRAIN_MS } : {}),
          ...(state === 'joining' && ADDR.test(String(p.replaces)) ? { replaces: p.replaces } : {}),
          tokens, gone: [], retiring, joinedAt: now(), lastCollect: 0, kidsDue: true, ...(state === 'active' || state === 'draining' ? { restoreCheck: true } : {}) });
      }
      // a pending switch is kept only if what it replaces was restored too
      for (const p of peers) if (p.replaces && !peers.some((x) => x.address === p.replaces && x.state === 'active')) delete p.replaces;
      const seq = Number.isSafeInteger(b.seq) && b.seq > 0 && b.seq < now() + SEQ_AHEAD_MS ? b.seq : 0;
      const keepFor = Number.isInteger(b.keepFor) && b.keepFor >= 3600 && b.keepFor <= KEEP_DEFAULT ? b.keepFor : KEEP_DEFAULT;
      const capable = {}; for (const c of Array.isArray(b.capable) ? b.capable : []) if (ADDR.test(String(c))) capable[c] = 1;
      const backupAt = Number.isFinite(b.at) && b.at > 0 && b.at <= now() + 3600e3 ? b.at : 0;
      st = { v: 1, seq, keepFor, peers, capable, sent: {}, restored: peers.some((p) => p.restoreCheck), ...(backupAt ? { backupAt } : {}) };
      save();
      return { restored: peers.length };
    },
    // A restore from a backup without a mailbox (or one too new to read): if contacts still hold mailbox details from before, they
    // should hear "write to me directly" once they show they read details, so seq is set (with no peers, details say exactly that).
    restoredWithoutMailbox() { if (!st.peers.length && !st.seq) { st.seq = now(); save(); } },
    stop() { clearInterval(retryT); },
    // Join with an invite (32 hex characters) from the peer's operator. Throws a SwarmError on refusal (invite-used, -expired, -unknown,
    // full) or no route.
    async join(address, invite, opts = {}) {
      address = String(address || '').trim().toLowerCase();
      invite = String(invite || '').trim().toLowerCase();
      if (!ADDR.test(address)) throw Object.assign(new Error('bad address'), { code: 'bad-address' });
      // a peer still draining (after Turn off or a Switch): taken back as it is, no invite needed
      let back = peer(address);
      // a cancelled join to the same address (never answered): replaced by this one
      if (back && back.state === 'cancelled' && !back.mailbox) { st.peers = st.peers.filter((x) => x !== back); save(); back = null; }
      const listedNow = () => st.peers.filter((p) => p.state === 'active' || p.state === 'joining').length
        - st.peers.filter((p) => p.state === 'joining' && p.replaces && peer(p.replaces)?.state === 'active').length;
      if (back && back.state === 'draining' && !opts.replaces) {
        if (listedNow() + 1 > MAX_PEERS) throw Object.assign(new Error('too many peers'), { code: 'too-many' });          // contacts refuse details with more
        back.state = 'active'; delete back.drainUntil; delete back.finishSince; delete back.collectPending; save();
        await sync(); bump();
        return { address, mailbox: back.mailbox, back: true };
      }
      if (!/^[0-9a-f]{32}$/.test(invite)) throw Object.assign(new Error('bad invite'), { code: 'invite-unknown' });
      if (back) throw Object.assign(new Error('already joined'), { code: 'already' });
      // Listed peers, counting a pending switch as the one it replaces; a switch keeps the count, a join adds one
      if (listedNow() + (opts.replaces ? 0 : 1) > MAX_PEERS || st.peers.length >= MAX_PEERS * 2) throw Object.assign(new Error('too many peers'), { code: 'too-many' });
      const secret = S.newSecret();
      // saved first, with the invite (and what it replaces): if we stop before the peer's answer is saved, the join is asked again (the
      // peer accepts it) and finishes what it started
      const p = { address, invite, secret: S.b64u(secret), state: 'joining', key: newKey(address), tokens: {}, gone: [], retiring: [], joinedAt: now(), lastCollect: 0, kidsDue: true,
        ...(opts.replaces ? { replaces: opts.replaces } : {}) };
      st.peers.push(p); save();
      let mailbox;
      try { ({ mailbox } = await askJoin(p)); }
      catch (e) {
        if (e.kind === 'answer') { st.peers = st.peers.filter((x) => x !== p); save(); throw e; }          // refused: nothing kept
        ev.emit('changed');
        throw Object.assign(e, { pending: true });          // no route: kept as joining, asked again every minute, and finished then
      }
      const became = activated(p, mailbox);
      await sync();
      bump();
      if (!became) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      return { address, mailbox };
    },
    // Leave a peer: contacts get details without it at once; the peer is told (and told again until it hears it).
    // Remove a peer now: contacts get details without it at once; what waits there is collected one last time; then the peer is told
    // (and told again until it hears it).
    async leave(address) {
      const p = peer(address); if (!p) return false;
      // a join not answered yet: cancelled (if its answer comes, that mailbox is left at once)
      if (p.state === 'joining') { p.state = 'cancelled'; save(); ev.emit('changed'); sync().catch(() => {}); return true; }
      if (p.state === 'leaving' || p.state === 'cancelled') return true;
      const wasListed = p.state === 'active';
      p.state = 'draining'; p.drainUntil = now(); save();
      if (wasListed) bump();
      const done = await finishDrain(p);
      if (done) await sync();
      return { ok: true, collectPending: !done };
    },
    // Switch: join the new peer first (nothing changes if that fails), then the old one drains 8 days: no longer in contacts' details,
    // still collected, then left.
    async switchPeer(from, address, invite) {
      const old = peer(from);
      if (!old || old.state !== 'active') throw Object.assign(new Error('no such peer'), { code: 'not-found' });
      if (st.peers.some((p) => p.state === 'joining' && p.replaces === from)) throw Object.assign(new Error('switch under way'), { code: 'already' });
      return this.join(address, invite, { replaces: from });          // the old peer drains once the new one is active (activated)
    },
    // Turn off: contacts get details with no peers (they write directly at once); every peer drains 8 days, then is left.
    turnOff() {
      let n = 0;
      for (const p of st.peers.filter((x) => x.state === 'active')) { p.state = 'draining'; p.drainUntil = now() + DRAIN_MS; n++; }
      for (const p of st.peers.filter((x) => x.state === 'joining')) p.state = 'cancelled';          // their answers, if they come, are left at once
      save();
      if (n) bump(); else ev.emit('changed');
      sync().catch(() => {});
      return n;
    },
    // A new seal key at every peer and new tokens for every contact; the old key opens drops 8 more days.
    rotate() {
      for (const p of st.peers.filter((x) => x.state === 'active')) {
        p.oldKey = { ...p.key, until: now() + ROTATE_KEEP_MS }; p.key = newKey(p.address); p.kidsDue = true;
        // the old tokens keep working 8 days, so contacts still holding the old details aren't refused meanwhile
        p.retiring = p.retiring || [];
        for (const t of Object.values(p.tokens)) if (t.reg) p.retiring.push({ h: S.sha256hex(S.fromB64u(t.tok)), until: now() + ROTATE_KEEP_MS });
        p.tokens = {};
      }
      save(); return sync();
    },
    sync,
    // The details frame for one contact (null if we have no peers and never had: nothing to say).
    detailsFor(contact) {
      if (quietAfterRestore()) return null;
      const ps = st.peers.filter((p) => p.state === 'active' && !p.lost && p.tokens[contact] && p.tokens[contact].reg);          // a lost mailbox: not offered
      if (!st.seq) return null;
      return { v: 1, seq: st.seq, keepFor: st.keepFor, peers: ps.map((p) => ({ address: p.address, kid: p.key.kid, pk: p.key.pk, token: p.tokens[contact].tok,
        ...(p.oldKey && p.oldKey.until > now() ? { oldKid: p.oldKey.kid, oldPk: p.oldKey.pk } : {}) })) };
    },
    // Capability: a contact's frames carried sw: 1. Returns true when they should get our details now.
    capable(contact) { if (!st.capable[contact]) { st.capable[contact] = 1; save(); } return !!st.seq && !quietAfterRestore() && (st.sent[contact] || 0) < st.seq; },
    sent(contact, seq) { if (Number.isSafeInteger(seq) && seq > (st.sent[contact] || 0)) { st.sent[contact] = seq; save(); } },
    // Contacts who can read our details and haven't got the latest.
    due() { return st.seq && !quietAfterRestore() ? Object.keys(st.capable).filter((c) => (st.sent[c] || 0) < st.seq && listContacts().includes(c)) : []; },
    forget(contact) { delete st.capable[contact]; delete st.sent[contact]; save(); return sync(); },
    // For collection
    peers: () => st.peers.filter((p) => (p.state === 'active' || p.state === 'draining') && !p.lost).map((p) => ({ address: p.address, owner: owner(p) })),          // collected
    // ---- health, for the warnings (design section 15): kept on this device, never sent anywhere ----
    // ok: an answer from the peer; not ok: no route or a failing peer. Changes of state are saved and said ('health').
    noteHealth(address, isOk) {
      const p = peer(address); if (!p) return;
      const h = p.health || (p.health = {});
      const t = now();
      if (isOk) { const was = !!h.failSince; h.okAt = t; delete h.failSince; delete h.failRun; if (p.lostSuspect) delete p.lostSuspect; if (was) { save(); ev.emit('health'); } return; }
      if (!ready()) return;          // our own network is down: not the peer's fault
      h.fails = (h.fails || []).filter((x) => t - x < 24 * 3600e3 && x <= t).slice(-199); h.fails.push(t);
      if (!h.failSince || h.failSince > t) { h.failSince = t; h.failRun = RUN; save(); ev.emit('health'); }
      else if (h.failRun !== RUN) { h.failRun = RUN; save(); ev.emit('health'); }          // a failure from before this start, seen again
    },
    // The peer no longer knows our mailbox (it was removed there, or forgotten after 60 days unused): not offered to contacts any more,
    // and the person is told to remove it.
    // Only a second "no such mailbox", at least 2 minutes after the first, makes it lost (one odd answer doesn't); see pollInfo for the way back.
    markLost(address) {
      const p = peer(address); if (!p || p.lost) return;
      if (!p.lostSuspect || p.lostSuspect > now()) { p.lostSuspect = now(); if (p.health) p.health.infoAt = 0; save(); return; }
      if (now() - p.lostSuspect < 2 * 60e3) return;
      p.lost = true; delete p.lostSuspect; save(); bump(); ev.emit('health');
    },
    // What the app explains (codes; the window words them): newest state each time it is asked.
    problems() {
      const t = now(), out = [];
      const listed = st.peers.filter((p) => p.state === 'active');
      const down = (p) => p.health && p.health.failSince && p.health.failRun === RUN && t - p.health.failSince > 2 * 60e3;
      const usable = listed.filter((p) => !p.lost);
      if (usable.length && usable.every(down)) out.push({ code: 'all-unreachable' });
      for (const p of listed) {
        if (p.lost) { out.push({ code: 'mailbox-lost', peer: p.address }); continue; }
        if (down(p) && t - p.health.failSince >= 7 * 86400e3) out.push({ code: 'peer-gone-week', peer: p.address });
        else if (down(p) && usable.length > 1) out.push({ code: 'peer-unreachable', peer: p.address, since: p.health.failSince });
        if (p.health && p.health.quota && p.health.heldBytes >= 0.9 * p.health.quota) out.push({ code: 'nearly-full', peer: p.address });
      }
      // A clock is off, ours or a peer's (design section 5): from peers that answered in the last 2 hours. When two or more of them agree
      // our clock is the odd one; otherwise the peer is named, since it may be the one that's wrong.
      const fresh = usable.filter((p) => p.health && p.health.clockAt && t - p.health.clockAt < 2 * 3600e3 && t >= p.health.clockAt);
      const offs = fresh.map((p) => ({ p, off: p.health.clockOffset || 0 })).filter((x) => Math.abs(x.off) > 5 * 60e3);
      if (offs.length) {
        const same = offs.filter((x) => Math.sign(x.off) === Math.sign(offs[0].off));
        const mins = (x) => Math.round(Math.abs(x.off) / 60e3);
        if (same.length >= 2 && same.length === fresh.length) out.push({ code: 'clock-off-mine', minutes: Math.min(...same.map(mins)) });
        else for (const x of offs) out.push({ code: 'clock-off', peer: x.p.address, minutes: mins(x) });
      }
      return out;
    },
    secretKey(address, kid) {
      const p = peer(address); if (!p) return null;
      if (p.key.kid === kid && p.key.sk) return { sk: S.fromB64u(p.key.sk), pk: S.fromB64u(p.key.pk) };
      if (p.oldKey && p.oldKey.kid === kid && p.oldKey.until > now() && p.oldKey.sk) return { sk: S.fromB64u(p.oldKey.sk), pk: S.fromB64u(p.oldKey.pk) };
      return null;
    },
    collected(address, at = now()) { const p = peer(address); if (p) { p.lastCollect = at; if (!p._savedAt || at - p._savedAt > 60e3 || at < p._savedAt) { p._savedAt = at; save(); } } },
    list: () => st.peers.filter((p) => p.state !== 'cancelled').map((p) => ({ address: p.address, state: p.state,
      ...(p.lost ? { lost: true } : {}),
      ...(p.health ? { unreachableSince: p.health.failSince || null, fails24h: (p.health.fails || []).filter((x) => now() - x < 24 * 3600e3).length,
        ...(p.health.quota ? { heldBytes: p.health.heldBytes || 0, quota: p.health.quota } : {}) } : {}), ...(p.state === 'draining' ? { drainUntil: p.drainUntil, ...(p.collectPending ? { collectPending: true } : {}) } : {}), joinedAt: p.joinedAt, lastCollect: p.lastCollect || 0, contacts: Object.values(p.tokens).filter((t) => t.reg).length })),
    hasPeers: () => st.peers.some((p) => p.state === 'active'),
    seq: () => st.seq,
    // The network is back (or the computer woke): waiting retries go now.
    kick() { for (const p of st.peers) delete p.nextFinishAt; return sync(); },
    // everything started in the background has finished (last collections and what follows them): for tests and the quit path
    async settled() { for (let i = 0; i < 5 && (finishing.size || syncing); i++) { await Promise.all([...finishing.values()]); if (syncing) await syncing.catch(() => {}); } },
  });
  Object.defineProperty(api, 'restoredPending', { get: () => !!st.restored });
  return api;
}

module.exports = { create, MAX_PEERS };
