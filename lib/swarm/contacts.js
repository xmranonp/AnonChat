'use strict';
// Contacts' mailbox details (design section 7): the latest swarm frame each contact sent us, checked and kept sealed on disk.
//
//   swarm: { v: 1, seq, keepFor, peers: [ { address, kid, pk, token, oldKid?, oldPk? } ] }     details; the newest seq wins
//   swarm: { v: 1, req: seq }                                                               "send me your details" (for owners: phase 3)
//
// pk and oldPk are 65-byte uncompressed P-256 points in base64url; token is 32 bytes in base64url; kid is 16 hex characters and must
// match the key (the kid is computed by both sides, so a frame naming a kid that isn't its key's is refused whole). Empty peers means
// "write to me directly". A frame that fails any check changes nothing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sealed = require('../sealed');
const { kidOf } = require('./seal');

const ADDR = /^[a-z2-7]{56}\.anyone$/, KID = /^[0-9a-f]{16}$/, TOKEN = /^[A-Za-z0-9_-]{43}$/, PK = /^[A-Za-z0-9_-]{87}$/;
const MAX_PEERS = 4;
const KEEP_MIN = 3600, KEEP_MAX = 7 * 86400, KEEP_DEFAULT = 7 * 86400;
const SEQ_AHEAD_MS = 366 * 86400 * 1000;          // a seq more than a year ahead of our clock: refused (design section 6)
const REQ_EVERY_MS = 24 * 3600 * 1000;          // a request for fresh details at most once a day per contact

function point(s) {
  if (typeof s !== 'string' || !PK.test(s)) return null;
  const b = Buffer.from(s, 'base64url');
  if (b.length !== 65 || b[0] !== 4) return null;
  try { crypto.ECDH.convertKey(b, 'prime256v1', undefined, undefined, 'uncompressed'); } catch { return null; }          // on the curve
  return b;
}
// A details frame's meta, checked. Returns {seq, keepFor, peers} or null. Unknown fields are ignored.
function parseDetails(m, nowMs = Date.now()) {
  if (!m || typeof m !== 'object' || m.v !== 1) return null;
  if (!Number.isSafeInteger(m.seq) || m.seq <= 0 || m.seq > nowMs + SEQ_AHEAD_MS) return null;
  if (!Array.isArray(m.peers) || m.peers.length > MAX_PEERS) return null;
  const keepFor = m.keepFor === undefined ? KEEP_DEFAULT : m.keepFor;
  if (!Number.isInteger(keepFor) || keepFor < KEEP_MIN || keepFor > KEEP_MAX) return null;
  const peers = [], seen = new Set();
  for (const p of m.peers) {
    if (!p || typeof p !== 'object') return null;
    if (typeof p.address !== 'string' || !ADDR.test(p.address) || seen.has(p.address)) return null;
    seen.add(p.address);
    const pk = point(p.pk);
    if (!pk || !KID.test(String(p.kid)) || kidOf(p.address, pk) !== p.kid || !TOKEN.test(String(p.token))) return null;
    const peer = { address: p.address, kid: p.kid, pk: p.pk, token: p.token };
    if (p.oldKid !== undefined || p.oldPk !== undefined) {
      const opk = point(p.oldPk);
      if (!opk || !KID.test(String(p.oldKid)) || kidOf(p.address, opk) !== p.oldKid) return null;
      peer.oldKid = p.oldKid; peer.oldPk = p.oldPk;
    }
    peers.push(peer);
  }
  return { seq: m.seq, keepFor, peers };
}
const parseRequest = (m) => (m && typeof m === 'object' && m.v === 1 && Number.isSafeInteger(m.req) && m.req >= 0 ? { req: m.req } : null);

function create({ dataDir, now = Date.now, log = () => {} } = {}) {
  const FILE = path.join(dataDir, 'swarm-contacts.json');
  let byAddr = new Map();          // address -> { seq, keepFor, peers, at, reqAt? }
  let loaded = false;
  const listeners = new Set();

  function load() {
    loaded = true;
    let buf; try { buf = fs.readFileSync(FILE); } catch { return; }
    try {
      const j = JSON.parse(sealed.open(buf, 'swarm-contacts').toString('utf8'));
      for (const [a, d] of Object.entries(j && j.contacts || {})) {
        const p = ADDR.test(a) && parseDetails({ v: 1, seq: d.seq, keepFor: d.keepFor, peers: d.peers }, now() + SEQ_AHEAD_MS);
        if (p) byAddr.set(a, { ...p, at: Number(d.at) || 0, ...(Number.isFinite(d.reqAt) ? { reqAt: d.reqAt } : {}) });
      }
    } catch (e) {
      log('[swarm] contacts\' mailbox details unreadable, set aside: ' + (e.code || e.message));
      try { fs.renameSync(FILE, FILE + '.unreadable'); } catch {}
    }
  }
  function save() {
    const j = JSON.stringify({ v: 1, contacts: Object.fromEntries(byAddr) });
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, sealed.seal(j, 'swarm-contacts'), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  }
  const ensure = () => { if (!loaded) load(); };

  return {
    // The details a contact sent. Returns 'updated', 'stale' (an older or equal seq) or 'invalid'.
    setDetails(address, meta) {
      ensure();
      if (!ADDR.test(String(address))) return 'invalid';
      const d = parseDetails(meta, now());
      if (!d) return 'invalid';
      const cur = byAddr.get(address);
      if (cur && cur.seq >= d.seq) return 'stale';
      byAddr.set(address, { ...d, at: now(), ...(cur && cur.reqAt ? { reqAt: cur.reqAt } : {}) });
      save();
      for (const f of listeners) { try { f(address, d, cur || null); } catch {} }
      return 'updated';
    },
    // Their current details, or null when they have none (or said "write to me directly": an empty list).
    get(address) { ensure(); const d = byAddr.get(address); return d && d.peers.length ? d : null; },
    seq(address) { ensure(); const d = byAddr.get(address); return d ? d.seq : 0; },
    // A contact was removed: their details go with them.
    remove(address) { ensure(); if (byAddr.delete(address)) save(); },
    // After a 403, 404 or 409 from one of their peers: true when a request for fresh details should go out now (at most once a day).
    wantFresh(address) {
      ensure();
      const d = byAddr.get(address); if (!d) return false;
      const t = now();
      if (d.reqAt && t - d.reqAt < REQ_EVERY_MS && t >= d.reqAt) return false;
      d.reqAt = t; save();
      return true;
    },
    onChange(f) { listeners.add(f); return () => listeners.delete(f); },
    list() { ensure(); return [...byAddr.keys()]; },
    // Backup: each contact's latest details. Restore: put back on an install that has none (each checked as if it had just arrived).
    backup() { ensure(); return Object.fromEntries([...byAddr].map(([a, d]) => [a, { v: 1, seq: d.seq, keepFor: d.keepFor, peers: d.peers }])); },
    restore(all) {
      ensure();
      let n = 0;
      for (const [a, d] of Object.entries(all && typeof all === 'object' ? all : {})) {
        if (byAddr.has(a) || !ADDR.test(a)) continue;
        const p = parseDetails(d, now());
        if (p) { byAddr.set(a, { ...p, at: now() }); n++; }
      }
      if (n) save();
      return n;
    },
  };
}

module.exports = { create, parseDetails, parseRequest, MAX_PEERS, KEEP_DEFAULT };
