'use strict';
// The data key: 32 random bytes that encrypt everything AnonChat keeps on this computer (the backend's files directly, and the window's
// storage together with the PIN). It is never stored in the clear. keystore.json holds it wrapped one of two ways:
//
//   os          the operating system's vault holds the wrapping key: Keychain (macOS), the user's DPAPI key (Windows), the GNOME
//               keyring or KWallet (Linux), through Electron's safeStorage. Nothing to type; a copy of the files is useless on another
//               computer or user account.
//   passphrase  wrapped with a key derived from the person's passphrase (scrypt, 128 MiB, about half a second): protects a stolen disk
//               or backup even from someone signed in as that person. Used when chosen in Settings, and on Linux systems without a
//               keyring.
//
// Changing between the two re-wraps the same data key, so no file has to be re-encrypted.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const MIN_PASSPHRASE = 12;

function file(dir) { return path.join(dir, 'keystore.json'); }

function load(dir) {
  try { for (const n of fs.readdirSync(dir)) if (/^keystore\.json\..*\.tmp$/.test(n)) fs.unlinkSync(path.join(dir, n)); } catch {}   // left by an interrupted save
  let raw;
  try { raw = fs.readFileSync(file(dir), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const ks = JSON.parse(raw);                         // a damaged keystore throws: never silently replaced by a new key
  if (!ks || ks.v !== 1 || (ks.mode !== 'os' && ks.mode !== 'passphrase')) throw new Error('unknown keystore format');
  checkShape(ks);
  return ks;
}
// A keystore whose fields can't be used (a cut-off or edited file that is still valid JSON) is reported as damaged here, at load, so the
// start screen says so: scrypt would otherwise throw in the middle of unlocking and leave the screen on "Unlocking…" for good.
function b64len(v, n) { return typeof v === 'string' && Buffer.from(v, 'base64').length === n; }
function checkShape(ks) {
  if (ks.mode === 'os') {
    if (typeof ks.wrapped !== 'string' || !ks.wrapped) throw new Error('keystore damaged: no wrapped key');
    return;
  }
  const k = ks.kdf;
  const pow2 = (n) => Number.isInteger(n) && n >= 1 << 10 && n <= 1 << 20 && (n & (n - 1)) === 0;
  if (!k || k.name !== 'scrypt' || !pow2(k.N) || !Number.isInteger(k.r) || k.r < 1 || k.r > 32 || !Number.isInteger(k.p) || k.p < 1 || k.p > 16
      || 128 * k.N * k.r > SCRYPT.maxmem) throw new Error('keystore damaged: unusable key settings');
  if (!b64len(k.salt, 16) || !b64len(ks.iv, 12) || !b64len(ks.tag, 16) || !b64len(ks.ct, 32)) throw new Error('keystore damaged: bad fields');
}
function save(dir, ks) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = file(dir) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ks, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file(dir));
}

// Is there a real vault? On Linux, safeStorage falls back to a fixed built-in key ("basic_text") when no keyring is running: that is not
// protection, so it counts as no vault.
function vaultAvailable(safeStorage) {
  try {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform === 'linux') {
      const b = typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : 'unknown';
      return b !== 'basic_text' && b !== 'unknown';
    }
    return true;
  } catch { return false; }
}
// What Settings shows under "Key kept by".
function vaultName(safeStorage) {
  if (process.platform === 'darwin') return 'keychain';
  if (process.platform === 'win32') return 'windows';
  try {
    const b = safeStorage.getSelectedStorageBackend();
    if (/kwallet/.test(b)) return 'kwallet';
    if (b === 'gnome_libsecret') return 'gnome';
  } catch {}
  return 'keyring';
}

function newDataKey() { return crypto.randomBytes(32); }

function wrapOs(dir, safeStorage, dk) {
  const wrapped = safeStorage.encryptString(dk.toString('hex'));
  save(dir, { v: 1, mode: 'os', wrapped: wrapped.toString('base64'), at: Date.now() });
}
function unwrapOs(ks, safeStorage) {
  const hex = safeStorage.decryptString(Buffer.from(ks.wrapped, 'base64'));
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('vault returned an invalid key');
  return Buffer.from(hex, 'hex');
}

function deriveFromPassphrase(pass, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(String(pass).normalize('NFKC'), salt, 32, SCRYPT, (e, k) => e ? reject(e) : resolve(k)));
}
async function wrapPassphrase(dir, pass, dk) {
  if (typeof pass !== 'string' || pass.length < MIN_PASSPHRASE) throw new Error('passphrase too short');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const kek = await deriveFromPassphrase(pass, salt);
  const c = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([c.update(dk), c.final()]);
  save(dir, { v: 1, mode: 'passphrase', kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') },
    iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64'), at: Date.now() });
}
// The data key, or null for a wrong passphrase.
async function unwrapPassphrase(ks, pass) {
  const p = ks.kdf || {};
  const kek = await new Promise((resolve, reject) => crypto.scrypt(String(pass).normalize('NFKC'), Buffer.from(p.salt, 'base64'), 32,
    { N: p.N, r: p.r, p: p.p, maxmem: SCRYPT.maxmem }, (e, k) => e ? reject(e) : resolve(k)));
  const d = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(ks.iv, 'base64'));
  d.setAuthTag(Buffer.from(ks.tag, 'base64'));
  try { return Buffer.concat([d.update(Buffer.from(ks.ct, 'base64')), d.final()]); }
  catch { return null; }
}

// The window's share of the data key: the page combines it with the PIN, so the PIN alone (a million possibilities) can't be tried
// against a copy of its storage.
function windowKey(dk) { return Buffer.from(crypto.hkdfSync('sha256', dk, Buffer.alloc(0), Buffer.from('anonchat window storage v1'), 32)); }

module.exports = { load, save, vaultAvailable, vaultName, newDataKey, wrapOs, unwrapOs, wrapPassphrase, unwrapPassphrase, windowKey, MIN_PASSPHRASE };
