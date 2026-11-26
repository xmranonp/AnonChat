'use strict';
// The shape of every answer a mailbox peer may give (design section 5), checked before anything uses it. A function here returns a clean
// copy with only the known fields, or throws: an answer that doesn't fit is malformed, whatever else it says.
const { isStep, MAX_DROP } = require('./seal');

const MAX_JSON = 1024 * 1024;                     // a JSON answer
const MAX_FRAME = 9 * 1024 * 1024 + 2 * 1024 * 1024;          // collect: 9 MiB of bodies plus the header
const MAX_WAIT_FRAME = 256 * 1024 + 1024 * 1024;  // wait: 256 KiB inline plus the header
const MAX_HEADER = 1024 * 1024;
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);
const ID = HEX(32), KID = HEX(16), HASH = HEX(64);
const TOKEN_B64U = /^[A-Za-z0-9_-]{43}$/;
const STATES = new Set(['held', 'collected', 'discarded', 'expired', 'unknown']);
const CODES = new Set(['bad-request', 'bad-size', 'bad-expiry', 'bad-kid', 'aborted', 'unauthorized', 'unknown-token', 'invite-used', 'invite-expired',
  'invite-unknown', 'no-mailbox', 'not-found', 'kid-not-accepted', 'expired', 'too-big', 'rate-limited', 'busy', 'full', 'internal']);

const fail = (why) => { throw new Error(why); };
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : fail('not an object'));
const int = (x, min = 0, max = Number.MAX_SAFE_INTEGER) => (Number.isInteger(x) && x >= min && x <= max ? x : fail('not a whole number in range'));
const str = (x, re) => (typeof x === 'string' && (!re || re.test(x)) ? x : fail('not the expected text'));
const arr = (x, max) => (Array.isArray(x) && x.length <= max ? x : fail('not a list of the expected length'));

function json(buf, ctype) {
  if (!/^application\/json\b/i.test(ctype)) fail('not JSON');
  if (buf.length > MAX_JSON) fail('too big');
  let j; try { j = JSON.parse(buf.toString('utf8')); } catch { fail('unreadable JSON'); }
  return obj(j);
}
// An error answer: {error, retryAfter?}. An unknown code is kept as 'other' (a newer peer may add codes; the status decides).
function error(j) {
  const code = typeof j.error === 'string' && j.error.length <= 64 ? (CODES.has(j.error) ? j.error : 'other') : fail('no error code');
  return { code };
}
// Seconds to wait: the header, else the body's field; at most an hour; null if none.
function retryAfter(header, field) {
  const h = String(header ?? '').trim();
  let s = /^\d{1,10}$/.test(h) ? Number(h) : null;
  if (s === null && Number.isInteger(field) && field >= 0) s = field;
  return s === null ? null : Math.min(s, 3600);
}
function hello(j) {
  const versions = arr(j.versions, 16).map((v) => str(v, /^\d{1,3}\.\d{1,3}$/));
  if (!versions.some((v) => v.startsWith('1.'))) fail('no version 1');
  const steps = arr(j.steps, 64).map((s) => int(s, 1, MAX_DROP));
  const l = obj(j.limits);
  return { versions, features: Array.isArray(j.features) ? j.features.filter((f) => typeof f === 'string' && f.length <= 64).slice(0, 64) : [], maxKeep: int(j.maxKeep, 3600),
    steps, limits: { maxDrop: int(l.maxDrop, 4096, MAX_DROP), mailboxQuota: int(l.mailboxQuota, 1), perContact: int(l.perContact, 1), maxTokens: int(l.maxTokens, 1),
      wait: int(l.wait, 1, 600), liveWaits: int(l.liveWaits, 1, 64), inline: int(l.inline, 0) } };
}
const join = (j) => ({ mailbox: str(j.mailbox, ID) });
const tokens = (j) => ({ tokens: int(j.tokens, 0, 100000), kids: arr(j.kids, 64).map((k) => str(k, KID)) });
const info = (j) => ({ heldDrops: int(j.heldDrops), heldBytes: int(j.heldBytes), quota: int(j.quota), used: Number.isInteger(j.used) ? j.used : null,
  lastCollect: int(j.lastCollect), kids: arr(j.kids, 64).map((k) => str(k, KID)) });
const ok = (j) => (j.ok === true ? { ok: true } : fail('not ok'));
const dropped = (j) => ({ id: str(j.id, ID), state: str(j.state, /^(held|collected|discarded|expired)$/), keepUntil: int(j.keepUntil, 1) });
function status(j) {
  const drops = arr(j.drops, 1000).map((d) => { obj(d); const state = str(d.state); if (!STATES.has(state)) fail('unknown state'); return { id: str(d.id, ID), state, at: int(d.at) }; });
  return { drops, next: typeof j.next === 'string' && /^\d{1,16}$/.test(j.next) ? j.next : null };
}

// A framed answer: u32(header length) ‖ JSON header ‖ inline bodies in header order. Every entry is checked, and every inline body
// must lie exactly where the header says, one after the other, with nothing left over.
function frame(buf, ctype, { byIds = false } = {}) {
  if (!/^application\/x-anonchat-swarm\b/i.test(ctype)) fail('not a frame');
  if (buf.length < 4) fail('short frame');
  const n = buf.readUInt32BE(0);
  if (n > MAX_HEADER || 4 + n > buf.length) fail('bad header length');
  let h; try { h = JSON.parse(buf.subarray(4, 4 + n).toString('utf8')); } catch { fail('unreadable header'); }
  obj(h);
  const base = 4 + n, ids = new Set();
  let pos = 0;
  const drops = arr(h.drops, 4096).map((e) => {
    obj(e);
    const d = { id: str(e.id, ID), kid: str(e.kid, KID), expiry: int(e.expiry, 1), size: int(e.size, 1, MAX_DROP), receivedAt: int(e.receivedAt),
      token: str(e.token, HASH), inline: e.inline === true };
    if (d.expiry % 3600) fail('expiry not whole hours');
    if (!isStep(d.size)) fail('size not a step');
    if (ids.has(d.id)) fail('the same drop twice'); ids.add(d.id);
    if (d.inline) {
      if (int(e.offset) !== pos) fail('bodies out of place');
      d.body = buf.subarray(base + pos, base + pos + d.size);
      if (d.body.length !== d.size) fail('a body cut short');
      pos += d.size;
    } else if (e.offset !== undefined) fail('an offset without a body');
    return d;
  });
  if (base + pos !== buf.length) fail('bytes after the last body');
  if (typeof h.more !== 'boolean') fail('no "more"');
  const out = { drops, more: h.more, prevCollectAt: Number.isInteger(h.prevCollectAt) && h.prevCollectAt >= 0 ? h.prevCollectAt : 0 };
  if (!byIds) out.cursor = str(h.cursor, /^\d{1,16}$/);
  return out;
}
function waitAnswer(res, ctype) {
  if (res.status !== 200) fail('status ' + res.status);
  if (/^application\/json\b/i.test(ctype)) {
    const j = json(res.body, ctype);
    if (j.closed !== 'superseded') fail('unknown JSON answer to wait');
    return { closed: 'superseded', prevCollectAt: Number.isInteger(j.prevCollectAt) && j.prevCollectAt >= 0 ? j.prevCollectAt : 0 };
  }
  return frame(res.body, ctype);
}

module.exports = { MAX_JSON, MAX_FRAME, MAX_WAIT_FRAME, json, error, retryAfter, hello, join, tokens, info, ok, dropped, status, frame, waitAnswer, TOKEN_B64U };
