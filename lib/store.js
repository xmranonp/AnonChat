'use strict';
// File persistence under DATA_DIR: synchronous reads and writes, atomic via temp file + rename, sealed with the data key when the
// desktop app gives one (lib/sealed.js).
//
// Reads fail closed. A file that exists but can't be read, decrypted or parsed is never treated as empty: that used to let one oversized
// or damaged file silently replace the whole inbox or contact list on the next write. The problem is recorded in health() and the
// operation throws; the app shows "Couldn't read saved data" instead of starting with nothing.
//
// The inbox is one file per waiting message (inbox/<time>-<id>.env) with an in-memory index, so its size never depends on reading or
// rewriting one huge file, and limits can be counted in bytes as well as messages.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const sealed = require('./sealed');

const DATA      = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const INBOX_DIR = path.join(DATA, 'inbox');
const MAX_INBOX = parseInt(process.env.MAX_INBOX || '5000', 10);
const MAX_PREKEYS = 100;              // one-time keys waiting to be handed out
// Proof of work only during floods (lib/ratelimit.js pressure) unless turned on.
const SETTINGS_DEFAULTS = { acceptRequests: true, powAlways: false, readReceipts: false, blockedCount: 0 };
// Every file this module keeps, for the start-up check.
const FILES = ['identity.json', 'contacts.json', 'peers.json', 'groups.json', 'prekeys.json', 'settings.json', 'blocked.json', 'mailbox.json'];

function file(name) { return path.join(DATA, name); }

// A write is a temp file plus a rename, so a crash or power cut in between leaves a stray ".tmp" that nothing reads again. Everything
// still named so when the backend starts is such a leftover (writes are synchronous: none is in progress), so they go.
function sweepTemp() {
  for (const dir of [DATA, INBOX_DIR]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) if (n.endsWith('.tmp')) { try { fs.unlinkSync(path.join(dir, n)); } catch {} }
  }
}
sweepTemp();

const problems = new Map();          // file name -> reason
function noteProblem(name, reason) {
  if (!problems.has(name)) console.error(`[store] can't read ${name}: ${reason}`);
  problems.set(name, reason);
}
class StoreError extends Error { constructor(name, reason) { super(`can't read ${name}: ${reason}`); this.code = 'STORE_UNREADABLE'; this.file = name; } }

function decode(buf, aad) { return JSON.parse(sealed.open(buf, aad).toString('utf8')); }
function encode(value, aad) { return sealed.seal(JSON.stringify(value), aad); }

function read(name, fallback) {
  let buf;
  try { buf = fs.readFileSync(file(name)); }
  catch (e) {
    if (e.code === 'ENOENT') return fallback;
    noteProblem(name, e.code || e.message); throw new StoreError(name, e.code || e.message);
  }
  try { const v = decode(buf, name); problems.delete(name); return v; }
  catch (e) { noteProblem(name, e.code || 'unreadable'); throw new StoreError(name, e.code || 'unreadable'); }
}

function writeFileAtomic(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = target + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, target);
}
function write(name, value) { writeFileAtomic(file(name), encode(value, name)); }

function mutate(name, fallback, fn) {
  const cur  = read(name, fallback);          // throws on an unreadable file, so nothing is overwritten
  const next = fn(cur);
  if (next !== undefined) write(name, next);
  return next;
}

// ---- Inbox: one file per waiting message ----
let _index = null;                    // id -> { id, from, size, ts, name, u } (u: claimed a contact's or member's address without a valid stamp)
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
function inboxIndex() {
  if (_index) return _index;
  _index = new Map();
  let names = [];
  try { names = fs.readdirSync(INBOX_DIR).filter((n) => n.endsWith('.env')); } catch {}
  let damaged = 0;
  for (const n of names) {
    const p = path.join(INBOX_DIR, n);
    try {
      const buf = fs.readFileSync(p);
      const env = decode(buf, 'inbox');
      if (!env || !ID_RE.test(env.id || '')) throw new Error('bad entry');
      _index.set(env.id, { id: env.id, from: env.from, size: buf.length, ts: env.receivedAt || 0, name: n, u: !!env.unverified });
    } catch (e) {
      // One damaged message is set aside (kept, renamed) instead of blocking every other one. A wrong key shows up first in the
      // start-up check of the other files.
      damaged++;
      try { fs.renameSync(p, p + '.damaged'); } catch {}
    }
  }
  if (damaged) console.error(`[store] set aside ${damaged} unreadable inbox file(s)`);
  return _index;
}
function inboxEntries() { return [...inboxIndex().values()].sort((a, b) => (a.ts - b.ts) || (a.name < b.name ? -1 : 1)); }

// Pending blocked/dropped count: written at most every 30 s instead of once per dropped message.
let _blockedPending = 0, _blockedTimer = null;
function flushBlocked() {
  _blockedTimer = null;
  if (!_blockedPending) return;
  const n = _blockedPending; _blockedPending = 0;
  try { mutate('settings.json', { ...SETTINGS_DEFAULTS }, (cur) => { cur.blockedCount = (cur.blockedCount || 0) + n; return cur; }); } catch {}
}

const REPLAY_CACHE_SIZE = 5000;
const REPLAY_TTL_MS     = 24 * 60 * 60 * 1000;
const _replayCache      = new Map();

module.exports = {
  StoreError,
  // Start-up check: every file readable with the key we have. Also used by /api/whoami so the window can show the problem.
  checkAll() {
    for (const n of FILES) { try { read(n, null); } catch {} }
    try { inboxIndex(); } catch {}
    return this.health();
  },
  health() { return { ok: problems.size === 0, problems: [...problems].map(([file, reason]) => ({ file, reason })) }; },

  // Whether files on disk are encrypted (for Settings).
  atRest() { return { encrypted: sealed.hasKey() }; },

  getIdentity()    { return read('identity.json', null); },
  setIdentity(pub) { write('identity.json', pub); return pub; },

  getContacts() { return read('contacts.json', []); },
  upsertContact(c) {
    return mutate('contacts.json', [], (list) => {
      const i = list.findIndex(x => x.address === c.address);
      if (i >= 0) list[i] = { ...list[i], ...c }; else list.push(c);
      return list;
    }) && c;
  },
  removeContact(address) {
    mutate('contacts.json', [], (list) => list.filter(x => x.address !== address));
  },

  // Group members who aren't contacts: their keys, fetched from their own .anyone address, so group messages to and from them use a
  // pinned identity just like a contact's. Never shown as contacts.
  getPeers() { return read('peers.json', []); },
  upsertPeer(p) {
    return mutate('peers.json', [], (list) => {
      const i = list.findIndex(x => x.address === p.address);
      if (i >= 0) list[i] = { ...list[i], ...p }; else list.push(p);
      return list;
    }) && p;
  },
  removePeer(address) {
    mutate('peers.json', [], (list) => list.filter(x => x.address !== address));
  },
  // Everyone listed in one of our groups (ourselves included; callers skip that).
  groupMemberSet() {
    const set = new Set();
    for (const g of read('groups.json', [])) for (const m of (Array.isArray(g.members) ? g.members : [])) if (m && typeof m.address === 'string') set.add(m.address);
    return set;
  },

  // Waiting messages, oldest first, up to maxBytes per call (the window asks again while `more` is true).
  getInbox({ maxBytes = Infinity } = {}) {
    const out = []; let bytes = 0, more = false;
    for (const e of inboxEntries()) {
      if (out.length && bytes + e.size > maxBytes) { more = true; break; }
      try { out.push(decode(fs.readFileSync(path.join(INBOX_DIR, e.name)), 'inbox')); bytes += e.size; }
      catch { inboxIndex().delete(e.id); }
    }
    return { items: out, more };
  },
  // Returns the stored envelope, or null when the inbox is full (the sender's app keeps it and retries; nothing already waiting is lost).
  addToInbox(env, { force = false } = {}) {
    const idx = inboxIndex();
    if (!force && idx.size >= MAX_INBOX) return null;
    const name = `${(env.receivedAt || Date.now()).toString(36).padStart(9, '0')}-${env.id}.env`;
    const data = encode(env, 'inbox');
    writeFileAtomic(path.join(INBOX_DIR, name), data);
    idx.set(env.id, { id: env.id, from: env.from, size: data.length, ts: env.receivedAt || 0, name, u: !!env.unverified });
    return env;
  },
  deleteFromInbox(ids) {
    const idx = inboxIndex();
    for (const id of ids) {
      const e = idx.get(id); if (!e) continue;
      try { fs.unlinkSync(path.join(INBOX_DIR, e.name)); } catch (err) { if (err.code !== 'ENOENT') continue; }
      idx.delete(id);
    }
  },
  inboxIdsFrom(address) { return [...inboxIndex().values()].filter((e) => e.from === address).map((e) => e.id); },
  // What is waiting, in messages and bytes: from this sender, from strangers, and in total. Strangers are everyone outside exemptSet
  // (contacts and group members) plus messages that claimed one of those addresses without a valid stamp. "From this sender" counts
  // stamped and unstamped messages separately, so messages wrongly claiming a contact's address never use up that contact's allowance.
  inboxUsage(exemptSet, from, { unverified = false } = {}) {
    const u = { fromCount: 0, fromBytes: 0, strangerCount: 0, strangerBytes: 0, totalCount: 0, totalBytes: 0 };
    for (const e of inboxIndex().values()) {
      u.totalCount++; u.totalBytes += e.size;
      if (e.from === from && !!e.u === unverified) { u.fromCount++; u.fromBytes += e.size; }
      if (e.u || !exemptSet.has(e.from)) { u.strangerCount++; u.strangerBytes += e.size; }
    }
    return u;
  },

  // Mailbox keys (see lib/stamp.js): address -> base64 key, given by the window for every contact and group member.
  mailboxKey(address) { const m = read('mailbox.json', {}); return Object.prototype.hasOwnProperty.call(m, address) ? m[address] : null; },
  setMailboxKeys(list, { replace = false } = {}) {
    mutate('mailbox.json', {}, (m) => {
      const next = replace ? {} : m;
      for (const { address, key } of list) next[address] = key;
      return next;
    });
  },
  removeMailboxKey(address) {
    mutate('mailbox.json', {}, (m) => { if (!(address in m)) return undefined; delete m[address]; return m; });
  },

  prekeyCount() { return read('prekeys.json', []).length; },
  prekeyIds() { return read('prekeys.json', []).map((k) => k.id); },
  // At most MAX_PREKEYS wait to be handed out; extra ones are ignored (the window keeps their private halves only until it next
  // compares lists, see ensurePrekeys in app.js).
  addPrekeys(arr) {
    mutate('prekeys.json', [], (pool) => {
      const have = new Set(pool.map((k) => k.id));
      for (const k of arr) {
        if (pool.length >= MAX_PREKEYS) break;
        if (k && typeof k.id === 'string' && typeof k.pub === 'string' && k.pub.length < 200 && !have.has(k.id)) {
          pool.push({ id: k.id.slice(0, 64), pub: k.pub });
          have.add(k.id);
        }
      }
      return pool;
    });
  },
  // Withdraw keys whose private half the window no longer has: handing one out would make that sender's first message unreadable.
  dropPrekeys(ids) {
    const drop = new Set(ids);
    mutate('prekeys.json', [], (pool) => pool.filter((k) => !drop.has(k.id)));
  },
  claimPrekey() {
    let claimed = null;
    mutate('prekeys.json', [], (pool) => {
      if (!pool.length) return undefined;
      claimed = pool.shift();
      return pool;
    });
    return claimed;
  },

  getGroups() { return read('groups.json', []); },
  upsertGroup(g) {
    if (!g || typeof g.id !== 'string') return;
    const safe = { ...g };
    // Server-side hard cap mirrors MAX_GROUP in app.js (10 incl. self).
    if (Array.isArray(safe.members)) safe.members = safe.members.slice(0, 10);
    mutate('groups.json', [], (gs) => {
      const i = gs.findIndex(x => x.id === safe.id);
      if (i >= 0) gs[i] = { ...gs[i], ...safe }; else gs.push(safe);
      return gs;
    });
  },
  removeGroup(id) {
    mutate('groups.json', [], (gs) => gs.filter(x => x.id !== id));
  },

  // Message requests from people who aren't contacts are on by default.
  getSettings() {
    const saved = read('settings.json', {});
    return { ...SETTINGS_DEFAULTS, ...saved, blockedCount: (saved.blockedCount || 0) + _blockedPending };
  },
  setSettings(patch) {
    flushBlocked();
    return mutate('settings.json', { ...SETTINGS_DEFAULTS }, (cur) => ({ ...SETTINGS_DEFAULTS, ...cur, ...patch }));
  },
  incrementBlocked() {
    _blockedPending++;
    if (!_blockedTimer) { _blockedTimer = setTimeout(flushBlocked, 30_000); _blockedTimer.unref?.(); }
  },

  // Addresses whose messages are dropped on arrival.
  getBlocked() { return read('blocked.json', []); },
  isBlocked(address) { return this.getBlocked().includes(address); },
  addBlocked(address) {
    mutate('blocked.json', [], (list) => { if (!list.includes(address)) list.push(address); return list; });
  },
  removeBlocked(address) {
    mutate('blocked.json', [], (list) => list.filter((a) => a !== address));
  },

  // Read-only replay check: true if this ciphertext was already accepted in the last 24 h.
  hasSeenEnvelope(ct) {
    if (!ct || typeof ct !== 'string') return false;
    const prev = _replayCache.get(crypto.createHash('sha256').update(ct).digest('hex'));
    return !!prev && Date.now() - prev < REPLAY_TTL_MS;
  },
  // Check and record. Call only when the envelope is really being accepted: recording one that is then turned away (proof of work
  // required, rate limited) would make the sender's corrected retry look like a replay.
  seenEnvelope(ct) {
    if (!ct || typeof ct !== 'string') return false;
    // Key on a SHA-256 of the FULL ciphertext: a short prefix could collide on distinct messages and drop a legitimate one.
    const key = crypto.createHash('sha256').update(ct).digest('hex');
    const now = Date.now();
    const prev = _replayCache.get(key);
    if (prev && now - prev < REPLAY_TTL_MS) return true;
    _replayCache.set(key, now);
    if (_replayCache.size > REPLAY_CACHE_SIZE) {
      const cutoff = now - REPLAY_TTL_MS;
      for (const [k, ts] of _replayCache)
        if (ts < cutoff) _replayCache.delete(k);
      // Still too many after a busy day: the oldest go first (a Map keeps insertion order). Older replays still fail at the ratchet.
      for (const k of _replayCache.keys()) { if (_replayCache.size <= REPLAY_CACHE_SIZE * 4) break; _replayCache.delete(k); }
    }
    return false;
  },
};
