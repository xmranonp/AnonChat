// lib/peerdata.js: what other nodes send about themselves is checked before it is stored. Run: node tools/peerdata-test.mjs
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
const require = createRequire(import.meta.url);
const P = require('../lib/peerdata.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else fail++; console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  [' + detail + ']')); };
const raw = async () => Buffer.from(await webcrypto.subtle.exportKey('raw', (await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])).publicKey)).toString('base64');
const K1 = await raw(), K2 = await raw();
// A real identity signing key and its signature over the ratchet (signed pre-) key, as the window makes them (public/ratchet.js).
const sk = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const K3 = Buffer.from(await webcrypto.subtle.exportKey('raw', sk.publicKey)).toString('base64');
const sig = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sk.privateKey, Buffer.from(K2, 'base64'))).toString('base64');
const pic = 'data:image/jpeg;base64,' + Buffer.alloc(30000, 1).toString('base64');

const good = P.identity({ ecdhPub: K1, ratchetPub: K2, ikSigPub: K3, spkSig: sig, opkId: 'a124ccf5-b542-4b1b-8e35-628c9b13903b', opkPub: K3, avatar: pic, bio: 'hi there', name: 'Bob' });
ok('a normal identity is kept whole', good && good.ecdhPub === K1 && good.ratchetPub === K2 && good.ikSigPub === K3 && good.spkSig === sig && good.opkPub === K3 && good.avatar === pic && good.bio === 'hi there');
ok('…without a self-chosen name', good && !('name' in good));
ok('keys that are objects are refused', P.identity({ ecdhPub: { a: 1 }, ratchetPub: ['x'] }) === null);
ok('keys that are not base64 are refused', P.identity({ ecdhPub: K1 + '<', ratchetPub: K2 }) === null);
ok('a missing ratchet key is refused', P.identity({ ecdhPub: K1 }) === null);
ok('a non-object answer is refused', P.identity('x') === null && P.identity(null) === null && P.identity([K1, K2]) === null);
const bad = P.identity({ ecdhPub: K1, ratchetPub: K2, avatar: { toString: 1 }, bio: { x: 1 }, ikSigPub: 5, opkId: 'x', opkPub: 'nope' });
ok('malformed optional fields are dropped, keys kept', bad && bad.avatar === null && bad.bio === null && bad.ikSigPub === null && bad.opkId === null && bad.opkPub === null);
// Keys that only look right: 65 bytes, but not a point on the curve; or the wrong length.
const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64');
ok('a key that is not a point on the curve is refused', P.identity({ ecdhPub: offCurve, ratchetPub: K2 }) === null && P.identity({ ecdhPub: K1, ratchetPub: offCurve }) === null);
ok('a key of the wrong length is refused', P.identity({ ecdhPub: Buffer.alloc(64, 9).toString('base64'), ratchetPub: K2 }) === null);
const forgedSig = P.identity({ ecdhPub: K1, ratchetPub: K2, ikSigPub: K3, spkSig: Buffer.alloc(64, 7).toString('base64') });
ok('a prekey signature that does not verify is dropped', forgedSig && forgedSig.ikSigPub === K3 && forgedSig.spkSig === null);
const otherPrekey = P.identity({ ecdhPub: K1, ratchetPub: K1, ikSigPub: K3, spkSig: sig });
ok('a signature made for another prekey is dropped', otherPrekey && otherPrekey.spkSig === null);
ok('a one-time key off the curve is dropped', P.identity({ ecdhPub: K1, ratchetPub: K2, opkId: 'x1', opkPub: offCurve }).opkPub === null);
ok('a 7 MB picture is dropped', P.picture('data:image/png;base64,' + 'A'.repeat(7 * 1024 * 1024)) === null);
ok('a picture that is not an image data URL is dropped', P.picture('javascript:alert(1)') === null && P.picture('http://x/y.png') === null && P.picture('data:image/svg+xml;base64,PHN2Zz4=') === null);
ok('a long status is cut to 280 characters', P.bio('b'.repeat(300000)).length === 280);
ok('control characters in a status become spaces', P.bio('a\u0000b\nc') === 'a b c');
const prof = P.profile({ avatar: pic, bio: 'x', name: 'Mallory' });
ok('profile keeps picture and status only', prof.avatar === pic && prof.bio === 'x' && !('name' in prof));
ok('profile of garbage is empty', JSON.stringify(P.profile([1])) === '{"avatar":null,"bio":null}');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
