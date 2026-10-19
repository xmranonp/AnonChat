// Identity backups: one encrypted file holding what makes you "you" on the Anyone network, so the same address can move to another
// computer (or, later, the Android app). The format is plain JSON with standard primitives so any platform can read it; it is specified
// in docs/BACKUP-FORMAT.md. Runs in the window and in Node (tests) alike: only WebCrypto and TextEncoder are used.
//
// Outer file (readable without the passphrase, and revealing nothing about whose it is):
//   { "format": "anonchat-backup", "v": 1,
//     "kdf":    { "name": "PBKDF2", "hash": "SHA-256", "iterations": 600000, "salt": <b64, 16 bytes> },
//     "cipher": { "name": "AES-GCM", "iv": <b64, 12 bytes> },
//     "ct":     <b64: AES-256-GCM(JSON payload), additional data = "anonchat-backup v1"> }

export const FORMAT = 'anonchat-backup';
export const VERSION = 1;
export const ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 12;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const FILE_EXT = '.anonchat';
const AAD = new TextEncoder().encode('anonchat-backup v1');

const subtle = globalThis.crypto.subtle;
const enc = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const dec = (b64s) => { const s = atob(b64s); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };

const ADDR_RE = /^[a-z2-7]{56}\.anyone$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max = 4096) => typeof v === 'string' && v.length > 0 && v.length <= max;

async function deriveKey(passphrase, salt, iterations) {
  const km = await subtle.importKey('raw', new TextEncoder().encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// The address encodes the service's public key: its first 32 bytes, base32. A hidden-service key that doesn't match the address it
// claims would publish a different address, so a backup like that is refused.
function base32Decode(s) {
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0, val = 0; const out = [];
  for (const ch of s) { const i = A.indexOf(ch); if (i < 0) return null; val = (val << 5) | i; bits += 5; if (bits >= 8) { bits -= 8; out.push((val >>> bits) & 0xff); } }
  return new Uint8Array(out);
}
const SECRET_HEADER = '== ed25519v1-secret: type0 ==';
const PUBLIC_HEADER = '== ed25519v1-public: type0 ==';
function headerIs(bytes, header) { return new TextDecoder().decode(bytes.subarray(0, header.length)) === header; }

// Checks that a decrypted payload has everything a restore needs, in the right shape. Returns a list of problems (empty = fine).
export function checkPayload(p) {
  const problems = [];
  if (!isObj(p)) return ['not an object'];
  if (p.format !== FORMAT || p.v !== VERSION) problems.push('unknown version');
  if (!isStr(p.address, 80) || !ADDR_RE.test(p.address)) problems.push('address');
  const hs = p.hs;
  if (!isObj(hs) || !isStr(hs.secret, 200) || !isStr(hs.public, 200) || hs.hostname !== p.address) problems.push('hidden-service key');
  else {
    try {
      const sec = dec(hs.secret), pub = dec(hs.public);
      if (sec.length !== 96 || !headerIs(sec, SECRET_HEADER)) problems.push('hidden-service secret key');
      if (pub.length !== 64 || !headerIs(pub, PUBLIC_HEADER)) problems.push('hidden-service public key');
      const fromAddr = base32Decode(p.address.slice(0, 56));
      if (!fromAddr || fromAddr.length < 32 || !fromAddr.subarray(0, 32).every((b, i) => b === pub[32 + i])) problems.push('address does not match its key');
    } catch { problems.push('hidden-service key encoding'); }
  }
  const id = p.identity;
  const jwkOk = (j) => isObj(j) && j.kty === 'EC' && j.crv === 'P-256' && isStr(j.d, 100) && isStr(j.x, 100) && isStr(j.y, 100);
  if (!isObj(id) || !jwkOk(id.ikPriv) || !isStr(id.ikPub, 200) || !isObj(id.spk) || !jwkOk(id.spk.priv) || !isStr(id.spk.pub, 200)
      || !isObj(id.ikSig) || !jwkOk(id.ikSig.priv) || !isStr(id.ikSig.pub, 400)) problems.push('identity keys');
  for (const k of ['contacts', 'peers', 'groups', 'blocked']) if (!Array.isArray(p[k])) problems.push(k);
  if (Array.isArray(p.contacts) && p.contacts.some((c) => !isObj(c) || !ADDR_RE.test(c.address || '') || !isStr(c.ecdhPub, 200))) problems.push('contacts');
  if (Array.isArray(p.peers) && p.peers.some((c) => !isObj(c) || !ADDR_RE.test(c.address || '') || !isStr(c.ecdhPub, 200))) problems.push('peers');
  if (Array.isArray(p.groups) && p.groups.some((g) => !isObj(g) || !isStr(g.id, 64) || !Array.isArray(g.members))) problems.push('groups');
  if (Array.isArray(p.blocked) && p.blocked.some((a) => !ADDR_RE.test(a))) problems.push('blocked');
  if (p.settings != null && !isObj(p.settings)) problems.push('settings');
  if (p.profile != null && !isObj(p.profile)) problems.push('profile');
  if (p.prefs != null && !isObj(p.prefs)) problems.push('prefs');
  return problems;
}

// The identity keys must really be pairs: each private key must belong to the public key stored beside it. A file put together by hand
// could pass checkPayload with mismatched halves, and restoring it would leave an identity that can't start a chat. Checked by using
// each pair (an exchange with a throwaway key for the ECDH keys, a signature for the signing key), before anything is erased.
async function keysPair(p) {
  const X = { name: 'ECDH', namedCurve: 'P-256' }, S = { name: 'ECDSA', namedCurve: 'P-256' };
  const pubOf = (b64s) => dec(b64s);
  const ecdhPair = async (privJwk, pubB64) => {
    const priv = await subtle.importKey('jwk', privJwk, X, false, ['deriveBits']);
    const pub = await subtle.importKey('raw', pubOf(pubB64), X, false, []);
    const t = await subtle.generateKey(X, false, ['deriveBits']);
    const a = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: t.publicKey }, priv, 256));
    const b = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, t.privateKey, 256));
    return a.length === b.length && a.every((v, i) => v === b[i]);
  };
  const sigPair = async (privJwk, pubB64) => {
    const priv = await subtle.importKey('jwk', privJwk, S, false, ['sign']);
    const pub = await subtle.importKey('raw', pubOf(pubB64), S, false, ['verify']);
    const msg = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, msg);
    return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, msg);
  };
  try {
    const id = p.identity;
    return (await ecdhPair(id.ikPriv, id.ikPub)) && (await ecdhPair(id.spk.priv, id.spk.pub)) && (await sigPair(id.ikSig.priv, id.ikSig.pub));
  } catch { return false; }
}

// What goes in: only what restores the identity and the people around it. One-time prekeys are left out on purpose (single use), and
// so are presence fields the backend adds when it lists contacts. Contacts' and group members' pictures are left out too: they are
// theirs, their apps serve them, and this app fetches them again when they next write. With them, a backup of many people with large
// pictures could grow past what a restore can take.
export function buildPayload({ address, hs, identity, contacts, peers, groups, blocked, settings, profile, prefs, now = Date.now() }) {
  const strip = (c) => { const { online, lastSeen, opkId, opkPub, avatar, ...rest } = c; return rest; };
  return {
    format: FORMAT, v: VERSION, createdAt: now, address,
    hs: { secret: hs.secret, public: hs.public, hostname: hs.hostname },
    identity: { ikPriv: identity.ikPriv, ikPub: identity.ikPub, spk: identity.spk, ikSig: identity.ikSig },
    contacts: (contacts || []).map(strip),
    peers: (peers || []).map(strip),
    groups: groups || [],
    blocked: blocked || [],
    settings: settings ? { acceptRequests: settings.acceptRequests, powAlways: settings.powAlways, readReceipts: settings.readReceipts } : {},
    profile: profile || {},
    prefs: prefs || {},
  };
}

export async function encryptBackup(payload, passphrase, { iterations = ITERATIONS } = {}) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) throw new Error('passphrase too short');
  const problems = checkPayload(payload);
  if (problems.length) throw new Error('backup incomplete: ' + problems.join(', '));
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(JSON.stringify(payload))));
  const file = { format: FORMAT, v: VERSION, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: enc(salt) }, cipher: { name: 'AES-GCM', iv: enc(iv) }, ct: enc(ct) };
  return new TextEncoder().encode(JSON.stringify(file));
}

// Errors carry a code the window turns into a sentence: 'not_backup' (not one of our files), 'too_new' (made by a newer version),
// 'wrong_passphrase' (or a damaged file: AES-GCM can't tell them apart), 'invalid' (opened, but something a restore needs is missing).
function fail(code, detail) { const e = new Error(detail || code); e.code = code; return e; }

export async function decryptBackup(bytes, passphrase) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_FILE_BYTES) throw fail('not_backup');
  let file;
  try { file = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw fail('not_backup'); }
  if (!isObj(file) || file.format !== FORMAT) throw fail('not_backup');
  if (file.v !== VERSION) throw fail(file.v > VERSION ? 'too_new' : 'not_backup');
  const k = file.kdf, c = file.cipher;
  if (!isObj(k) || k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || !Number.isInteger(k.iterations) || k.iterations < 100_000 || k.iterations > 10_000_000
      || !isStr(k.salt, 64) || !isObj(c) || c.name !== 'AES-GCM' || !isStr(c.iv, 64) || !isStr(file.ct, MAX_FILE_BYTES * 2)) throw fail('not_backup');
  let pt;
  try {
    const key = await deriveKey(String(passphrase || ''), dec(k.salt), k.iterations);
    pt = await subtle.decrypt({ name: 'AES-GCM', iv: dec(c.iv), additionalData: AAD }, key, dec(file.ct));
  } catch { throw fail('wrong_passphrase'); }
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(pt)); } catch { throw fail('invalid'); }
  const problems = checkPayload(payload);
  if (problems.length) throw fail('invalid', problems.join(', '));
  if (!(await keysPair(payload))) throw fail('invalid', 'identity keys do not match');
  return payload;
}

export function backupFileName(now = new Date()) {
  const d = now.toISOString().slice(0, 10);
  return `anonchat-backup-${d}${FILE_EXT}`;
}
