'use strict';

// server.js — the node behind your .anyone address.
// Two listeners: a public one (the hidden service's port) with the peer API, and a loopback-only one for the UI.

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const axios   = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { WebSocketServer } = require('ws');

const store = require('./lib/store');
const sealed = require('./lib/sealed');
const http = require('http');
const rl    = require('./lib/ratelimit');
const pow   = require('./lib/pow');
const stamp = require('./lib/stamp');
const contactTest = require('./lib/contacttest');
const deliverylog = require('./lib/deliverylog');   // also names the network's own SOCKS reply codes (see the file)
const netlock = require('./lib/netlock');
const peerdata = require('./lib/peerdata');
const { createCallBridge } = require('./lib/callbridge');

// Stay up on stray errors: one unhandled rejection must not take the hidden service and WebSocket down.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err && err.stack ? err.stack : err);
});

const PUBLIC_PORT = parseInt(process.env.PUBLIC_PORT || '3000', 10);
const UI_PORT     = parseInt(process.env.UI_PORT     || '4000', 10);
// All outbound HTTP goes through the loopback SOCKS proxy (socks5h, remote DNS); nothing can route around it.
const SOCKS = (() => {
  try { return netlock.normalizeSocks(process.env.SOCKS || 'socks5h://127.0.0.1:9050'); }
  catch (e) { console.error('  [fatal] ' + e.message); process.exit(1); }
})();
const HOST        = '127.0.0.1';
const ANON_DIR    = process.env.ANON_DIR || path.join(__dirname, 'anon');
const HOSTNAME_FILE = path.join(ANON_DIR, 'anon_service', 'hostname');
const ANON_LOG    = path.join(ANON_DIR, 'anon.log');
const ANON_COOKIE = path.join(ANON_DIR, 'control_auth_cookie');
const CTRL_PORT   = Number(process.env.ANON_CTRL_PORT) || 9051;

async function ctrlCmd(cmd) {
  return new Promise((resolve, reject) => {
    let cookie;
    try { cookie = fs.readFileSync(ANON_COOKIE); }
    catch { return reject(new Error('control cookie not yet available — anon may still be bootstrapping')); }
    const sock = require('net').connect(CTRL_PORT, '127.0.0.1', () => {
      sock.write(`AUTHENTICATE ${cookie.toString('hex')}\r\n${cmd}\r\nQUIT\r\n`);
    });
    let out = '';
    sock.on('data', d => { out += d.toString(); });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('control port timeout')); }, 5000);
    sock.on('end',  () => { clearTimeout(timer); resolve(out); });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
const MAX_ENVELOPE  = 8 * 1024 * 1024;  // 8 MB: covers a 5 MB file + base64 + envelope overhead
const MB = 1024 * 1024;
const LIMITS = {
  strangerEnvelope: 512 * 1024,   // a stranger's single message: text, or a group invite with its picture
  strangerCount: 20,  strangerBytes: 2 * MB,      // one stranger
  strangersCount: 200, strangersBytes: 16 * MB,   // all strangers together
  peerCount: 300, peerBytes: 64 * MB,             // one group member who isn't a contact
  contactBytes: 256 * MB,                         // one contact
  totalCount: parseInt(process.env.MAX_INBOX || '5000', 10), totalBytes: 1024 * MB,
};

// A v3 .anyone address is 56 base32 chars (a-z, 2-7) + ".anyone"; validate before putting one in an outbound URL.
const ADDR_RE = /^[a-z2-7]{56}\.anyone$/;
function cleanAddr(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}
function isValidAddr(addr) {
  return ADDR_RE.test(addr);
}

// Validate the shape of every inbound envelope: unbounded or untyped fields would let a sender waste inbox rows and WebSocket pushes.
const MAX_DH_LEN  = 512;            // base64 P-256 pubkey is ~88 chars
const MAX_CT_LEN  = 8 * 1024 * 1024;
const MAX_OPK_LEN = 128;
function validEnvelope(env) {
  if (typeof env.from !== 'string' || !env.from) return false;
  if (typeof env.dh   !== 'string' || env.dh.length === 0 || env.dh.length > MAX_DH_LEN) return false;
  if (typeof env.ct   !== 'string' || env.ct.length === 0 || env.ct.length > MAX_CT_LEN) return false;
  if (!Number.isInteger(env.n) || env.n < 0) return false;
  if (env.pn != null && (!Number.isInteger(env.pn) || env.pn < 0)) return false;
  if (env.x3dh != null) {
    const x = env.x3dh;
    if (typeof x !== 'object' || Array.isArray(x)) return false;
    if (typeof x.ik !== 'string' || x.ik.length > MAX_DH_LEN) return false;
    if (typeof x.ek !== 'string' || x.ek.length > MAX_DH_LEN) return false;
    if (x.opkId != null && (typeof x.opkId !== 'string' || x.opkId.length > MAX_OPK_LEN)) return false;
  }
  if (env.stamp != null && (typeof env.stamp !== 'string' || env.stamp.length > 64)) return false;
  if (env.pow != null) {
    const p = env.pow;
    if (typeof p !== 'object' || Array.isArray(p)) return false;
    if (typeof p.c !== 'string' || p.c.length > 128) return false;
    if (typeof p.n !== 'string' || p.n.length > 64) return false;
  }
  return true;
}

function myAddress() {
  try { return fs.readFileSync(HOSTNAME_FILE, 'utf8').trim(); }
  catch { return null; }
}

// Every request to another node has a hard deadline: its timeout, from start to the last byte. axios's own `timeout` only covers the wait
// for the answer to begin; a node that then sends one byte every few seconds could hold the request open for ever, and with it the
// online checks and the retry rounds for everyone else. A request cut off this way fails exactly as a timeout does.
const PEER_DEADLINE_MS = 45000;
function withDeadline(inst) {
  inst.interceptors.request.use((cfg) => {
    if (!cfg.signal) { cfg._deadlineMs = cfg.timeout || PEER_DEADLINE_MS; cfg.signal = AbortSignal.timeout(cfg._deadlineMs); }
    return cfg;
  });
  inst.interceptors.response.use(null, (err) => {
    const cfg = err && err.config;
    if (cfg && cfg._deadlineMs && axios.isCancel(err)) {
      return Promise.reject(new axios.AxiosError(`timeout of ${cfg._deadlineMs}ms exceeded`, 'ECONNABORTED', cfg, err.request));
    }
    return Promise.reject(err);
  });
  return inst;
}

function onion() {
  const agent = new SocksProxyAgent(SOCKS);
  return withDeadline(axios.create({
    httpAgent: agent,
    httpsAgent: agent,
    proxy: false,
    adapter: 'http',           // Node's http client through the SOCKS agent only: never the fetch or HTTP/2 adapters, which can skip it
    maxRedirects: 0,           // a peer never needs to redirect us, so a peer can't send our request somewhere else either
    timeout: 45000,
    maxContentLength: MAX_ENVELOPE,
    maxBodyLength: MAX_ENVELOPE,
    // Answers from other nodes are never unpacked: we ask for them plain, and a compressed answer is taken as-is (and then fails the
    // checks as unreadable). A peer could otherwise feed any bytes it likes to the gzip or Brotli decoder before our own size limit
    // applies; a bug in a decoder (Node.js CVE-2026-111497, Brotli) would then be within reach of every contact and group member.
    decompress: false,
    headers: { 'Accept-Encoding': 'identity' },
  }));
}

function noCache(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Content-Security-Policy: same-origin assets and WebSocket only, no inline or eval scripts (the theme pre-paint lives in pre-theme.js).
  // Inline styles are allowed only for static style attributes; style injection can't execute code.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self' ws://127.0.0.1:${UI_PORT} ws://localhost:${UI_PORT}`,   // only the local backend: no other host can be contacted from a page
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; '));
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}

const wsClients = new Set();
function broadcastEnvelope(envelope) {
  const msg = JSON.stringify({ type: 'inbox', envelope });
  for (const sock of wsClients) {
    if (sock.readyState === 1) sock.send(msg);
  }
}

// A message arrived from a contact or group member whose mailbox key we don't have yet: ask the window (which holds our identity key) to
// work it out, fetching the member's keys first if needed. At most every 30 s per address.
const _keyAsks = new Map();
function askWindowForKey(address) {
  const now = Date.now();
  if (now - (_keyAsks.get(address) || 0) < 30000) return;
  _keyAsks.set(address, now);
  if (_keyAsks.size > 1000) _keyAsks.clear();
  const msg = JSON.stringify({ type: 'mailbox:missing', address });
  for (const sock of wsClients) if (sock.readyState === 1) sock.send(msg);
}

// Refresh a contact's profile when they message us: their node is known to be reachable.
const PROFILE_REFRESH_MS = 60 * 60 * 1000;
const PROFILE_FORCE_MS   = 10 * 1000;
const lastProfileCheck = new Map();

const lastForcedCheck = new Map();
// Remember when an address was last checked, keeping the maps at 2000 entries: the oldest is forgotten first (a check may then happen a
// little early for an address nobody has written from in a long while, which costs one request).
function noteCheck(map, addr, now) {
  map.delete(addr); map.set(addr, now);
  if (map.size > 2000) map.delete(map.keys().next().value);
}
function maybeRefreshProfile(fromAddr, force = false) {
  const now = Date.now();
  // A notice that their profile changed (a profile bump) is limited only by other notices: limited by the routine check a message
  // just made, a new picture sent right after a message was ignored until the next hourly check.
  const last = (force ? lastForcedCheck : lastProfileCheck).get(fromAddr) || 0;
  if (now - last < (force ? PROFILE_FORCE_MS : PROFILE_REFRESH_MS)) return;
  noteCheck(lastProfileCheck, fromAddr, now);
  if (force) noteCheck(lastForcedCheck, fromAddr, now);

  (async () => {
    try {
      const contact = store.getContacts().find(c => c.address === fromAddr);
      // A group member who isn't a contact: only their picture is kept (shown beside their group messages), refreshed the same way.
      if (!contact) {
        if (!store.getPeers().some(p => p.address === fromAddr) || !store.groupMemberSet().has(fromAddr)) return;
        const { data } = await onion().get(`http://${fromAddr}/api/profile`);
        const { avatar } = peerdata.profile(data);
        const peer = store.getPeers().find(p => p.address === fromAddr);
        const pk = peer ? peerdata.prekey(data, peer.ikSigPub) : null;
        const newKey = pk && pk.ratchetPub !== peer.ratchetPub ? pk : null;
        if (peer && ((peer.avatar || null) !== avatar || newKey)) store.upsertPeer({ address: fromAddr, avatar, ...(newKey || {}) });
        return;
      }
      const { data } = await onion().get(`http://${fromAddr}/api/profile`);
      markSeen(fromAddr);
      const { avatar: newAvatar, bio: newBio } = peerdata.profile(data);     // checked: a picture of sane size, a short status
      // Re-read after the network call: the contact may have been removed or edited meanwhile.
      const fresh = store.getContacts().find(c => c.address === fromAddr);
      if (!fresh) return; // removed mid-refresh — don't recreate
      // Their new signed prekey (replaced every week), taken only with a valid signature by the identity signing key pinned when they
      // were added: a new chat session with them then starts from their current one.
      const pk = peerdata.prekey(data, fresh.ikSigPub);
      const newKey = pk && pk.ratchetPub !== fresh.ratchetPub ? pk : null;
      if (newAvatar !== (fresh.avatar || null) || newBio !== (fresh.bio || null) || fresh.name || newKey) {
        store.upsertContact({ address: fromAddr, avatar: newAvatar, name: null, bio: newBio, ...(newKey || {}) });
      }
    } catch {}
  })();
}

// Whether each contact's node can be reached. A hidden-service connection often fails or takes long on the first try (a fresh
// descriptor, a new rendezvous circuit), so one failed check is not enough to call someone offline: it takes two in a row, the second
// 30 s after the first. Anything that proves they are reachable (a message from them, a message delivered to them, their profile)
// marks them online at once, and a contact seen in the last two minutes isn't checked again.
const presence = new Map();          // address -> { online, lastSeen, fails }
const envMs = (k, d) => { const v = parseInt(process.env[k] || '', 10); return v > 0 ? v : d; };   // the tests shorten these
const PRESENCE_INTERVAL_MS = envMs('PRESENCE_INTERVAL_MS', 3 * 60 * 1000);
const PRESENCE_STAGGER_MS  = envMs('PRESENCE_STAGGER_MS', 4000);
const PRESENCE_TIMEOUT_MS  = 30000;
const PRESENCE_RECHECK_MS  = envMs('PRESENCE_RECHECK_MS', 30000);
const PRESENCE_FRESH_MS    = envMs('PRESENCE_FRESH_MS', 2 * 60 * 1000);

function markSeen(address) {
  presence.set(address, { online: true, lastSeen: Date.now(), fails: 0 });
}
const _rechecks = new Set();
async function checkPresence(address) {
  try {
    await onion().get(`http://${address}/api/profile`, { timeout: PRESENCE_TIMEOUT_MS });
    markSeen(address);
  } catch {
    const p = presence.get(address) || { online: null, lastSeen: null, fails: 0 };
    if (Date.now() - (p.lastSeen || 0) < PRESENCE_FRESH_MS) return;          // reached meanwhile by a message: that wins
    const fails = (p.fails || 0) + 1;
    presence.set(address, { online: fails >= 2 ? false : p.online, lastSeen: p.lastSeen, fails });
    if (fails === 1 && !_rechecks.has(address)) {
      _rechecks.add(address);
      setTimeout(() => { _rechecks.delete(address); if (store.getContacts().some((c) => c.address === address)) checkPresence(address); }, PRESENCE_RECHECK_MS);
    }
  }
}

let _sweeping = false;              // a sweep over many unreachable contacts can outlast the interval: never run two at once
async function presenceSweep() {
  if (_sweeping || !netready.isReady()) return;          // not before the network is ready (lib/netready.js)
  _sweeping = true;
  try { await presenceSweepOnce(); } finally { _sweeping = false; }
}
async function presenceSweepOnce() {
  for (const c of store.getContacts()) {
    if (Date.now() - (presence.get(c.address)?.lastSeen || 0) < PRESENCE_FRESH_MS) continue;
    await checkPresence(c.address);
    await new Promise(r => setTimeout(r, PRESENCE_STAGGER_MS));
  }
}
setInterval(presenceSweep, PRESENCE_INTERVAL_MS);
setTimeout(presenceSweep, envMs('PRESENCE_FIRST_MS', 15000));

// The public port is reachable from this machine as 127.0.0.1, so a web page in an ordinary browser could call it and learn the .anyone address.
// Real peers always arrive through the hidden service, from a backend (no Origin header) with Host set to our own .anyone name. Anything else is refused.
const PEER_HOST_RE = /^([a-z2-7]{56}\.anyone)(?::80)?$/;
function peerRequestAllowed(headers) {
  if (headers.origin !== undefined) return false;                      // browsers always send Origin on cross-origin and POST requests
  const m = PEER_HOST_RE.exec(String(headers.host || '').toLowerCase());
  if (!m) return false;
  const me = myAddress();
  return !me || m[1] === me.toLowerCase();                             // before the address exists nothing can reach us through the network anyway
}

const pub = express();
// No 'trust proxy': nothing here reads req.ip (limits use the socket's own address), so forwarded-for headers are never parsed.
pub.set('query parser', false);       // no peer route takes a query string
pub.disable('x-powered-by');
pub.set('env', 'production');      // never Express's development error pages (stack traces), however the backend is started
// The public port is taken at start, before anything else (see listenPublic), but nothing is accepted on it until every saved file has
// been read: a store that can't be read must not take in messages it couldn't keep.
let publicOpen = false;
pub.use((req, res, next) => {
  if (!publicOpen) return res.status(503).set('Connection', 'close').end();
  if (peerRequestAllowed(req.headers)) return next();
  res.status(403).set('Connection', 'close').end();
});
pub.use(noCache);
// Only a message (/api/inbox) can be large: headroom over the 8 MB envelope cap. Every other request on this port is a few bytes, and
// anyone who knows the address can send them, so a big body there is refused before it is read.
// inflate: false everywhere: a body that claims to be compressed is refused (415), never unpacked. Nobody here sends one (the window and
// other nodes send plain JSON), and a bug in a decompressor (body-parser <1.20.9, trailing bytes after a compressed body) must not be reachable.
const pubInboxJson = express.json({ limit: '10mb', inflate: false }), pubSmallJson = express.json({ limit: '4kb', inflate: false });
pub.use((req, res, next) => (req.path === '/api/inbox' ? pubInboxJson : pubSmallJson)(req, res, next));

pub.get('/api/profile', (_req, res) => {
  const id = store.getIdentity();
  if (!id) return res.status(503).json({ error: 'identity not initialised yet' });
  // The current signed prekey too (it is public, as at /api/identity, but this hands out no one-time key): the window replaces it every
  // week, and contacts learn the new one here when they next refresh our profile.
  res.json({ name: id.name || null, avatar: id.avatar || null, bio: id.bio || null, ratchetPub: id.ratchetPub || null, spkSig: id.spkSig || null });
});

// Anyone can send this notice, claiming any address, so it is limited. Only a notice that claims one of our contacts or group members
// does anything, and only those count: any other address is ignored without counting, so strangers can't use up the allowance and
// make a real contact's "back online" go unheard. From one address at most once every 10 s (what it does is limited further below:
// the profile fetch, and the network's fresh start at most once a minute), and from everyone together at most 60 a minute.
const _bumpFrom = new Map(), _bumpAll = { n: 0, since: Date.now() };
function bumpAllowed(from) {
  if (!store.getContacts().some((c) => c.address === from) && !(store.groupMemberSet().has(from) && store.getPeers().some((p) => p.address === from))) return false;
  const now = Date.now();
  if (now - _bumpAll.since > 60000) { _bumpAll.n = 0; _bumpAll.since = now; }
  if (now - (_bumpFrom.get(from) || 0) < 10000) return false;
  if (++_bumpAll.n > 60) return false;
  _bumpFrom.set(from, now);
  return true;
}
pub.post('/api/profile-bump', (req, res) => {
  const from = cleanAddr(req.body?.from || '');
  if (!isValidAddr(from) || !bumpAllowed(from)) return res.json({ ok: true });
  if (isValidAddr(from) && store.getPeers().some(p => p.address === from) && store.groupMemberSet().has(from)) maybeRefreshProfile(from, true);
  if (isValidAddr(from) && store.getContacts().some(c => c.address === from)) {
    maybeRefreshProfile(from, true);
    // Also sent when their app comes back online (announceBack). Messages waiting for them go now; if our tries were failing, the
    // network's stale lookups of their address are cleared first (they can reach us, but our side would wait up to 15 minutes).
    if (outbox.countFor(from)) {
      if (outbox.failingFor(from)) { forgetOnionLookups(); setTimeout(() => outbox.flushTo(from).catch(() => {}), 1500); }
      else setImmediate(() => outbox.flushTo(from).catch(() => {}));
    }
  }
  res.json({ ok: true });
});

pub.get('/api/pow-challenge', (_req, res) => res.json(pow.currentChallenge()));

// One-time keys are handed out sparingly: a burst of OPK_BURST, then OPK_PER_HOUR an hour. Anyone can ask for our identity, so without
// this a stranger could use up every key (and make the window keep generating and storing new ones). Past the limit the answer simply
// carries no one-time key: the chat still starts fully encrypted, only without the extra protection on its very first message.
const OPK_BURST = 20, OPK_PER_HOUR = 10;
const opkBucket = { tokens: OPK_BURST, at: Date.now() };
function takeOpkToken() {
  const now = Date.now();
  opkBucket.tokens = Math.min(OPK_BURST, opkBucket.tokens + ((now - opkBucket.at) / 3600000) * OPK_PER_HOUR);
  opkBucket.at = now;
  if (opkBucket.tokens < 1) return false;
  opkBucket.tokens -= 1;
  return true;
}

pub.get('/api/identity', (_req, res) => {
  const id = store.getIdentity();
  if (!id) return res.status(503).json({ error: 'identity not initialised yet' });
  const claimed = store.prekeyCount() && takeOpkToken() ? store.claimPrekey() : null;
  res.json({
    address: myAddress(),
    ecdhPub: id.ecdhPub,
    ratchetPub: id.ratchetPub,
    ikSigPub: id.ikSigPub || null,
    spkSig: id.spkSig || null,
    name: id.name || null,
    avatar: id.avatar || null,
    bio: id.bio || null,
    opkId: claimed ? claimed.id : null,
    opkPub: claimed ? claimed.pub : null,
  });
});

let _lastUnstampedLog = 0;               // that warning is printed at most once a minute, so a flood of them can't fill the log
pub.post('/api/inbox', (req, res) => {
  const env = req.body || {};
  if (!validEnvelope(env)) return res.status(400).json({ error: 'malformed envelope' });
  // Reject malformed from-addresses. The ratchet is the real authentication, so this is only an input check.
  if (!isValidAddr(cleanAddr(env.from))) return res.status(400).json({ error: 'bad from-address' });

  // Replay check: ciphertexts seen in the last 24 h are rejected (in-memory, cleared on restart; the ratchet's consumed-key set is the persistent guard).
  if (store.hasSeenEnvelope(env.ct)) {
    return res.status(409).json({ error: 'duplicate envelope' });
  }

  // The connection's own address. X-Forwarded-For is written by the sender and is never trusted: rotating it used to dodge the limit.
  // Everything through the Anyone network arrives from the local proxy, so for non-contacts this limit is shared by all of them.
  const ip   = req.socket.remoteAddress || 'unknown';
  const from = cleanAddr(env.from);
  const size = Buffer.byteLength(env.ct) + Buffer.byteLength(env.dh) + 256;

  // Every drop below still answers 200, so a sender can't tell whether they were blocked, filtered, or who our contacts are.
  const settings = store.getSettings();
  const contactList = store.getContacts();
  const members = store.groupMemberSet();
  // A message claiming a contact's or a group member's address counts as theirs only with a valid stamp (lib/stamp.js). Without one it
  // is treated, and counted, as a stranger's. If we don't have that person's key yet (a contact or member just added, whose keys the
  // window hasn't handed over), nothing can be checked: the message is neither trusted nor stored, the sender is asked to retry (its app
  // keeps the message and tries again every 15 s) and the window is asked for the key.
  const claimedContact = contactList.find(c => c.address === from) || null;
  const claimedPeer = !claimedContact && members.has(from) && from !== myAddress();
  const needsStamp = !!claimedContact || claimedPeer;
  const mkey = needsStamp ? store.mailboxKey(from) : null;
  const missingKey = needsStamp && !mkey;
  const unverified = needsStamp && (!mkey || !stamp.check(mkey, env, from, myAddress()));
  const known = !!claimedContact && !unverified;
  if (unverified && Date.now() - _lastUnstampedLog > 60000) { _lastUnstampedLog = Date.now(); console.warn('[inbox] a message claimed a contact\u2019s or group member\u2019s address without a valid stamp: treated as a stranger\u2019s'); }

  // Contacts have per-sender limits only, so a flood from strangers can't slow them down.
  // Messages without a valid stamp have their own per-sender bucket, so they can't use up the real contact's rate limit either.
  // A stamped contact or group member gets the larger trusted allowance; everyone else (strangers, and anything without a valid stamp)
  // keeps the small per-sender and per-connection limits.
  const trusted = needsStamp && !unverified;
  const rlKey = { ip: trusted ? null : ip, from: unverified ? 'unverified:' + from : from, trusted };
  const reason = rl.classify(rlKey);
  if (reason) {
    res.set('Retry-After', String(rl.retryAfter(reason, rlKey)));
    return res.status(429).json({ error: 'rate limited' });
  }
  // Proof of work: from anyone who isn't a contact while messages from non-contacts are arriving unusually fast (a flood), or always if
  // turned on. Normally nobody pays it, so group photos and first messages go out at once.
  // Asked for here, before any check whose answer depends on the address the message claims (blocked, a contact's key, a member's): a
  // sender who hasn't paid gets the same 402 whoever they claim to be, so the answers can't be used to find out who our contacts are.
  // A real contact is never asked (their stamp proves them, and only they and we have its key).
  const powAlways = !!settings.powAlways;
  if (!known && (powAlways || rl.pressure({ ip, from }))) {
    const proof = env.pow;
    const ok = proof && pow.verifyProof({
      challenge: proof.c,
      from,
      ct: env.ct,
      nonce: proof.n,
    });
    if (!ok) {
      const ch = pow.currentChallenge();
      return res.status(402).json({ error: 'proof of work required', challenge: ch.challenge, bits: ch.bits });
    }
  }

  if (store.isBlocked(from)) {
    store.incrementBlocked();
    return res.json({ ok: true });
  }
  if (missingKey) {
    askWindowForKey(from);
    res.set('Retry-After', '15');
    return res.status(503).json({ error: 'retry later' });
  }

  // What may wait in the inbox, in messages and bytes. The sender address is only a claim until the app decrypts, so every class has
  // its own budget and none can push out another's messages:
  //   strangers (message requests): small, text-only messages; a little each and a little together, dropped silently beyond that;
  //   group members who aren't contacts: room for photos and voice messages; over the budget they are asked to retry later;
  //   contacts: a large budget of their own; over it, asked to retry later;
  //   everything together: a hard ceiling, beyond which senders retry (their apps keep the message) and nothing waiting is lost.
  const groupPeer = claimedPeer && !unverified;
  if (!known && !groupPeer && settings.acceptRequests === false) { store.incrementBlocked(); return res.json({ ok: true }); }
  const exempt = new Set(contactList.map(c => c.address));
  for (const a of members) exempt.add(a);
  const u = store.inboxUsage(exempt, from, { unverified });
  const retryLater = () => { res.set('Retry-After', '120'); return res.status(503).json({ error: 'inbox full, retry later' }); };
  if (u.totalCount >= LIMITS.totalCount || u.totalBytes + size > LIMITS.totalBytes) return retryLater();
  if (known) {
    if (u.fromBytes + size > LIMITS.contactBytes) return retryLater();
  } else if (groupPeer) {
    if (u.fromCount >= LIMITS.peerCount || u.fromBytes + size > LIMITS.peerBytes) return retryLater();
  } else {
    const over = size > LIMITS.strangerEnvelope
      || u.fromCount >= LIMITS.strangerCount || u.fromBytes + size > LIMITS.strangerBytes
      || u.strangerCount >= LIMITS.strangersCount || u.strangerBytes + size > LIMITS.strangersBytes;
    if (over) { store.incrementBlocked(); return res.json({ ok: true }); }
  }
  // A contact's identity key was fetched from their own .anyone address when they were added. A handshake claiming to be them with any
  // other key can only come from an impostor: drop it, answering 200 like the allow-list so the reply doesn't reveal who our contacts are.
  const pinned = claimedContact || store.getPeers().find(p => p.address === from);   // a group member's keys are pinned the same way
  if (pinned && env.x3dh && pinned.ecdhPub && env.x3dh.ik !== pinned.ecdhPub) {
    store.incrementBlocked();
    return res.json({ ok: true });
  }

  // Recorded only now that it is accepted (see store.seenEnvelope); still checked, as two copies may have raced through the checks above.
  if (store.seenEnvelope(env.ct)) return res.status(409).json({ error: 'duplicate envelope' });
  const stored = store.addToInbox({
    id: crypto.randomUUID(),
    from,
    dh: env.dh,
    pn: Number.isInteger(env.pn) ? env.pn : 0,
    n: env.n,
    ct: env.ct,
    // Store only the known x3dh fields, never the raw object — a validated
    // envelope can still carry extra keys we don't want persisted.
    x3dh: env.x3dh ? { ik: env.x3dh.ik, ek: env.x3dh.ek, opkId: env.x3dh.opkId || null } : null,
    receivedAt: Date.now(),
    ...(unverified ? { unverified: true } : {}),
  }, { force: true });                  // the limits above already decided; the store's own ceiling is for anything else
  broadcastEnvelope(stored);
  if (!unverified) {
    maybeRefreshProfile(from);
    // They just reached us, so they're online and their node is reachable now: anything waiting for them goes out at once.
    if (known) markSeen(from);
    if (outbox.countFor(from)) {
      // Our tries to them have been failing although they can reach us: the network's lookup of their address is stuck on what it
      // fetched while they were away (see forgetOnionLookups). Start the lookups afresh, then send.
      if (outbox.failingFor(from)) { forgetOnionLookups(); setTimeout(() => outbox.flushTo(from).catch(() => {}), 1500); }
      else setImmediate(() => outbox.flushTo(from).catch(() => {}));
    }
  }
  res.json({ ok: true });
});

// UI access check. A DNS-rebinding page arrives with its own Host name, and any other local program or browser tab has no token.
// The desktop app creates a random token at each launch and adds it as a header to every request its window makes; the page itself never sees it.
// Browser mode (npm start / npm run web) prints a link with the token in its fragment (#t=...): the page keeps it in its own tab and
// sends it as that same header. There is no cookie: browsers send cookies to every port on the same host name, so any other local web
// server the person opened in that browser would have received it. The page's own files (no secrets in them) are served without it;
// every /api call and both WebSockets need it.
const UI_HOSTS = new Set([`127.0.0.1:${UI_PORT}`, `localhost:${UI_PORT}`]);
const UI_TOKEN_HEADER = 'x-anonchat-token';
const UI_TOKEN_FROM_ENV = typeof process.env.ANONCHAT_UI_TOKEN === 'string' && process.env.ANONCHAT_UI_TOKEN.length >= 32;
const UI_TOKEN = UI_TOKEN_FROM_ENV ? process.env.ANONCHAT_UI_TOKEN : crypto.randomBytes(32).toString('hex');
delete process.env.ANONCHAT_UI_TOKEN;
const UI_TOKEN_HASH = crypto.createHash('sha256').update(UI_TOKEN).digest();
function tokenMatches(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const h = crypto.createHash('sha256').update(candidate).digest();   // equal-length digests, so the comparison takes the same time for any input
  return crypto.timingSafeEqual(h, UI_TOKEN_HASH);
}
// A browser can't set headers on a WebSocket, so the page offers the token as a second sub-protocol ("anonchat.<token>"); the server
// accepts the connection with the plain "anonchat" one, so the token is never echoed back.
function wsProtocolToken(headers) {
  for (const p of String(headers['sec-websocket-protocol'] || '').split(',')) {
    const v = p.trim();
    if (v.startsWith('anonchat.')) return v.slice(9);
  }
  return null;
}
function uiHostAllowed(headers) { return UI_HOSTS.has(String(headers.host || '').toLowerCase()); }
function uiTokenPresent(headers) { return tokenMatches(headers[UI_TOKEN_HEADER]); }
function wsTokenPresent(headers) { return uiTokenPresent(headers) || tokenMatches(wsProtocolToken(headers)); }

const ui = express();
ui.disable('x-powered-by');
ui.set('env', 'production');
ui.set('query parser', 'simple');      // flat key=value only: the window never sends nested or array queries
ui.use((req, res, next) => {
  if (!uiHostAllowed(req.headers)) return res.status(403).set('Connection', 'close').end();
  // The desktop app's check that this really is its backend (desktop/main.js waitForReady): proves knowledge of the token without
  // receiving it. Reveals nothing else.
  if (req.method === 'GET' && req.path === '/api/hello') {
    const n = typeof req.query.n === 'string' && /^[0-9a-f]{32}$/.test(req.query.n) ? req.query.n : null;
    if (!n) return res.status(400).end();
    return res.json({ mac: crypto.createHmac('sha256', UI_TOKEN).update('anonchat-hello|' + n).digest('hex') });
  }
  // Older links (/?t=<token>): moved to the fragment form, which never reaches a server or a log.
  if (req.method === 'GET' && req.path === '/' && typeof req.query.t === 'string') {
    if (!tokenMatches(req.query.t)) return res.status(403).end();
    res.set('Cache-Control', 'no-store');
    return res.redirect(303, '/#t=' + req.query.t);
  }
  if (req.path.startsWith('/api/')) {
    if (!uiTokenPresent(req.headers)) return res.status(403).set('Connection', 'close').end();
    // Even with the token, a request that a browser says came from another site, or carries another origin, isn't ours.
    const site = req.headers['sec-fetch-site'];
    const origin = req.headers.origin;
    if ((site && site !== 'same-origin') || (origin && !UI_ORIGINS.has(origin))) return res.status(403).set('Connection', 'close').end();
  }
  next();
});
ui.use(noCache);
// A restore carries a whole backup (public/backup.js MAX_FILE_BYTES: 20 MB at most, less once decrypted): its own, larger limit, so
// any backup the window can open can also be put in place. Everything else keeps the usual one.
const uiJson = express.json({ limit: '10mb', inflate: false }), restoreJson = express.json({ limit: '32mb', inflate: false });
ui.use((req, res, next) => (req.path === '/api/restore' ? restoreJson : uiJson)(req, res, next));
ui.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res, file) => {
    if (/[\\/](emoji|flags)[\\/]/.test(file)) {          // never change within a release: keep them, so the picker opens instantly after the first time
      res.set('Cache-Control', 'public, max-age=86400'); res.removeHeader('Pragma'); res.removeHeader('Expires'); return;
    }
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  },
}));

ui.get('/api/whoami', async (_req, res) => {
  // Always answers (the desktop app waits for it): a store that can't be read is reported instead of failing the request.
  const health = store.health();
  let id = null;
  try { id = store.getIdentity(); } catch {}
  // "ready" once the Anyone network is fully bootstrapped (the address exists earlier, so it is not enough).
  // A real answer counts as it is (less than 100 is "connecting" at once); no answer in time: the last one reported, if recent.
  const pct = (await Promise.race([bootstrapPct(), new Promise((r) => setTimeout(() => r(null), 1500))])) ?? knownBootstrap();
  res.json({ address: myAddress(), hasIdentity: !!id, name: id?.name || null, network: pct === 100 ? 'ready' : 'connecting',
    storeOk: health.ok, storeProblems: health.problems, encryptedAtRest: store.atRest().encrypted });
});

// Manual only, and only through the Anyone proxy. There is no direct fallback: if the network is unreachable the check fails and nothing leaves the Anyone network.
const updater = require('./lib/updater');
const PKG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')); }
  catch { return {}; }
})();
const APP_VERSION = PKG.version || '0.0.0';
let lastUpdateCheck = 0;

ui.get('/api/version', (_req, res) => res.json({ version: APP_VERSION }));

ui.post('/api/update/check', async (req, res) => {
  const now = Date.now();
  if (now - lastUpdateCheck < 3000) return res.status(429).json({ error: 'too_many_requests' });
  lastUpdateCheck = now;
  const repoUrl = PKG.repository && PKG.repository.url;
  if (!updater.parseRepo(repoUrl)) return res.status(501).json({ error: 'not_configured' });
  try {
    // Leaves the Anyone network through an exit relay, on a route of its own (netlock.isolatedSocks): never shared with a browser that
    // uses the same proxy.
    const agent = new SocksProxyAgent(netlock.isolatedSocks(SOCKS, 'update'));
    const http = axios.create({ httpAgent: agent, httpsAgent: agent, proxy: false, adapter: 'http', timeout: 45000, maxContentLength: 1024 * 1024 });
    const result = await updater.checkForUpdate({ current: APP_VERSION, repoUrl, http });
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'unreachable' });
  }
});

const circuits = require('./lib/circuits');
circuits.startStreamWatcher();

const relaygeo = require('./lib/relaygeo');
let _bp = { t: 0, v: null };
// The last progress the network actually reported, and when. A query that fails or comes back late (the control port answers a new
// connection slowly now and then, notably on Windows) says nothing about the network: until it has gone unanswered for a minute,
// the last reported progress stands, so the window doesn't flip to "Connecting" while messages flow.
let _bpKnown = { v: null, at: 0 };
const BP_STALE_MS = 60_000;
function knownBootstrap() { return _bpKnown.v != null && Date.now() - _bpKnown.at < BP_STALE_MS ? _bpKnown.v : null; }
async function bootstrapPct() {
  if (Date.now() - _bp.t < 1500) return _bp.v;
  let v = null;
  try {
    v = require('./lib/exitpolicy').parseBootstrap(await ctrlCmd('GETINFO status/bootstrap-phase'));
  } catch {}
  _bp = { t: Date.now(), v };
  if (v != null) _bpKnown = { v, at: Date.now() };
  return v;
}

// Fetch the country database through the anon proxy once anon is fully bootstrapped; nothing is downloaded when a fresh copy is cached.
(async function ensureGeoDb() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let failures = 0, delay = 10000;
  for (;;) {
    if (relaygeo.databaseReady() && !relaygeo.databaseStale()) return;
    if ((await bootstrapPct()) !== 100) { await sleep(3000); continue; }
    try {
      const r = await relaygeo.updateDatabase();
      if (r && r.updated) console.log('[relaygeo] libloc DB ready');
      return;
    } catch (e) {
      if (++failures >= 8) { console.error('[relaygeo] DB update giving up:', e.message); return; }
      console.log(`[relaygeo] DB download failed (${e.message}); retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
      delay = Math.min(delay * 2, 120000);
    }
  }
})();

let lastRenew = 0;
ui.post('/api/circuit/renew', async (_req, res) => {
  if (Date.now() - lastRenew < 1500) return res.status(429).json({ error: 'too_many_requests' });
  lastRenew = Date.now();
  try { res.json(await circuits.renewGeneralCircuits()); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

ui.get('/api/circuits', async (_req, res) => {
  try {
    const list = await circuits.getCircuitsShared();
    res.json({ circuits: list, callTo: callBridge.dialing() });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

ui.get('/api/circuit/geo', async (req, res) => {
  try {
    const type = req.query.type === 'hs' ? 'hs' : 'socks';
    const list = await circuits.getCircuitsShared();
    const out = { type, circuitId: null, dbReady: relaygeo.databaseReady(), hops: [], unknown: 0, callTo: callBridge.dialing() };
    let pick = null;
    if (type === 'hs') {
      // Hidden view: the live-checked circuit that carries messages to a contact (see circuits.resolveContactCircuit).
      const rows = store.getContacts().map((c) => ({ c, r: circuits.resolveContactCircuit(circuits.getActiveCircuitForAddress(c.address), list) }));
      const live = rows.filter((x) => x.r.status !== 'none').sort((a, b) => (b.r.lastUsed || 0) - (a.r.lastUsed || 0));
      out.contacts = live.map((x) => ({ address: x.c.address, name: x.c.petname || null, status: x.r.status, lastUsed: x.r.lastUsed }));
      const want = req.query.contact ? cleanAddr(String(req.query.contact)) : null;
      let row;
      if (want) {
        if (!isValidAddr(want)) return res.status(400).json({ error: 'invalid address' });
        row = rows.find((x) => x.c.address === want);
        out.contact = want; out.name = row ? (row.c.petname || null) : null;
        if (!row) { out.status = 'none'; out.reason = 'unknown-contact'; return res.json(out); }
      } else row = live[0];
      if (row) { out.contact = row.c.address; out.name = row.c.petname || null; out.status = row.r.status; out.reason = row.r.reason || null; out.lastUsed = row.r.lastUsed || null; pick = row.r.circuit || null; }
      else { out.status = 'none'; out.reason = 'never'; }
    } else {
      // Same circuits as the Circuits tab; `user` lists circuit ids the person just built with "New circuit".
      const userIds = String(req.query.user || '').split(',').filter((x) => /^\d+$/.test(x)).slice(0, 8);
      pick = circuits.pickSocksCircuit(list, userIds);
      if (pick) out.status = pick.streams.some((s) => s.state !== 'RECENT') ? 'active' : 'idle';
    }
    if (pick) {
      out.circuitId = pick.id;
      out.hops = relaygeo.hopsFromCircuit(pick);
      out.unknown = pick.relays.length - out.hops.length;     // relays whose country could not be found are not drawn: say so
      out.relays = pick.relays.map((r) => r.nickname || (r.fingerprint || '').slice(0, 8));
    }
    res.json(out);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

ui.delete('/api/circuit/:id', async (req, res) => {
  try {
    const ok = await circuits.closeCircuit(req.params.id);
    res.json({ ok });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

ui.get('/api/traffic', async (_req, res) => {
  try { res.json(await circuits.getTraffic()); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

// The exit choice is applied to anon as a strict list of exit-relay fingerprints (lib/exitpolicy.js) and only affects traffic that leaves the network.
const netprefs   = require('./lib/netprefs');
const exitpolicy = require('./lib/exitpolicy');
const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const SOCKS_PORT = Number(SOCKS.split(':').pop());
const exitSvc = exitpolicy.createExitService({
  ctrl:       ctrlCmd,
  getRouters: () => circuits.getRouterList(),
  lookup:     (ip) => relaygeo.lookupCountry(ip),
  isCountry:  (cc) => !!relaygeo.centroidFor(cc),
  ready:      () => relaygeo.databaseReady(),
  bootstrapPct,
  log:        (m) => console.log(m),
  // Exit-count history (last 500 builds) in exit-history.jsonl.
  record: (e) => {
    const f = path.join(DATA_DIR, 'exit-history.jsonl');
    let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch {}
    lines.push(JSON.stringify(e));
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(f, lines.slice(-500).join('\n') + '\n');
  },
  load:       () => netprefs.load(DATA_DIR),
  save:       (p) => netprefs.save(DATA_DIR, p),
});

// Build the country list in the background so the UI never waits for it; refresh every 15 minutes.
(function warmCountryList() {
  exitSvc.prepare()
    .then((ok) => setTimeout(warmCountryList, ok ? 15 * 60 * 1000 : 3000))
    .catch(() => setTimeout(warmCountryList, 5000));
})();

// Re-apply a saved exit choice once anon, the relay list and the country database are ready; refresh every 15 minutes.
(function keepExitApplied(retryMs = 5000) {
  exitSvc.reapply()
    .then(() => setTimeout(() => keepExitApplied(5000), 15 * 60 * 1000))
    .catch(() => setTimeout(() => keepExitApplied(Math.min(retryMs * 2, 60000)), retryMs));
})();

ui.get('/api/network', (_req, res) => {
  const p = netprefs.load(DATA_DIR);
  res.json({ socksPort: SOCKS_PORT, dynamicPort: p.dynamicPort, exitCountry: p.exitCountry });
});

ui.post('/api/network/dynamic-port', express.json({ inflate: false }), (req, res) => {
  const enabled = req.body && req.body.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'invalid' });
  const p = netprefs.save(DATA_DIR, { ...netprefs.load(DATA_DIR), dynamicPort: enabled });
  res.json({ ok: true, dynamicPort: p.dynamicPort, restartRequired: true });
});

ui.get('/api/exit/countries', async (_req, res) => {
  try { res.json(await exitSvc.countries()); }
  catch (e) { res.status(503).json({ error: 'unavailable' }); }
});

let lastExitChange = 0;
ui.post('/api/exit', express.json({ inflate: false }), async (req, res) => {
  if (Date.now() - lastExitChange < 1500) return res.status(429).json({ error: 'too_many_requests' });
  lastExitChange = Date.now();
  const cc = req.body ? req.body.country : null;
  if (cc != null && typeof cc !== 'string') return res.status(400).json({ error: 'invalid' });
  try { res.json(await exitSvc.select(cc || null)); }
  catch (e) {
    const status = e.code === 'unknown_country' ? 400 : e.code === 'not_ready' ? 409 : 503;
    res.status(status).json({ error: e.code || 'failed' });
  }
});

ui.get('/api/hs/health', async (_req, res) => {
  try { res.json({ ...(await circuits.getServiceHealth(myAddress())), selfTest: selfTest.status(), network: netready.status() }); }
  catch (e) { res.status(503).json({ error: e.message }); }
});

// "Test connection" (conversation menu): finds out where the way to one contact breaks, and reports it as codes the window words.
// Makes one small request to their app, the one the online check makes; nothing is sent to them but that. One test at a time per contact.
const _tests = new Map();
ui.post('/api/contact-test/:addr', async (req, res) => {
  const addr = cleanAddr(req.params.addr);
  if (!isValidAddr(addr)) return res.status(400).json({ error: 'invalid address' });
  if (!store.getContacts().some((c) => c.address === addr)) return res.status(404).json({ error: 'not a contact' });
  let run = _tests.get(addr);
  if (!run) {
    run = (async () => {
      // Our own address is looked up at the same time (unless it was, a moment ago): if it can't be found either, the fault is here.
      const selfRun = selfTest.runNow().catch(() => null);
      const own = await circuits.getServiceHealth(myAddress()).catch(() => ({ detail: 'unknown' }));
      const probe = { ok: false };
      const sentAt = Date.now();
      try {
        const r = await onion().get(`http://${addr}/api/profile`, { timeout: 45000 });
        probe.ok = true;
        probe.skewMs = contactTest.clockSkew(r.headers && r.headers.date, sentAt, Date.now());
      } catch (e) {
        probe.error = contactTest.readProbeError(e);
        if (e.response) probe.skewMs = contactTest.clockSkew(e.response.headers && e.response.headers.date, sentAt, Date.now());
      }
      if (probe.ok) {
        markSeen(addr);                  // they answered: they are reachable, so whatever waits for them goes now
        if (outbox.countFor(addr)) setImmediate(() => outbox.flushTo(addr).catch(() => {}));
      }
      await selfRun;
      return contactTest.summarize({ own, probe, queue: outbox.stateFor(addr), self: selfTest.status() });
    })().finally(() => _tests.delete(addr));
    _tests.set(addr, run);
  }
  try { res.json(await run); }
  catch (e) { res.status(503).json({ error: 'failed' }); }
});

ui.post('/api/circuit/rebuild-contact/:addr', async (req, res) => {
  const addr = cleanAddr(req.params.addr);
  if (!isValidAddr(addr)) return res.status(400).json({ error: 'invalid address' });
  try {
    const out = await circuits.rebuildCircuitForContact(addr);
    forgetOnionLookups(true);           // also when their address can't be looked up any more (no route to close)
    setTimeout(() => outbox.flushTo(addr).catch(() => {}), 1500);
    res.json(out);
  }
  catch (e) { res.status(503).json({ error: e.message }); }
});

ui.get('/api/circuit/for-contact/:addr', async (req, res) => {
  const addr = cleanAddr(req.params.addr);
  if (!isValidAddr(addr)) return res.status(400).json({ error: 'invalid address' });
  const info = circuits.getActiveCircuitForAddress(addr);
  res.json(info || { circuitId: null });
});

ui.post('/api/profile/broadcast', (_req, res) => {
  const me = myAddress();
  if (me) {
    // Contacts, and the members of our groups who aren't contacts (they show our picture beside our group messages).
    const to = new Set(store.getContacts().map(c => c.address));
    for (const a of store.groupMemberSet()) if (a !== me) to.add(a);
    for (const a of to) {
      onion().post(`http://${a}/api/profile-bump`, { from: me }, { timeout: 15000 }).catch(() => {});
    }
  }
  res.json({ ok: true });
});
let _maxBootstrap = 0;
ui.get('/api/logs', async (_req, res) => {
  let lines = [];
  try {
    const raw = fs.readFileSync(ANON_LOG, 'utf8');
    lines = raw.split('\n').filter(l => l.trim()).slice(-200);
  } catch {}
  const netLines = lines;

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/Bootstrapped (\d+)%/);
    if (m) { const v = parseInt(m[1], 10); if (v > _maxBootstrap) _maxBootstrap = v; break; }
  }

  // The network's own answer first. The log only says it once ("Bootstrapped 100%"), and that line scrolls out of the last 200
  // lines read here within minutes, which left 0% on screen when the panel was first opened later. The log is the fallback.
  const fromCtrl = (await Promise.race([bootstrapPct(), new Promise((r) => setTimeout(() => r(null), 1500))])) ?? knownBootstrap();
  res.json({
    address:   myAddress() || null,
    uptime:    Math.floor(process.uptime()),
    bootstrap: fromCtrl ?? _maxBootstrap,
    lines: deliverylog.merge(netLines, deliveryLog.lines().map((x) => x.text)),
  });
});

// Merge with the existing record instead of overwriting it, so updating only the avatar doesn't drop the name.
ui.post('/api/identity', (req, res) => {
  const { ecdhPub, ratchetPub, ikSigPub, spkSig, name, avatar, bio } = req.body || {};
  if (!ecdhPub || !ratchetPub) return res.status(400).json({ error: 'missing public keys' });
  const existing = store.getIdentity() || {};
  store.setIdentity({
    ecdhPub,
    ratchetPub,
    ikSigPub: ikSigPub !== undefined ? (ikSigPub || null) : (existing.ikSigPub ?? null),
    spkSig:   spkSig   !== undefined ? (spkSig   || null) : (existing.spkSig   ?? null),
    name: name !== undefined ? (name || null) : (existing.name ?? null),
    avatar: avatar !== undefined ? (avatar || null) : (existing.avatar ?? null),
    bio: bio !== undefined ? (bio || null) : (existing.bio ?? null),
  });
  res.json({ ok: true, address: myAddress() });
});

ui.get('/api/contacts', (_req, res) => {
  res.json(store.getContacts().map(c => {
    const p = presence.get(c.address);
    return { ...c, online: p ? p.online : null, lastSeen: p ? p.lastSeen : null };
  }));
});

ui.post('/api/contacts', async (req, res) => {
  const { petname, address, expectIk } = req.body || {};
  if (!petname || !address) return res.status(400).json({ error: 'petname and address required' });
  const addr = cleanAddr(address);
  if (!isValidAddr(addr)) {
    return res.status(400).json({ error: 'invalid .anyone address (expected 56 base32 chars + .anyone)' });
  }
  if (addr === myAddress()) return res.status(400).json({ error: 'own_address' });   // pasted by mistake: messages to it go nowhere
  // Someone already in the contacts is never added again: adding fetches the keys their address serves now, and saving those over the
  // ones kept since they were added would accept a change of keys without a word. To start over with someone, remove them first.
  if (store.getContacts().some((c) => c.address === addr)) return res.status(409).json({ error: 'already_contact' });

  try {
    const { data: raw } = await onion().get(`http://${addr}/api/identity`);
    const data = peerdata.identity(raw);                                      // keys, picture and status checked; anything else dropped
    if (!data) throw new Error('peer returned no valid keys');
    // A fellow group member's keys were saved when they were first seen: becoming a contact keeps them, never different ones.
    const member = store.getPeers().find((p) => p.address === addr);
    if (member && member.ecdhPub && member.ecdhPub !== data.ecdhPub) return res.status(409).json({ error: 'key_mismatch' });
    // Accepting a message request: the request's handshake key must be the key this address itself serves. Only the real owner of
    // the address can answer here, so a mismatch means the request was forged; nothing is saved.
    if (expectIk !== undefined && data.ecdhPub !== expectIk) {
      return res.status(409).json({ error: 'key_mismatch' });
    }
    const contact = store.upsertContact({
      petname: String(petname).slice(0, 40),
      address: addr,
      ecdhPub: data.ecdhPub,
      ratchetPub: data.ratchetPub,
      ikSigPub: data.ikSigPub,
      spkSig: data.spkSig,
      opkId: data.opkId,
      opkPub: data.opkPub,
      opkAt: data.opkId ? Date.now() : null,      // a one-time key is only used while fresh (ensureSession in app.js)
      avatar: data.avatar,
      bio: data.bio,
      addedAt: Date.now(),
    });
    res.json(contact);
  } catch (err) {
    res.status(502).json({ error: `could not reach ${addr}: ${err.message}` });
  }
});

// Rename a contact. The name is local only (never sent anywhere), so only its shape is checked.
ui.post('/api/contacts/rename', (req, res) => {
  const addr = cleanAddr(req.body?.address);
  const petname = typeof req.body?.petname === 'string' ? req.body.petname.trim().slice(0, 40) : '';
  if (!isValidAddr(addr) || !petname) return res.status(400).json({ error: 'invalid' });
  const c = store.getContacts().find((x) => x.address === addr);
  if (!c) return res.status(404).json({ error: 'not a contact' });
  store.upsertContact({ ...c, petname });
  res.json({ ok: true });
});

ui.delete('/api/contacts', (req, res) => {
  const { address } = req.body || {};
  if (address) {
    store.removeContact(address);
    if (!store.getPeers().some((p) => p.address === address)) store.removeMailboxKey(address);
  }
  res.json({ ok: true });
});

// Mailbox keys (lib/stamp.js) for contacts and group members, worked out by the window, which holds the identity key. `replace` sends
// the full set (at start and whenever the lists change); otherwise the keys are added, as before a first message to someone new.
ui.post('/api/mailbox-keys', (req, res) => {
  const list = Array.isArray(req.body?.keys) ? req.body.keys : null;
  if (!list || list.length > 5000) return res.status(400).json({ error: 'keys required' });
  const clean = [];
  for (const k of list) {
    const address = cleanAddr(k?.address);
    if (!isValidAddr(address) || typeof k.key !== 'string' || Buffer.from(k.key, 'base64').length !== 32) return res.status(400).json({ error: 'bad key' });
    clean.push({ address, key: k.key });
  }
  store.setMailboxKeys(clean, { replace: req.body.replace === true });
  res.json({ ok: true, count: clean.length });
});

ui.get('/api/groups',    (_req, res) => res.json(store.getGroups()));

ui.post('/api/groups',   (req, res)  => { store.upsertGroup(req.body); res.json({ ok: true }); });
ui.delete('/api/groups', (req, res)  => { store.removeGroup(req.body?.id); res.json({ ok: true }); });

// The browser calls this once it has consumed a contact's one-time prekey in
// x3dhInitiator, so a later session reset can't accidentally reuse it.
ui.post('/api/contacts/opk-used', (req, res) => {
  const { address } = req.body || {};
  const c = store.getContacts().find(x => x.address === address);
  if (c) store.upsertContact({ ...c, opkId: null, opkPub: null, opkAt: null });
  const p = store.getPeers().find(x => x.address === address);
  if (p) store.upsertPeer({ ...p, opkId: null, opkPub: null, opkAt: null });
  res.json({ ok: true });
});

// Group members who aren't contacts. Their keys come from their own .anyone address, like a contact's, and only for someone listed in
// one of our groups: this is not a back door for adding contacts.
ui.get('/api/peers', (_req, res) => res.json(store.getPeers()));
ui.post('/api/peers', async (req, res) => {
  const addr = cleanAddr(req.body?.address);
  if (!isValidAddr(addr)) return res.status(400).json({ error: 'invalid address' });
  if (!store.groupMemberSet().has(addr)) return res.status(403).json({ error: 'not a group member' });
  const known = store.getPeers().find(x => x.address === addr);
  if (known && !req.body?.refresh) return res.json(known);
  try {
    const { data: raw } = await onion().get(`http://${addr}/api/identity`);
    const data = peerdata.identity(raw);
    if (!data) throw new Error('peer returned no valid keys');
    // The key a peer was first seen with stays: a later fetch serving a different key is refused, as for contacts.
    if (known && known.ecdhPub && known.ecdhPub !== data.ecdhPub) return res.status(409).json({ error: 'key_mismatch' });
    const peer = store.upsertPeer({
      address: addr,
      ecdhPub: data.ecdhPub, ratchetPub: data.ratchetPub,
      ikSigPub: data.ikSigPub, spkSig: data.spkSig,
      opkId: data.opkId, opkPub: data.opkPub, opkAt: data.opkId ? Date.now() : null,
      avatar: data.avatar,
      addedAt: known?.addedAt || Date.now(),
    });
    res.json(peer);
  } catch (err) {
    res.status(502).json({ error: `could not reach ${addr}: ${err.message}` });
  }
});
ui.delete('/api/peers', (req, res) => {
  const addr = cleanAddr(req.body?.address);
  if (addr) {
    store.removePeer(addr);
    if (!store.getContacts().some((c) => c.address === addr)) store.removeMailboxKey(addr);
  }
  res.json({ ok: true });
});

// Waiting messages, oldest first, at most ~32 MB per answer; X-More tells the window to ask again straight away.
ui.get('/api/messages', (_req, res) => {
  const { items, more } = store.getInbox({ maxBytes: 32 * 1024 * 1024 });
  if (more) res.set('X-More', '1');
  res.json(items);
});
ui.post('/api/messages/ack', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (ids.length) store.deleteFromInbox(ids);
  res.json({ ok: true });
});

const outbox = require('./lib/outbox');
const deliveryLog = deliverylog.create();

// Force a fresh descriptor fetch for a peer: it busts a stale cache that still points at the peer's old introduction points after a restart.
const _lastHsFetch = new Map();
function refreshPeerDescriptor(addr) {
  const now = Date.now();
  const last = _lastHsFetch.get(addr) || 0;
  // At most every 5 minutes per peer. Each lookup asks one of the few directories that hold their address, and the network won't ask
  // the same one again for 15 minutes: looking up every 20 s while they were away used them all up, so their new address (they came
  // back) couldn't be fetched for up to a quarter of an hour.
  if (now - last < 5 * 60 * 1000) return;
  _lastHsFetch.set(addr, now);
  // The control port wants the 56-char onion id without the TLD suffix.
  const onionId = String(addr).replace(/\.anyone$/, '').replace(/\.onion$/, '');
  ctrlCmd(`HSFETCH ${onionId}`).catch(() => {
  });
  dropDeadPath(addr);
}
// The Anyone network remembers which directories it asked for an address in the last 15 minutes (and won't ask them again), which
// introduction points failed, and the address details it fetched. While a contact is away all of that goes stale, and when they come
// back it can keep us from reaching them for many minutes, although they reach us. NEWNYM clears that memory (and has new
// connections use new routes; open ones, a call say, carry on). Only when there is reason: they just wrote to us while our messages
// to them were failing, or "Rebuild network path" was pressed. At most once a minute (manual: every 10 s, the network's own limit).
let _lastForget = 0;
function forgetOnionLookups(manual = false) {
  const now = Date.now();
  if (now - _lastForget < (manual ? 10000 : 60000)) return;
  _lastForget = now;
  ctrlCmd('SIGNAL NEWNYM').catch(() => {});
}
// Whether the network is ready to look addresses up (lib/netready.js). Sending, the online checks and the "back online" notices wait for
// it; when it becomes ready the network's lookup memory is cleared once and whatever waits goes. Only when the supervisor (start.js)
// asks for it: a backend run on its own (tests, `node server.js`) has no network program of its own to wait for.
const netreadyLib = require('./lib/netready');
const netready = netreadyLib.create({
  enabled: process.env.ANONCHAT_WAIT_NETWORK === '1',
  bootstrapPct: async () => (await Promise.race([bootstrapPct(), new Promise((r) => setTimeout(() => r(null), 1500))])) ?? knownBootstrap(),
  consensusTimes: () => netreadyLib.readConsensusTimes(ctrlCmd),
  onReady: (why) => {
    console.log(`[network] ready (${why})`);
    deliveryLog.note('the network is ready; sending what waits');
    forgetOnionLookups(true);
    setTimeout(() => outbox.kick(), 1500);
    setTimeout(() => presenceSweep().catch(() => {}), 5000);
  },
});
setInterval(() => { netready.check().catch(() => {}); }, 3000);
netready.check().catch(() => {});

// Can our own address be found through the network? (lib/selftest.js)
const selfTest = require('./lib/selftest').create({
  probe: () => onion().get(`http://${myAddress()}/api/profile`, { timeout: 60000 }),
  isPublished: () => circuits.isServicePublished(myAddress()),
  clearLookups: async () => { forgetOnionLookups(true); },
  republish: () => circuits.republishService(myAddress()),
  isReady: () => netready.isReady() && !!myAddress(),
  log: (m) => deliveryLog.note(m),
  timing: process.env.SELFTEST_FAST === '1' ? { settleMs: 500, okEveryMs: 4000, badEveryMs: 2000, againMs: 1500, republishEveryMs: 5000 } : {},    // the tests
});
setInterval(() => { selfTest.tick().catch(() => {}); }, process.env.SELFTEST_FAST === '1' ? 700 : 15000);

// The route to a contact can die without either side noticing (their connection dropped, their app was closed): every new try is then
// sent down it and fails, while everyone else is reached. After a failed try, the route the last try used is closed, so the next one
// builds a fresh route (what "Rebuild network path" does by hand). At most once a minute per contact.
const _lastPathDrop = new Map();
function dropDeadPath(addr) {
  const now = Date.now();
  if (now - (_lastPathDrop.get(addr) || 0) < 60000) return;
  _lastPathDrop.set(addr, now);
  if (_lastPathDrop.size > 1000) _lastPathDrop.clear();
  circuits.rebuildCircuitForContact(addr).catch(() => {});
}

// The stamp is always worked out here from the stored mailbox key, never taken from the window. Without a key the message goes unstamped.
function stampEnvelope(envelope, from, to) {
  const { stamp: _ignored, pow: _p, ...plainEnv } = envelope;
  const mk = store.mailboxKey(to);
  return mk ? { ...plainEnv, stamp: stamp.make(mk, { ...plainEnv, from }, from, to) } : plainEnv;
}
// For a retry from the queue: a fresh stamp when the key is known now; otherwise the one this backend made when the message was queued
// (a group left meanwhile drops that member's key, but the goodbye still has to arrive as ours). Queued envelopes are only ever written
// by /api/send, which replaces any stamp the window sent, so a kept stamp is always our own.
function restampQueued(envelope, from, to) {
  const fresh = stampEnvelope(envelope, from, to);
  return fresh.stamp || typeof envelope.stamp !== 'string' ? fresh : { ...fresh, stamp: envelope.stamp };
}

// Back online: once our address is published on the network, each contact is told (a profile bump), twice a minute apart. Their app
// then sends what it kept for us while we were away at once, instead of when the network lets it look our new address up again
// (up to 15 minutes). We can reach them at once, since this app has just started; they couldn't reach us yet.
async function announceBack() {
  const waitMax = envMs('ANNOUNCE_MAX_WAIT_MS', 5 * 60 * 1000), settle = envMs('ANNOUNCE_SETTLE_MS', 20000);
  const t0 = Date.now();
  while (!netready.isReady() && Date.now() - t0 < 10 * 60 * 1000) await new Promise((r) => setTimeout(r, 2000));   // not before the network is ready
  for (;;) {                                      // published (or, if the control port can't say, after waiting the longest)
    let published = false;
    try { published = await circuits.isServicePublished(myAddress()); } catch {}
    if (published || Date.now() - t0 > waitMax) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  await new Promise((r) => setTimeout(r, settle));  // the address details reach the network's directories a little after
  for (let round = 0; round < 2; round++) {
    const me = myAddress();
    if (me) for (const c of store.getContacts()) {
      onion().post(`http://${c.address}/api/profile-bump`, { from: me }, { timeout: 30000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise((r) => setTimeout(r, envMs('ANNOUNCE_AGAIN_MS', 60000)));
  }
}

function initOutbox() {
  announceBack().catch(() => {});
  outbox.on('delivered', (item) => {
    if (store.getContacts().some((c) => c.address === item.toAddress)) markSeen(item.toAddress);
    const msg = { type: 'outbox:delivered', id: item.id, msgId: item.msgId || null, toAddress: item.toAddress, queuedAt: item.queuedAt };
    for (const ws of wsClients) try { ws.send(JSON.stringify(msg)); } catch {}
  });
  // Why messages to someone are waiting, in the Status log (lib/deliverylog.js).
  outbox.on('tryFailed', ({ toAddress, error }) => deliveryLog.failed(toAddress, error));
  outbox.on('delivered', (item) => deliveryLog.delivered(item.toAddress));
  outbox.on('expired', (item) => {
    const msg = { type: 'outbox:expired', id: item.id, msgId: item.msgId || null, toAddress: item.toAddress };
    for (const ws of wsClients) try { ws.send(JSON.stringify(msg)); } catch {}
  });
  // After the listeners: messages that ran out of time while the app was closed are reported too.
  outbox.init({ onion, pow, myAddress, onRetryFail: refreshPeerDescriptor, stamp: restampQueued, ready: () => netready.isReady() });
}

ui.post('/api/send', async (req, res) => {
  let { toAddress, envelope, msgId, offlineTtl, ephemeral } = req.body || {};
  if (!toAddress || !envelope) return res.status(400).json({ error: 'toAddress and envelope required' });
  const addr = cleanAddr(toAddress);
  if (!isValidAddr(addr)) return res.status(400).json({ error: 'invalid .anyone address' });
  const from = myAddress();
  // The stamp is added here, never taken from the window, and travels with the message into the outbox.
  envelope = stampEnvelope(envelope, from, addr);
  const payload = { ...envelope, from };
  // Per-message offline expiry chosen by the sender (1h / 12h / 24h); anything else falls back to the outbox default.
  const ALLOWED_TTL = new Set([3600, 43200, 86400]);
  const ttlMs = ALLOWED_TTL.has(Number(offlineTtl)) ? Number(offlineTtl) * 1000 : null;

  // Every message is written to the queue before the first try, so closing the app at any moment can't lose it, and it is tried at once
  // from there (lib/outbox.js deliverNow), a few times on a fresh circuit when the network fails, each message on its own. When older
  // messages to the same recipient are already waiting in the queue, it goes behind them in the background instead.
  // Leaving or dissolving a group (queueOnly): queued and sent in the background, so the window never waits on an offline member.
  if (ephemeral !== true) {
    const qid = outbox.enqueue(addr, envelope, from, ttlMs, typeof msgId === 'string' ? msgId : null);
    if (req.body.queueOnly === true) {
      setImmediate(() => outbox.flushTo(addr).catch(() => {}));
      return res.json({ ok: true, queued: true, queueId: qid });
    }
    const r = await outbox.deliverNow(qid);
    if (r === 'delivered') return res.json({ ok: true, queued: false });
    if (r === 'failed') return res.status(502).json({ error: 'delivery failed' });
    return res.json({ ok: true, queued: true, queueId: qid });
  }

  // Call signalling is time-critical and worthless later: two attempts at most, never queued.
  const TRANSIENT = /HostUnreachable|Hs[A-Z]\w+|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|Proxy connection timed out|proxy.*timed out|timed out|timeout|ESOCKETTIMEDOUT|Network Error|connect ENETUNREACH/i;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await onion().post(`http://${addr}/api/inbox`, payload);
      if (presence.has(addr) || store.getContacts().some((c) => c.address === addr)) markSeen(addr);
      return res.json({ ok: true, queued: false });
    } catch (err) {
      const status = err.response?.status;
      const data   = err.response?.data;
      // 409 on a retry: the first attempt did arrive, only its answer was lost (a timeout on the way back).
      if (status === 409 && attempt > 1) return res.json({ ok: true, queued: false });
      if (status === 402 && data?.challenge) {
        try {
          const nonce = await pow.solveAsync({ challenge: data.challenge, from, ct: envelope.ct, bits: data.bits || 18 });
          await onion().post(`http://${addr}/api/inbox`, { ...payload, pow: { c: data.challenge, n: nonce } });
          return res.json({ ok: true, queued: false, pow: true });
        } catch (err2) {
          if (err2.response?.status === 409) return res.json({ ok: true, queued: false, pow: true });
          return res.status(502).json({ error: 'unreachable' });
        }
      }
      if (!status && TRANSIENT.test(err.message) && attempt < 2) {
        refreshPeerDescriptor(addr);
        await new Promise(r => setTimeout(r, 2500));
        continue;
      }
      return res.status(502).json({ error: 'unreachable' });
    }
  }
  return res.status(502).json({ error: 'unreachable' });
});

ui.get('/api/outbox', (_req, res) => res.json({ items: outbox.list() }));
// What happened to recent messages (delivered, or not delivered in time), for a window that wasn't connected when it happened.
ui.get('/api/outbox/outcomes', (_req, res) => res.json({ outcomes: outbox.outcomes() }));
ui.delete('/api/outbox/:id', (req, res) => {
  outbox.remove(req.params.id);
  res.json({ ok: true });
});
ui.post('/api/outbox/flush', (_req, res) => {
  outbox._flush().catch(() => {});
  res.json({ ok: true });
});

// ---- Identity backup and restore (public/backup.js, docs/BACKUP-FORMAT.md) ----
// The hidden service's key lives in the Anyone network program's folder. The window encrypts it into the backup with the rest of the
// identity; it never leaves this computer in the clear. Same access rules as every other window call (launch token, loopback only).
const SERVICE_DIR = path.join(ANON_DIR, 'anon_service');
const HS_FILES = { secret: 'hs_ed25519_secret_key', public: 'hs_ed25519_public_key' };
ui.get('/api/backup/hs', (_req, res) => {
  try {
    const secret = fs.readFileSync(path.join(SERVICE_DIR, HS_FILES.secret));
    const pub = fs.readFileSync(path.join(SERVICE_DIR, HS_FILES.public));
    const hostname = myAddress();
    if (!hostname || secret.length !== 96 || pub.length !== 64) return res.status(503).json({ error: 'not_ready' });
    res.json({ secret: secret.toString('base64'), public: pub.toString('base64'), hostname });
    secret.fill(0);
  } catch { res.status(503).json({ error: 'not_ready' }); }
});

// Restore puts a backup's hidden-service key and lists in place. Only on a fresh install (no contacts, groups or group members yet):
// a restore from Settings erases everything first, so this never overwrites anyone's data. The window then restarts the app, and the
// Anyone network program starts with the restored key, i.e. the restored address.
const ADDR_ONLY = /^[a-z2-7]{56}\.anyone$/;
function writeFileAtomicSync(target, data, mode = 0o600) {
  const tmp = target + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, target);
}
ui.post('/api/restore', (req, res) => {
  const b = req.body || {};
  if (store.getContacts().length || store.getGroups().length || store.getPeers().length) return res.status(409).json({ error: 'not_fresh' });
  const hs = b.hs || {};
  let secret, pub;
  try { secret = Buffer.from(String(hs.secret || ''), 'base64'); pub = Buffer.from(String(hs.public || ''), 'base64'); } catch { return res.status(400).json({ error: 'bad_key' }); }
  const hostname = String(hs.hostname || '');
  if (secret.length !== 96 || pub.length !== 64 || !ADDR_ONLY.test(hostname)) return res.status(400).json({ error: 'bad_key' });
  const list = (v) => (Array.isArray(v) ? v : []);
  const contacts = list(b.contacts).filter((c) => c && isValidAddr(cleanAddr(c.address)) && typeof c.ecdhPub === 'string' && cleanAddr(c.address) !== hostname);
  const peers = list(b.peers).filter((p) => p && isValidAddr(cleanAddr(p.address)) && typeof p.ecdhPub === 'string' && cleanAddr(p.address) !== hostname);
  const groups = list(b.groups).filter((g) => g && typeof g.id === 'string' && g.id.length <= 64 && Array.isArray(g.members));
  const blocked = list(b.blocked).map(cleanAddr).filter(isValidAddr);
  try {
    fs.mkdirSync(SERVICE_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomicSync(path.join(SERVICE_DIR, HS_FILES.secret), secret);
    writeFileAtomicSync(path.join(SERVICE_DIR, HS_FILES.public), pub);
    writeFileAtomicSync(HOSTNAME_FILE, hostname + '\n');
    secret.fill(0);
    let nContacts = 0;
    for (const c of contacts) {
      const k = peerdata.identity(c); if (!k) continue;
      nContacts++;
      store.upsertContact({ ...k, address: cleanAddr(c.address), petname: String(c.petname || '').slice(0, 40) || cleanAddr(c.address).slice(0, 8),
        opkId: null, opkPub: null, addedAt: Number.isFinite(c.addedAt) ? c.addedAt : Date.now() });
    }
    for (const p of peers) {
      const k = peerdata.identity(p); if (!k) continue;
      store.upsertPeer({ ...k, address: cleanAddr(p.address), opkId: null, opkPub: null, addedAt: Number.isFinite(p.addedAt) ? p.addedAt : Date.now() });
    }
    for (const g of groups) store.upsertGroup(g);
    for (const a of blocked) store.addBlocked(a);
    const s = b.settings || {};
    const patch = {};
    for (const k of ['acceptRequests', 'powAlways', 'readReceipts']) if (typeof s[k] === 'boolean') patch[k] = s[k];
    if (Object.keys(patch).length) store.setSettings(patch);
    console.log(`[restore] identity restored: ${nContacts} contact(s), ${groups.length} group(s); restart to publish the address`);
    res.json({ ok: true, address: hostname, contacts: nContacts, groups: groups.length });
  } catch (e) {
    console.error('[restore] failed:', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

ui.get('/api/blocked', (_req, res) => res.json(store.getBlocked()));
ui.post('/api/blocked', (req, res) => {
  const addr = cleanAddr(req.body?.address);
  if (!isValidAddr(addr)) return res.status(400).json({ error: 'invalid address' });
  store.addBlocked(addr);
  store.deleteFromInbox(store.inboxIdsFrom(addr));   // anything they already queued goes too
  res.json({ ok: true });
});
ui.delete('/api/blocked', (req, res) => {
  const addr = cleanAddr(req.body?.address);
  if (!isValidAddr(addr)) return res.status(400).json({ error: 'invalid address' });
  store.removeBlocked(addr);
  res.json({ ok: true });
});

ui.get('/api/settings', (_req, res) => res.json(store.getSettings()));
ui.post('/api/settings', (req, res) => {
  const patch = {};
  if (typeof req.body?.acceptRequests === 'boolean') patch.acceptRequests = req.body.acceptRequests;
  if (typeof req.body?.powAlways      === 'boolean') patch.powAlways      = req.body.powAlways;
  if (typeof req.body?.readReceipts   === 'boolean') patch.readReceipts   = req.body.readReceipts;
  if (req.body?.resetBlocked) patch.blockedCount = 0;
  res.json(store.setSettings(patch));
});

ui.get('/api/prekeys', (_req, res) => { const ids = store.prekeyIds(); res.json({ count: ids.length, ids }); });
ui.post('/api/prekeys', (req, res) => {
  const keys = Array.isArray(req.body?.keys) ? req.body.keys : [];
  const drop = Array.isArray(req.body?.drop) ? req.body.drop.filter((x) => typeof x === 'string') : [];
  if (drop.length) store.dropPrekeys(drop);
  if (keys.length) store.addPrekeys(keys);
  const ids = store.prekeyIds();
  res.json({ ok: true, count: ids.length, ids });
});

// Voice calls: the caller's audio WebSocket arrives on the hidden service's port at /call/<id>; anything else upgrading is refused.
const callBridge = createCallBridge({ socks: SOCKS, log: (m) => console.log(m) });
const pubServer = http.createServer(pub);
pubServer.on('upgrade', (req, socket, head) => {
  if (publicOpen && /^\/call\//.test(req.url || '') && peerRequestAllowed(req.headers)) callBridge.handlePublicUpgrade(req, socket, head);
  else socket.destroy();
});

const uiServer = http.createServer(ui);
function listenUi() { uiServer.listen(UI_PORT, HOST, () => {
  // The desktop app supplies the token itself and keeps it out of the logs; only a standalone run prints the sign-in link.
  if (!UI_TOKEN_FROM_ENV) {
    console.log(`  - private UI   -> http://localhost:${UI_PORT}/#t=${UI_TOKEN}`);
    console.log(`                    (open this link in your browser; it changes every launch)`);
  } else {
    console.log(`  - private UI   -> http://${HOST}:${UI_PORT}`);
  }
  const addr = myAddress();
  if (addr) console.log(`  - your address -> ${addr}`);
  else      console.log(`  - your address -> (waiting for the anon client to publish the service...)`);
  initOutbox();
}); }

// Everything that reaches the .anyone address is handed to this port. If another program holds it, that program would receive it all
// (and could answer in our place), while this app looked fine: so a port that can't be taken stops the app, and start.js stops the
// Anyone network program with it. Exit code 5 tells the desktop app why (its start screen says so).
const EXIT_PORT_BUSY = 5;
function listenPublic() {
  return new Promise((resolve) => {
    pubServer.once('error', (e) => {
      console.error(`  [fatal] the port your address uses (${HOST}:${PUBLIC_PORT}) can't be taken: ${e.code || e.message}. ` +
        'Another program may be using it. Nothing will be received until it is free.');
      process.exit(EXIT_PORT_BUSY);
    });
    pubServer.listen(PUBLIC_PORT, HOST, () => {
      console.log(`  - public node  -> http://${HOST}:${PUBLIC_PORT}  (mapped to your .anyone address)`);
      resolve();
    });
  });
}
// "Try again" on the window's error screen: check every file again, and accept messages once everything reads.
ui.post('/api/store/recheck', (_req, res) => {
  const h = store.checkAll();
  if (h.ok) publicOpen = true;
  res.json(h);
});

// A store file that can't be read: say so plainly (the window shows "Couldn't read saved data") instead of a generic failure.
function storeErrors(err, _req, res, next) {
  if (err && err.code === 'STORE_UNREADABLE') return res.status(503).json({ error: 'store_unreadable', file: err.file });
  return next(err);
}
ui.use(storeErrors);
pub.use(storeErrors);

// Every other error, and unknown paths, answer with a status and a one-word reason only. Express's own error page prints a stack trace
// with this computer's file paths (on Windows they contain the user name), and the public port is reachable by anyone who knows the address.
function quietErrors(app) {
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  app.use((err, _req, res, _next) => {
    const status = Number.isInteger(err && err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('[server] request failed:', err && err.message);
    if (res.headersSent) return res.end();
    res.status(status).json({ error: status === 413 ? 'too_large' : status < 500 ? 'bad_request' : 'failed' });
  });
}
quietErrors(ui);
quietErrors(pub);

// Start: the data key first (the desktop app writes it to stdin), then check that every file can be read, and only then open the two
// ports. A store that can't be read keeps the hidden service closed (nothing arrives that
// couldn't be stored) and the window shows what went wrong.
(async () => {
  try {
    const key = await sealed.readKeyFromStdin();
    if (key) { sealed.setKey(key); key.fill(0); }
  } catch (e) {
    console.error('[store] no data key:', e.message);
    process.exit(3);
  }
  await listenPublic();
  const h = store.checkAll();
  if (!h.ok) console.error('[store] saved data unreadable:', h.problems.map((p) => p.file + ' (' + p.reason + ')').join(', '));
  if (h.ok) publicOpen = true;
  listenUi();
})();

// Verify the Origin on the WebSocket upgrade: the socket is loopback-only, but any local process or browser tab could otherwise connect.
const UI_ORIGINS = new Set([
  `http://${HOST}:${UI_PORT}`,
  `http://localhost:${UI_PORT}`,
]);
// Two loopback sockets share the UI port: /ws (inbox pushes) and /call-ws (voice-call audio, binary). One dispatcher, since two servers
// bound to the same http server with different paths would each abort the other's upgrade.
const pickProtocol = (protocols) => (protocols.has('anonchat') ? 'anonchat' : false);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, handleProtocols: pickProtocol });
const callWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4096, handleProtocols: pickProtocol });
uiServer.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  const pathname = (req.url || '').split('?')[0];
  const wsAllowed = (!origin || UI_ORIGINS.has(origin))     // browser: must match our own origin
    && uiHostAllowed(req.headers) && wsTokenPresent(req.headers);
  const target = pathname === '/ws' ? wss : pathname === '/call-ws' ? callWss : null;
  if (!target || !wsAllowed) { try { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {} socket.destroy(); return; }
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});
wss.on('connection', (sock) => {
  wsClients.add(sock);
  sock.on('close', () => wsClients.delete(sock));
  sock.on('error', () => wsClients.delete(sock));
});
callWss.on('connection', (sock) => callBridge.attachLocal(sock));
