// Identity backups: the file format (public/backup.js) and the backend's restore (server.js /api/backup/hs, /api/restore).
// Run: node tools/backup-test.mjs   (the backend part needs `npm install`)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, webcrypto } from 'node:crypto';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
// public/*.js are browser modules; the project itself is CommonJS, so load a copy with the .mjs extension.
const tmpMod = join(mkdtempSync(join(tmpdir(), 'bk-mod-')), 'backup.mjs');
writeFileSync(tmpMod, readFileSync(join(APP, 'public/backup.js')));
const B = await import(pathToFileURL(tmpMod).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else fail++; console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  [' + detail + ']')); };
const rejects = async (p, code) => { try { await p; return false; } catch (e) { return !code || e.code === code; } };

// A hidden-service key whose public half matches the address (the first 32 bytes of the base32 address).
const A32 = 'abcdefghijklmnopqrstuvwxyz234567';
function b32(bytes) { let bits = 0, val = 0, out = ''; for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += A32[(val << (5 - bits)) & 31]; return out; }
function hsKey() {
  const pub = randomBytes(32);
  const address = b32(Buffer.concat([pub, randomBytes(3)])).slice(0, 56) + '.anyone';
  const head = (s) => { const h = Buffer.alloc(32); h.write(s); return h; };
  return { address, secret: Buffer.concat([head('== ed25519v1-secret: type0 =='), randomBytes(64)]), public: Buffer.concat([head('== ed25519v1-public: type0 =='), pub]) };
}
async function jwkPair(alg) {
  const kp = await webcrypto.subtle.generateKey(alg, true, alg.name === 'ECDSA' ? ['sign', 'verify'] : ['deriveBits']);
  return { priv: await webcrypto.subtle.exportKey('jwk', kp.privateKey), pub: Buffer.from(await webcrypto.subtle.exportKey('raw', kp.publicKey)).toString('base64') };
}
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const key = hsKey();
const ik = await jwkPair(EC), spk = await jwkPair(EC), sig = await jwkPair({ name: 'ECDSA', namedCurve: 'P-256' });
const FRIEND = 'f'.repeat(56) + '.anyone', MEMBER = 'm'.repeat(56) + '.anyone';
const payload = B.buildPayload({
  address: key.address,
  hs: { secret: key.secret.toString('base64'), public: key.public.toString('base64'), hostname: key.address },
  identity: { ikPriv: ik.priv, ikPub: ik.pub, spk, ikSig: sig },
  contacts: [{ address: FRIEND, petname: 'Friend', ecdhPub: (await jwkPair(EC)).pub, ratchetPub: (await jwkPair(EC)).pub, opkId: 'x', opkPub: 'y', online: true, lastSeen: 1, avatar: 'data:image/jpeg;base64,AAAA' }],
  peers: [{ address: MEMBER, ecdhPub: (await jwkPair(EC)).pub, ratchetPub: (await jwkPair(EC)).pub, avatar: 'data:image/jpeg;base64,AAAA' }],
  groups: [{ id: 'g1', name: 'G', members: [{ address: key.address }, { address: FRIEND }, { address: MEMBER }], adminAddr: key.address }],
  blocked: ['b'.repeat(56) + '.anyone'],
  settings: { acceptRequests: false, powAlways: false, readReceipts: true, blockedCount: 4 },
  profile: { avatar: null, bio: 'hi' },
});

console.log('Backup file');
ok('a payload with everything checks clean', B.checkPayload(payload).length === 0, B.checkPayload(payload));
ok('one-time prekeys and presence are left out', !('opkId' in payload.contacts[0]) && !('online' in payload.contacts[0]));
ok('contacts’ and group members’ pictures are left out', !('avatar' in payload.contacts[0]) && !('avatar' in payload.peers[0]));
{
  const withOld = B.buildPayload({ address: key.address, hs: { secret: 'a', public: 'b', hostname: key.address },
    identity: { ikPriv: ik.priv, ikPub: ik.pub, spk: { ...spk, created: 5, old: [{ ...(await jwkPair(EC)), retired: 4 }] }, ikSig: sig } });
  ok('retired signed prekeys are left out: only the current one goes in', JSON.stringify(Object.keys(withOld.identity.spk).sort()) === '["created","priv","pub"]'
    && withOld.identity.spk.pub === spk.pub, JSON.stringify(Object.keys(withOld.identity.spk)));
}
ok('only the three settings go in', JSON.stringify(Object.keys(payload.settings).sort()) === '["acceptRequests","powAlways","readReceipts"]');
const PW = 'correct horse battery staple';
const file = await B.encryptBackup(payload, PW, { iterations: 100_000 });
const outer = JSON.parse(new TextDecoder().decode(file));
ok('the outer file names nothing about whose it is', !new TextDecoder().decode(file).includes(key.address.slice(0, 20)) && outer.format === 'anonchat-backup' && outer.v === 1 && outer.kdf.name === 'PBKDF2');
const back = await B.decryptBackup(file, PW);
ok('decrypts back to the same payload', JSON.stringify(back) === JSON.stringify(payload));
ok('a wrong passphrase is refused', await rejects(B.decryptBackup(file, PW + 'x'), 'wrong_passphrase'));
const tampered = JSON.parse(new TextDecoder().decode(file)); tampered.ct = tampered.ct.slice(0, -8) + 'AAAAAAA=';
ok('a changed file is refused', await rejects(B.decryptBackup(new TextEncoder().encode(JSON.stringify(tampered)), PW), 'wrong_passphrase'));
ok('a file that isn’t a backup is refused', await rejects(B.decryptBackup(new TextEncoder().encode('{"hello":1}'), PW), 'not_backup'));
ok('random bytes are refused', await rejects(B.decryptBackup(randomBytes(500), PW), 'not_backup'));
const newer = { ...outer, v: 2 };
ok('a newer format version says so', await rejects(B.decryptBackup(new TextEncoder().encode(JSON.stringify(newer)), PW), 'too_new'));
ok('a short passphrase is refused when saving', await rejects(B.encryptBackup(payload, 'short')));
const wrongAddr = { ...payload, address: hsKey().address, hs: { ...payload.hs } }; wrongAddr.hs.hostname = wrongAddr.address;
ok('a key that doesn’t match its address is refused', B.checkPayload(wrongAddr).includes('address does not match its key'));
ok('missing identity keys are refused', B.checkPayload({ ...payload, identity: { ...payload.identity, ikSig: null } }).includes('identity keys'));
ok('a bad contact address is refused', B.checkPayload({ ...payload, contacts: [{ address: 'nope', ecdhPub: 'K' }] }).includes('contacts'));
// Keys that don't belong together: the file opens with its passphrase, but the identity in it could never start a chat.
const other = await jwkPair(EC), otherSig = await jwkPair({ name: 'ECDSA', namedCurve: 'P-256' });
const mixedSpk = { ...payload, identity: { ...payload.identity, spk: { priv: other.priv, pub: spk.pub } } };
ok('a prekey whose private half is another key’s is refused', await rejects(B.decryptBackup(await B.encryptBackup(mixedSpk, PW, { iterations: 100_000 }), PW), 'invalid'));
const mixedIk = { ...payload, identity: { ...payload.identity, ikPub: other.pub } };
ok('an identity key that doesn’t match its private half is refused', await rejects(B.decryptBackup(await B.encryptBackup(mixedIk, PW, { iterations: 100_000 }), PW), 'invalid'));
const mixedSig = { ...payload, identity: { ...payload.identity, ikSig: { priv: otherSig.priv, pub: sig.pub } } };
ok('a signing key that doesn’t match its private half is refused', await rejects(B.decryptBackup(await B.encryptBackup(mixedSig, PW, { iterations: 100_000 }), PW), 'invalid'));
ok('the file name carries the date only', /^anonchat-backup-\d{4}-\d{2}-\d{2}\.anonchat$/.test(B.backupFileName()));

console.log('Backend restore');
const d = mkdtempSync(join(tmpdir(), 'bk-srv-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
const fresh = hsKey();                    // the brand-new install's own throwaway address
writeFileSync(d + '/anon/anon_service/hostname', fresh.address + '\n');
writeFileSync(d + '/anon/anon_service/hs_ed25519_secret_key', fresh.secret);
writeFileSync(d + '/anon/anon_service/hs_ed25519_public_key', fresh.public);
const TOKEN = 'e'.repeat(64);
const srv = spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env, PUBLIC_PORT: '6312', UI_PORT: '6311', DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: '1', PEERS: '{}' } });
const ui = (p, m = 'GET', body) => fetch('http://127.0.0.1:6311' + p, { method: m, headers: { 'X-AnonChat-Token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
try {
  for (let i = 0; i < 200; i++) { try { await ui('/api/version'); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
  const hs = await ui('/api/backup/hs');
  ok('the window can read this install’s key for a backup', hs.status === 200 && hs.body.hostname === fresh.address && Buffer.from(hs.body.secret, 'base64').equals(fresh.secret));
  const noToken = await fetch('http://127.0.0.1:6311/api/backup/hs').then((r) => r.status);
  ok('…but nothing without the launch token can', noToken === 403, noToken);
  const bad = await ui('/api/restore', 'POST', { ...back, hs: { ...back.hs, secret: 'AAAA' } });
  ok('a malformed key is refused', bad.status === 400, bad.status);
  const r = await ui('/api/restore', 'POST', { hs: back.hs, contacts: back.contacts, peers: back.peers, groups: back.groups, blocked: back.blocked, settings: back.settings });
  ok('restore on a fresh install succeeds', r.status === 200 && r.body.address === key.address, JSON.stringify(r.body));
  ok('the key files and the address are in place', readFileSync(d + '/anon/anon_service/hs_ed25519_secret_key').equals(key.secret)
    && readFileSync(d + '/anon/anon_service/hs_ed25519_public_key').equals(key.public) && readFileSync(d + '/anon/anon_service/hostname', 'utf8').trim() === key.address);
  const [c, p, g, bl, st] = await Promise.all(['/api/contacts', '/api/peers', '/api/groups', '/api/blocked', '/api/settings'].map((u) => ui(u)));
  ok('contacts, group members, groups, blocked list and settings are back', c.body.length === 1 && c.body[0].address === FRIEND && c.body[0].opkId === null
    && p.body.length === 1 && g.body.length === 1 && bl.body.length === 1 && st.body.acceptRequests === false && st.body.readReceipts === true);
  const again = await ui('/api/restore', 'POST', { hs: back.hs, contacts: [], peers: [], groups: [] });
  ok('a second restore over existing data is refused', again.status === 409, again.status);
  // A restore may carry up to a whole backup file (20 MB): more than the window's other calls may send, and it must still be read.
  const big = await ui('/api/restore', 'POST', { hs: back.hs, contacts: [], peers: [], groups: [], pad: 'x'.repeat(14 * 1024 * 1024) });
  ok('a restore larger than 10 MB is read (refused here only because data exists)', big.status === 409 && big.body?.error === 'not_fresh', big.status);
  const bigOther = await ui('/api/groups', 'POST', { id: 'gx', members: [], pad: 'x'.repeat(14 * 1024 * 1024) });
  ok('…while other calls keep the 10 MB limit', bigOther.status === 413, bigOther.status);
  ok('nothing was left in plain text next to the store', !existsSync(d + '/data/restore.json'));
} finally { srv.kill(); }

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
