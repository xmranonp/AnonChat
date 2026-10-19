// End-to-end test of the real Double Ratchet and X3DH (public/ratchet.js), with no mocking of the crypto: round trips, out-of-order delivery, replay and tamper rejection.
// Run: node tools/crypto-interop-test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pub = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const dir = mkdtempSync(join(tmpdir(), 'ratchet-'));
writeFileSync(join(dir, 'crypto.mjs'), readFileSync(join(pub, 'crypto.js')));
writeFileSync(join(dir, 'ratchet.mjs'),
  readFileSync(join(pub, 'ratchet.js'), 'utf8').replace("'./crypto.js'", "'./crypto.mjs'"));

const {
  genSigningKey, signSPK, verifySPK,
  x3dhInitiator, x3dhResponder,
  initInitiator, initResponder,
  ratchetEncrypt, ratchetDecrypt,
} = await import(pathToFileURL(join(dir, 'ratchet.mjs')).href);
const { b64, text } = await import(pathToFileURL(join(dir, 'crypto.mjs')).href);

let passed = 0, failed = 0;
const ok  = (name, cond) => { cond ? (passed++, console.log('  ✓ ' + name)) : (failed++, console.log('  ✗ ' + name)); };
async function throws(name, fn) {
  try { await fn(); failed++; console.log('  ✗ ' + name + ' (expected throw, got none)'); }
  catch { passed++; console.log('  ✓ ' + name + ' (rejected as expected)'); }
}

const X = { name: 'ECDH', namedCurve: 'P-256' };
async function genDH() {
  const kp = await crypto.subtle.generateKey(X, true, ['deriveBits']);
  return { priv: await crypto.subtle.exportKey('jwk', kp.privateKey),
           pub:  b64.enc(await crypto.subtle.exportKey('raw', kp.publicKey)) };
}
const dec = m => text.fromBytes(m);
const encPT = s => text.toBytes(s);

async function establish({ withOPK }) {
  const aIK = await genDH(), bIK = await genDH();
  const bIKsig = await genSigningKey();
  const bSPK = await genDH();
  const bSPKsig = await signSPK(bIKsig.priv, bSPK.pub);
  const bOPK = withOPK ? await genDH() : null;

  const sigOK = await verifySPK(bIKsig.pub, bSPK.pub, bSPKsig);

  const { sk: skA, ekPub } = await x3dhInitiator(aIK.priv, bIK.pub, bSPK.pub, bOPK ? bOPK.pub : null);
  const alice = await initInitiator(skA, bSPK.pub, { verified: true });

  // Bob: X3DH responder → SK (must equal Alice's) → responder session on his SPK
  const skB = await x3dhResponder(bSPK.priv, bIK.priv, aIK.pub, ekPub, bOPK ? bOPK.priv : null);
  const bob = initResponder(skB, bSPK, { verified: true });

  return { alice, bob, skA, skB, sigOK, tamperSig: bSPKsig, bIKsigPub: bIKsig.pub, bSPKpub: bSPK.pub };
}

const send = async (from, to, msg) => { const m = await ratchetEncrypt(from, encPT(msg)); return dec(await ratchetDecrypt(to, m.header, m.ct)); };

console.log('CRYPTO INTEROP — real ratchet.js\n');

console.log('1. X3DH handshake (with one-time prekey)');
let S = await establish({ withOPK: true });
ok('SPK signature verifies', S.sigOK === true);
ok('Alice SK === Bob SK', b64.enc(S.skA) === b64.enc(S.skB));

console.log('\n2. Round-trips and DH-ratchet turns');
ok('A→B #1', (await send(S.alice, S.bob, 'hello bob')) === 'hello bob');
ok('A→B #2 (same chain)', (await send(S.alice, S.bob, 'still alice')) === 'still alice');
ok('B→A #1 (Bob DH-ratchets)', (await send(S.bob, S.alice, 'hi alice')) === 'hi alice');
ok('A→B #3 (Alice DH-ratchets)', (await send(S.alice, S.bob, 'ratcheted')) === 'ratcheted');
ok('B→A #2', (await send(S.bob, S.alice, 'unicode ✓ 日本語 🔐')) === 'unicode ✓ 日本語 🔐');

console.log('\n3. Out-of-order delivery (deliver 3,1,2)');
S = await establish({ withOPK: true });
const m1 = await ratchetEncrypt(S.alice, encPT('one'));
const m2 = await ratchetEncrypt(S.alice, encPT('two'));
const m3 = await ratchetEncrypt(S.alice, encPT('three'));
ok('receive #3 first', dec(await ratchetDecrypt(S.bob, m3.header, m3.ct)) === 'three');
ok('receive #1 (skipped key)', dec(await ratchetDecrypt(S.bob, m1.header, m1.ct)) === 'one');
ok('receive #2 (skipped key)', dec(await ratchetDecrypt(S.bob, m2.header, m2.ct)) === 'two');

console.log('\n4. Replay / duplicate rejection');
await throws('replaying #1 is rejected', () => ratchetDecrypt(S.bob, m1.header, m1.ct));

console.log('\n5. Tamper rejection');
S = await establish({ withOPK: true });
const t1 = await ratchetEncrypt(S.alice, encPT('authentic'));
const badCtBytes = b64.dec(t1.ct); badCtBytes[0] ^= 0x01;
await throws('flipped ciphertext byte → GCM auth fails', () => ratchetDecrypt(S.bob, t1.header, b64.enc(badCtBytes)));
await throws('tampered header (n) → decrypt fails', () => ratchetDecrypt(S.bob, { ...t1.header, n: 99 }, t1.ct));

console.log('\n6. Skipped-message bound (MAX_SKIP)');
S = await establish({ withOPK: true });
let jump; for (let i = 0; i < 300; i++) jump = await ratchetEncrypt(S.alice, encPT('m' + i));
await throws('gap > MAX_SKIP(256) is rejected', () => ratchetDecrypt(S.bob, jump.header, jump.ct));

console.log('\n7. No one-time prekey (3-DH fallback)');
S = await establish({ withOPK: false });
ok('SK match without OPK', b64.enc(S.skA) === b64.enc(S.skB));
ok('A→B round-trip without OPK', (await send(S.alice, S.bob, 'no opk')) === 'no opk');

console.log('\n8. Wrong-session key does not decrypt');
const S2 = await establish({ withOPK: true });
const x = await ratchetEncrypt(S.alice, encPT('for session 1'));
await throws('other Bob cannot decrypt', () => ratchetDecrypt(S2.bob, x.header, x.ct));

console.log(`\n${failed === 0 ? '✅ PASS' : '❌ FAIL'} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
