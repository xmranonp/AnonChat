// The same code as the mailbox peer's lib/hpke.mjs (design section 6), as CommonJS for the app's backend. Kept identical on purpose:
// both are tested against RFC 9180, swarm-vectors.json and a second implementation (tools/swarm-seal-test.mjs).
// HPKE (RFC 9180), base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-GCM, single-shot seal/open. Node's crypto only.
'use strict';
const { createECDH, createCipheriv, createDecipheriv, createHmac } = require('crypto');

const cat = (...a) => Buffer.concat(a.map((x) => (typeof x === 'string' ? Buffer.from(x, 'latin1') : Buffer.from(x))));
const i2 = (n) => Buffer.from([(n >> 8) & 255, n & 255]);
const EMPTY = Buffer.alloc(0);
const hkdfExtract = (salt, ikm) => createHmac('sha256', salt.length ? salt : Buffer.alloc(32)).update(ikm).digest();
function hkdfExpand(prk, info, L) {
  const out = []; let t = EMPTY, n = 0;
  for (let i = 1; n < L; i++) { t = createHmac('sha256', prk).update(cat(t, info, Buffer.from([i]))).digest(); out.push(t); n += t.length; }
  return Buffer.concat(out).subarray(0, L);
}
const lExtract = (suite, salt, label, ikm) => hkdfExtract(salt, cat('HPKE-v1', suite, label, ikm));
const lExpand = (suite, prk, label, info, L) => hkdfExpand(prk, cat(i2(L), 'HPKE-v1', suite, label, info), L);

const KEM_P256 = 0x0010, KDF_SHA256 = 0x0001, AEAD_AES128 = 0x0001, AEAD_AES256 = 0x0002;
const KEM_SUITE = cat('KEM', i2(KEM_P256));
const extractAndExpand = (dh, ctx) => lExpand(KEM_SUITE, lExtract(KEM_SUITE, EMPTY, 'eae_prk', dh), 'shared_secret', ctx, 32);

function generateKeyPair() {
  const e = createECDH('prime256v1'); e.generateKeys();
  return { sk: e.getPrivateKey(), pk: e.getPublicKey(null, 'uncompressed') };
}
const publicKeyOf = (sk) => { const e = createECDH('prime256v1'); e.setPrivateKey(sk); return e.getPublicKey(null, 'uncompressed'); };

function encap(pkR, skE) { // skE only for known-answer tests
  const e = createECDH('prime256v1'); if (skE) e.setPrivateKey(skE); else e.generateKeys();
  const enc = e.getPublicKey(null, 'uncompressed');
  const dh = e.computeSecret(pkR); // throws on a point that is not on the curve
  return { shared: extractAndExpand(dh, cat(enc, pkR)), enc };
}
function decap(enc, skR) {
  const e = createECDH('prime256v1'); e.setPrivateKey(skR);
  const dh = e.computeSecret(enc);
  return extractAndExpand(dh, cat(enc, e.getPublicKey(null, 'uncompressed')));
}
function keySchedule(aeadId, shared, info) {
  const suite = cat('HPKE', i2(KEM_P256), i2(KDF_SHA256), i2(aeadId));
  const Nk = aeadId === AEAD_AES128 ? 16 : 32;
  const ctx = cat(Buffer.from([0]), lExtract(suite, EMPTY, 'psk_id_hash', EMPTY), lExtract(suite, EMPTY, 'info_hash', info));
  const secret = lExtract(suite, shared, 'secret', EMPTY);
  return { key: lExpand(suite, secret, 'key', ctx, Nk), nonce: lExpand(suite, secret, 'base_nonce', ctx, 12), ctx, secret };
}
const alg = (aeadId) => (aeadId === AEAD_AES128 ? 'aes-128-gcm' : 'aes-256-gcm');

function seal(pkR, info, aad, pt, { aeadId = AEAD_AES256, skE } = {}) {
  const { shared, enc } = encap(pkR, skE);
  const { key, nonce } = keySchedule(aeadId, shared, info);
  const c = createCipheriv(alg(aeadId), key, nonce); c.setAAD(aad);
  const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  return { enc, ct };
}
function open(skR, enc, info, aad, ct, { aeadId = AEAD_AES256 } = {}) {
  if (ct.length < 16) throw new Error('hpke: short ciphertext');
  const { key, nonce } = keySchedule(aeadId, decap(enc, skR), info);
  const d = createDecipheriv(alg(aeadId), key, nonce); d.setAAD(aad); d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

module.exports = { KEM_P256, KDF_SHA256, AEAD_AES128, AEAD_AES256, generateKeyPair, publicKeyOf, encap, decap, keySchedule, seal, open };
