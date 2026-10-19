// Double Ratchet over an X3DH handshake: forward secrecy, post-compromise security and signed prekeys (ECDH/ECDSA P-256, AES-256-GCM).

import { b64 } from './crypto.js';

// ECDH P-256: the raw public key is the 65-byte uncompressed point; the shared secret is the 32-byte X coordinate.
const X = { name: 'ECDH', namedCurve: 'P-256' };

// The ECDH identity key can't also sign (WebCrypto forbids dual ECDH+ECDSA use), so a separate ECDSA key signs the SPK.
const SIG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG_HASH = { name: 'ECDSA', hash: 'SHA-256' };

export async function genSigningKey() {
  const kp = await crypto.subtle.generateKey(SIG, true, ['sign', 'verify']);
  return {
    priv: await crypto.subtle.exportKey('jwk', kp.privateKey),
    pub:  b64.enc(await crypto.subtle.exportKey('raw', kp.publicKey)),
  };
}

export async function signSPK(sigPrivJwk, spkPubB64) {
  const key = await crypto.subtle.importKey('jwk', sigPrivJwk, SIG, false, ['sign']);
  const data = b64.dec(spkPubB64);
  const sig = await crypto.subtle.sign(SIG_HASH, key, data);
  return b64.enc(sig);
}

// Returns false instead of throwing on a bad signature.
export async function verifySPK(sigPubB64, spkPubB64, sigB64) {
  try {
    const key = await crypto.subtle.importKey('raw', b64.dec(sigPubB64), SIG, false, ['verify']);
    return await crypto.subtle.verify(SIG_HASH, key, b64.dec(sigB64), b64.dec(spkPubB64));
  } catch {
    return false;
  }
}

const MAX_SKIP = 256;

const ZERO32 = new Uint8Array(32);
const enc = new TextEncoder();

function u8(...a) {
  const t = a.reduce((n, x) => n + x.length, 0);
  const o = new Uint8Array(t);
  let f = 0;
  for (const x of a) { o.set(x, f); f += x.length; }
  return o;
}
const info = (s) => enc.encode(s);

async function genDH() {
  const kp = await crypto.subtle.generateKey(X, true, ['deriveBits']);
  return {
    priv: await crypto.subtle.exportKey('jwk', kp.privateKey),
    pub:  b64.enc(await crypto.subtle.exportKey('raw', kp.publicKey)),
  };
}

async function dh(privJwk, pubB64) {
  const priv = await crypto.subtle.importKey('jwk', privJwk, X, false, ['deriveBits']);
  const pub  = await crypto.subtle.importKey('raw', b64.dec(pubB64), X, false, []);
  // P-256 ECDH shared secret is the 32-byte (256-bit) X-coordinate.
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  return new Uint8Array(bits);
}

async function hkdf(ikm, salt, infoBytes, lenBytes) {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: infoBytes }, base, lenBytes * 8);
  return new Uint8Array(bits);
}

async function kdfRK(rk, dhOut) {
  const out = await hkdf(dhOut, rk, info('anyone-chat/root'), 64);
  return [out.slice(0, 32), out.slice(32, 64)];
}

async function kdfCK(ck) {
  const key = await crypto.subtle.importKey('raw', ck, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mk = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array([0x01])));
  const nck = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array([0x02])));
  return [nck, mk];
}

// Message key -> (AES-256-GCM key, 12-byte IV)
async function msgKeyMaterial(mk) {
  const m = await hkdf(mk, ZERO32, info('anyone-chat/msg'), 44);
  const aesKey = await crypto.subtle.importKey('raw', m.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return { aesKey, iv: m.slice(32, 44) };
}

function headerBytes(h) {
  // Stable field order — used as AES-GCM additional data, must match both sides.
  return enc.encode(JSON.stringify({ dh: h.dh, pn: h.pn, n: h.n }));
}

async function encryptMK(mk, plaintext, aad) {
  const { aesKey, iv } = await msgKeyMaterial(mk);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, plaintext);
  return b64.enc(new Uint8Array(ct));
}
async function decryptMK(mk, ctB64, aad) {
  const { aesKey, iv } = await msgKeyMaterial(mk);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, aesKey, b64.dec(ctB64));
  return new Uint8Array(pt);
}

export async function x3dhInitiator(myIKPrivJwk, theirIKPub, theirSPKPub, theirOPKPub) {
  const ek = await genDH();
  const dh1 = await dh(myIKPrivJwk, theirSPKPub);
  const dh2 = await dh(ek.priv, theirIKPub);
  const dh3 = await dh(ek.priv, theirSPKPub);
  const parts = [dh1, dh2, dh3];
  if (theirOPKPub) parts.push(await dh(ek.priv, theirOPKPub));
  const sk = await hkdf(u8(...parts), ZERO32, info('anyone-chat/x3dh'), 32);
  return { sk, ekPub: ek.pub };
}

export async function x3dhResponder(mySPKPrivJwk, myIKPrivJwk, theirIKPub, theirEKPub, myOPKPrivJwk) {
  const dh1 = await dh(mySPKPrivJwk, theirIKPub);
  const dh2 = await dh(myIKPrivJwk, theirEKPub);
  const dh3 = await dh(mySPKPrivJwk, theirEKPub);
  const parts = [dh1, dh2, dh3];
  if (myOPKPrivJwk) parts.push(await dh(myOPKPrivJwk, theirEKPub));
  return await hkdf(u8(...parts), ZERO32, info('anyone-chat/x3dh'), 32);
}

export async function initInitiator(sk, theirSPKPub, meta = {}) {
  const DHs = await genDH();
  const [RK, CKs] = await kdfRK(sk, await dh(DHs.priv, theirSPKPub));
  return {
    role: 'initiator',
    DHs, DHr: theirSPKPub,
    RK: b64.enc(RK), CKs: b64.enc(CKs), CKr: null,
    Ns: 0, Nr: 0, PN: 0,
    skipped: {},
    confirmed: false,
    ...meta,
  };
}

export function initResponder(sk, mySPK, meta = {}) {
  return {
    role: 'responder',
    DHs: mySPK, DHr: null,
    RK: b64.enc(sk), CKs: null, CKr: null,
    Ns: 0, Nr: 0, PN: 0,
    skipped: {},
    confirmed: false,
    ...meta,
  };
}

async function dhRatchet(s, headerDh) {
  s.PN = s.Ns; s.Ns = 0; s.Nr = 0;
  s.DHr = headerDh;
  let [rk, ckr] = await kdfRK(b64.dec(s.RK), await dh(s.DHs.priv, s.DHr));
  s.RK = b64.enc(rk); s.CKr = b64.enc(ckr);
  s.DHs = await genDH();
  let [rk2, cks] = await kdfRK(b64.dec(s.RK), await dh(s.DHs.priv, s.DHr));
  s.RK = b64.enc(rk2); s.CKs = b64.enc(cks);
}

async function skipMessageKeys(s, until) {
  if (s.Nr + MAX_SKIP < until) throw new Error('too many skipped messages');
  if (s.CKr == null) return;
  while (s.Nr < until) {
    const [nck, mk] = await kdfCK(b64.dec(s.CKr));
    s.skipped[`${s.DHr}|${s.Nr}`] = b64.enc(mk);
    s.CKr = b64.enc(nck);
    s.Nr += 1;
  }
  // Cap the skipped store so it can't grow without bound.
  const keys = Object.keys(s.skipped);
  if (keys.length > MAX_SKIP) for (const k of keys.slice(0, keys.length - MAX_SKIP)) delete s.skipped[k];
}

export async function ratchetEncrypt(s, plaintext) {
  const [nck, mk] = await kdfCK(b64.dec(s.CKs));
  s.CKs = b64.enc(nck);
  const header = { dh: s.DHs.pub, pn: s.PN, n: s.Ns };
  s.Ns += 1;
  const ct = await encryptMK(mk, plaintext, headerBytes(header));
  return { header, ct };
}

export async function ratchetDecrypt(s, header, ct) {
  const aad = headerBytes(header);

  // Reject any (DHr, n) pair already decrypted: closes the concurrent-delivery gap where one message could be processed twice.
  if (!s.consumed) s.consumed = {};
  const consumedKey = `${header.dh}|${header.n}`;
  if (s.consumed[consumedKey]) {
    throw new Error('duplicate message: already decrypted this position');
  }

  const skKey = `${header.dh}|${header.n}`;
  if (s.skipped[skKey]) {
    const mk = b64.dec(s.skipped[skKey]);
    const pt = await decryptMK(mk, ct, aad);
    delete s.skipped[skKey];
    s.consumed[consumedKey] = 1;
    // Prune consumed set so it doesn't grow unboundedly.
    const ckeys = Object.keys(s.consumed);
    if (ckeys.length > MAX_SKIP) for (const k of ckeys.slice(0, ckeys.length - MAX_SKIP)) delete s.consumed[k];
    s.confirmed = true;
    return pt;
  }

  if (header.dh !== s.DHr) {
    await skipMessageKeys(s, header.pn);
    await dhRatchet(s, header.dh);
  }

  await skipMessageKeys(s, header.n);

  const [nck, mk] = await kdfCK(b64.dec(s.CKr));
  s.CKr = b64.enc(nck);
  s.Nr += 1;
  const pt = await decryptMK(mk, ct, aad);
  s.consumed[consumedKey] = 1;
  const ckeys2 = Object.keys(s.consumed);
  if (ckeys2.length > MAX_SKIP) for (const k of ckeys2.slice(0, ckeys2.length - MAX_SKIP)) delete s.consumed[k];
  s.confirmed = true;
  return pt;
}
