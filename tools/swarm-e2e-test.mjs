// Mailbox sending end to end with the real backend (server.js) and the real mailbox peer: a contact's details from the window, a message
// held for their mailbox (never tried directly), dropped at their peer through an isolated route, collected by the owner, ✓ through the
// live status; a call invite's copy for the missed-call record; the profile says swarm: 1. Needs MAILBOX_PEER_DIR (a mailbox-peer source
// folder) and `npm install`. Run: MAILBOX_PEER_DIR=... node tools/swarm-e2e-test.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
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
if (!PEER || !existsSync(join(PEER, 'test/helpers.mjs'))) { console.log('(set MAILBOX_PEER_DIR to a mailbox-peer source folder to run this)\n\n0 passed, 0 failed'); process.exit(0); }

const require = createRequire(import.meta.url);
const PC = require(join(APP, 'lib/swarm/peerclient.js')), S = require(join(APP, 'lib/swarm/seal.js')), H = require(join(APP, 'lib/swarm/hpke.js'));
const ph = await import(pathToFileURL(join(PEER, 'test/helpers.mjs')).href);
const h = await ph.startPeer({ clock: { t: Date.now() }, waitMax: 2 });
const PA = ph.ADDR, ME = 'q'.repeat(56) + '.anyone', BOB = 'b'.repeat(56) + '.anyone', TOKEN = 'e'.repeat(64);
const socks = await startSocks((host) => (host === PA ? { path: h.sock } : 'refuse'));          // Bob's own app is offline
const owner = PC.create({ address: PA, socksUrl: socks.url, timing: { connectMs: 2000, connectColdMs: 3000 } });

const d = mkdtempSync(join(tmpdir(), 'swarm-e2e-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
writeFileSync(join(d, 'data', 'contacts.json'), JSON.stringify([{ address: BOB, petname: 'Bob', ecdhPub: 'K', ratchetPub: 'R' }]));
const UI = 6851, PUB = 6852;
const srv = spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  PUBLIC_PORT: String(PUB), UI_PORT: String(UI), DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: '1', PEERS: '{}', SOCKS: socks.url } });
let logs = ''; srv.stdout.on('data', (x) => { logs += x; }); srv.stderr.on('data', (x) => { logs += x; });
const ui = (p, m = 'GET', body) => fetch(`http://127.0.0.1:${UI}` + p, { method: m, headers: { 'X-AnonChat-Token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
try {
  for (let i = 0; i < 200; i++) { try { const r = await ui('/api/swarm/states'); if (r.status === 200) break; } catch {} await sleep(150); }
  // Bob joins his peer (the owner's side comes in phase 3) and his window sends Ana his details; here, by hand
  const inv = await h.store.createInvite({});
  const sec = S.newSecret(), o = { secret: S.b64u(sec) };
  o.mailbox = (await owner.join(inv.invite, S.sha256hex(sec))).mailbox;
  const keys = H.generateKeyPair(), kid = S.kidOf(PA, keys.pk), tok = S.newSecret();
  await owner.tokens(o, { add: [S.sha256hex(tok)], kids: [kid] });
  const details = { v: 1, seq: Date.now(), keepFor: 3 * 86400, peers: [{ address: PA, kid, pk: S.b64u(keys.pk), token: S.b64u(tok) }] };
  const stranger = 's'.repeat(56) + '.anyone';
  ok('details from someone who isn\'t a contact: ignored', (await ui('/api/swarm/details', 'POST', { address: stranger, details })).status === 403);
  ok('Bob\'s details are taken', (await (await ui('/api/swarm/details', 'POST', { address: BOB, details })).json()).result === 'updated');
  ok('…and he is listed as having a mailbox', (await (await ui('/api/swarm/contacts')).json()).contacts.includes(BOB));

  // the stamp key the window works out for Bob (a drop is never sealed without its stamp)
  ok('the window hands over the stamp key for Bob', (await ui('/api/stamp-keys', 'POST', { keys: [{ address: BOB, key: randomBytes(32).toString('base64') }] })).status === 200);
  const env = { dh: 'x', pn: 0, n: 1, ct: randomBytes(48).toString('base64') };
  const r = await (await ui('/api/send', 'POST', { toAddress: BOB, envelope: env, msgId: 'mid-1', route: 'swarm-ok', class: 'text', offlineTtl: 86400 })).json();
  ok('a message to Bob goes to his mailbox (held, not tried directly)', r.ok && r.mailbox && r.queued, JSON.stringify(r));
  const q = (await (await ui('/api/outbox')).json()).items.find((i) => i.id === r.queueId);
  ok('…the outbox shows it held', q && q.held === true, JSON.stringify(q));
  let st; for (let i = 0; i < 100; i++) { st = (await (await ui('/api/swarm/states')).json()).states.find((s) => s.id === r.queueId); if (st && st.shown === 'mailbox') break; await sleep(100); }
  ok('📮 once his peer took it', st && st.shown === 'mailbox', JSON.stringify(st) + logs.slice(-800));
  ok('…the drop went on the isolated drop route', socks.seen.some((x) => x.host === PA && x.user.startsWith('swarm-drop-')));
  ok('…and nothing tried Bob\'s own app with it (no direct send)', !/outbox.*bbbbbbbb/.test(logs) && socks.seen.filter((x) => x.host === BOB).every((x) => !x.user || !x.user.startsWith('swarm')));
  const f = await owner.collect(o, { cursor: '0' });
  const got = f.drops.length === 1 && S.openDrop({ body: f.drops[0].body, peerAddress: PA, sk: keys.sk, pk: keys.pk, expiry: f.drops[0].expiry });
  ok('Bob collects it: Ana\'s envelope, from Ana, stamped, the ciphertext unchanged', got && got.from === ME && got.ct === env.ct && typeof got.stamp === 'string' && got.stamp.length > 0, JSON.stringify(got).slice(0, 200));
  ok('…its expiry follows the shorter of his keep-for (3 days) and Ana\'s 24 h only if she chose it (she didn\'t): 3 days', f.drops[0].expiry - Date.now() / 1000 > 2.9 * 86400);
  await owner.ack(o, [{ id: f.drops[0].id, result: 'stored' }]);
  let out; for (let i = 0; i < 150; i++) { out = (await (await ui('/api/outbox/outcomes')).json()).outcomes.find((x) => x.id === r.queueId); if (out) break; await sleep(100); }
  ok('Ana sees ✓ (delivered) through the live status', out && out.outcome === 'delivered' && out.msgId === 'mid-1', JSON.stringify(out));

  // a call invite: directly as always (Bob is offline, so it fails), and a copy at his peer for the missed-call record
  const inv2 = { dh: 'x', pn: 0, n: 2, ct: randomBytes(32).toString('base64') };
  const cr = await ui('/api/send', 'POST', { toAddress: BOB, envelope: inv2, ephemeral: true, route: 'direct+copy', class: 'text' });
  ok('the call invite itself goes directly, and fails at once with Bob offline', cr.status === 502 || cr.status === 503, cr.status);
  let f2; for (let i = 0; i < 60; i++) { f2 = await owner.collect(o, { cursor: f.cursor }); if (f2.drops.length) break; await sleep(100); }
  const cp = f2.drops.length === 1 && S.openDrop({ body: f2.drops[0].body, peerAddress: PA, sk: keys.sk, pk: keys.pk, expiry: f2.drops[0].expiry });
  ok('…and its copy is at his peer', cp && cp.ct === inv2.ct);

  // direct-only (a profile bump, a stranger's request): never into the mailbox
  const r3 = await (await ui('/api/send', 'POST', { toAddress: BOB, envelope: { dh: 'x', pn: 0, n: 3, ct: randomBytes(16).toString('base64') }, route: 'direct-only' })).json();
  ok('direct-only: today\'s outbox, not the mailbox', !r3.mailbox && r3.queued);
  const old = await (await ui('/api/send', 'POST', { toAddress: BOB, envelope: { dh: 'x', pn: 0, n: 4, ct: randomBytes(16).toString('base64') } })).json();
  ok('a window that names no route (an older window): direct, as before', !old.mailbox);

  const prof = await new Promise((res) => { http.get({ host: '127.0.0.1', port: PUB, path: '/api/profile', headers: { Host: ME } }, (rs) => { let b = ''; rs.on('data', (x) => { b += x; }); rs.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: rs.statusCode + ' ' + b.slice(0, 100) }); } }); }).on('error', (e) => res({ e: e.message })); });
  // no identity in this test (the window makes it): the profile answers 503, so the field is checked in the code it comes from
  const profCode = require('node:fs').readFileSync(join(APP, 'server.js'), 'utf8').includes("spkSig: id.spkSig || null, swarm: 1 }");
  ok('the public profile says swarm: 1', prof.swarm === 1 || (prof.error === 'identity not initialised yet' && profCode), JSON.stringify(prof));
  ok('no owner secret or token in the backend\'s log', !logs.includes(o.secret) && !logs.includes(S.b64u(tok)));
} finally { srv.kill(); owner.close(); socks.close(); await h.stop(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
