// The sealing of mailbox drops (lib/swarm/hpke.js, lib/swarm/seal.js; design section 6). The release gate: RFC 9180's P-256 example
// and the CFRG test vector for the exact suite (tools/hpke-p256-aes256-vector.json) through the same code, swarm-vectors.json (made by the mailbox peer; both sides test against it), a second implementation in both
// directions (WebCrypto here: other code for every step), and the failure cases. With MAILBOX_PEER_DIR set to a mailbox-peer source
// folder, also the peer's own code in both directions. Run: node tools/swarm-seal-test.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { webcrypto as wc } from 'node:crypto';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(import.meta.url);
const H = require(join(APP, 'lib/swarm/hpke.js')), S = require(join(APP, 'lib/swarm/seal.js'));
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + x + ']')); };
const throws = (m, f) => { try { f(); ok(m, false, 'did not throw'); } catch { ok(m, true); } };
const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex'), eq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

console.log('1. RFC 9180 A.3.1 (DHKEM(P-256), HKDF-SHA256, AES-128-GCM): the same code, every intermediate value');
{
  const A = { info: hex('4f6465206f6e2061204772656369616e2055726e'), skRm: hex('f3ce7fdae57e1a310d87f1ebbde6f328be0a99cdbcadf4d6589cf29de4b8ffd2'),
    skEm: hex('4995788ef4b9d6132b249ce59a77281493eb39af373d236a1fe415cb0c2d7beb'),
    pkRm: hex('04fe8c19ce0905191ebc298a9245792531f26f0cece2460639e8bc39cb7f706a826a779b4cf969b8a0e539c7f62fb3d30ad6aa8f80e30f1d128aafd68a2ce72ea0'),
    enc: hex('04a92719c6195d5085104f469a8b9814d5838ff72b60501e2c4466e5e67b325ac98536d7b61a1af4b78e5b7f951c0900be863c403ce65c9bfcb9382657222d18c4'),
    shared: hex('c0d26aeab536609a572b07695d933b589dcf363ff9d93c93adea537aeabb8cb8'),
    key: hex('868c066ef58aae6dc589b6cfdd18f97e'), nonce: hex('4e0bc5018beba4bf004cca59'),
    pt: hex('4265617574792069732074727574682c20747275746820626561757479'), aad: hex('436f756e742d30'),
    ct: hex('5ad590bb8baa577f8619db35a36311226a896e7342a6d836d8b7bcd2f20b6c7f9076ac232e3ab2523f39513434') };
  ok('the recipient\'s public key', eq(H.publicKeyOf(A.skRm), A.pkRm));
  const e = H.encap(A.pkRm, A.skEm);
  ok('enc and the shared secret', eq(e.enc, A.enc) && eq(e.shared, A.shared));
  const ks = H.keySchedule(H.AEAD_AES128, e.shared, A.info);
  ok('key and base nonce', eq(ks.key, A.key) && eq(ks.nonce, A.nonce));
  const s = H.seal(A.pkRm, A.info, A.aad, A.pt, { aeadId: H.AEAD_AES128, skE: A.skEm });
  ok('the first ciphertext', eq(s.ct, A.ct));
  ok('…and it opens', eq(H.open(A.skRm, s.enc, A.info, A.aad, s.ct, { aeadId: H.AEAD_AES128 }), A.pt));
}

console.log('1b. The CFRG test vector for the exact suite used: DHKEM(P-256), HKDF-SHA256, AES-256-GCM, all 257 encryptions');
{
  const C = JSON.parse(readFileSync(join(APP, 'tools/hpke-p256-aes256-vector.json'), 'utf8'));
  ok('it is that suite, base mode', C.mode === 0 && C.kem_id === 16 && C.kdf_id === 1 && C.aead_id === 2 && H.AEAD_AES256 === 2);
  ok('the recipient\'s and the ephemeral public keys', eq(H.publicKeyOf(hex(C.skRm)), hex(C.pkRm)) && eq(H.publicKeyOf(hex(C.skEm)), hex(C.pkEm)));
  const e = H.encap(hex(C.pkRm), hex(C.skEm));
  ok('enc and the shared secret', eq(e.enc, hex(C.enc)) && eq(e.shared, hex(C.shared_secret)));
  ok('decap gives the same shared secret', eq(H.decap(hex(C.enc), hex(C.skRm)), hex(C.shared_secret)));
  const ks = H.keySchedule(H.AEAD_AES256, e.shared, hex(C.info));
  ok('key schedule context, secret, key and base nonce', eq(ks.ctx, hex(C.key_schedule_context)) && eq(ks.secret, hex(C.secret)) && eq(ks.key, hex(C.key)) && eq(ks.nonce, hex(C.base_nonce)));
  const first = C.encryptions[0];
  const s0 = H.seal(hex(C.pkRm), hex(C.info), hex(first.aad), hex(first.pt), { skE: hex(C.skEm) });
  ok('the first encryption through seal(), byte for byte', eq(s0.enc, hex(C.enc)) && eq(s0.ct, hex(first.ct)));
  ok('…and open() gives the plaintext', eq(H.open(hex(C.skRm), hex(C.enc), hex(C.info), hex(first.aad), hex(first.ct)), hex(first.pt)));
  const { createCipheriv } = await import('node:crypto');
  let all = true;
  C.encryptions.forEach((x, seq) => {
    const nonce = Buffer.from(ks.nonce); const sb = Buffer.alloc(12); sb.writeBigUInt64BE(BigInt(seq), 4);
    for (let i = 0; i < 12; i++) nonce[i] ^= sb[i];
    const c = createCipheriv('aes-256-gcm', ks.key, nonce); c.setAAD(hex(x.aad));
    if (!eq(Buffer.concat([c.update(hex(x.pt)), c.final(), c.getAuthTag()]), hex(x.ct))) all = false;
  });
  ok('all 257 encryptions, with the key and nonce from our key schedule', all);
}

console.log('2. swarm-vectors.json (from the mailbox peer)');
const V = JSON.parse(readFileSync(join(APP, 'tools/swarm-vectors.json'), 'utf8'));
{
  ok('size steps', JSON.stringify(S.STEPS) === JSON.stringify(V.steps));
  ok('seal label', S.SEAL_INFO.toString() === V.sealInfo);
  ok('lp()', V.lp.every((x) => S.lp(x.in).toString('hex') === x.out));
  ok('u64()', V.u64.every((x) => S.u64(x.in).toString('hex') === x.out));
  const pk = hex(V.recipient.pk), sk = hex(V.recipient.sk);
  ok('kid input and kid', Buffer.concat([S.lp('anonchat swarm kid'), S.lp(V.peerAddress), S.lp(pk)]).toString('hex') === V.kidInput && S.kidOf(V.peerAddress, pk) === V.kid);
  for (const k of ['token', 'ownerSecret']) ok(`${k}: base64url and hash`, S.b64u(hex(V[k].raw)) === V[k].base64url && S.sha256hex(S.fromB64u(V[k].base64url)) === V[k].hash);
  const d = V.drop, ours = S.sealDrop({ env: d.env, peerAddress: V.peerAddress, pk, expiry: d.expiry, skE: hex(d.ephemeralSk) });
  ok('the sealed drop, byte for byte (fixed ephemeral key)', ours.body.toString('hex') === d.body && ours.size === d.size);
  ok('its aad', S.sealAad(V.peerAddress, V.kid, d.expiry, d.size).toString('hex') === d.aad);
  ok('the published drop opens to the published envelope', JSON.stringify(S.openDrop({ body: hex(d.body), peerAddress: V.peerAddress, sk, pk, expiry: d.expiry })) === JSON.stringify(d.env));
}

console.log('3. A second implementation (WebCrypto: its own ECDH, HMAC and AES-GCM), both directions');
const subtle = wc.subtle, te = (s) => Buffer.from(s, 'latin1');
const cat = (...a) => Buffer.concat(a.map((x) => Buffer.from(x)));
const i2 = (n) => Buffer.from([(n >> 8) & 255, n & 255]);
async function hmac(key, data) { const k = await subtle.importKey('raw', key.length ? key : new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return Buffer.from(await subtle.sign('HMAC', k, data)); }
async function expand(prk, info, L) { let t = Buffer.alloc(0), out = Buffer.alloc(0); for (let i = 1; out.length < L; i++) { t = await hmac(prk, cat(t, info, [i])); out = cat(out, t); } return out.subarray(0, L); }
const KEM = cat(te('KEM'), i2(0x10)), SUITE = cat(te('HPKE'), i2(0x10), i2(1), i2(2));
const lx = (suite, salt, label, ikm) => hmac(salt, cat(te('HPKE-v1'), suite, te(label), ikm));
const le = (suite, prk, label, info, L) => expand(prk, cat(i2(L), te('HPKE-v1'), suite, te(label), info), L);
const b64url = (b) => Buffer.from(b).toString('base64url');
async function ecdh(skRaw, pkPeer) {
  const pkSelf = H.publicKeyOf(skRaw);          // only to fill in the JWK's x and y; the key agreement itself is WebCrypto's
  const priv = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: b64url(skRaw), x: b64url(pkSelf.subarray(1, 33)), y: b64url(pkSelf.subarray(33)) }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = await subtle.importKey('raw', pkPeer, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return Buffer.from(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
}
async function schedule(shared, info) {
  const ctx = cat([0], await lx(SUITE, Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0)), await lx(SUITE, Buffer.alloc(0), 'info_hash', info));
  const secret = await lx(SUITE, shared, 'secret', Buffer.alloc(0));
  return { key: await le(SUITE, secret, 'key', ctx, 32), nonce: await le(SUITE, secret, 'base_nonce', ctx, 12) };
}
async function wcSeal(pkR, info, aad, pt) {
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const enc = Buffer.from(await subtle.exportKey('raw', eph.publicKey));
  const pub = await subtle.importKey('raw', pkR, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const dh = Buffer.from(await subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256));
  const shared = await le(KEM, await lx(KEM, Buffer.alloc(0), 'eae_prk', dh), 'shared_secret', cat(enc, pkR), 32);
  const { key, nonce } = await schedule(shared, info);
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  return { enc, ct: Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, k, pt)) };
}
async function wcOpen(skR, enc, info, aad, ct) {
  const dh = await ecdh(skR, enc);
  const shared = await le(KEM, await lx(KEM, Buffer.alloc(0), 'eae_prk', dh), 'shared_secret', cat(enc, H.publicKeyOf(skR)), 32);
  const { key, nonce } = await schedule(shared, info);
  const k = await subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  return Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, k, ct));
}
{
  let a2b = true, b2a = true;
  for (const n of [0, 1, 100, 5000, 70000]) {
    const pt = Buffer.alloc(n, 7), info = S.SEAL_INFO, aad = Buffer.from('aad ' + n);
    const r = H.generateKeyPair(); const s = H.seal(r.pk, info, aad, pt);
    try { if (!eq(await wcOpen(r.sk, s.enc, info, aad, s.ct), pt)) a2b = false; } catch { a2b = false; }
    const r2 = H.generateKeyPair(); const w = await wcSeal(r2.pk, info, aad, pt);
    try { if (!eq(H.open(r2.sk, w.enc, info, aad, w.ct), pt)) b2a = false; } catch { b2a = false; }
  }
  ok('ours sealed, WebCrypto opens (with aad)', a2b);
  ok('WebCrypto sealed, ours opens (with aad)', b2a);
  const d = V.drop; let opened = false;
  try { const body = hex(d.body); const pt = await wcOpen(hex(V.recipient.sk), body.subarray(0, 65), S.SEAL_INFO, hex(d.aad), body.subarray(65)); opened = JSON.parse(pt.subarray(4, 4 + pt.readUInt32BE(0)).toString()).env.text === d.env.text; } catch {}
  ok('WebCrypto opens the published sealed drop too', opened);
}

console.log('4. Failure cases: bad keys, damaged data, wrong labels');
{
  const { sk, pk } = H.generateKeyPair(), info = Buffer.from('info'), aad = Buffer.from('aad'), pt = Buffer.from('hello');
  const { enc, ct } = H.seal(pk, info, aad, pt);
  const flip = (b, i) => { const c = Buffer.from(b); c[i] ^= 1; return c; };
  throws('a changed ciphertext byte', () => H.open(sk, enc, info, aad, flip(ct, 0)));
  throws('a changed tag', () => H.open(sk, enc, info, aad, flip(ct, ct.length - 1)));
  throws('a changed enc', () => H.open(sk, flip(enc, 5), info, aad, ct));
  throws('another label (info)', () => H.open(sk, enc, Buffer.from('other'), aad, ct));
  throws('another aad', () => H.open(sk, enc, info, Buffer.from('other'), ct));
  throws('another key', () => H.open(H.generateKeyPair().sk, enc, info, aad, ct));
  throws('too short', () => H.open(sk, enc, info, aad, ct.subarray(0, 10)));
  throws('a point not on the curve (open)', () => H.open(sk, Buffer.alloc(65, 4), info, aad, ct));
  throws('a point not on the curve (seal)', () => H.seal(Buffer.alloc(65, 4), info, aad, pt));
  const addr = 'a'.repeat(56) + '.anyone', other = 'b'.repeat(56) + '.anyone', expiry = 1800000000;
  const d = S.sealDrop({ env: { t: 'x' }, peerAddress: addr, pk, expiry });
  ok('a small envelope takes the 4 KiB step', d.size === 4096 && d.body.length === 4096);
  throws('the drop at another peer address', () => S.openDrop({ body: d.body, peerAddress: other, sk, pk, expiry }));
  throws('the drop with another expiry', () => S.openDrop({ body: d.body, peerAddress: addr, sk, pk, expiry: expiry + 3600 }));
  throws('the drop cut to another size', () => S.openDrop({ body: d.body.subarray(0, 4000), peerAddress: addr, sk, pk, expiry }));
  throws('the drop padded to the next step', () => S.openDrop({ body: Buffer.concat([d.body, Buffer.alloc(65536 - 4096)]), peerAddress: addr, sk, pk, expiry }));
  throws('an expiry that isn\'t whole hours is never sealed', () => S.sealDrop({ env: { t: 'x' }, peerAddress: addr, pk, expiry: expiry + 1 }));
  throws('too big for 8 MiB', () => S.sealDrop({ env: { t: 'x'.repeat(8 * 1048576) }, peerAddress: addr, pk, expiry }));
  ok('size steps: 64 KiB, 512 KiB, 8 MiB', S.sealDrop({ env: { x: 'y'.repeat(4000) }, peerAddress: addr, pk, expiry }).size === 65536
    && S.sealDrop({ env: { x: 'y'.repeat(70000) }, peerAddress: addr, pk, expiry }).size === 524288
    && S.sealDrop({ env: { x: 'y'.repeat(8 * 1048576 - 200) }, peerAddress: addr, pk, expiry }).size === 8388608);
  // the checks after decryption, on genuine ciphertext (a broken sealer, not damage on the way: the AEAD can't catch these)
  const sealRaw = (json, padByte = 0, lenAdj = 0) => {
    const size = 4096, pt = Buffer.alloc(size - 81, padByte), j = Buffer.from(json); pt.writeUInt32BE(j.length + lenAdj, 0); j.copy(pt, 4);
    const kid = S.kidOf(addr, pk); const { enc, ct } = H.seal(pk, S.SEAL_INFO, S.sealAad(addr, kid, expiry, size), pt); return Buffer.concat([enc, ct]);
  };
  const opens = (b) => { try { return S.openDrop({ body: b, peerAddress: addr, sk, pk, expiry }); } catch (e) { return e; } };
  ok('a well-made drop opens (the control for the cases below)', opens(sealRaw('{"v":1,"env":{"a":1}}')).a === 1);
  ok('a length beyond the plaintext: refused', opens(sealRaw('{"v":1,"env":{}}', 0, 5000)) instanceof Error);
  ok('padding that isn\'t zero: refused', opens(sealRaw('{"v":1,"env":{}}', 0x20)) instanceof Error);
  ok('another version: refused', opens(sealRaw('{"v":2,"env":{}}')) instanceof Error);
  ok('an envelope that isn\'t an object: refused', opens(sealRaw('{"v":1,"env":[1]}')) instanceof Error && opens(sealRaw('{"v":1,"env":"x"}')) instanceof Error);
  ok('whitespace around the JSON: refused (one encoding only)', opens(sealRaw(' {"v":1,"env":{}}')) instanceof Error && opens(sealRaw('{"v":1,"env":{}} ')) instanceof Error);
  ok('unreadable JSON: refused', opens(sealRaw('{"v":1,"env":{')) instanceof Error);
  const pr = opens(sealRaw('{"v":1,"env":{"__proto__":{"x":1},"a":2}}'));
  ok('an own "__proto__" key doesn\'t come out', pr.a === 2 && !Object.prototype.hasOwnProperty.call(pr, '__proto__') && Object.getPrototypeOf(pr) === Object.prototype);
  throws('an expiry that isn\'t whole hours is refused when opening too', () => S.openDrop({ body: d.body, peerAddress: addr, sk, pk, expiry: 1.5 }));
  throws('a minimum step beyond 8 MiB', () => S.sealDrop({ env: { t: 'x' }, peerAddress: addr, pk, expiry, minStep: 9 * 1048576 }));
  ok('expiryAfter gives whole hours', S.expiryAfter(86400, Date.parse('2026-11-22T10:17:00Z')) % 3600 === 0);
}

const PEER = process.env.MAILBOX_PEER_DIR;
if (PEER && existsSync(join(PEER, 'lib/seal.mjs'))) {
  console.log('5. The mailbox peer\'s own code, both directions');
  const P = await import(pathToFileURL(join(PEER, 'lib/seal.mjs')).href), PH = await import(pathToFileURL(join(PEER, 'lib/hpke.mjs')).href);
  const addr = 'c'.repeat(56) + '.anyone', expiry = 1800003600;
  const r = H.generateKeyPair(), env = { from: 'z'.repeat(56) + '.anyone', ct: 'AAAA', dh: 'x', n: 1, pn: 0, stamp: 's' };
  const ours = S.sealDrop({ env, peerAddress: addr, pk: r.pk, expiry });
  ok('the peer\'s code opens what the app sealed', JSON.stringify(P.openDrop({ body: ours.body, peerAddress: addr, sk: r.sk, pk: r.pk, expiry })) === JSON.stringify(env));
  const r2 = PH.generateKeyPair(); const theirs = P.sealDrop({ env, peerAddress: addr, pk: r2.pk, expiry });
  ok('the app opens what the peer\'s code sealed', JSON.stringify(S.openDrop({ body: theirs.body, peerAddress: addr, sk: r2.sk, pk: r2.pk, expiry })) === JSON.stringify(env));
  ok('the same kid on both sides', P.kidOf(addr, r.pk) === S.kidOf(addr, r.pk));
} else console.log('5. (the mailbox peer\'s own code: set MAILBOX_PEER_DIR to a mailbox-peer source folder to run it)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
