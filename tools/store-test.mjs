// Backend store: files sealed with the data key, reads that fail closed (never "empty"), planted or swapped files refused, one file per
// waiting message, answers in parts. Each case runs lib/store.js in its own process with its own data folder.
// Run: node tools/store-test.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const KEY = randomBytes(32).toString('hex'), OTHER = randomBytes(32).toString('hex');
let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => { cond ? (passed++, console.log('  ✓ ' + name)) : (failed++, console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : ''))); };

// Runs `body` (JS using `store`, `sealed`) with DATA_DIR=dir and the given key; returns what it prints as JSON.
function run(dir, key, body) {
  const src = `
    const sealed = require(${JSON.stringify(join(root, 'lib/sealed.js'))});
    ${key ? `sealed.setKey(Buffer.from('${key}', 'hex'));` : ''}
    const store = require(${JSON.stringify(join(root, 'lib/store.js'))});
    const out = (v) => process.stdout.write(JSON.stringify(v));
    (async () => { ${body} })().catch((e) => out({ thrown: e.code || e.message }));`;
  const r = execFileSync(process.execPath, ['-e', src], { env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  return r ? JSON.parse(r) : null;
}
const fresh = () => mkdtempSync(join(tmpdir(), 'store-'));
const plain = (dir, name, v) => writeFileSync(join(dir, name), JSON.stringify(v));

console.log('1. Everything is written encrypted');
{
  const d = fresh();
  const r = run(d, KEY, `store.upsertContact({ address: 'a'.repeat(56) + '.anyone', petname: 'Ana' }); store.upsertGroup({ id: 'g1', name: 'Trip', members: [] });
    store.setSettings({ readReceipts: true }); store.addToInbox({ id: 'm1', from: 'x', ct: 'aa', receivedAt: 1 });
    out({ health: store.checkAll(), c: store.getContacts(), s: store.getSettings(), inbox: store.getInbox() });`);
  ok('contacts, groups and settings sealed', ['contacts.json', 'groups.json', 'settings.json'].every((f) => readFileSync(join(d, f)).subarray(0, 4).toString() === 'ACE1'));
  ok('nothing readable in the files', !readFileSync(join(d, 'contacts.json')).includes('Ana') && !readFileSync(join(d, 'groups.json')).includes('Trip'));
  ok('content reads back', r.c[0]?.petname === 'Ana' && r.s.readReceipts === true && r.health.ok, JSON.stringify(r.health));
  ok('one sealed file per waiting message', readdirSync(join(d, 'inbox')).length === 1 && r.inbox.items.length === 1);
  ok('proof of work is “only during floods” by default', r.s.powAlways === false);
}

console.log('2. Reads fail closed');
{
  const d = fresh();
  run(d, KEY, `store.upsertContact({ address: 'b', petname: 'Bob' }); out(1);`);
  const before = readFileSync(join(d, 'contacts.json'));
  const r = run(d, OTHER, `const h = store.checkAll(); let thrown = null; try { store.upsertContact({ address: 'c', petname: 'Eve' }); } catch (e) { thrown = e.code; } out({ h, thrown });`);
  ok('a different key: reported, not treated as empty', r.h.ok === false && r.h.problems.some((p) => p.file === 'contacts.json'));
  ok('…and nothing is overwritten', r.thrown === 'STORE_UNREADABLE' && readFileSync(join(d, 'contacts.json')).equals(before));
  const r2 = run(d, null, `out(store.checkAll());`);
  ok('a sealed file without any key: reported', r2.ok === false && r2.problems.some((p) => p.reason === 'NO_KEY'));
  const d2 = fresh(); writeFileSync(join(d2, 'contacts.json'), '{"broken": ');
  const r3 = run(d2, null, `const h = store.checkAll(); let t = null; try { store.removeContact('x'); } catch (e) { t = e.code; } out({ h, t });`);
  ok('a damaged plaintext file: reported and kept', r3.h.ok === false && r3.t === 'STORE_UNREADABLE' && readFileSync(join(d2, 'contacts.json'), 'utf8') === '{"broken": ');
}

console.log('4. Inbox: one file per message');
{
  const d = fresh();
  const r = run(d, KEY, `
    const big = 'x'.repeat(5 * 1024 * 1024);
    for (let i = 0; i < 9; i++) store.addToInbox({ id: 'id' + i, from: i < 3 ? 'stranger' : 'friend', ct: big, receivedAt: 1000 + i });
    const p1 = store.getInbox({ maxBytes: 32 * 1024 * 1024 });
    const u = store.inboxUsage(new Set(['friend']), 'stranger');
    store.deleteFromInbox(p1.items.map((e) => e.id));
    const p2 = store.getInbox({ maxBytes: 32 * 1024 * 1024 });
    out({ n1: p1.items.length, more1: p1.more, n2: p2.items.length, more2: p2.more, order: p1.items[0].id, u });`);
  ok('answers in parts of at most ~32 MB, oldest first', r.n1 === 6 && r.more1 === true && r.n2 === 3 && r.more2 === false && r.order === 'id0', JSON.stringify(r));
  ok('usage counted in messages and bytes, per sender and for strangers', r.u.fromCount === 3 && r.u.strangerCount === 3 && r.u.totalCount === 9 && r.u.fromBytes > 15 * 1024 * 1024);
  const files = readdirSync(join(d, 'inbox'));
  ok('each file is sealed', files.every((f) => readFileSync(join(d, 'inbox', f)).subarray(0, 4).toString() === 'ACE1'));
  writeFileSync(join(d, 'inbox', files[0]), 'garbage');
  const r2 = run(d, KEY, `out(store.getInbox().items.length);`);
  ok('one damaged message is set aside, the rest still arrive', r2 === 2 && readdirSync(join(d, 'inbox')).some((f) => f.endsWith('.damaged')));
}

console.log('5. Without a key (browser mode) files stay readable JSON, as before');
{
  const d = fresh();
  const r = run(d, null, `store.upsertContact({ address: 'z', petname: 'Zoe' }); out(store.atRest());`);
  ok('plain JSON, reported as not encrypted', JSON.parse(readFileSync(join(d, 'contacts.json'), 'utf8'))[0].petname === 'Zoe' && r.encrypted === false);
}

console.log('6. Files can\u2019t be planted or swapped');
{
  const d = fresh();
  run(d, KEY, `store.upsertContact({ address: 'r', petname: 'Real' }); store.addBlocked('spam'); out(1);`);
  writeFileSync(join(d, 'contacts.json'), JSON.stringify([{ address: 'r', petname: 'Real', ecdhPub: 'ATTACKER' }]));
  const r = run(d, KEY, `out(store.checkAll());`);
  ok('a plain contacts.json put in place of the encrypted one is refused', r.ok === false && r.problems.some((p) => p.file === 'contacts.json' && p.reason === 'NOT_ENCRYPTED'));
  const d2 = fresh();
  run(d2, KEY, `store.upsertContact({ address: 'r', petname: 'Real' }); store.addBlocked('spam'); out(1);`);
  writeFileSync(join(d2, 'contacts.json'), readFileSync(join(d2, 'blocked.json')));
  const r2 = run(d2, KEY, `out(store.checkAll());`);
  ok('an encrypted file copied over another one is detected', r2.ok === false && r2.problems.some((p) => p.file === 'contacts.json' && p.reason === 'BAD_SEAL'));
}

console.log('Leftovers of an interrupted write');
{
  const d = fresh();
  run(d, KEY, `store.upsertContact({ address: 'r', petname: 'Real' }); out(1);`);
  mkdirSync(join(d, 'inbox'), { recursive: true });
  writeFileSync(join(d, 'contacts.json.123.abcdef.tmp'), 'half a write');
  writeFileSync(join(d, 'inbox', 'x.env.456.tmp'), 'half a write');
  writeFileSync(join(d, 'inbox', 'keep.txt'), 'not ours');
  const r = run(d, KEY, `out({ contacts: store.getContacts().length });`);
  ok('stray .tmp files are removed when the backend starts', !readdirSync(d).some((n) => n.endsWith('.tmp')) && !readdirSync(join(d, 'inbox')).some((n) => n.endsWith('.tmp')));
  ok('…and nothing else is touched', readdirSync(join(d, 'inbox')).includes('keep.txt') && r.contacts === 1);
}
{
  // server.js's note of when an address was last checked stays at 2000, forgetting the oldest first.
  const src = readFileSync(join(root, 'server.js'), 'utf8');
  const i = src.indexOf('function noteCheck'); const fn = src.slice(i, src.indexOf('\n}\n', i) + 2);
  const noteCheck = new Function(fn + '\nreturn noteCheck;')();
  const m = new Map();
  for (let k = 0; k < 5000; k++) noteCheck(m, 'a' + k, k);
  ok('the map of checked addresses stays at 2000', m.size === 2000);
  ok('…the newest are kept, the oldest forgotten', m.has('a4999') && m.has('a3000') && !m.has('a2999') && !m.has('a0'));
  noteCheck(m, 'a3000', 9999); noteCheck(m, 'new', 10000);
  ok('…and an address checked again counts as new', m.has('a3000') && !m.has('a3001') && m.get('a3000') === 9999);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
