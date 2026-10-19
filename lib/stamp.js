'use strict';
// Message stamps: proof, checkable by the recipient's backend before anything is stored, that a message claiming to come from a
// contact (or a fellow group member) really does.
//
// The "from" address on an envelope is only a label until the window decrypts the message. The inbox gives contacts a large allowance
// and spares them proof of work, so without a check anyone who knows a contact's address could claim it and get the same treatment.
//
// Each pair of people shares a mailbox key: HKDF over the ECDH of their two identity keys (public/app.js, mailboxKeyFor). Both sides can
// compute it and nobody else can. The window hands the keys to its backend; the backend stamps every message it sends with
// HMAC-SHA-256 under the recipient's key, and checks the stamp on every message that claims a contact's or member's address. Being a
// shared key, a stamp proves nothing to anyone else: unlike a signature, it can't be used to show a third party who sent a message.

const crypto = require('crypto');

function material(env, from, to) {
  const x = env.x3dh ? [env.x3dh.ik, env.x3dh.ek, env.x3dh.opkId || ''].join(',') : '';
  const ctHash = crypto.createHash('sha256').update(String(env.ct)).digest('hex');
  const pn = Number.isInteger(env.pn) ? env.pn : 0;
  return ['anonchat stamp v1', from, to, env.dh, env.n, pn, x, ctHash].join('\n');
}

function keyBuf(keyB64) {
  const k = Buffer.from(String(keyB64 || ''), 'base64');
  return k.length === 32 ? k : null;
}

// Returns the stamp (base64url), or null without a usable key.
function make(keyB64, env, from, to) {
  const k = keyBuf(keyB64);
  if (!k) return null;
  return crypto.createHmac('sha256', k).update(material(env, from, to)).digest('base64url');
}

function check(keyB64, env, from, to) {
  if (typeof env.stamp !== 'string' || env.stamp.length > 64) return false;
  const want = make(keyB64, env, from, to);
  if (!want) return false;
  const a = Buffer.from(want), b = Buffer.from(env.stamp);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { make, check };
