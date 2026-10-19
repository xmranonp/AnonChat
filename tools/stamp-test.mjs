// Message stamps and one-time key limits, against a real server.js (needs `npm install`).
// Stamps: a message claiming a contact's or group member's address is treated as theirs only with a valid stamp; otherwise it is a
// stranger's, counted as one, and can't use up the real contact's allowance. One-time keys: handed out sparingly, at most 100 waiting.
// Run: node tools/stamp-test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const stamp = createRequire(import.meta.url)(join(APP, 'lib/stamp.js'));
const ME = 'a'.repeat(56) + '.anyone', FRIEND = 'f'.repeat(56) + '.anyone', MEMBER = 'm'.repeat(56) + '.anyone', OTHER = 'o'.repeat(56) + '.anyone';
const K_FRIEND = randomBytes(32).toString('base64'), K_MEMBER = randomBytes(32).toString('base64'), K_WRONG = randomBytes(32).toString('base64');

const d = mkdtempSync(join(tmpdir(), 'stamp-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
writeFileSync(join(d, 'data', 'contacts.json'), JSON.stringify([{ address: FRIEND, petname: 'Friend', ecdhPub: 'K1', ratchetPub: 'R1' }]));
writeFileSync(join(d, 'data', 'groups.json'), JSON.stringify([{ id: 'g1', name: 'G', members: [{ address: ME }, { address: MEMBER }] }]));
const TOKEN = 'e'.repeat(64);
const srv = spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env,
  PUBLIC_PORT: '6212', UI_PORT: '6211', DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: '1', PEERS: '{}' } });

const req = (port, p, m = 'GET', body, headers = {}) => new Promise((res, rej) => {
  const data = body ? JSON.stringify(body) : '';
  const r = http.request({ host: '127.0.0.1', port, path: p, method: m, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
    (resp) => { let b = ''; resp.on('data', (c) => b += c); resp.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} res({ status: resp.statusCode, body: j }); }); });
  r.on('error', rej); r.end(data);
});
const inbox = (env) => req(6212, '/api/inbox', 'POST', env, { Host: ME }).then((r) => r.status);
const pubGet = (p) => req(6212, p, 'GET', null, { Host: ME });
const ui = (p, m = 'GET', body) => req(6211, p, m, body, { 'X-AnonChat-Token': TOKEN, Host: '127.0.0.1:6211' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const big0 = 600 * 1024;
const env = (from, { key, to = ME, size } = {}) => {
  const e = { from, ct: (size ? 'x'.repeat(size) : 'ct') + '-' + (++n) + '-' + Math.random(), dh: 'dh', n: 0, pn: 0 };
  if (key) e.stamp = stamp.make(key, e, from, to);
  return e;
};
const waiting = async (from) => {
  const all = (await ui('/api/messages')).body || [];
  const mine = all.filter((e) => e.from === from);
  return { stamped: mine.filter((e) => !e.unverified).length, unstamped: mine.filter((e) => e.unverified).length };
};

let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + x + ']')); };
try {
  for (let i = 0; i < 40; i++) { try { if ((await ui('/api/whoami')).status === 200) break; } catch {} await sleep(250); }

  console.log('Message stamps');
  // Listen as the window does, to see the backend ask for a missing key.
  const events = [];
  const WS = createRequire(join(APP, 'x.js'))('ws');
  const sock = new WS('ws://127.0.0.1:6211/ws', { headers: { 'X-AnonChat-Token': TOKEN, Host: '127.0.0.1:6211' } });
  sock.on('message', (m) => { try { events.push(JSON.parse(String(m))); } catch {} });
  await new Promise((r) => { sock.on('open', r); sock.on('error', r); setTimeout(r, 2000); });

  // Before the window has handed over any key: nothing claiming a contact or member is trusted or stored.
  ok('contact, no key yet, no stamp: asked to retry, nothing stored', (await inbox(env(FRIEND, { size: big0 }))) === 503 && (await waiting(FRIEND)).stamped + (await waiting(FRIEND)).unstamped === 0);
  ok('contact, no key yet, any stamp: same', (await inbox(env(FRIEND, { key: K_FRIEND }))) === 503);
  ok('group member, no key yet: same', (await inbox(env(MEMBER))) === 503 && (await waiting(MEMBER)).stamped + (await waiting(MEMBER)).unstamped === 0);
  ok('a stranger is unaffected', (await inbox(env(OTHER))) === 200);
  await sleep(300);
  ok('the window is asked for the missing keys (once per address)', events.filter((e) => e.type === 'mailbox:missing' && e.address === FRIEND).length === 1
    && events.some((e) => e.type === 'mailbox:missing' && e.address === MEMBER), JSON.stringify(events));
  sock.close();

  ok('a malformed mailbox key is refused', (await ui('/api/mailbox-keys', 'POST', { keys: [{ address: FRIEND, key: 'short' }] })).status === 400);
  const set = await ui('/api/mailbox-keys', 'POST', { replace: true, keys: [{ address: FRIEND, key: K_FRIEND }, { address: MEMBER, key: K_MEMBER }] });
  ok('the window can hand over the keys', set.status === 200 && set.body.count === 2);

  const big = big0;
  ok('once the key arrives, a stamped 600 KB message from the contact is kept (contact allowance)', (await inbox(env(FRIEND, { key: K_FRIEND, size: big }))) === 200 && (await waiting(FRIEND)).stamped === 1);
  await inbox(env(FRIEND, { size: big }));
  ok('the same message claiming the contact without a stamp is treated as a stranger’s (too big: not kept)', (await waiting(FRIEND)).unstamped === 0);
  await inbox(env(FRIEND, { key: K_WRONG }));
  await inbox(env(FRIEND, { key: K_FRIEND, to: OTHER }));
  ok('a wrong stamp, or one made for someone else, doesn’t count', (await waiting(FRIEND)).unstamped === 2, JSON.stringify(await waiting(FRIEND)));
  ok('a stamped group member’s 600 KB message is kept; an unstamped one isn’t',
    (await inbox(env(MEMBER, { key: K_MEMBER, size: big }))) === 200 && (await inbox(env(MEMBER, { size: big }))) === 200
    && (await waiting(MEMBER)).stamped === 1 && (await waiting(MEMBER)).unstamped === 0);

  // Fill the stranger allowance for this address with unstamped claims (20 waiting at most), paced under the burst limit.
  for (let i = 0; i < 24; i++) { await inbox(env(FRIEND)); if (i % 4 === 3) await sleep(1100); }
  const w = await waiting(FRIEND);
  ok('unstamped claims are held to the stranger limit (20 waiting)', w.unstamped === 20, JSON.stringify(w));
  ok('…and never use up the contact’s own allowance', (await inbox(env(FRIEND, { key: K_FRIEND }))) === 200 && (await waiting(FRIEND)).stamped === 2);

  // A flood from non-contacts: unstamped claims then need proof of work, the real contact doesn't.
  for (let s = 0; s < 4; s++) { for (let k = 0; k < 9; k++) await inbox(env('s' + String(s * 10 + k).padStart(2, '0') + 'b'.repeat(53) + '.anyone')); await sleep(1100); }
  ok('during a flood an unstamped claim must solve proof of work (402)', (await inbox(env(MEMBER))) === 402);
  ok('…while the stamped contact gets straight through', (await inbox(env(FRIEND, { key: K_FRIEND }))) === 200);

  await ui('/api/contacts', 'DELETE', { address: FRIEND });
  const mbox = JSON.parse(readFileSync(join(d, 'data', 'mailbox.json'), 'utf8'));
  ok('removing a contact also removes their mailbox key', !(FRIEND in mbox) && MEMBER in mbox);

  console.log('Shared mailbox key (the function in public/app.js)');
  {
    const pubDir = join(APP, 'public'), tmp = mkdtempSync(join(tmpdir(), 'mbox-'));
    writeFileSync(join(tmp, 'crypto.mjs'), readFileSync(join(pubDir, 'crypto.js')));
    const { b64 } = await import(pathToFileURL(join(tmp, 'crypto.mjs')).href);
    const SRC = readFileSync(join(pubDir, 'app.js'), 'utf8');
    const m = /^async function mailboxKeyFor\(/m.exec(SRC);
    let i = SRC.indexOf('{', SRC.indexOf(')', m.index)), depth = 0, end = -1;
    for (let j = i; j < SRC.length; j++) { if (SRC[j] === '{') depth++; else if (SRC[j] === '}' && --depth === 0) { end = j + 1; break; } }
    const EC = { name: 'ECDH', namedCurve: 'P-256' };
    const party = async (address) => {
      const kp = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
      const me = { address, ecdhPub: b64.enc(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
      me.keyFor = new Function('EC', 'b64', 'ikPrivJwk', 'myAddress', '_mboxKeys', SRC.slice(m.index, end) + '\nreturn mailboxKeyFor;')(EC, b64, me.jwk, address, new Map());
      return me;
    };
    const A = await party(ME), B = await party(FRIEND), C = await party(OTHER);
    const ab = await A.keyFor(B), ba = await B.keyFor(A), ac = await A.keyFor(C);
    ok('both people work out the same key', ab && ab === ba && Buffer.from(ab, 'base64').length === 32);
    ok('a different person gets a different key', ac && ac !== ab);
    const e = env(ME, {}); delete e.stamp;
    const sent = { ...e, stamp: stamp.make(ab, e, ME, FRIEND) };
    ok('a stamp made with one side’s key checks out with the other side’s', stamp.check(ba, sent, ME, FRIEND) && !stamp.check(ac, sent, ME, FRIEND));
  }

  console.log('One-time keys: the window keeps only what it needs (ensurePrekeys in public/app.js)');
  {
    const tmp = mkdtempSync(join(tmpdir(), 'opk-'));
    writeFileSync(join(tmp, 'crypto.mjs'), readFileSync(join(APP, 'public', 'crypto.js')));
    const { b64 } = await import(pathToFileURL(join(tmp, 'crypto.mjs')).href);
    const SRC = readFileSync(join(APP, 'public', 'app.js'), 'utf8');
    const fn = (name) => { const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(SRC); let i = SRC.indexOf('{', SRC.indexOf(')', m.index)), dp = 0;
      for (let j = i; j < SRC.length; j++) { if (SRC[j] === '{') dp++; else if (SRC[j] === '}' && --dp === 0) return SRC.slice(m.index, j + 1); } };
    const consts = SRC.match(/^const OPK_[A-Z_]+ = .*;$/gm).join('\n');
    const pool = new Set(); let store = {}; const posts = [];
    const fakeFetch = async (url, opts = {}) => {
      if (opts.method === 'POST') { const b = JSON.parse(opts.body); posts.push(b); for (const id of b.drop) pool.delete(id); for (const k of b.keys) if (pool.size < 100) pool.add(k.id); }
      return { json: async () => ({ ids: [...pool], count: pool.size }) };
    };
    const run = new Function('fetch', 'b64', 'EC', 'store', `${consts}\nlet opkTarget = OPK_TARGET_MIN, opkLastSeen = null;
      function loadOPKs() { return store.v; } function saveOPKs(o) { store.v = o; }\n${fn('ensurePrekeys')}\nreturn { ensurePrekeys, keep: OPK_KEEP_MS, max: OPK_KEEP_MAX };`);
    const holder = { v: {} };
    const W = run(fakeFetch, b64, { name: 'ECDH', namedCurve: 'P-256' }, holder);
    await W.ensurePrekeys();
    const first = Object.keys(holder.v);
    ok('the first top-up stores the private halves and hands over the public ones', first.length === 10 && pool.size === 10 && first.every((id) => pool.has(id) && holder.v[id].k));
    pool.delete(first[0]); pool.delete(first[1]);           // two handed out
    await W.ensurePrekeys();
    ok('a handed-out key is kept (waiting for its first message), marked with when it went out', holder.v[first[0]]?.out > 0 && holder.v[first[1]]?.out > 0);
    holder.v[first[0]].out = Date.now() - W.keep - 1000;
    await W.ensurePrekeys();
    ok('one no first message used within 14 days is forgotten', !holder.v[first[0]] && !!holder.v[first[1]]);
    // A drain: hundreds handed out and never used.
    for (let i = 0; i < W.max + 50; i++) holder.v['old' + i] = { k: { kty: 'EC' }, out: Date.now() - (W.max + 50 - i) * 1000 };
    await W.ensurePrekeys();
    const outNow = Object.entries(holder.v).filter(([id]) => !pool.has(id));
    ok(`at most ${W.max} handed-out keys are kept, the oldest go first`, outNow.length === W.max && !holder.v.old0 && !!holder.v['old' + (W.max + 49)], outNow.length);
    pool.add('ghost');                                       // waiting on the backend, but the private half is gone
    await W.ensurePrekeys();
    ok('a waiting key without its private half is withdrawn', !pool.has('ghost') && posts.at(-1).drop.includes('ghost'));
  }

  console.log('One-time keys: the backend');
  await ui('/api/identity', 'POST', { ecdhPub: 'E', ratchetPub: 'R' });
  const keys = Array.from({ length: 150 }, (_, i) => ({ id: 'k' + i, pub: 'P' + i }));
  const add = await ui('/api/prekeys', 'POST', { keys });
  ok('at most 100 keys wait to be handed out', add.body.count === 100, add.body.count);
  const given = [];
  for (let i = 0; i < 26; i++) given.push((await pubGet('/api/identity')).body.opkId);
  ok('the first 20 identity requests each get a key', given.slice(0, 20).every(Boolean), given.slice(0, 20).filter(Boolean).length);
  ok('after that, requests get none (the chat still starts, without the extra first-message protection)', given.slice(20).every((x) => x === null));
  const left = (await ui('/api/prekeys')).body;
  ok('only those 20 were used up', left.count === 80 && Array.isArray(left.ids));
  const dropped = await ui('/api/prekeys', 'POST', { keys: [], drop: left.ids.slice(0, 5) });
  ok('keys the window can no longer use are withdrawn', dropped.body.count === 75 && !dropped.body.ids.includes(left.ids[0]));
} finally { srv.kill(); }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
