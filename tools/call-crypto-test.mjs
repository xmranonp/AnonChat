// The call crypto (public/call.js) in Node's WebCrypto: key agreement, directional keys, tamper/replay-proof frames, constant-size padding.
import fs from 'node:fs';
// public/ has no package.json "type": "module", so the browser module is loaded from its source text.
const src = fs.readFileSync(new URL('../public/call.js', import.meta.url), 'utf8');
const { __test: C } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => { cond ? passed++ : (failed++, console.log(`FAIL ${name} ${extra}`)); };
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));

const id = rnd(16);
const caller = await C.newKeyPair(), callee = await C.newKeyPair();
ok('ephemeral private keys are not extractable', caller.priv.extractable === false && callee.priv.extractable === false);
const k1 = await C.deriveKeys(caller.priv, callee.pub, id, caller.pub, callee.pub, 'caller');
const k2 = await C.deriveKeys(callee.priv, caller.pub, id, caller.pub, callee.pub, 'callee');

const msg = rnd(128);
const f = await C.seal(k1.send, id, 1, 0, msg);
const r = await C.unseal(k2.recv, id, f);
ok('caller -> callee frame opens', r && r.type === 1 && r.seq === 0 && Buffer.compare(Buffer.from(r.plain), Buffer.from(msg)) === 0);
const g = await C.seal(k2.send, id, 2, 7, msg);
const r2 = await C.unseal(k1.recv, id, g);
ok('callee -> caller frame opens', r2 && r2.type === 2 && r2.seq === 7);
ok('a frame cannot be opened with the sender\'s own key (directions are separate keys)', (await C.unseal(k1.recv, id, f)) === null);

// tamper with every byte position class
let allRejected = true;
for (const pos of [0, 1, 4, 8, 9, 20, f.length - 17, f.length - 1]) { const t = f.slice(); t[pos] ^= 1; if (await C.unseal(k2.recv, id, t)) { allRejected = false; console.log('accepted a frame altered at', pos); } }
ok('a frame altered anywhere (type, counter, body, tag) is rejected', allRejected);
ok('a truncated frame is rejected', (await C.unseal(k2.recv, id, f.slice(0, 20))) === null);
ok('a frame for another call id is rejected', (await C.unseal(k2.recv, rnd(16), f)) === null);

const a1 = await C.seal(k1.send, id, 1, 1, msg), a2 = await C.seal(k1.send, id, 1, 2, msg);
ok('the same audio under two counters gives different ciphertext (no nonce reuse)', Buffer.compare(Buffer.from(a1.slice(9)), Buffer.from(a2.slice(9))) !== 0);

// a different call (fresh ephemeral keys) cannot read this one
const c3 = await C.newKeyPair(), c4 = await C.newKeyPair();
const k3 = await C.deriveKeys(c4.priv, c3.pub, id, c3.pub, c4.pub, 'callee');
ok('keys of another call cannot open the frame', (await C.unseal(k3.recv, id, f)) === null);
// a man in the middle with his own key gets different keys
const mitm = await C.newKeyPair();
const km = await C.deriveKeys(mitm.priv, caller.pub, id, caller.pub, callee.pub, 'callee');
ok('someone who swaps in his own key cannot open the frame', (await C.unseal(km.recv, id, f)) === null);

// invalid peer keys
for (const [name, pub] of [['short', rnd(10)], ['zeros', new Uint8Array(65)], ['not on the curve', (() => { const p = callee.pub.slice(); p[40] ^= 0xff; return p; })()]]) {
  let threw = false; try { await C.deriveKeys(caller.priv, pub, id, caller.pub, pub, 'caller'); } catch { threw = true; }
  ok('a malformed peer key is refused: ' + name, threw);
}

// constant-size audio frames, so the length of a frame says nothing about the speech in it
const sizes = new Set();
for (let n = 20; n <= 122; n++) sizes.add(C.padAudio(0, rnd(n)).length);
ok('opus packets of 20..122 bytes all travel in one frame size', sizes.size === 1 && [...sizes][0] === 128, JSON.stringify([...sizes]));
const big = rnd(300); const back = C.unpadAudio(C.padAudio(42, big));
ok('padding round-trips', back && back.idx === 42 && Buffer.compare(Buffer.from(back.opus), Buffer.from(big)) === 0);
ok('a bad length field is rejected', C.unpadAudio(new Uint8Array(128).fill(255)) === null);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
