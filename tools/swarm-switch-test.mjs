// Switching peers, removing one and turning the mailbox off (design section 8), against two real mailbox peers: the new peer listed and
// the old one drained 8 days (still collected, not in contacts' details), a last collection before any peer is left, a failed switch
// changing nothing, Turn off telling contacts to write directly, and a backup made while a peer drains. Needs MAILBOX_PEER_DIR.
// Run: MAILBOX_PEER_DIR=... node tools/swarm-switch-test.mjs
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { startSocks } from './swarm-socks.mjs';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PEER = process.env.MAILBOX_PEER_DIR;
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + String(x).slice(0, 300) + ']')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await f()) return true; await sleep(30); } return false; };
if (!PEER || !existsSync(join(PEER, 'test/helpers.mjs'))) { console.log('(set MAILBOX_PEER_DIR to a mailbox-peer source folder to run this)\n\n0 passed, 0 failed'); process.exit(0); }

const require = createRequire(import.meta.url);
require(join(APP, 'lib/sealed.js')).setKey(randomBytes(32));
const PC = require(join(APP, 'lib/swarm/peerclient.js')), S = require(join(APP, 'lib/swarm/seal.js'));
const Own = require(join(APP, 'lib/swarm/own.js')), Collect = require(join(APP, 'lib/swarm/collect.js'));
const ph = await import(pathToFileURL(join(PEER, 'test/helpers.mjs')).href);
const live = { get t() { return Date.now(); }, set t(_) {} };
const hA = await ph.startPeer({ clock: live, waitMax: 2 }), hB = await ph.startPeer({ clock: live, waitMax: 2 });
const PA = 'p'.repeat(56) + '.anyone', PB = 'r'.repeat(56) + '.anyone', ANA = 'a'.repeat(56) + '.anyone';
const down = { A: false, B: false };          // a peer that can't be reached
const socks = await startSocks((host) => (host === PA && !down.A ? { path: hA.sock } : host === PB && !down.B ? { path: hB.sock } : 'refuse'));
const dropAll = () => { socks.dropAll(); for (const c of clients.values()) c.close(); clients.clear(); };          // open routes cut too
const FAST = { connectMs: 2000, connectColdMs: 3000 };
const clients = new Map(); const clientFor = (a) => { if (!clients.has(a)) clients.set(a, PC.create({ address: a, socksUrl: socks.url, timing: FAST })); return clients.get(a); };
const sender = (a) => clientFor(a);

const clock = { skew: 0 }; const now = () => Date.now() + clock.skew;
let collect = null; const got = [];
const mk = (dir) => { const o = Own.create({ dataDir: dir, clientFor, contacts: () => [ANA], now, beforeLeave: (a) => (collect ? collect.sessionNow(a) : Promise.resolve()) }); o.on('changed', () => collect && collect.pump()); return o; };          // as lib/swarm/backend.js wires them
const startCollect = (own) => { collect = Collect.create({ own, clientFor, accept: async (env) => { got.push(env.ct); return 'stored'; } }); collect.start(); return collect; };          // the drops' own clock: real time
const drop = async (d, address, n) => {
  const p = d.peers.find((x) => x.address === address);
  const ct = randomBytes(24).toString('base64');
  const { body } = S.sealDrop({ env: { from: ANA, dh: 'x', pn: 0, n, ct, stamp: 's' }, peerAddress: address, pk: S.fromB64u(p.pk), expiry: S.expiryAfter(3600) });
  await sender(address).drop({ token: p.token, kid: p.kid, expiry: S.expiryAfter(3600), body });
  return ct;
};
try {
  console.log('1. Switch');
  const own = mk(mkdtempSync(join(tmpdir(), 'swarm-sw-')));
  await own.join(PA, (await hA.store.createInvite({})).invite);
  const d1 = own.detailsFor(ANA);
  startCollect(own);
  let e1; try { await own.switchPeer(PA, PB, '0'.repeat(32)); } catch (e) { e1 = e; }
  ok('a switch with a bad invite: refused, and nothing changes', e1 && own.list().length === 1 && own.list()[0].state === 'active' && own.detailsFor(ANA).peers[0].address === PA);
  await own.switchPeer(PA, PB, (await hB.store.createInvite({})).invite);
  const d2 = own.detailsFor(ANA);
  ok('switched: contacts\' details name only the new peer, with a higher seq', d2.peers.length === 1 && d2.peers[0].address === PB && d2.seq > d1.seq);
  const old = own.list().find((p) => p.address === PA);
  ok('…the old peer drains for 8 days', old && old.state === 'draining' && Math.abs(old.drainUntil - now() - 8 * 86400e3) < 60e3);
  const ctOld = await drop(d1, PA, 1);
  ok('a contact still holding the old details: the draining peer is still collected', await until(() => got.includes(ctOld)));
  const ctNew = await drop(d2, PB, 2);
  ok('…and the new peer too', await until(() => got.includes(ctNew)));
  const bkDrain = JSON.parse(JSON.stringify(own.backup()));
  ok('a backup made while a peer drains keeps it draining, with its date', bkDrain.peers.some((p) => p.address === PA && p.state === 'draining' && p.drainUntil === old.drainUntil));
  // 8 days later: a last collection, then the old peer is left
  collect.stop(); await sleep(200);
  const ctLast = await drop(d1, PA, 3);
  clock.skew = 8 * 86400e3 + 60e3;
  await own.sync(); await own.settled();
  ok('8 days on: a last collection first (nothing waiting there is lost)', got.includes(ctLast));
  ok('…then the old peer is left: gone from the list', !own.list().some((p) => p.address === PA));
  let r1; try { await drop(d1, PA, 4); } catch (e) { r1 = e; }
  ok('…and it no longer takes drops for that mailbox', r1 && (r1.status === 403 || r1.status === 404));
  clock.skew = 0;

  console.log('2. Remove');
  const ctWaiting = await drop(d2, PB, 5);          // nothing is collecting now: it waits at the peer
  const s0 = own.seq();
  await own.leave(PB);
  ok('Remove: what waited there is collected one last time', got.includes(ctWaiting));
  ok('…contacts get details without it (seq up)', own.seq() > s0 && own.detailsFor(ANA).peers.length === 0);
  ok('…and the peer was told', own.list().length === 0);

  console.log('3. Turn off');
  const own2 = mk(mkdtempSync(join(tmpdir(), 'swarm-off-')));
  await own2.join(PA, (await hA.store.createInvite({})).invite);
  const d3 = own2.detailsFor(ANA);
  startCollect(own2);
  ok('Turn off: one peer now draining', own2.turnOff() === 1 && own2.list()[0].state === 'draining');
  const d4 = own2.detailsFor(ANA);
  ok('…contacts get details with no peers ("write to me directly"), seq up', d4.peers.length === 0 && d4.seq > d3.seq);
  const ctOff = await drop(d3, PA, 6);
  ok('…what contacts drop meanwhile is still collected for 8 days', await until(() => got.includes(ctOff)));
  collect.stop();

  console.log('3b. The third audit\'s findings: unreachable peers and racing actions');
  {
    const own4 = mk(mkdtempSync(join(tmpdir(), 'swarm-a6-')));
    await own4.join(PB, (await hB.store.createInvite({})).invite);
    const dB = own4.detailsFor(ANA);
    collect && collect.stop(); collect = null;
    startCollect(own4); collect.stop();          // a collector for the last collections, not running live
    const ctHeld = await drop(dB, PB, 20);
    down.B = true; dropAll();
    const rm = await own4.leave(PB);
    ok('Remove while the peer is unreachable: not left yet ("collecting what waits there")', rm.collectPending === true && own4.list().some((p) => p.address === PB && p.state === 'draining' && p.collectPending));
    down.B = false;
    await own4.kick(); await own4.settled();          // the network back: the waiting retry goes at once
    ok('…once it answers: the last collection takes what waited, then it is left', got.includes(ctHeld) && !own4.list().some((p) => p.address === PB));
    // a switch while the new peer can't be reached: kept as an intent and finished by itself
    const own5 = mk(mkdtempSync(join(tmpdir(), 'swarm-a6b-')));
    await own5.join(PA, (await hA.store.createInvite({})).invite);
    down.B = true; dropAll();
    let e5; try { await own5.switchPeer(PA, PB, (await hB.store.createInvite({})).invite); } catch (e) { e5 = e; }
    ok('a switch with no route to the new peer: said to be pending; the old peer stays listed meanwhile', e5 && e5.pending && own5.list().find((p) => p.address === PA)?.state === 'active' && own5.detailsFor(ANA).peers[0].address === PA);
    let e6; try { await own5.switchPeer(PA, PB, (await hB.store.createInvite({})).invite); } catch (e) { e6 = e; }
    ok('…a second switch of the same peer meanwhile is refused', e6 && e6.code === 'already');
    down.B = false; await own5.sync();
    ok('…the new peer answers: it is listed, and only then does the old one drain', own5.detailsFor(ANA).peers.map((p) => p.address).join() === PB && own5.list().find((p) => p.address === PA)?.state === 'draining');
    // Remove during a pending switch: the removed peer doesn't come back
    const own6 = mk(mkdtempSync(join(tmpdir(), 'swarm-a6c-')));
    await own6.join(PA, (await hA.store.createInvite({})).invite);
    down.B = true; dropAll();
    try { await own6.switchPeer(PA, PB, (await hB.store.createInvite({})).invite); } catch {}
    await own6.leave(PA);
    down.B = false; await own6.sync(); await own6.sync();
    ok('Remove during a pending switch: the removed peer stays removed when the switch finishes', !own6.list().some((p) => p.address === PA) && own6.list().find((p) => p.address === PB)?.state === 'active');
    // Turn off while a join is pending: its answer is left at once, nothing orphaned
    const own7 = mk(mkdtempSync(join(tmpdir(), 'swarm-a6d-')));
    down.A = true; dropAll();
    try { await own7.join(PA, (await hA.store.createInvite({})).invite); } catch {}
    own7.turnOff();
    ok('Turn off with a join pending: it is cancelled (not listed)', own7.list().length === 0);
    const before = hA.store.mailboxes ? hA.store.mailboxes.size : null;
    down.A = false; await own7.sync(); await own7.sync();
    ok('…when the peer answers, that mailbox is left at once (no orphan)', own7.list().length === 0 && own7.backup().peers.length === 0, before);
    // a draining peer taken back, no invite needed
    const own8 = mk(mkdtempSync(join(tmpdir(), 'swarm-a6e-')));
    await own8.join(PA, (await hA.store.createInvite({})).invite);
    own8.turnOff();
    const back = await own8.join(PA, '');
    ok('after Turn off, a draining peer is taken back as it is (no invite)', back.back === true && own8.list()[0].state === 'active' && own8.detailsFor(ANA).peers.length === 1);
  }

  console.log('3c. The fourth audit\'s findings (fake peers: timing and limits)');
  {
    const PEERS = ['k', 'l', 'm', 'n', 'o'].map((c) => c.repeat(56) + '.anyone');
    const fake = (opts = {}) => {
      let n = 0;
      return { joins: () => n, client: (a) => ({
        join: async () => { n++; await sleep(opts.joinMs || 0); if (opts.joinDown) throw Object.assign(new Error('no route'), { kind: 'network' }); return { mailbox: randomBytes(16).toString('hex') }; },
        tokens: async () => ({ tokens: 1, kids: [] }), leave: async () => ({ ok: true }), info: async () => ({ kids: [], lastCollect: 0, heldDrops: 0, heldBytes: 0, quota: 1 }),
        toLocal: (x) => x, clockOffset: () => 0 }) };
    };
    const inv = () => randomBytes(16).toString('hex');
    // H1: a cancelled join, with a second request for it under way, never comes back as a listed peer without its key
    { const f = fake({ joinMs: 200 }); const o = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-c1-')), clientFor: f.client, contacts: () => [ANA] });
      const j = o.join(PEERS[0], inv()).catch((e) => e);
      await sleep(20); const sy = o.sync(); await o.leave(PEERS[0]); await j; await sy; await o.sync();
      ok('a join cancelled while its request (and a retry) is under way: one request, never listed, no keyless peer', f.joins() === 1 && !o.list().some((p) => p.state === 'active') && !(o.detailsFor(ANA)?.peers || []).length, JSON.stringify(o.list())); }
    // M1: "Keep using it" can't go past 4 listed peers
    { const f = fake(); const o = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-c2-')), clientFor: f.client, contacts: () => [ANA] });
      for (let i = 0; i < 4; i++) await o.join(PEERS[i], inv());
      o.turnOff();
      for (const c of ['za', 'zb', 'zc']) await o.join(c.padEnd(56, 'z') + '.anyone', inv());
      const listedBefore = o.list().filter((p) => p.state === 'active').length;
      const r1 = await o.join(PEERS[0], '').catch((e) => e);
      const r2 = await o.join(PEERS[1], '').catch((e) => e);
      const listed = o.list().filter((p) => p.state === 'active').length;
      ok('"Keep using it" stops at 4 listed peers (contacts refuse details with more)', listedBefore === 3 && listed === 4 && !r1.code && r2.code === 'too-many', `${listedBefore} → ${listed} ${r1.code} ${r2.code}`); }
    // M2 and M3: a pending switch survives backup and restore; draining peers never push a listed one out
    { const f = fake({ joinDown: true }); const fUp = fake();
      const D = mkdtempSync(join(tmpdir(), 'swarm-c3-'));
      const o = Own.create({ dataDir: D, clientFor: fUp.client, contacts: () => [ANA] });
      for (let i = 0; i < 4; i++) await o.join(PEERS[i], inv());
      o.turnOff();          // 4 draining
      for (const c of ['qa', 'qb', 'qc']) await o.join(c.padEnd(56, 'q') + '.anyone', inv());
      const bk = JSON.parse(JSON.stringify(o.backup()));
      const r = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-c3r-')), clientFor: fUp.client, contacts: () => [ANA] });
      r.restore(bk);
      ok('restore with 4 draining and 3 active peers: every active one kept', r.list().filter((p) => p.state === 'active').length === 3 && r.list().length === 7, JSON.stringify(r.list().map((p) => p.state)));
      const o2 = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-c3b-')), clientFor: (a) => (a === PEERS[4] ? f.client(a) : fUp.client(a)), contacts: () => [ANA] });
      await o2.join(PEERS[0], inv());
      await o2.switchPeer(PEERS[0], PEERS[4], inv()).catch(() => {});
      const bk2 = JSON.parse(JSON.stringify(o2.backup()));
      const r2 = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-c3c-')), clientFor: fUp.client, contacts: () => [ANA] });
      r2.restore(bk2); r2.start(); await sleep(100); await r2.sync(); await sleep(100); r2.stop();
      ok('a switch still pending when the backup was made finishes after the restore: the old peer drains', bk2.peers.some((p) => p.replaces === PEERS[0]) && r2.list().find((p) => p.address === PEERS[0])?.state === 'draining' && r2.list().find((p) => p.address === PEERS[4])?.state === 'active', JSON.stringify(r2.list().map((p) => [p.address[0], p.state]))); }
    // M4: a cancelled join no longer blocks joining that peer again
    { const f = fake({ joinDown: true }); const o = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-c4-')), clientFor: (a) => f.client(a), contacts: () => [ANA] });
      await o.join(PEERS[0], inv()).catch(() => {}); await o.leave(PEERS[0]);
      const up = fake(); const o2 = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-c4b-')), clientFor: up.client, contacts: () => [ANA] });
      void o2;
      let e; try { await o.join(PEERS[0], inv()); } catch (x) { e = x; }
      ok('a cancelled join doesn\'t block joining the same peer again with a new invite', !e || e.pending, e && e.code); }
    // L1 and L3: a last collection that keeps failing is said once; a clock jump alone never gives up
    { const f = fake(); const sk = { t: Date.now() };
      const o = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-c5-')), clientFor: f.client, contacts: () => [ANA], now: () => sk.t, beforeLeave: async () => false });
      await o.join(PEERS[0], inv());
      let changes = 0; o.on('changed', () => changes++);
      await o.leave(PEERS[0]);
      for (let i = 0; i < 4; i++) { sk.t += 3600e3; await o.sync(); await o.settled(); }
      ok('a last collection that keeps failing: said once, not at every try', changes <= 2 && o.list()[0]?.collectPending, changes);
      sk.t += 31 * 86400e3; await o.sync(); await o.settled();
      ok('a 31-day clock jump alone doesn\'t give up on it (tries are counted too)', o.list().some((p) => p.address === PEERS[0] && p.state === 'draining')); }
  }

  console.log('3d. What the app explains (health and problems)');
  {
    const ck = { t: Date.now() };
    let info = { heldBytes: 0, quota: 1000, kids: [], lastCollect: 0, heldDrops: 0 };
    let offset = 0;
    const fc = (a) => ({ join: async () => ({ mailbox: randomBytes(16).toString('hex') }), tokens: async () => ({ tokens: 1, kids: [] }), leave: async () => ({ ok: true }),
      info: async () => info, toLocal: (x) => x, clockOffset: () => offset });
    const P1 = 's'.repeat(56) + '.anyone', P2 = 't'.repeat(56) + '.anyone';
    const o = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-h-')), clientFor: fc, contacts: () => [ANA], now: () => ck.t });
    await o.join(P1, randomBytes(16).toString('hex'));
    const codes = () => o.problems().map((p) => p.code).sort().join();
    ok('all well: no problems', codes() === '');
    o.noteHealth(P1, false); ck.t += 3 * 60e3;
    ok('the only peer unreachable for more than 2 minutes: "your mailbox can\'t be reached"', codes() === 'all-unreachable');
    ok('…its row says since when', o.list()[0].unreachableSince > 0);
    o.noteHealth(P1, true);
    ok('an answer again: the problem goes', codes() === '');
    await o.join(P2, randomBytes(16).toString('hex'));
    o.noteHealth(P2, false); ck.t += 3 * 60e3;
    ok('one of two peers unreachable: named, and the other carries on', codes() === 'peer-unreachable' && o.problems()[0].peer === P2);
    ck.t += 7 * 86400e3; o.noteHealth(P1, true);
    ok('a week without an answer: "switch or remove it"', codes() === 'peer-gone-week');
    await o.leave(P2);
    o.markLost(P1);
    ok('one "no such mailbox" answer alone: not yet lost (it is asked again first)', !codes().includes('mailbox-lost'));
    o.markLost(P1);
    ok('…nor a second one at once', !codes().includes('mailbox-lost'));
    ck.t += 3 * 60e3; o.markLost(P1);
    ok('a peer that no longer knows our mailbox: said, and no longer offered to contacts', codes().includes('mailbox-lost') && (o.detailsFor(ANA)?.peers || []).length === 0);
    await o.leave(P1);
    const o2 = Own.create({ dataDir: mkdtempSync(join(tmpdir(), 'swarm-h2-')), clientFor: fc, contacts: () => [ANA], now: () => ck.t });
    await o2.join(P1, randomBytes(16).toString('hex'));
    info = { ...info, heldBytes: 950 }; offset = 3 * 3600e3;
    o2.start(); await until(() => o2.list()[0]?.quota, 8000); o2.stop();
    ok('usage from the peer every hour: shown in its row', o2.list()[0].heldBytes === 950 && o2.list()[0].quota === 1000);
    ok('nearly full and a clock three hours off: both said', codes.call(null) === '' && o2.problems().map((p) => p.code).sort().join() === 'clock-off,nearly-full' && o2.problems().find((p) => p.code === 'clock-off').minutes === 180);
    ok('…with one peer, the peer is named (theirs or ours: we can\'t tell)', o2.problems().find((p) => p.code === 'clock-off').peer === P1);
    await o2.join(P2, randomBytes(16).toString('hex'));
    o2.start(); await until(() => o2.list().find((p) => p.address === P2)?.quota, 8000); o2.stop();
    ok('two peers agreeing our clock is 3 hours off: "your computer\'s clock"', o2.problems().some((p) => p.code === 'clock-off-mine' && p.minutes === 180) && !o2.problems().some((p) => p.code === 'clock-off'));
    ck.t += 3 * 3600e3;
    ok('clock offsets older than 2 hours: not said any more', !o2.problems().some((p) => /^clock-off/.test(p.code)));
    // not ready (no network yet, or Anyone still starting): failures aren't counted
    let rdy = false;
    const d3 = mkdtempSync(join(tmpdir(), 'swarm-h3-'));
    const o3 = Own.create({ dataDir: d3, clientFor: fc, contacts: () => [ANA], now: () => ck.t, ready: () => rdy });
    await o3.join(P1, randomBytes(16).toString('hex'));
    o3.noteHealth(P1, false); ck.t += 3 * 60e3;
    ok('while the app is not ready, a failed call is not "unreachable"', o3.problems().length === 0);
    rdy = true; o3.noteHealth(P1, false); ck.t += 3 * 60e3;
    ok('once ready: it is', o3.problems().map((p) => p.code).join() === 'all-unreachable');
    o3.stop();
    const o4 = Own.create({ dataDir: d3, clientFor: fc, contacts: () => [ANA], now: () => ck.t, ready: () => true });
    ok('after a restart, failures from the last run aren\'t said until this run sees one', o4.problems().length === 0);
    o4.noteHealth(P1, false); ck.t += 3 * 60e3;
    ok('…and then they are', o4.problems().map((p) => p.code).join() === 'all-unreachable');
  }

  console.log('4. Restore while a peer drains');
  const own3 = mk(mkdtempSync(join(tmpdir(), 'swarm-rd-')));
  const bk2 = JSON.parse(JSON.stringify(own2.backup()));
  own3.restore(bk2); own3.start();
  ok('restored: the peer is still draining, with its date', await until(() => !own3.restoredPending) && own3.list()[0].state === 'draining' && own3.list()[0].drainUntil === own2.list()[0].drainUntil);
  ok('…and not in contacts\' details', (own3.detailsFor(ANA)?.peers || []).length === 0);
  own3.stop();
} finally { if (collect) collect.stop(); for (const c of clients.values()) c.close(); socks.close(); await hA.stop(); await hB.stop(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
