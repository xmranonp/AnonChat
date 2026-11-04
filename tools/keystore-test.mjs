// The data key's keystore (desktop/keystore.js): OS-vault wrapping, passphrase wrapping (right, wrong, too short), switching between them
// without changing the key, a damaged keystore never silently replaced, and Linux's built-in fallback "vault" not counted as one.
// Run: node tools/keystore-test.mjs
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
// The same vault with the asynchronous calls Electron 45 recommends (the synchronous ones are removed in Electron 46). `stale` makes
// decryptStringAsync report shouldReEncrypt, as a vault does after its own key rotated.
const asyncVault = (backend = 'gnome_libsecret', stale = false) => ({
  ...vault(backend),
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (s) => vault(backend).encryptString(s),
  decryptStringAsync: async (b) => ({ result: vault(backend).decryptString(b), shouldReEncrypt: stale }),
});
// An Electron that has removed the synchronous calls: using one of them would throw.
const only46 = (backend = 'gnome_libsecret') => {
  const v = asyncVault(backend);
  const gone = () => { throw new Error('removed in Electron 46'); };
  return { ...v, isEncryptionAvailable: gone, encryptString: gone, decryptString: gone };
};
const dir = mkdtempSync(join(tmpdir(), 'ks-'));

console.log('1. OS vault');
const dk = ks.newDataKey();
await ks.wrapOs(dir, vault(), dk);
const k1 = ks.load(dir);
ok('keystore written, mode os, key not in the clear', k1.mode === 'os' && !readFileSync(join(dir, 'keystore.json'), 'utf8').includes(dk.toString('hex')));
ok('unwraps to the same key', (await ks.unwrapOs(k1, vault())).equals(dk));
ok('Linux without a keyring ("basic_text") is not a vault', (await ks.vaultAvailable(vault('basic_text'))) === false || process.platform !== 'linux');
ok('a real keyring is', (await ks.vaultAvailable(vault('gnome_libsecret'))) === true);

console.log('1b. Asynchronous vault calls (N-13)');
{
  const d2 = mkdtempSync(join(tmpdir(), 'ks-'));
  const dkA = ks.newDataKey();
  await ks.wrapOs(d2, only46(), dkA);
  ok('Electron 46 (no synchronous calls): wrapping works', ks.load(d2).mode === 'os');
  ok('Electron 46: unwrapping works and gives the same key', (await ks.unwrapOs(ks.load(d2), only46())).equals(dkA));
  ok('Electron 46: a real keyring counts, "basic_text" does not',
    (await ks.vaultAvailable(only46('gnome_libsecret'))) === true && ((await ks.vaultAvailable(only46('basic_text'))) === false || process.platform !== 'linux'));
  // A keystore written by 1.0.4 (synchronous encryptString) opens with the asynchronous calls.
  const d3 = mkdtempSync(join(tmpdir(), 'ks-'));
  const dkB = ks.newDataKey();
  writeFileSync(join(d3, 'keystore.json'), JSON.stringify({ v: 1, mode: 'os', wrapped: vault().encryptString(dkB.toString('hex')).toString('base64'), at: 1 }));
  ok('a keystore made by 1.0.4 still opens through the asynchronous calls', (await ks.unwrapOs(ks.load(d3), only46())).equals(dkB));
  // The vault reports an out-of-date wrapping: the key is wrapped again, and still opens.
  const before = readFileSync(join(d3, 'keystore.json'), 'utf8');
  const got = await ks.unwrapOs(ks.load(d3), asyncVault('gnome_libsecret', true), d3);
  const after = JSON.parse(readFileSync(join(d3, 'keystore.json'), 'utf8'));
  ok('shouldReEncrypt: the key is the same and the keystore was written again', got.equals(dkB) && after.mode === 'os' && JSON.stringify(after) !== before);
  ok('...and the rewritten keystore opens', (await ks.unwrapOs(ks.load(d3), only46())).equals(dkB));
  // Re-wrapping that fails changes nothing.
  const d4 = mkdtempSync(join(tmpdir(), 'ks-'));
  writeFileSync(join(d4, 'keystore.json'), readFileSync(join(d3, 'keystore.json')));
  const broken = { ...asyncVault('gnome_libsecret', true), encryptStringAsync: async () => { throw new Error('vault busy'); } };
  ok('a failed re-wrap still gives the key and keeps the keystore', (await ks.unwrapOs(ks.load(d4), broken, d4)).equals(dkB) && ks.load(d4).mode === 'os');
  // A vault whose first answer after a rotation is unusable but whose second is right: the key still opens (never a lock-out).
  {
    let n = 0;
    const flaky = { ...asyncVault('gnome_libsecret', true), decryptStringAsync: async (b) => (++n === 1 ? { result: '', shouldReEncrypt: true } : { result: vault().decryptString(b), shouldReEncrypt: false }) };
    ok('a stale first answer is asked for again, and the key opens', (await ks.unwrapOs(ks.load(d4), flaky, d4)).equals(dkB) && n === 2, n);
  }
  const gone = () => { throw new Error('removed in Electron 46'); };
  let bad = null; try { await ks.unwrapOs(ks.load(d4), { ...only46(), decryptStringAsync: async () => ({ result: 'nothex', shouldReEncrypt: false }) }); } catch (e) { bad = e.message; }
  ok('a vault answer that is not a key is refused (no old call to fall back on)', /invalid key/.test(bad || '') && /async/.test(bad || ''));
  // The reported 1.0.4 -> 1.0.5 case: the asynchronous call fails or answers wrongly, the old call still opens the key.
  ok('async throws, the old call opens the key', (await ks.unwrapOs(ks.load(d4), { ...asyncVault(), decryptStringAsync: async () => { throw new Error('boom'); } })).equals(dkB));
  ok('async answers wrongly, the old call opens the key', (await ks.unwrapOs(ks.load(d4), { ...asyncVault(), decryptStringAsync: async () => ({ result: '', shouldReEncrypt: false }) })).equals(dkB));
  let both = null; try { await ks.unwrapOs(ks.load(d4), { ...asyncVault(), decryptStringAsync: async () => { throw new Error('boom'); }, decryptString: () => { throw new Error('locked'); } }); } catch (e) { both = e.message; }
  ok('both fail: refused, and the reasons are in the message', /boom/.test(both || '') && /locked/.test(both || ''));
}

console.log('1c. Keystores from 1.0.4 on a vault whose asynchronous call cannot open them (seen on Linux, Electron 45.2.2)');
{
  const calls = { sync: 0, async: 0 };
  const mk = (over = {}) => { const v = vault(); return { ...v, isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (x) => Buffer.concat([Buffer.from('A:'), v.encryptString(x)]),
    decryptStringAsync: async (b) => { calls.async++; if (b.slice(0, 2).toString() !== 'A:') throw new Error('Error while decrypting the ciphertext'); return { result: v.decryptString(b.slice(2)), shouldReEncrypt: false }; },
    decryptString: (b) => { calls.sync++; if (b.slice(0, 2).toString() === 'A:') throw new Error('sync cannot read'); return v.decryptString(b); }, ...over }; };
  const rd = (d) => JSON.parse(readFileSync(join(d, 'keystore.json'), 'utf8'));
  const d = mkdtempSync(join(tmpdir(), 'ks-')); const k = ks.newDataKey();
  const old = vault().encryptString(k.toString('hex')).toString('base64');
  writeFileSync(join(d, 'keystore.json'), JSON.stringify({ v: 1, mode: 'os', wrapped: old, at: 1 }));
  ok('1.0.4 keystore opens (old call)', (await ks.unwrapOs(ks.load(d), mk(), d)).equals(k));
  let m = rd(d);
  ok('migrated: new wrapping, earlier one kept as prev, original copied aside', m.wrapped !== old && m.prev === old && readFileSync(join(d, 'keystore.json.pre-async.bak'), 'utf8').includes(old));
  calls.sync = 0;
  ok('next start opens through the asynchronous call alone', (await ks.unwrapOs(ks.load(d), mk(), d)).equals(k) && calls.sync === 0);
  ok('...and prev is dropped once the new wrapping has opened by itself', rd(d).prev === undefined);
  ok('Electron 46 (no synchronous calls) opens it', (await ks.unwrapOs(ks.load(d), mk({ decryptString: undefined, encryptString: undefined, isEncryptionAvailable: undefined })) ).equals(k));
  // The new wrapping fails on a later start: prev still opens the key.
  const d2 = mkdtempSync(join(tmpdir(), 'ks-')); writeFileSync(join(d2, 'keystore.json'), JSON.stringify({ v: 1, mode: 'os', wrapped: old, at: 1 }));
  await ks.unwrapOs(ks.load(d2), mk(), d2);
  ok('new wrapping unreadable later: prev opens the key', (await ks.unwrapOs(ks.load(d2), mk({ decryptStringAsync: async () => { throw new Error('boom'); } }), d2)).equals(k));
  // A wrapping that does not read back is never saved.
  const d3 = mkdtempSync(join(tmpdir(), 'ks-')); writeFileSync(join(d3, 'keystore.json'), JSON.stringify({ v: 1, mode: 'os', wrapped: old, at: 1 }));
  const before = readFileSync(join(d3, 'keystore.json'), 'utf8');
  await ks.unwrapOs(ks.load(d3), mk({ encryptStringAsync: async () => Buffer.from('A:garbage') }), d3);
  ok('async wrapping that does not read back: keystore untouched, no backup', readFileSync(join(d3, 'keystore.json'), 'utf8') === before && !existsSync(join(d3, 'keystore.json.pre-async.bak')));
  ok('a migrated keystore still passes the shape check', (() => { try { ks.load(d2); return true; } catch { return false; } })());
}

console.log('1d. Never a fixed key, never a key left behind');
{
  // A Linux vault whose asynchronous call only has Chromium's fixed key ("v10") while the synchronous one uses the keyring ("v11").
  const v = vault();
  const pre = (p, b) => Buffer.concat([Buffer.from(p), b]);
  const split = (b) => [b.subarray(0, 3).toString(), b.subarray(3)];
  const weakAsync = { ...v, isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (x) => pre('v10', v.encryptString(x)),
    decryptStringAsync: async (b) => { const [p, r] = split(b); if (p !== 'v10') throw new Error('Error while decrypting the ciphertext'); return { result: v.decryptString(r), shouldReEncrypt: false }; },
    encryptString: (x) => pre('v11', v.encryptString(x)),
    decryptString: (b) => { const [p, r] = split(b); if (p !== 'v11') throw new Error('wrong'); return v.decryptString(r); } };
  const linux = process.platform === 'linux';
  const d = mkdtempSync(join(tmpdir(), 'ks-')); const k = ks.newDataKey();
  await ks.wrapOs(d, weakAsync, k);
  const w = Buffer.from(JSON.parse(readFileSync(join(d, 'keystore.json'), 'utf8')).wrapped, 'base64').subarray(0, 3).toString();
  ok('new keystore: a fixed-key ("v10") answer is not kept, the keyring one is', !linux || w === 'v11', w);
  ok('...and it opens', (await ks.unwrapOs(ks.load(d), weakAsync, d)).equals(k));
  const after = JSON.parse(readFileSync(join(d, 'keystore.json'), 'utf8'));
  ok('no migration to a fixed key: keystore unchanged, no prev, no backup', !linux || (Buffer.from(after.wrapped, 'base64').subarray(0, 3).toString() === 'v11' && !after.prev && !existsSync(join(d, 'keystore.json.pre-async.bak'))));
  let threw = false; try { await ks.wrapOs(mkdtempSync(join(tmpdir(), 'ks-')), { ...weakAsync, encryptString: undefined }, k); } catch { threw = true; }
  ok('only a fixed key on offer (Electron 46): nothing written, an error instead', !linux || threw);
  // A keystore an earlier test build migrated to the fixed key: repaired at the next start, back to the keyring.
  const d3 = mkdtempSync(join(tmpdir(), 'ks-'));
  writeFileSync(join(d3, 'keystore.json'), JSON.stringify({ v: 1, mode: 'os', wrapped: (await weakAsync.encryptStringAsync(k.toString('hex'))).toString('base64'), prev: weakAsync.encryptString(k.toString('hex')).toString('base64'), at: 1 }));
  ok('a fixed-key keystore opens', (await ks.unwrapOs(ks.load(d3), weakAsync, d3)).equals(k));
  const r3 = JSON.parse(readFileSync(join(d3, 'keystore.json'), 'utf8'));
  ok('...and is wrapped again by the keyring ("v11")', !linux || Buffer.from(r3.wrapped, 'base64').subarray(0, 3).toString() === 'v11', Buffer.from(r3.wrapped, 'base64').subarray(0, 3).toString());
  ok('...which opens on the next start', (await ks.unwrapOs(ks.load(d3), weakAsync, d3)).equals(k));
  // Opened through prev, migration refused: the working wrapping becomes the main one.
  const d4 = mkdtempSync(join(tmpdir(), 'ks-'));
  writeFileSync(join(d4, 'keystore.json'), JSON.stringify({ v: 1, mode: 'os', wrapped: Buffer.from('broken').toString('base64'), prev: weakAsync.encryptString(k.toString('hex')).toString('base64'), at: 1 }));
  ok('opened through prev, no migration possible: prev becomes the main wrapping', (await ks.unwrapOs(ks.load(d4), weakAsync, d4)).equals(k) && (!linux || JSON.parse(readFileSync(join(d4, 'keystore.json'), 'utf8')).prev === undefined));
  // Passphrase mode removes the OS-wrapped copy a migration kept.
  const d2 = mkdtempSync(join(tmpdir(), 'ks-'));
  writeFileSync(join(d2, 'keystore.json.pre-async.bak'), '{"v":1,"mode":"os","wrapped":"x"}');
  await ks.wrapPassphrase(d2, 'correct horse battery staple', k);
  ok('switching to a passphrase removes keystore.json.pre-async.bak', !existsSync(join(d2, 'keystore.json.pre-async.bak')));
}

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
