'use strict';

// Checks what other nodes send about themselves (/api/identity and /api/profile) before any of it is stored or handed to the window.
// A contact or group member controls those answers, now and on every later profile refresh: without these checks one of them could store
// a picture of many megabytes, or values that aren't strings, which break the contact list when it is drawn.

const KEY_RE = /^[A-Za-z0-9+/]{40,200}={0,2}$/;                              // base64 public keys and signatures (P-256: 88 characters)
const OPK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PICTURE_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;  // what the app itself produces (JPEG at 256 px)
const MAX_PICTURE = 300000;                                                   // same ceiling as a group picture
const MAX_BIO = 280;

const crypto = require('crypto');
const key = (v) => (typeof v === 'string' && KEY_RE.test(v) ? v : null);
// A public key must be a real P-256 point: 65 bytes, uncompressed, and on the curve (loading it checks that). A key of the right shape
// that isn't one would be saved, then break every attempt to start a chat with that contact.
function p256(v) {
  if (!key(v)) return null;
  const b = Buffer.from(v, 'base64');
  if (b.length !== 65 || b[0] !== 4) return null;
  try { return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b.subarray(1, 33).toString('base64url'), y: b.subarray(33).toString('base64url') }, format: 'jwk' }); }
  catch { return null; }
}
const point = (v) => (p256(v) ? v : null);
// The signed prekey's signature (WebCrypto's ECDSA P-256 / SHA-256, 64 bytes r||s) by the identity signing key. Checked here as well as in
// the window before a chat starts, so a prekey that isn't really theirs is never even saved.
function signed(ikSigPub, ratchetPub, sigB64) {
  const pub = p256(ikSigPub);
  if (!pub || !key(sigB64)) return false;
  const sig = Buffer.from(sigB64, 'base64');
  if (sig.length !== 64) return false;
  try { return crypto.verify('sha256', Buffer.from(ratchetPub, 'base64'), { key: pub, dsaEncoding: 'ieee-p1363' }, sig); } catch { return false; }
}
const opkId = (v) => (typeof v === 'string' && OPK_ID_RE.test(v) ? v : null);
const picture = (v) => (typeof v === 'string' && v.length <= MAX_PICTURE && PICTURE_RE.test(v) ? v : null);
const bio = (v) => (typeof v === 'string' ? (v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_BIO) || null) : null);

// The keys a node serves at /api/identity. null when the two keys a session needs are missing or malformed (the node is then treated as
// unreachable/invalid); optional fields that are malformed are dropped. A one-time key is kept only with a valid id.
function identity(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const ecdhPub = point(data.ecdhPub), ratchetPub = point(data.ratchetPub);
  if (!ecdhPub || !ratchetPub) return null;
  const id = opkId(data.opkId), opkPub = point(data.opkPub);
  const ikSigPub = point(data.ikSigPub);
  return {
    ecdhPub, ratchetPub,
    ikSigPub, spkSig: ikSigPub && signed(ikSigPub, ratchetPub, data.spkSig) ? data.spkSig : null,
    opkId: id && opkPub ? id : null, opkPub: id && opkPub ? opkPub : null,
    avatar: picture(data.avatar), bio: bio(data.bio),
  };
}

// A signed prekey from a profile: kept only when it is a real P-256 point signed by the identity signing key we pinned for them (never one
// that came with this answer). null otherwise, including for apps from before 1.0.2, whose profile doesn't carry one.
function prekey(data, pinnedIkSigPub) {
  if (!data || typeof data !== 'object' || !pinnedIkSigPub) return null;
  const ratchetPub = point(data.ratchetPub);
  if (!ratchetPub || !signed(pinnedIkSigPub, ratchetPub, data.spkSig)) return null;
  return { ratchetPub, spkSig: data.spkSig };
}

// The public profile (/api/profile): picture and short status only. Names chosen by the other side are never taken.
function profile(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { avatar: null, bio: null };
  return { avatar: picture(data.avatar), bio: bio(data.bio) };
}

module.exports = { identity, profile, prekey, picture, bio, key, point, signed, MAX_PICTURE, MAX_BIO };
