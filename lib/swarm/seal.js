'use strict';
// The sealed drop (design section 6), the same code as the mailbox peer's lib/seal.mjs, as CommonJS for the app's backend.
//   seal:      HPKE base mode (RFC 9180): DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM
//   info:      "anonchat swarm seal v1"
//   aad:       lp("anonchat swarm v1") ‖ lp(peer address) ‖ lp(kid) ‖ u64(expiry) ‖ u64(size)
//   plaintext: u32(JSON length) ‖ {"v":1,"env":{…}} ‖ zero padding
//   body:      enc (65 bytes) ‖ ciphertext ‖ tag; total = a size step
// Inside is today's envelope, unchanged: the backend runs the same checks on it as on one that came directly.
const { createHash, randomBytes } = require('crypto');
const { seal, open } = require('./hpke');

const SEAL_INFO = Buffer.from('anonchat swarm seal v1');
const STEPS = [4096, 65536, ...Array.from({ length: 16 }, (_, i) => (i + 1) * 524288)];          // 4 KiB, 64 KiB, then 512 KiB .. 8 MiB
const MAX_DROP = STEPS[STEPS.length - 1];
const isStep = (n) => STEPS.includes(n);
const OVERHEAD = 65 + 16;          // enc + tag

const lp = (x) => { const b = Buffer.isBuffer(x) ? x : Buffer.from(x, 'utf8'); const h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]); };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const kidOf = (peerAddress, pk) => createHash('sha256').update(Buffer.concat([lp('anonchat swarm kid'), lp(peerAddress), lp(pk)])).digest().subarray(0, 8).toString('hex');
const sealAad = (peerAddress, kid, expiry, size) => Buffer.concat([lp('anonchat swarm v1'), lp(peerAddress), lp(kid), u64(expiry), u64(size)]);
const stepFor = (jsonLen) => { const need = OVERHEAD + 4 + jsonLen; const s = STEPS.find((x) => x >= need); if (!s) throw new Error('too-big'); return s; };

// env: the envelope object (with its stamp: an envelope is never sealed without it). Returns {body, kid, size}; body.length is a step.
function sealDrop({ env, peerAddress, pk, expiry, minStep = 0, skE }) {
  if (!env || typeof env !== 'object') throw new Error('seal: no envelope');
  if (!Number.isInteger(expiry) || expiry % 3600) throw new Error('seal: the expiry must be whole hours');
  const json = Buffer.from(JSON.stringify({ v: 1, env }), 'utf8');
  if (minStep > MAX_DROP) throw new Error('seal: no step that big');
  const size = Math.max(stepFor(json.length), STEPS.find((x) => x >= minStep) || 0);
  const pt = Buffer.alloc(size - OVERHEAD); pt.writeUInt32BE(json.length, 0); json.copy(pt, 4);
  const kid = kidOf(peerAddress, pk);
  const { enc, ct } = seal(pk, SEAL_INFO, sealAad(peerAddress, kid, expiry, size), pt, { skE });
  const body = Buffer.concat([enc, ct]);
  if (body.length !== size) throw new Error('seal: size mismatch');
  return { body, kid, size };
}
// Returns the envelope. Throws on any damage, wrong key, wrong label, wrong size, wrong expiry, padding that isn't zero.
function openDrop({ body, peerAddress, sk, pk, expiry }) {
  if (!Buffer.isBuffer(body) || !isStep(body.length)) throw new Error('bad-size');
  if (!Number.isInteger(expiry) || expiry <= 0 || expiry % 3600) throw new Error('bad-expiry');
  const kid = kidOf(peerAddress, pk);
  const pt = open(sk, body.subarray(0, 65), SEAL_INFO, sealAad(peerAddress, kid, expiry, body.length), body.subarray(65));
  const n = pt.readUInt32BE(0);
  if (n > pt.length - 4) throw new Error('bad-length');
  for (let i = 4 + n; i < pt.length; i++) if (pt[i] !== 0) throw new Error('bad-padding');
  if (n < 2 || pt[4] !== 0x7b || pt[4 + n - 1] !== 0x7d) throw new Error('bad-json');          // exactly one object: no whitespace around it
  // no own __proto__ keys come out (a caller that copies the envelope with Object.assign must not get a changed prototype)
  const j = JSON.parse(pt.subarray(4, 4 + n).toString('utf8'), (k, v) => (k === '__proto__' ? undefined : v));
  if (!j || j.v !== 1 || !j.env || typeof j.env !== 'object' || Array.isArray(j.env)) throw new Error('bad-version');
  return j.env;
}
const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');
const sha256hex = (b) => createHash('sha256').update(b).digest('hex');
const newSecret = () => randomBytes(32);          // tokens and owner secrets: 32 random bytes; the peer gets SHA-256 of them, in hex
// The expiry sealed into a drop: whole hours, on our own clock (design: "Clocks").
const expiryAfter = (seconds, nowMs = Date.now()) => Math.ceil((nowMs / 1000 + seconds) / 3600) * 3600;

module.exports = { SEAL_INFO, STEPS, MAX_DROP, isStep, lp, u64, kidOf, sealAad, stepFor, sealDrop, openDrop, b64u, fromB64u, sha256hex, newSecret, expiryAfter };
