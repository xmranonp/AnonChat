// Our own mailbox (lib/swarm/own.js) and collecting from it (lib/swarm/collect.js), against the real mailbox peer: joining with an
// invite, a token per contact, the details frame, live collection and sessions, every ack, a key rotated, a contact removed, leaving.
// Needs MAILBOX_PEER_DIR (a mailbox-peer source folder); without it, says so and passes nothing. Run: node tools/swarm-collect-test.mjs
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { startSocks } from './swarm-socks.mjs';
const H2 = createRequire(import.meta.url)(join(process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..'), 'lib/swarm/hpke.js'));

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PEER = process.env.MAILBOX_PEER_DIR;
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + String(x).slice(0, 300) + ']')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await sleep(30); } return false; };
if (!PEER || !existsSync(join(PEER, 'test/helpers.mjs'))) { console.log('(set MAILBOX_PEER_DIR to a mailbox-peer source folder to run this)\n\n0 passed, 0 failed'); process.exit(0); }

const require = createRequire(import.meta.url);
require(join(APP, 'lib/sealed.js')).setKey(randomBytes(32));
const PC = require(join(APP, 'lib/swarm/peerclient.js')), S = require(join(APP, 'lib/swarm/seal.js'));
const Own = require(join(APP, 'lib/swarm/own.js')), Collect = require(join(APP, 'lib/swarm/collect.js')), Contacts = require(join(APP, 'lib/swarm/contacts.js'));
const ph = await import(pathToFileURL(join(PEER, 'test/helpers.mjs')).href);
const h = await ph.startPeer({ clock: { get t() { return Date.now(); }, set t(_) {} }, waitMax: 2 });
const PA = ph.ADDR, ANA = 'a'.repeat(56) + '.anyone', CLEO = 'c'.repeat(56) + '.anyone', BOB = 'b'.repeat(56) + '.anyone';
const socks = await startSocks((host) => (host === PA ? { path: h.sock } : 'refuse'));
const FAST = { connectMs: 2000, connectColdMs: 3000 };
const clients = new Map(); const clientFor = (a) => { if (!clients.has(a)) clients.set(a, PC.create({ address: a, socksUrl: socks.url, timing: FAST })); return clients.get(a); };
const sender = PC.create({ address: PA, socksUrl: socks.url, timing: FAST });

let contacts = [ANA];
const DATA = mkdtempSync(join(tmpdir(), 'swarm-own-'));
const own = Own.create({ dataDir: DATA, clientFor, contacts: () => contacts });
let mode = 'stored'; const got = [];
const collect = Collect.create({ own, clientFor, accept: async (env, o) => { if (mode === 'stored') got.push({ env, ...o }); return mode; }, timing: { laterMs: 200, retry: [50, 100] } });
let changes = 0; own.on('changed', () => changes++);
// What Ana's app does with Bob's details: seal a drop for his peer under her token.
const drop = (d, env, { kid, pk } = {}) => {
  const p = d.peers[0];
  const { body } = S.sealDrop({ env, peerAddress: p.address, pk: S.fromB64u(pk || p.pk), expiry: S.expiryAfter(3600) });
  return sender.drop({ token: p.token, kid: kid || p.kid, expiry: S.expiryAfter(3600), body });
};
try {
  console.log('1. Joining');
  ok('no peers: no details to give', own.detailsFor(ANA) === null && !own.hasPeers());
  const inv = await h.store.createInvite({});
  let e1; try { await own.join(PA, '00'.repeat(16)); } catch (e) { e1 = e; }
  ok('an unknown invite is refused, nothing kept', e1 && e1.status === 403 && !own.hasPeers(), e1 && e1.message);
  const j = await own.join(PA, inv.invite);
  ok('joined with the invite: a mailbox at the peer', /^[0-9a-f]{32}$/.test(j.mailbox) && own.list()[0].contacts === 1);
  let e2; try { await own.join(PA, inv.invite); } catch (e) { e2 = e; }
  ok('the same peer twice: refused', e2 && e2.code === 'already');
  const d = own.detailsFor(ANA);
  ok('Ana\'s details: our peer, its key and her own token', d && d.v === 1 && d.seq > 0 && d.peers.length === 1 && d.peers[0].address === PA && d.peers[0].token.length === 43);
  const c2 = Contacts.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-ana-')) });
  ok('…and they pass every check on her side', c2.setDetails(BOB, d) === 'updated');
  ok('Cleo, not a contact, has no token and no details', own.detailsFor(CLEO) === null || own.detailsFor(CLEO).peers.length === 0);
  ok('capability: Ana shows sw: 1 and is due our details', own.capable(ANA) === true && own.due().includes(ANA));
  own.sent(ANA, d.seq);
  ok('…once sent, not due again', !own.due().includes(ANA) && own.capable(ANA) === false);

  console.log('2. Collecting');
  collect.start();
  const env1 = { from: ANA, dh: 'x', pn: 0, n: 1, ct: randomBytes(40).toString('base64'), stamp: 's' };
  const r1 = await drop(d, env1);
  ok('Ana drops a message', r1.state === 'held');
  ok('the live wait takes it at once', await until(() => got.some((g) => g.env.ct === env1.ct)), got.length);
  ok('…with when it reached the peer', got[0] && Math.abs(got[0].writtenAt - Date.now()) < 120000 && got[0].peer === PA, JSON.stringify({ w: got[0]?.writtenAt, now: Date.now(), p: got[0]?.peer }));
  ok('…and acks it: Ana\'s status says collected', await until(async () => (await sender.status([d.peers[0].token], { ids: [r1.id] })).drops[0].state === 'collected'));
  // not yet (no stamp key): not acked, taken at a later session
  mode = 'later';
  const env2 = { ...env1, n: 2, ct: randomBytes(40).toString('base64') };
  const r2 = await drop(d, env2);
  await sleep(600);
  ok('"later": not acked, still held at the peer', (await sender.status([d.peers[0].token], { ids: [r2.id] })).drops[0].state === 'held');
  mode = 'stored'; collect.kick();
  ok('…taken once it can be (a session at the stamp key\'s arrival)', await until(() => got.some((g) => g.env.ct === env2.ct)));
  ok('…and acked', await until(async () => (await sender.status([d.peers[0].token], { ids: [r2.id] })).drops[0].state === 'collected'));
  // discarded (say, a bad stamp): the sender's status says so
  mode = 'discarded';
  const r3 = await drop(d, { ...env1, n: 3, ct: randomBytes(40).toString('base64') });
  ok('"discarded": acked as discarded, so the sender sends directly', await until(async () => (await sender.status([d.peers[0].token], { ids: [r3.id] })).drops[0].state === 'discarded'));
  mode = 'stored';
  // a drop sealed to a kid we never had: discarded unopened
  const other = require(join(APP, 'lib/swarm/hpke.js')).generateKeyPair();
  let r4; try { r4 = await drop(d, env1, { kid: S.kidOf(PA, other.pk), pk: S.b64u(other.pk) }); } catch (e) { r4 = e; }
  ok('a kid the peer doesn\'t accept: 409 to the sender (nothing reaches us)', r4 && r4.status === 409, r4 && r4.message);
  // a large one: fetched by id
  const big = { ...env1, n: 5, ct: 'Q'.repeat(400000) };
  await drop(d, big);
  ok('a 400 kB message (not inline): fetched by id and taken', await until(() => got.some((g) => g.env.ct === big.ct), 8000));
  // while we were away: a session at start takes it
  collect.stop(); await sleep(100);
  const env6 = { ...env1, n: 6, ct: randomBytes(40).toString('base64') };
  await drop(d, env6);
  const collect2 = Collect.create({ own, clientFor, accept: async (env, o) => { got.push({ env, ...o }); return 'stored'; } });
  collect2.start();
  ok('dropped while the app was closed: taken at the next start', await until(() => got.some((g) => g.env.ct === env6.ct)));

  console.log('3. Contacts and keys');
  contacts = [ANA, CLEO]; await own.sync();
  const dc = own.detailsFor(CLEO);
  ok('a new contact gets a token, and the details change (seq up)', dc && dc.peers.length === 1 && dc.seq > d.seq);
  ok('Ana is due the new seq only if she was told the old one… (capable contacts are re-sent on any change)', own.capable(ANA) === true);
  own.sent(ANA, dc.seq);
  const before = own.detailsFor(ANA);
  await own.rotate();
  const after = own.detailsFor(ANA);
  ok('rotate: a new key and new tokens; the old key still listed for 8 days', after.peers[0].kid !== before.peers[0].kid && after.peers[0].oldKid === before.peers[0].kid && after.peers[0].token !== before.peers[0].token);
  const env5 = { ...env1, n: 50, ct: randomBytes(40).toString('base64') };
  let r5; try { r5 = await drop(before, env5); } catch (e) { r5 = e; }
  ok('the old token and key keep working 8 days (contacts with the old details aren\'t refused)', r5 && r5.state === 'held' && await until(() => got.some((g) => g.env.ct === env5.ct)), r5 && r5.message);
  const env7 = { ...env1, n: 7, ct: randomBytes(40).toString('base64') };
  await drop({ peers: [{ ...after.peers[0], kid: after.peers[0].oldKid, pk: after.peers[0].oldPk }] }, env7);
  ok('a drop sealed to the old key under the new token still opens', await until(() => got.some((g) => g.env.ct === env7.ct)));
  const dcNow = own.detailsFor(CLEO);          // her token since the rotation
  contacts = [ANA]; await own.forget(CLEO);
  let r6; try { r6 = await drop(dcNow, env1); } catch (e) { r6 = e; }
  ok('a removed contact\'s token is deleted at the peer', r6 && r6.status === 403);

  console.log('3b. The audit\'s findings');
  // a drop that can't be taken yet is remembered, not downloaded again at every session
  const realCl = clientFor(PA); let collects = 0;
  const counting = new Proxy(realCl, { get: (t, k) => (k === 'collect' ? (...a) => { collects++; return t.collect(...a); } : t[k]) });
  let mode3 = 'later'; const got3 = [];
  const c3 = Collect.create({ own, clientFor: () => counting, accept: async (env) => { if (mode3 === 'stored') got3.push(env); return mode3; }, timing: { sessionEveryMs: 60000, laterMs: 100 } });
  collect2.stop(); c3.start(); await sleep(400);
  const env8 = { ...env1, n: 8, ct: randomBytes(400000).toString('base64').slice(0, 400000) };
  await drop(own.detailsFor(ANA), env8);
  await sleep(1500);
  const n0 = collects;
  await sleep(1500);
  ok('a big drop that can\'t be taken yet is not downloaded again every 30 s (only at the 5-minute rounds, or when a stamp key arrives)', collects - n0 <= 1, collects - n0);
  mode3 = 'stored'; c3.kick();
  ok('…and taken once it can be', await until(() => got3.some((e) => e.ct === env8.ct)));
  c3.stop();
  // a peer whose wait answers at once with nothing: a pause, not a flood
  let waits = 0;
  const quickPeer = new Proxy(realCl, { get: (t, k) => (k === 'wait' ? async () => { waits++; return { drops: [], more: false, cursor: '0', prevCollectAt: 0 }; } : t[k]) });
  const c4 = Collect.create({ own, clientFor: () => quickPeer, accept: async () => 'stored', timing: { quickPauseMs: 100 } });
  c4.start(); await sleep(1000); c4.stop();
  ok('a wait answered at once with nothing, again and again: a few requests, not a flood', waits < 10, waits);
  // a join whose answer is lost (the app stops, or the route drops): asked again and completed with the same mailbox
  const inv2 = await h.store.createInvite({});
  const PB = PA;          // the same peer, a second app
  const D2 = mkdtempSync(join(tmpdir(), 'swarm-own2-'));
  let failJoin = true;
  const lossy = (a) => new Proxy(clientFor(a), { get: (t, k) => (k === 'join' ? async (...x) => { const r = await t.join(...x); if (failJoin) { failJoin = false; throw Object.assign(new Error('cut'), { kind: 'network' }); } return r; } : t[k]) });
  const own2 = Own.create({ dataDir: D2, clientFor: lossy, contacts: () => [ANA] });
  let je; try { await own2.join(PB, inv2.invite); } catch (e) { je = e; }
  ok('the join\'s answer is lost: kept as "joining", the invite saved', je && own2.list()[0]?.state === 'joining');
  const own2b = Own.create({ dataDir: D2, clientFor, contacts: () => [ANA] });          // the app started again
  await own2b.sync();
  ok('…asked again at the next start: joined, with a mailbox at the peer', own2b.list()[0]?.state === 'active' && own2b.detailsFor(ANA)?.peers.length === 1);
  // a peer that is down when a contact is added: the token is registered at the next retry
  let down = true;
  const flaky = (a) => new Proxy(clientFor(a), { get: (t, k) => (k === 'tokens' ? async (...x) => { if (down) throw Object.assign(new Error('down'), { kind: 'network' }); return t.tokens(...x); } : t[k]) });
  let cs = [ANA];
  const own3 = Own.create({ dataDir: D2, clientFor: flaky, contacts: () => cs });
  cs = [ANA, CLEO]; await own3.sync();
  ok('a contact added while the peer is down: no token there yet, so not in their details', (own3.detailsFor(CLEO)?.peers || []).length === 0);
  down = false; await own3.sync();
  ok('…registered when the peer answers again (the minute\'s retry)', own3.detailsFor(CLEO)?.peers.length === 1);

  console.log('3c. Backup and restore');
  const bk = own.backup();
  ok('the backup holds our peer, its owner secret, keys and each contact\'s token', bk.v === 1 && bk.peers.length === 1 && bk.peers[0].secret && bk.peers[0].key.sk && bk.peers[0].tokens[ANA] === own.detailsFor(ANA).peers[0].token);
  const json = JSON.stringify(bk);
  ok('…and survives JSON (it goes into the encrypted backup file)', JSON.stringify(JSON.parse(json)) === json);
  // a message Ana drops while Bob's old computer is gone and the new one is being set up
  const envR = { ...env1, n: 70, ct: randomBytes(40).toString('base64') };
  await drop(own.detailsFor(ANA), envR);
  collect.stop(); try { c3.stop(); } catch {}
  const DR = mkdtempSync(join(tmpdir(), 'swarm-restored-'));
  const ownR = Own.create({ dataDir: DR, clientFor, contacts: () => contacts });
  const rr = ownR.restore(JSON.parse(json));
  ok('restored on a fresh install: the same peer', rr.restored === 1 && ownR.list()[0].address === PA);
  ok('…a second restore over it is refused', ownR.restore(JSON.parse(json)).error === 'not-fresh');
  let seqBumped = false; ownR.on('changed', () => { seqBumped = true; });
  ownR.start();
  ok('after the restart: the mailbox is checked, the token list put back, and contacts are due fresh details', await until(() => !ownR.restoredPending && seqBumped && ownR.seq() > bk.seq, 8000), JSON.stringify({ p: ownR.restoredPending, s: ownR.seq(), b: bk.seq }));
  ok('…Ana\'s token is the same, so her details still work', ownR.detailsFor(ANA).peers[0].token === bk.peers[0].tokens[ANA]);
  const gotR = [];
  const cR = Collect.create({ own: ownR, clientFor, accept: async (env) => { gotR.push(env); return 'stored'; } });
  cR.start();
  ok('the restored install collects what was dropped meanwhile, with the backed-up keys', await until(() => gotR.some((e) => e.ct === envR.ct)));
  const envR2 = { ...env1, n: 71, ct: randomBytes(40).toString('base64') };
  await drop(ownR.detailsFor(ANA), envR2);
  ok('…and what Ana drops next', await until(() => gotR.some((e) => e.ct === envR2.ct)));
  cR.stop(); ownR.stop();
  ok('a backup from a newer mailbox format is left out, not guessed at', Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-r2-')), clientFor, contacts: () => [] }).restore({ ...bk, v: 2 }).error === 'too-new');
  const broken = JSON.parse(json); broken.peers[0].key.kid = 'f'.repeat(16);
  ok('a peer whose key doesn\'t match its kid is left out', Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-r3-')), clientFor, contacts: () => [] }).restore(broken).restored === 0);
  // the second audit's findings
  const fresh = (n) => Own.create({ dataDir: mkdtempSync(join(tmpdir(), `swarm-r${n}-`)), clientFor, contacts: () => contacts });
  const wrongSk = JSON.parse(json); wrongSk.peers[0].key.sk = S.b64u(randomBytes(32));
  ok('a secret key that isn\'t its public key\'s: left out', fresh(4).restore(wrongSk).restored === 0);
  const dup = JSON.parse(json); dup.peers.push(dup.peers[0]);
  const fd = fresh(5); fd.restore(dup);
  ok('the same peer twice: kept once (details listing a peer twice would be refused by contacts)', fd.list().length === 1);
  const zero = JSON.parse(json); zero.v = 0;
  ok('v 0: refused as invalid', fresh(6).restore(zero).error === 'invalid');
  const pol = JSON.parse(json); pol.peers[0].tokens = JSON.parse('{"__proto__": "x", "constructor": "y"}'); pol.peers[0].retiring = Array.from({ length: 20000 }, () => ({ h: 'a'.repeat(64), until: 9e15, extra: 1 }));
  const fp = fresh(7); fp.restore(pol);
  const bp = fp.backup();
  ok('hostile maps and lists: no prototype keys, retiring capped and cleaned, its time at most 8 days', Object.keys(bp.peers[0].tokens).length === 0 && bp.peers[0].retiring.length <= 10000
    && bp.peers[0].retiring.every((y) => Object.keys(y).join() === 'h,until' && y.until <= Date.now() + 8 * 86400e3 + 1000) && ({}).polluted === undefined);
  // before a restored peer is checked, contacts get nothing (empty details would say "write to me directly")
  const fq = fresh(8); fq.restore(JSON.parse(json));
  ok('restored, not yet checked: no details and nobody due (not "write directly")', fq.detailsFor(ANA) === null && fq.due().length === 0 && fq.capable(ANA) === false);
  // one peer that never answers doesn't hold up the others
  const UNREACH = 'u'.repeat(56) + '.anyone';
  const two = JSON.parse(json);
  { const k = H2.generateKeyPair(); two.peers.push({ ...two.peers[0], address: UNREACH, key: { kid: S.kidOf(UNREACH, k.pk), pk: S.b64u(k.pk), sk: S.b64u(k.sk) } }); }
  const f2 = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-r9-')), clientFor, contacts: () => contacts });
  f2.restore(two); let bumped2 = 0; f2.on('changed', () => bumped2++);
  f2.start();
  ok('two restored peers, one unreachable: the reachable one is checked and contacts get details naming it', await until(() => bumped2 > 0 && f2.detailsFor(ANA)?.peers.length === 1 && f2.detailsFor(ANA).peers[0].address === PA, 15000), JSON.stringify(f2.detailsFor(ANA)));
  ok('…the other is still being asked (the restore isn\'t over)', f2.restoredPending === true && f2.list().length === 2);
  f2.stop();
  // many contacts: more than one request's worth of tokens (2,000), every one registered again after a restore
  const D2B = { 0: 'w', 1: 'x', 2: 'y', 3: 'z', 4: '2', 5: '3', 6: '4', 7: '5', 8: '6', 9: '7' };
  const many = Array.from({ length: 2300 }, (_, i) => i.toString(32).replace(/[0-9]/g, (d) => D2B[d]).padStart(4, 'q').padEnd(56, 'q') + '.anyone');
  const uniq = [...new Set(many)].slice(0, 2300);
  const inv3 = await h.store.createInvite({});
  const ownM = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-many-')), clientFor, contacts: () => uniq });
  await ownM.join(PA, inv3.invite);
  const bkM = JSON.parse(JSON.stringify(ownM.backup()));
  const ownM2 = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-many2-')), clientFor, contacts: () => uniq });
  ownM2.restore(bkM); ownM2.start();
  await until(() => !ownM2.restoredPending, 20000);
  const last = uniq[uniq.length - 1];
  let rl; try { rl = await drop(ownM2.detailsFor(last), { ...env1, n: 90, ct: randomBytes(20).toString('base64') }); } catch (e) { rl = e; }
  ok(`${uniq.length} contacts: after the restore, the last one\'s token works too (sent in chunks, not cut at 2,000)`, uniq.length > 2000 && rl && rl.state === 'held', rl && rl.message);
  ownM2.stop();
  // the old install still running and rotating after the backup: the restore notices and keeps its key 8 days
  const bkO = JSON.parse(JSON.stringify(ownM.backup()));
  await ownM.rotate();
  const newKid = ownM.detailsFor(last).peers[0].kid;
  const ownM3 = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-many3-')), clientFor, contacts: () => uniq });
  let otherSaid = false; ownM3.on('other-install', () => { otherSaid = true; });
  ownM3.restore(bkO); ownM3.start();
  ok('restored while the old install is still in use (it rotated since): "open on another computer"', await until(() => otherSaid, 20000));
  await until(() => !ownM3.restoredPending, 20000);
  let ro; try { ro = await drop(ownM.detailsFor(last), { ...env1, n: 91, ct: randomBytes(20).toString('base64') }); } catch (e) { ro = e; }
  ok('…and the old install\'s new key still works there (not cut off while the person is warned)', ro && ro.state === 'held' && newKid !== bkO.peers[0].key.kid, ro && ro.message);
  ownM3.stop();

  console.log('4. Leaving');
  const s0 = own.seq();
  await own.leave(PA);
  const dl = own.detailsFor(ANA);
  ok('left: contacts get details with no peers ("write to me directly")', dl && dl.peers.length === 0 && dl.seq > s0);
  ok('…the peer forgot the mailbox', own.list().length === 0);
  let r7; try { r7 = await drop(after, env1); } catch (e) { r7 = e; }
  ok('…and refuses drops for it', r7 && (r7.status === 403 || r7.status === 404));
  // restoring the old backup now: the peer no longer knows that mailbox
  const ownG = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-rg-')), clientFor, contacts: () => contacts });
  let goneSaid = false; ownG.on('mailbox-gone', () => { goneSaid = true; });
  ownG.restore(JSON.parse(json)); ownG.start();
  ok('restoring a backup whose mailbox was since left: the peer is removed and the window told', await until(() => goneSaid && ownG.list().length === 0));
  ownG.stop();
  collect2.stop();
} finally { collect.stop(); for (const c of clients.values()) c.close(); sender.close(); socks.close(); await h.stop(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
