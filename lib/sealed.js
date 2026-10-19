'use strict';
// Encryption at rest for the backend's own files (contacts, groups, settings, inbox, outbox…).
//
// The desktop app hands the backend a 32-byte data key at start (over stdin, never on the command line or in the environment). The key
// itself is kept by the operating system's vault (Keychain, Windows user encryption, the Linux keyring) or wrapped with the person's
// passphrase; see desktop/main.js. Each file is sealed with AES-256-GCM under a key derived from it, so a copied file can't be read and
// any change to it is detected.
//
// Without a data key (the browser-mode `npm start`), files are written in the clear as before and the app says so in Settings.

const crypto = require('crypto');

const MAGIC = Buffer.from('ACE1');          // AnonChat encrypted, format 1: MAGIC | iv (12) | tag (16) | ciphertext
let fileKey = null;

function setKey(dataKey) {
  if (!Buffer.isBuffer(dataKey) || dataKey.length !== 32) throw new Error('data key must be 32 bytes');
  fileKey = Buffer.from(crypto.hkdfSync('sha256', dataKey, Buffer.alloc(0), Buffer.from('anonchat backend files v1'), 32));
}
function hasKey() { return !!fileKey; }
function isSealed(buf) { return Buffer.isBuffer(buf) && buf.length >= 32 && buf.subarray(0, 4).equals(MAGIC); }

// `aad` names what the file is (contacts.json, inbox, outbox…): a sealed file only opens under its own name, so one file can't be swapped
// in for another (say, an old block list for the contact list) without the change being detected.
function seal(plain, aad = '') {
  if (!fileKey) return Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', fileKey, iv);
  c.setAAD(Buffer.from(String(aad)));
  const ct = Buffer.concat([c.update(Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8')), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), ct]);
}

// Returns the plaintext as a Buffer. A sealed file without the key, or one that fails authentication, throws: the caller must never
// treat that as "empty". With a key, a file that isn't sealed is refused too: once everything has been encrypted, a plain file can only
// have been put there by someone else.
function open(buf, aad = '') {
  if (!isSealed(buf)) {
    if (fileKey) { const e = new Error('file is not encrypted'); e.code = 'NOT_ENCRYPTED'; throw e; }
    return buf;
  }
  if (!fileKey) { const e = new Error('file is encrypted and no key was given'); e.code = 'NO_KEY'; throw e; }
  const d = crypto.createDecipheriv('aes-256-gcm', fileKey, buf.subarray(4, 16));
  d.setAAD(Buffer.from(String(aad)));
  d.setAuthTag(buf.subarray(16, 32));
  try { return Buffer.concat([d.update(buf.subarray(32)), d.final()]); }
  catch { const e = new Error('file could not be decrypted (wrong key or damaged)'); e.code = 'BAD_SEAL'; throw e; }
}

// Read the data key the desktop app writes to stdin as one line of hex. Resolves null when stdin is not used for that.
function readKeyFromStdin(timeoutMs = 10000) {
  if (process.env.ANONCHAT_KEY_STDIN !== '1') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let buf = '';
    const done = (v, err) => { clearTimeout(timer); process.stdin.removeAllListeners('data'); process.stdin.pause(); err ? reject(err) : resolve(v); };
    const timer = setTimeout(() => done(null, new Error('no data key on stdin')), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) { if (buf.length > 200) done(null, new Error('bad data key')); return; }
      const hex = buf.slice(0, nl).trim();
      buf = '';
      if (!/^[0-9a-f]{64}$/.test(hex)) return done(null, new Error('bad data key'));
      done(Buffer.from(hex, 'hex'));
    });
    process.stdin.resume();
  });
}

module.exports = { setKey, hasKey, isSealed, seal, open, readKeyFromStdin };
