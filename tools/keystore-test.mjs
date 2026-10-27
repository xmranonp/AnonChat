// The data key's keystore (desktop/keystore.js): OS-vault wrapping, passphrase wrapping (right, wrong, too short), switching between them
// without changing the key, a damaged keystore never silently replaced, and Linux's built-in fallback "vault" not counted as one.
// Run: node tools/keystore-test.mjs
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ks = require(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'desktop', 'keystore.js'));
let passed = 0, failed = 0;
const ok = (n, c, d = '') => { c ? (passed++, console.log('  ✓ ' + n)) : (failed++, console.log('  ✗ ' + n + (d ? '  [' + d + ']' : ''))); };
// A stand-in vault: encrypts by XOR with a secret only "this user" has.
const secret = Buffer.alloc(64, 7);
const vault = (backend = 'gnome_libsecret') => ({
  isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend,
  encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b, i) => b ^ secret[i % 64])),
  decryptString: (b) => Buffer.from([...b].map((x, i) => x ^ secret[i % 64])).toString(),
});
const dir = mkdtempSync(join(tmpdir(), 'ks-'));

console.log('1. OS vault');
const dk = ks.newDataKey();
ks.wrapOs(dir, vault(), dk);
const k1 = ks.load(dir);
ok('keystore written, mode os, key not in the clear', k1.mode === 'os' && !readFileSync(join(dir, 'keystore.json'), 'utf8').includes(dk.toString('hex')));
ok('unwraps to the same key', ks.unwrapOs(k1, vault()).equals(dk));
ok('Linux without a keyring ("basic_text") is not a vault', ks.vaultAvailable(vault('basic_text')) === false || process.platform !== 'linux');
ok('a real keyring is', ks.vaultAvailable(vault('gnome_libsecret')) === true);

console.log('2. Passphrase');
await ks.wrapPassphrase(dir, 'correct horse battery staple', dk);
const k2 = ks.load(dir);
ok('mode passphrase, scrypt parameters stored', k2.mode === 'passphrase' && k2.kdf.name === 'scrypt' && k2.kdf.N === 131072);
ok('right passphrase gives the same key (switching re-wraps, never re-keys)', (await ks.unwrapPassphrase(k2, 'correct horse battery staple')).equals(dk));
ok('wrong passphrase gives nothing', (await ks.unwrapPassphrase(k2, 'correct horse battery stapler')) === null);
let short = null; try { await ks.wrapPassphrase(dir, 'too short', dk); } catch (e) { short = e.message; }
ok('passphrases under 12 characters are refused', !!short);
const t = Date.now(); await ks.unwrapPassphrase(k2, 'x'.repeat(12)); const ms = Date.now() - t;
ok(`each guess costs real time (${ms} ms)`, ms > 100);

console.log('3. Damage and the window key');
writeFileSync(join(dir, 'keystore.json'), '{ "v": 1, "mode": ');
let threw = false; try { ks.load(dir); } catch { threw = true; }
ok('a damaged keystore throws (the start screen says so) instead of a fresh key', threw);
{
  await ks.wrapPassphrase(dir, 'correct horse battery staple', dk);
  const good = JSON.parse(readFileSync(join(dir, 'keystore.json'), 'utf8'));
  const loads = (o) => { writeFileSync(join(dir, 'keystore.json'), JSON.stringify(o)); try { ks.load(dir); return true; } catch { return false; } };
  const mut = (f) => { const o = JSON.parse(JSON.stringify(good)); f(o); return o; };
  ok('an intact passphrase keystore still loads', loads(good));
  ok('scrypt N not a power of 2 is damage', !loads(mut((o) => { o.kdf.N = 1000; })));
  ok('scrypt N huge is damage (would hang or run out of memory)', !loads(mut((o) => { o.kdf.N = 2 ** 30; })));
  ok('scrypt settings as text are damage', !loads(mut((o) => { o.kdf.N = '131072'; })));
  ok('missing kdf is damage', !loads(mut((o) => { delete o.kdf; })));
  ok('missing salt is damage', !loads(mut((o) => { delete o.kdf.salt; })));
  ok('short iv is damage', !loads(mut((o) => { o.iv = 'AAAA'; })));
  ok('missing tag is damage', !loads(mut((o) => { delete o.tag; })));
  ok('wrong-size ciphertext is damage', !loads(mut((o) => { o.ct = 'AAAA'; })));
  ok('an OS keystore with nothing wrapped is damage', !loads({ v: 1, mode: 'os' }));
}
{
  const { readdirSync } = await import('node:fs');
  writeFileSync(join(dir, 'keystore.json.999.tmp'), 'half a save'); writeFileSync(join(dir, 'other.tmp'), 'not ours');
  await ks.wrapPassphrase(dir, 'correct horse battery staple', dk); ks.load(dir);
  ok('a leftover of an interrupted save is removed on load, other files are not', !readdirSync(dir).includes('keystore.json.999.tmp') && readdirSync(dir).includes('other.tmp'));
}
ok('window key: derived, stable, not the data key', ks.windowKey(dk).equals(ks.windowKey(dk)) && !ks.windowKey(dk).equals(dk));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
