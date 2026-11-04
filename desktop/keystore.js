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

// Electron 45 deprecates the synchronous safeStorage calls (isEncryptionAvailable, encryptString, decryptString) and removes them in 46.
// The asynchronous ones are used whenever they exist; the synchronous ones remain only as a fallback for an Electron without them.
// Data wrapped by the old calls is opened by the new ones (Electron documents this), so existing keystores keep working.
function hasAsync(s) {
  return !!s && typeof s.isAsyncEncryptionAvailable === 'function' && typeof s.encryptStringAsync === 'function' && typeof s.decryptStringAsync === 'function';
}

// Is there a real vault? On Linux, safeStorage falls back to a fixed built-in key ("basic_text") when no keyring is running: that is not
// protection, so it counts as no vault.
async function vaultAvailable(safeStorage) {
  try {
    const available = hasAsync(safeStorage) ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
    if (!available) return false;
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

// On Linux, Chromium marks with "v10" what it encrypted with its fixed built-in key (the "basic_text" fallback): no protection at all. The
// asynchronous call can do that even when the synchronous one uses the keyring ("v11"), so its answer is checked before it is kept.
function weakBlob(b) { return process.platform === 'linux' && Buffer.from(b).subarray(0, 3).toString('latin1') === 'v10'; }
// The key wrapped by the vault: the asynchronous call when it gives real protection, otherwise the synchronous one (Electron 45), otherwise
// an error (no keystore is written that a fixed key opens).
async function osWrap(safeStorage, hex) {
  if (hasAsync(safeStorage)) {
    try { const b = Buffer.from(await safeStorage.encryptStringAsync(hex)); if (!weakBlob(b)) return { blob: b, async: true }; } catch {}
  }
  if (typeof safeStorage.encryptString === 'function') {
    const b = Buffer.from(safeStorage.encryptString(hex));
    if (!weakBlob(b)) return { blob: b, async: false };
  }
  throw new Error('the system vault would only use a fixed key');
}
async function wrapOs(dir, safeStorage, dk) {
  const { blob } = await osWrap(safeStorage, dk.toString('hex'));
  save(dir, { v: 1, mode: 'os', wrapped: blob.toString('base64'), at: Date.now() });
}
// The data key. Order of attempts, so that a key the vault can still give is never refused:
//   1. the asynchronous call on `wrapped` (the only call left in Electron 46);
//   2. the synchronous call on `wrapped` (how 1.0.4 wrapped it: on Linux, Electron 45's asynchronous call cannot always open that);
//   3. the same two on `prev`, the earlier wrapping kept by a migration.
// When only a synchronous call worked, the key is wrapped again with the asynchronous call (see migrate), so that Electron 46 can open it.
// When the vault says the wrapping is out of date, it is wrapped again in place. Re-wrapping that fails changes nothing.
async function unwrapOs(ks, safeStorage, dir) {
  const isKey = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);
  const why = [];
  const viaAsync = async (blob, tag) => {
    if (!hasAsync(safeStorage)) return null;
    try {
      let r = await safeStorage.decryptStringAsync(blob);
      let hex = r && r.result; const stale = !!(r && r.shouldReEncrypt);
      if (stale && !isKey(hex)) { r = await safeStorage.decryptStringAsync(blob); hex = r && r.result; }   // asked again only when unusable
      if (isKey(hex)) return { hex, stale };
      why.push(tag + ' async: answer is not a key');
    } catch (e) { why.push(tag + ' async: ' + (e && e.message || e)); }
    return null;
  };
  const viaSync = (blob, tag) => {
    if (typeof safeStorage.decryptString !== 'function') return null;
    try { const hex = safeStorage.decryptString(blob); if (isKey(hex)) return { hex, stale: false }; why.push(tag + ' sync: answer is not a key'); }
    catch (e) { why.push(tag + ' sync: ' + (e && e.message || e)); }
    return null;
  };
  const blob = Buffer.from(ks.wrapped, 'base64');
  let got = await viaAsync(blob, 'wrapped'), via = 'async';
  if (!got) {
    got = viaSync(blob, 'wrapped'); via = 'sync';
    if (got) { try { console.warn('[keystore] asynchronous unlock did not work (' + why.join('; ') + '); using the synchronous call'); } catch {} }
  }
  if (!got && typeof ks.prev === 'string' && ks.prev) {
    const pb = Buffer.from(ks.prev, 'base64');
    got = (await viaAsync(pb, 'prev')) || viaSync(pb, 'prev'); via = 'prev';
  }
  if (!got) {
    const err = new Error('vault returned an invalid key (' + (why.join('; ') || 'no answer') + ')');
    try { console.error('[keystore] ' + err.message); } catch {}
    throw err;
  }
  const dk = Buffer.from(got.hex, 'hex');
  if (dir) {
    try {
      if (via === 'async' && (got.stale || weakBlob(blob))) await wrapOs(dir, safeStorage, dk);   // out of date, or only a fixed key: wrapped again properly
      else if (via === 'async' && ks.prev) save(dir, { v: 1, mode: 'os', wrapped: ks.wrapped, at: ks.at || Date.now() });   // the new wrapping opened by itself: `prev` is done
      else if (via !== 'async') {
        const moved = await migrate(dir, ks, safeStorage, dk, via === 'prev' ? ks.prev : ks.wrapped);
        if (!moved && via === 'prev') save(dir, { v: 1, mode: 'os', wrapped: ks.prev, at: Date.now() });   // keep the wrapping that works
      }
    } catch {}
  }
  return dk;
}
// Wraps the key with the asynchronous call, but only if that wrapping is read back to the same key right now. The earlier wrapping is kept
// as `prev` (opened by unwrapOs if the new one ever fails), and the original file is copied once to keystore.json.pre-async.bak.
async function migrate(dir, ks, safeStorage, dk, goodBlob) {
  if (!hasAsync(safeStorage)) return false;
  const hex = dk.toString('hex');
  const blob2 = Buffer.from(await safeStorage.encryptStringAsync(hex));
  if (weakBlob(blob2)) { try { console.warn('[keystore] not migrating: the asynchronous call would use a fixed key, not the keyring'); } catch {} return false; }
  const r = await safeStorage.decryptStringAsync(blob2);
  if (!r || r.result !== hex) return false;                             // does not read back: leave the keystore as it is
  const bak = file(dir) + '.pre-async.bak';
  if (!fs.existsSync(bak)) fs.copyFileSync(file(dir), bak);
  save(dir, { v: 1, mode: 'os', wrapped: blob2.toString('base64'), prev: goodBlob, at: Date.now() });
  return true;
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
  // The copy kept by a migration holds the key wrapped by the OS vault: left behind, it would open the data without the passphrase.
  try { fs.unlinkSync(file(dir) + '.pre-async.bak'); } catch {}
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
