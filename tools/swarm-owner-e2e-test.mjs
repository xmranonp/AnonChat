// Both halves of the mailbox, end to end: two real backends (Ana and Bob) and the real mailbox peer. Bob joins the peer with an invite
// (a test build), his window hands Ana his details, Ana writes while Bob's app can't be reached directly, Bob's backend collects the
// message from his peer and stores it for his window (marked as from the mailbox, stamped, checked), Ana sees ✓. Then: a copy of the same
// message is stored once; a message without a valid stamp is discarded and Ana sends directly; Bob leaves and Ana's app writes directly
// again. Needs MAILBOX_PEER_DIR and `npm install`. Run: MAILBOX_PEER_DIR=... node tools/swarm-owner-e2e-test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createECDH } from 'node:crypto';
import { startSocks } from './swarm-socks.mjs';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PEER = process.env.MAILBOX_PEER_DIR;
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + String(x).slice(0, 400) + ']')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { try { v = await f(); if (v) return v; } catch {} await sleep(150); } return v; };
if (!PEER || !existsSync(join(PEER, 'test/helpers.mjs'))) { console.log('(set MAILBOX_PEER_DIR to a mailbox-peer source folder to run this)\n\n0 passed, 0 failed'); process.exit(0); }

const ph = await import(pathToFileURL(join(PEER, 'test/helpers.mjs')).href);
const h = await ph.startPeer({ clock: { get t() { return Date.now(); }, set t(_) {} }, waitMax: 3 });
const PA = ph.ADDR, ANA = 'a'.repeat(56) + '.anyone', BOB = 'b'.repeat(56) + '.anyone', TOKEN = 'f'.repeat(64);
let bobReachable = false;
const nodes = {};
const socks = await startSocks((host) => (host === PA ? { path: h.sock } : (host === BOB && bobReachable) ? { port: nodes.bob.pub } : 'refuse'));
const STAMP = randomBytes(32).toString('base64');          // the key both windows work out for this pair
let logs = '';
function start(name, me, other, port, env = {}, { dir = null, noContacts = false } = {}) {
  const d = dir || mkdtempSync(join(tmpdir(), `swarm-${name}-`));
  if (!dir) {
    mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
    writeFileSync(d + '/anon/anon_service/hostname', me + '\n');
    if (!noContacts) writeFileSync(join(d, 'data', 'contacts.json'), JSON.stringify([{ address: other, petname: name === 'ana' ? 'Bob' : 'Ana', ecdhPub: 'K', ratchetPub: 'R' }]));
  }
  const p = spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PUBLIC_PORT: String(port + 1), UI_PORT: String(port),
    DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: '1', PEERS: '{}', SOCKS: socks.url, ...env } });
  p.stdout.on('data', (x) => { logs += x; }); p.stderr.on('data', (x) => { logs += x; });
  return { p, ui: port, pub: port + 1, dir: d };
}
const ui = (n, p, m = 'GET', body) => fetch(`http://127.0.0.1:${nodes[n].ui}` + p, { method: m, headers: { 'X-AnonChat-Token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const J = async (n, p, m, b) => (await ui(n, p, m, b)).json();
// What Ana's window does: a message encrypted by her ratchet (here, any ciphertext: the backends never read it)
const msg = (n) => ({ dh: 'x', pn: 0, n, ct: randomBytes(64).toString('base64') });
try {
  nodes.ana = start('ana', ANA, BOB, 6861);
  nodes.bob = start('bob', BOB, ANA, 6871, { ANONCHAT_SWARM_TEST: '1' });
  for (const n of ['ana', 'bob']) for (let i = 0; i < 200; i++) { try { if ((await ui(n, '/api/swarm/own')).status === 200) break; } catch {} await sleep(150); }
  ok('both windows hand over the stamp key for the other', (await ui('ana', '/api/stamp-keys', 'POST', { keys: [{ address: BOB, key: STAMP }] })).status === 200
    && (await ui('bob', '/api/stamp-keys', 'POST', { keys: [{ address: ANA, key: STAMP }] })).status === 200);

  console.log('1. Bob joins his peer');
  ok('Ana\'s build doesn\'t offer joining', (await J('ana', '/api/swarm/own')).joinAllowed === false && (await ui('ana', '/api/swarm/join', 'POST', { address: PA, invite: '0'.repeat(32) })).status === 403);
  const bad = await J('bob', '/api/swarm/join', 'POST', { address: PA, invite: '1'.repeat(32) });
  ok('an unknown invite: refused with a reason the window can show', bad.error === 'invite-unknown', JSON.stringify(bad));
  const inv = await h.store.createInvite({});
  const j = await J('bob', '/api/swarm/join', 'POST', { address: PA, invite: inv.invite });
  ok('Bob joins with the invite', j.ok && j.address === PA, JSON.stringify(j));
  const own = await J('bob', '/api/swarm/own');
  ok('…his settings list the peer, with a token for his one contact', own.peers.length === 1 && own.peers[0].contacts === 1, JSON.stringify(own));
  ok('Ana\'s frames carry sw: 1: Bob\'s window is told to send her his details', (await J('bob', '/api/swarm/capable', 'POST', { address: ANA })).send === true);
  const { details } = await J('bob', `/api/swarm/details-for?address=${ANA}`);
  ok('…the frame names his peer, its key and Ana\'s token', details && details.peers.length === 1 && details.peers[0].address === PA);
  await J('bob', '/api/swarm/details-sent', 'POST', { address: ANA, seq: details.seq });
  ok('…and once sent, she isn\'t due them again', !(await J('bob', '/api/swarm/due')).contacts.includes(ANA));
  ok('Ana\'s window passes the frame to her backend', (await J('ana', '/api/swarm/details', 'POST', { address: BOB, details })).result === 'updated');

  console.log('2. Ana writes; Bob\'s app can\'t be reached directly');
  const m1 = msg(1);
  const r1 = await J('ana', '/api/send', 'POST', { toAddress: BOB, envelope: m1, msgId: 'm1', route: 'swarm-ok', class: 'text' });
  ok('the message goes to Bob\'s mailbox', r1.mailbox === true && r1.queued, JSON.stringify(r1));
  const got = await until(async () => (await J('bob', '/api/messages')).find((e) => e.ct === m1.ct));
  ok('Bob\'s backend collected it and stored it for his window', !!got, logs.slice(-600));
  ok('…marked as from his mailbox, from Ana, with when it was written', got && got.src === 'mailbox' && got.from === ANA && Math.abs(got.receivedAt - Date.now()) < 120000);
  const out = await until(async () => (await J('ana', '/api/outbox/outcomes')).outcomes.find((o) => o.id === r1.queueId));
  ok('Ana sees ✓', out && out.outcome === 'delivered', JSON.stringify(out));
  ok('…and nothing reached Bob directly', !socks.seen.some((x) => x.host === BOB));

  console.log('3. Checks on what is collected');
  // a copy of the same ciphertext (Ana sent it again, or a second peer): stored once
  const r2 = await J('ana', '/api/send', 'POST', { toAddress: BOB, envelope: m1, msgId: 'm1b', route: 'swarm-ok', class: 'text' });
  const out2 = await until(async () => (await J('ana', '/api/outbox/outcomes')).outcomes.find((o) => o.id === r2.queueId));
  ok('a copy is acked as stored (✓ for Ana)…', out2 && out2.outcome === 'delivered');
  ok('…and stored once', (await J('bob', '/api/messages')).filter((e) => e.ct === m1.ct).length === 1);
  // a wrong stamp key on Ana's side: Bob's backend can't verify, discards, and Ana sends directly
  await ui('ana', '/api/stamp-keys', 'POST', { keys: [{ address: BOB, key: randomBytes(32).toString('base64') }] });
  const m3 = msg(3);
  const r3 = await J('ana', '/api/send', 'POST', { toAddress: BOB, envelope: m3, msgId: 'm3', route: 'swarm-ok', class: 'text' });
  const st3 = await until(async () => (await J('ana', '/api/swarm/states')).states.find((s) => s.id === r3.queueId && s.route === 'released'));
  ok('a bad stamp: discarded at Bob\'s, and Ana\'s app sends it directly', !!st3 && !(await J('bob', '/api/messages')).some((e) => e.ct === m3.ct), JSON.stringify(st3));
  await ui('ana', '/api/stamp-keys', 'POST', { keys: [{ address: BOB, key: STAMP }] });
  // no stamp key yet on Bob's side: not acked; taken once the key arrives
  await ui('bob', '/api/stamp-keys', 'POST', { keys: [], replace: true });
  const m4 = msg(4);
  const r4 = await J('ana', '/api/send', 'POST', { toAddress: BOB, envelope: m4, msgId: 'm4', route: 'swarm-ok', class: 'text' });
  await sleep(3000);
  ok('Bob has no stamp key for Ana yet: not taken, still 📮 for Ana', !(await J('bob', '/api/messages')).some((e) => e.ct === m4.ct)
    && (await J('ana', '/api/swarm/states')).states.find((s) => s.id === r4.queueId)?.shown === 'mailbox');
  await ui('bob', '/api/stamp-keys', 'POST', { keys: [{ address: ANA, key: STAMP }] });
  ok('…the key arrives: collected at once', !!(await until(async () => (await J('bob', '/api/messages')).find((e) => e.ct === m4.ct))));

  console.log('4. Calls');
  bobReachable = true;
  const live = msg(40);
  const lr = await ui('ana', '/api/send', 'POST', { toAddress: BOB, envelope: live, ephemeral: true, route: 'direct+copy', class: 'text' });
  const got40 = await until(async () => (await J('bob', '/api/messages')).filter((e) => e.ct === live.ct));
  await sleep(4000);
  const all40 = (await J('bob', '/api/messages')).filter((e) => e.ct === live.ct);
  ok('a call to Bob reachable directly: delivered directly, and no copy at his peer (a copy taken first would stop it ringing)', lr.status === 200 && got40 && all40.length === 1 && !all40[0].src, JSON.stringify(all40.map((e) => e.src || 'direct')));
  bobReachable = false;

  const inv5 = msg(5);
  await ui('ana', '/api/send', 'POST', { toAddress: BOB, envelope: inv5, ephemeral: true, route: 'direct+copy', class: 'text' });
  const c5 = await until(async () => (await J('bob', '/api/messages')).find((e) => e.ct === inv5.ct));
  ok('the invite\'s copy reaches Bob\'s window through his mailbox (it writes "Missed call", never rings)', c5 && c5.src === 'mailbox');

  console.log('4b. Bob restores his backup on a new computer');
  const point = () => { const e = createECDH('prime256v1'); e.generateKeys(); return e.getPublicKey().toString('base64'); };
  const { swarm: bobSwarm } = await J('bob', '/api/swarm/backup');
  ok('Bob\'s backup carries his mailbox (peer, owner secret, keys, Ana\'s token) and Ana\'s details', bobSwarm.v === 1 && bobSwarm.peers.length === 1 && bobSwarm.peers[0].tokens[ANA] && bobSwarm.capable.includes(ANA));
  nodes.bob.p.kill(); await sleep(500);
  const m7 = msg(7);
  const r7 = await J('ana', '/api/send', 'POST', { toAddress: BOB, envelope: m7, msgId: 'm7', route: 'swarm-ok', class: 'text' });
  ok('while Bob moves, Ana\'s message waits in his mailbox', !!(await until(async () => (await J('ana', '/api/swarm/states')).states.find((x) => x.id === r7.queueId && x.shown === 'mailbox'))));
  nodes.bob = start('bob2', BOB, ANA, 6881, { ANONCHAT_SWARM_TEST: '1' }, { noContacts: true });
  for (let i = 0; i < 200; i++) { try { if ((await ui('bob', '/api/swarm/own')).status === 200) break; } catch {} await sleep(150); }
  const hs = { secret: Buffer.concat([Buffer.from('== ed25519v1-secret: type0 ==\0\0\0'), randomBytes(64)]).toString('base64'),
    public: Buffer.concat([Buffer.from('== ed25519v1-public: type0 ==\0\0\0'), randomBytes(32)]).toString('base64'), hostname: BOB };
  const rs = await J('bob', '/api/restore', 'POST', { hs, contacts: [{ address: ANA, petname: 'Ana', ecdhPub: point(), ratchetPub: point() }], peers: [], groups: [], blocked: [], swarm: bobSwarm });
  ok('the restore puts his mailbox back', rs.ok && rs.mailboxes === 1, JSON.stringify(rs));
  // the app restarts after a restore
  nodes.bob.p.kill(); await sleep(500);
  nodes.bob = start('bob2', BOB, ANA, 6881, { ANONCHAT_SWARM_TEST: '1' }, { dir: nodes.bob.dir });
  for (let i = 0; i < 200; i++) { try { if ((await ui('bob', '/api/swarm/own')).status === 200) break; } catch {} await sleep(150); }
  await ui('bob', '/api/stamp-keys', 'POST', { keys: [{ address: ANA, key: STAMP }] });
  ok('after the restart Bob\'s new computer collects what waited', !!(await until(async () => (await J('bob', '/api/messages')).find((e) => e.ct === m7.ct && e.src === 'mailbox'), 30000)));
  ok('…Ana sees ✓', (await until(async () => (await J('ana', '/api/outbox/outcomes')).outcomes.find((o) => o.id === r7.queueId)))?.outcome === 'delivered');
  ok('…the mailbox was checked and seq went up, so Ana is due his details again', !!(await until(async () => (await J('bob', '/api/swarm/own')).seq > bobSwarm.seq && (await J('bob', '/api/swarm/due')).contacts.includes(ANA))));
  const { details: d3 } = await J('bob', `/api/swarm/details-for?address=${ANA}`);
  await J('bob', '/api/swarm/details-sent', 'POST', { address: ANA, seq: d3.seq });
  ok('…with the same token as before (her old details keep working meanwhile)', d3.peers[0].token === details.peers[0].token);

  console.log('5. Bob leaves');
  const s0 = (await J('bob', '/api/swarm/own')).seq;
  ok('Bob leaves his peer', (await J('bob', '/api/swarm/leave', 'POST', { address: PA })).ok === true);
  const own2 = await until(async () => { const o = await J('bob', '/api/swarm/own'); return o.peers.length === 0 && o; });
  ok('…it is gone from his settings, and the peer was told', own2 && own2.seq > s0);
  ok('…Ana is due his new details', (await J('bob', '/api/swarm/due')).contacts.includes(ANA));
  const { details: d2 } = await J('bob', `/api/swarm/details-for?address=${ANA}`);
  ok('…which say "write to me directly" (no peers)', d2 && d2.peers.length === 0);
  await J('ana', '/api/swarm/details', 'POST', { address: BOB, details: d2 });
  bobReachable = true;
  const m6 = msg(6);
  const r6 = await J('ana', '/api/send', 'POST', { toAddress: BOB, envelope: m6, msgId: 'm6', route: 'swarm-ok', class: 'text' });
  ok('Ana\'s next message goes directly', !r6.mailbox && (await until(async () => (await J('bob', '/api/messages')).find((e) => e.ct === m6.ct && !e.src))), JSON.stringify(r6));
  ok('no owner secret or token in either backend\'s log', !logs.includes(details.peers[0].token) && !logs.includes(details.peers[0].pk));
} finally { for (const n of Object.values(nodes)) n.p.kill(); socks.close(); await h.stop(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
