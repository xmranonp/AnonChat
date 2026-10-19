// Identity-key pinning and message-request test: runs the real handleInbound / ensureSession / request code from public/app.js with the
// real ratchet and real keys. Checks that nobody can pose as a contact (or have a forged request accepted) without that person's private key.
// Run: node tools/identity-pin-test.mjs

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pub = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const dir = mkdtempSync(join(tmpdir(), 'pin-'));
writeFileSync(join(dir, 'crypto.mjs'), readFileSync(join(pub, 'crypto.js')));
writeFileSync(join(dir, 'ratchet.mjs'), readFileSync(join(pub, 'ratchet.js'), 'utf8').replace("'./crypto.js'", "'./crypto.mjs'"));
const Ratchet = await import(pathToFileURL(join(dir, 'ratchet.mjs')).href);
const { b64 } = await import(pathToFileURL(join(dir, 'crypto.mjs')).href);

// Pull named functions out of app.js so the test exercises the shipped code, not a copy.
const APP = readFileSync(join(pub, 'app.js'), 'utf8');
function extract(name) {
  const m = new RegExp(`^(async )?function ${name}\\(`, 'm').exec(APP);
  if (!m) throw new Error('not found in app.js: ' + name);
  let i = APP.indexOf('{', APP.indexOf(')', m.index)), depth = 0;
  for (let j = i; j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}' && --depth === 0) return APP.slice(m.index, j + 1);
  }
  throw new Error('unbalanced: ' + name);
}
const FNS = ['identityMismatch', 'sessionMatchesPin', 'discardSession', 'pinnedSession', 'ensureSession', 'shouldAdoptResponder', 'handleInbound',
  'decodeFrame', '_processEnvelopeInner',
  'requestName', 'dropRequestBlobs', 'forgetRequest', 'expireRequests', 'isGroupFrameFromMember', 'addToRequest',
  'absorbRequestsOfContacts', 'acceptRequest', 'deleteRequest', 'blockRequest',
  'richSendAllowed', 'shownError', 'errorText', 'textOnlyError', 'deliver', 'withSessionLock', 'incomingId',
  'quoteFor', 'messageAuthorLabel', 'messageGist', 'personLabel', 'kindLabel',
  'peerByAddress', 'inAnyGroup', 'keyHolder', 'ensurePeer', 'applyGroupFrame', 'replayHeldGroupFrames', 'deliverToGroup',
  'cleanFrame', 'cleanMember', 'keepForMember', 'sendGroupWaiting', 'saveGroupWaiting', 'writtenOrderTs', 'resendOnAdoptedSession'];
// Constants the extracted functions use, read from app.js too.
const constOf = (name) => { const m = new RegExp(`^const ${name} = (.*);$`, 'm').exec(APP); if (!m) throw new Error('const not found: ' + name); return new Function(`return (${m[1]});`)(); };
const SRC = FNS.map(extract).join('\n\n');

const EC = { name: 'ECDH', namedCurve: 'P-256' };
const te = new TextEncoder(), td = new TextDecoder();
const concat = (...a) => { const t = a.reduce((n, x) => n + x.length, 0); const o = new Uint8Array(t); let f = 0; for (const x of a) { o.set(x, f); f += x.length; } return o; };
function encodeFrame(kind, meta, payload) {
  const head = te.encode(JSON.stringify({ kind, meta: meta || null }));
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, head.length);
  return concat(len, head, payload || new Uint8Array(0));
}

// The network: what each .anyone address answers to /api/identity. Only the real owner of an address can answer for it.
const NET = new Map();
const OFFLINE = new Set();

async function makeParty(name, address) {
  const ikKp = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
  const spkKp = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
  const P = {
    name, address,
    ikPrivJwk: await crypto.subtle.exportKey('jwk', ikKp.privateKey),
    ikPub: b64.enc(await crypto.subtle.exportKey('raw', ikKp.publicKey)),
    spk: { priv: await crypto.subtle.exportKey('jwk', spkKp.privateKey), pub: b64.enc(await crypto.subtle.exportKey('raw', spkKp.publicKey)) },
    ikSig: await Ratchet.genSigningKey(),
    contacts: [], serverContacts: [], blocked: [], sessions: new Map(), store: new Map(), threads: new Map(), thread: [], toasts: [], processed: new Set(),
    requests: {}, groups: [], opened: null, invitesApplied: [], wire: [], peers: [], peerFetches: 0,
  };
  P.spkSig = await Ratchet.signSPK(P.ikSig.priv, P.spk.pub);
  P.card = () => ({ address: P.address, petname: P.name, ecdhPub: P.ikPub, ratchetPub: P.spk.pub, ikSigPub: P.ikSig.pub, spkSig: P.spkSig });
  // Minimal stand-in for the backend endpoints the request code calls.
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fakeFetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (url === '/api/contacts' && opts.method === 'POST') {
      const peer = NET.get(body.address);
      if (!peer || OFFLINE.has(body.address)) return reply(502, { error: 'could not reach' });
      const card = peer.card();
      if (body.expectIk !== undefined && card.ecdhPub !== body.expectIk) return reply(409, { error: 'key_mismatch' });
      P.serverContacts = P.serverContacts.filter((c) => c.address !== body.address).concat({ ...card, petname: body.petname });
      return reply(200, card);
    }
    if (url === '/api/peers' && opts.method === 'POST') {    // as the backend: only for someone in one of our groups, keys from the address itself
      P.peerFetches++;
      if (!P.groups.some((g) => g.members.some((m) => m.address === body.address))) return reply(403, { error: 'not a group member' });
      const peer = NET.get(body.address);
      if (!peer || OFFLINE.has(body.address)) return reply(502, { error: 'could not reach' });
      const card = peer.card(); delete card.petname;
      return reply(200, card);
    }
    if (url === '/api/blocked' && opts.method === 'POST') { P.blocked.push(body.address); return reply(200, { ok: true }); }
    if (url === '/api/send') {                       // the backend hands the envelope to the peer's inbox
      const peer = NET.get(body.toAddress);
      if (peer) peer.wire.push({ id: 'w' + (++wireSeq), ...body.envelope, from: P.address, receivedAt: Date.now() });
      return reply(200, { ok: true, queued: false });
    }
    return reply(200, {});
  };
  const loadThread = (k) => { if (!P.threads.has(k)) P.threads.set(k, []); return P.threads.get(k); };
  const env = {
    Ratchet, clone: (o) => JSON.parse(JSON.stringify(o)), td, Blob, URL,
    ikPrivJwk: P.ikPrivJwk, ikPub: P.ikPub, spk: P.spk, myAddress: P.address,
    contactByAddress: (a) => P.contacts.find((c) => c.address === a),
    loadSession: (a) => P.sessions.get(a) || null,
    saveSession: (a, s) => { P.sessions.set(a, s); P.store.set('anyonechat.session.' + a, JSON.stringify(s)); },
    sessions: P.sessions,
    LS: { session: (a) => 'anyonechat.session.' + a, thread: (a) => 'anyonechat.thread.' + a },
    localStorage: { removeItem: (k) => P.store.delete(k), getItem: () => null },
    rememberMedia: (id, blob) => { P.media = P.media || new Map(); P.media.set(id, blob); },
    fields: { delete: (k) => { P.store.delete(k); return Promise.resolve(); }, get: (k) => P.store.get(k) ?? null, keys: () => [...P.store.keys()] },
    persistQueues: new Map(), corruptSessions: new Set(), persistField: () => Promise.resolve(),
    loadOPKs: () => ({}), saveOPKs: () => {}, ensureMailboxKey: async () => {}, syncMailboxKeys: async () => {},
    appendThread: (k, rec) => { P.thread.push({ k, ...rec }); loadThread(k).push(rec); },
    loadThread, threadCache: P.threads,
    toast: (m) => P.toasts.push(m),
    t: (k, v) => k + (v && v.name ? ':' + v.name : ''),
    shortAddr: (a) => a.slice(0, 8),
    markProcessed: (id) => P.processed.add(id), processedSet: () => P.processed,
    _inboundFails: new Map(), MAX_INBOUND_RETRIES: 5, _lastInboundError: null,
    fetch: fakeFetch,
    console: { warn: () => {}, log: () => {} },
    markMessagesRead: () => {}, calls: { onSignal: () => { P.rang = true; } },
    applyGroupInvite: async (e, f) => { P.invitesApplied.push({ from: e.from, meta: f.meta }); },
    applyGroupUpdate: () => {}, groupById: (id) => P.groups.find((g) => g.id === id),
    saveGroup: async () => {}, deleteGroup: async () => {}, renderGroupConv: () => {}, renderGroups: () => {}, renderConversation: () => {},
    renderRequests: () => {}, playNotification: () => {}, notifyRequest: () => {}, notifyIncoming: () => {}, askConfirm: async () => true,
    openContactChat: (c) => { P.opened = c.address; },
    loadContacts: async () => { P.contacts = [...P.serverContacts]; P.absorbRequestsOfContacts(); },
    saveRequests: () => {},
    requests: P.requests, requestBlobs: new Map(), expandedRequest: null, _requestBlobBytes: 0,
    MAX_REQUESTS: 50, MAX_REQ_ITEMS: 20, REQ_TTL_MS: 30 * 24 * 3600 * 1000, MAX_REQ_BLOB_BYTES: 25 * 1024 * 1024,
    TEXT_ONLY_KINDS: new Set(['text', 'read', 'reaction', 'accept']), encodeFrame, _sessionOpChain: Promise.resolve(),
    REPLY_KINDS: new Set(['image', 'video', 'audio', 'voice', 'file']),
    applyReaction: () => {}, selected: null, selectedGroup: null, sessionUrls: new Map(), sessionBlobs: new Map(),
    peers: P.peers, _peerFetches: new Map(), groups: P.groups, heldGroupFrames: [], HELD_GROUP_TTL: 10 * 60 * 1000, MAX_HELD_GROUP: 100,
    MEDIA_KINDS: new Set(['image', 'video', 'audio', 'voice', 'file']), MAX_EMOJI_LEN: constOf('MAX_EMOJI_LEN'), FRAME_KIND_RE: constOf('FRAME_KIND_RE'),
    THUMB_RE: constOf('THUMB_RE'), MEMBER_ADDR_RE: constOf('MEMBER_ADDR_RE'), OPK_USE_MS: 7 * 24 * 3600 * 1000,
    offerNewSession: (a, force, why) => { (P.offers = P.offers || []).push({ a, why }); },
    tellNowARequest: (a) => { (P.told = P.told || []).push(a); },
    groupWaiting: [], _groupWaitBusy: new Set(), GROUP_WAIT_MS: 24 * 3600 * 1000, GROUP_WAIT_MAX_BYTES: 64 * 1024 * 1024, GROUP_WAIT_KEY: 'gw', b64,
  };
  const names = Object.keys(env);
  const api = new Function(...names, `'use strict';\n${SRC}\nreturn { ${FNS.join(', ')} };`)(...names.map((k) => env[k]));
  Object.assign(P, api);
  P.setGroups = (list) => { P.groups.splice(0, P.groups.length, ...list); };
  P.addContact = (other) => { P.serverContacts.push(other.card()); P.contacts = [...P.serverContacts]; P.absorbRequestsOfContacts(); };
  NET.set(address, P);
  return P;
}

let seq = 0, wireSeq = 0;
// Deliver everything waiting for P (what its backend would push to the app).
async function flush(P) { const w = P.wire.splice(0); for (const e of w) await receive(P, e); return w; }
const tick = () => new Promise((r) => setTimeout(r, 20));
// `sender` encrypts to `toCard` and the envelope claims to come from `fromAddr` (the attacker sets this freely).
async function send(sender, toCard, fromAddr, textMsg, { stripX3dh = false, kind = 'text', meta = {}, payload } = {}) {
  const s = await sender.ensureSession(toCard);
  const { header, ct } = await Ratchet.ratchetEncrypt(s, encodeFrame(kind, { mid: 'm' + (++seq), ...meta }, payload || te.encode(textMsg || '')));
  sender.sessions.set(toCard.address, s);
  const env = { id: 'e' + seq, from: fromAddr, dh: header.dh, pn: header.pn, n: header.n, ct, receivedAt: Date.now() };
  if (s.pendingX3DH && !stripX3dh) env.x3dh = s.pendingX3DH;
  return env;
}
async function receive(P, env) {
  try { await P.handleInbound(env); return 'ok'; } catch (e) { return e.code || e.message; }
}

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => { cond ? (passed++, console.log('  ✓ ' + name)) : (failed++, console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : ''))); };
const A = 'a'.repeat(56) + '.anyone', B = 'b'.repeat(56) + '.anyone', E = 'e'.repeat(56) + '.anyone';
const fresh = async () => { NET.clear(); OFFLINE.clear(); return [await makeParty('Alice', A), await makeParty('Bob', B), await makeParty('Eve', E)]; };
const texts = (P, k) => (P.threads.get(k) || []).map((m) => m.text);

console.log('1. Impostor handshake for a known contact');
{
  const [alice, bob, eve] = await fresh();
  alice.addContact(bob);
  const fake = await send(eve, alice.card(), B, 'hi it is bob');
  ok('rejected with IK_MISMATCH', (await receive(alice, fake)) === 'IK_MISMATCH');
  ok('no session created for Bob', !alice.sessions.has(B));
  ok('nothing shown in the chat, no request', alice.thread.length === 0 && !alice.requests[B]);
  const fake2 = await send(eve, alice.card(), B, 'again');
  ok('dropped at once (no retries) with a clear warning', (await alice._processEnvelopeInner(fake2)) === true && alice.toasts.includes('msg.keyMismatch:Bob'));
  const real = await send(bob, alice.card(), B, 'real bob');
  ok('real Bob still gets through afterwards', (await receive(alice, real)) === 'ok' && alice.thread.at(-1)?.text === 'real bob' && alice.thread.at(-1)?.verified === true);
}

console.log('2. Normal conversation between contacts');
{
  const [alice, bob] = await fresh();
  alice.addContact(bob); bob.addContact(alice);
  ok('Bob → Alice first message', (await receive(alice, await send(bob, alice.card(), B, 'one'))) === 'ok');
  ok('Alice → Bob reply on the same session', (await receive(bob, await send(alice, bob.card(), A, 'two'))) === 'ok' && alice.sessions.get(B).role === 'responder');
  ok('Bob → Alice again', (await receive(alice, await send(bob, alice.card(), B, 'three'))) === 'ok');
  ok('no message requests between contacts', !Object.keys(alice.requests).length && !Object.keys(bob.requests).length);
  ok('all marked verified', alice.thread.every((m) => m.verified) && bob.thread.every((m) => m.verified));
}

console.log('3. Message request from someone new (Ana adds Bob and writes first)');
{
  const [bob, ana] = (await fresh()).slice(1, 3).map((p, i) => p);   // Bob = party B, Ana = party E (address e…)
  ana.addContact(bob);
  const first = await send(ana, bob.card(), E, 'Hi Bob', { meta: { sn: 'Bob\u2019s bank' } });   // a modified client trying to name itself
  ok('first message becomes a request, not a chat', (await receive(bob, first)) === 'ok' && bob.requests[E] && !bob.threads.has(E));
  ok('a name claimed by the sender is ignored; the request shows the address', !('name' in (bob.requests[E] || {})) && bob.requestName(bob.requests[E]) === E.slice(0, 8));
  ok('Bob is told a request arrived', bob.toasts.includes('req.new'));
  ok('a second message joins the same request', (await receive(bob, await send(ana, bob.card(), E, 'are you there?'))) === 'ok' && bob.requests[E]?.items?.length === 2);
  ok('a call from her does not ring', (await receive(bob, await send(ana, bob.card(), E, '', { kind: 'call', meta: { op: 'invite', id: 'x' } }))) === 'ok' && !bob.rang && bob.requests[E]?.items?.at(-1).kind === 'call');
  const pic = await send(ana, bob.card(), E, '', { kind: 'image', meta: { type: 'image/png' }, payload: new Uint8Array([1, 2, 3]) });
  ok('an attachment is held, not shown', (await receive(bob, pic)) === 'ok' && bob.requests[E]?.items?.at(-1).kind === 'image' && !bob.thread.length);
  ok('Accept without a nickname is refused', (await bob.acceptRequest(E, '   ')).error === 'name' && !!bob.requests[E]);
  ok('Accept with a nickname succeeds', (await bob.acceptRequest(E, '  Ana  ')).ok === true);
  await tick(); await flush(ana);                    // Bob's app signals the accept; Ana's app receives it
  ok('her key is checked against her address and she is saved under the chosen nickname', bob.contacts.some((c) => c.address === E && c.ecdhPub === ana.ikPub && c.petname === 'Ana'));
  ok('the request is gone and the chat opens', !bob.requests[E] && bob.opened === E);
  const moved = bob.threads.get(E) || [];
  ok('her messages are now in the chat, verified', texts(bob, E).slice(0, 2).join('|') === 'Hi Bob|are you there?' && moved.filter((m) => m.kind === 'text').every((m) => m.verified));
  ok('the held call shows as missed, the attachment is available', moved.some((m) => m.kind === 'system' && m.text === 'call.log.missed') && moved.some((m) => m.kind === 'image'));
  const reply = await send(bob, ana.card(), B, 'Hi Ana!');
  ok('Bob replies on the same session (no new handshake)', !reply.x3dh && bob.sessions.get(E).role === 'responder');
  ok('Ana reads the reply', (await receive(ana, reply)) === 'ok' && ana.thread.at(-1)?.text === 'Hi Ana!');
  ok('and keeps talking', (await receive(bob, await send(ana, bob.card(), E, 'great'))) === 'ok' && texts(bob, E).at(-1) === 'great');
}

console.log('4. Forged request: Eve claims to be Bob');
{
  const [alice, bob, eve] = await fresh();
  const fake = await send(eve, alice.card(), B, 'it is bob, honestly', { meta: { sn: 'Bob' } });
  ok('arrives as a request', (await receive(alice, fake)) === 'ok' && alice.requests[B]);
  const forged = await alice.acceptRequest(B, 'Bob');
  ok('Accept refuses it: Bob’s address serves a different key', forged.error === 'forged' && !alice.contacts.length && alice.toasts.includes('req.forged'));
  ok('request and the impostor’s session are thrown away', !alice.requests[B] && !alice.sessions.has(B));
  bob.addContact(alice);
  const real = await send(bob, alice.card(), B, 'the real bob');
  ok('the real Bob can still send a request afterwards', (await receive(alice, real)) === 'ok' && alice.requests[B]?.items[0]?.text === 'the real bob');
  await alice.acceptRequest(B, 'Bob');
  ok('and it can be accepted', alice.contacts.some((c) => c.address === B) && texts(alice, B).includes('the real bob'));
}

console.log('5. Impostor request pending, then the real contact is added by hand');
{
  const [alice, bob, eve] = await fresh();
  await receive(alice, await send(eve, alice.card(), B, 'stranger hello'));
  alice.addContact(bob);
  ok('the forged request is dropped with a warning, nothing reaches the chat', !alice.requests[B] && !(alice.threads.get(B) || []).length && alice.toasts.includes('req.forged'));
  ok('impostor follow-up with handshake is rejected', (await receive(alice, await send(eve, alice.card(), B, 'still me'))) === 'IK_MISMATCH');
  const noHs = await send(eve, alice.card(), B, 'no header', { stripX3dh: true });
  ok('impostor follow-up without handshake fails', (await receive(alice, noHs)) !== 'ok' && !alice.sessions.has(B));
  const out = await send(alice, bob.card(), A, 'for the real bob');
  ok('Alice’s next message starts a fresh handshake with Bob’s saved key', out.x3dh && alice.sessions.get(B).remoteIk === bob.ikPub);
  eve.addContact(alice);
  ok('the impostor cannot read it', (await receive(eve, { ...out, from: A })) !== 'ok');
  bob.addContact(alice);
  ok('the real Bob can', (await receive(bob, out)) === 'ok' && bob.thread.at(-1)?.text === 'for the real bob');
}

console.log('6. Delete, Block, offline');
{
  const [alice, bob] = await fresh();
  await receive(alice, await send(bob, alice.card(), B, 'first'));
  alice.deleteRequest(B);
  ok('Delete removes the request', !alice.requests[B]);
  ok('a later message from them opens a new request', (await receive(alice, await send(bob, alice.card(), B, 'second try'))) === 'ok' && alice.requests[B]?.items[0]?.text === 'second try');
  await alice.blockRequest(B);
  ok('Block tells the backend and drops request and session', alice.blocked.includes(B) && !alice.requests[B] && !alice.sessions.has(B));

  const [carol, dave] = (await fresh()).slice(0, 2);
  await receive(carol, await send(dave, carol.card(), B, 'hello'));
  OFFLINE.add(B);
  const off = await carol.acceptRequest(B, 'Dave');
  ok('sender offline: request kept, nothing added, the dialog can retry', off.error === 'offline' && !!carol.requests[B] && !carol.contacts.length);
  OFFLINE.clear();
  await carol.acceptRequest(B, 'Dave');
  ok('accepting works once they are back', carol.contacts.some((c) => c.address === B) && !carol.requests[B]);
}

console.log('7. Limits and group traffic');
{
  const [alice, bob, eve] = await fresh();
  for (let i = 0; i < 25; i++) await receive(alice, await send(bob, alice.card(), B, 'msg ' + i));
  ok('one request keeps at most 20 messages (the newest)', alice.requests[B]?.items?.length === 20 && alice.requests[B]?.items?.[0]?.text === 'msg 5');
  alice.requests[B].lastAt = Date.now() - 31 * 24 * 3600 * 1000;
  alice.expireRequests();
  ok('a request untouched for 30 days expires', !alice.requests[B]);
  alice.groups.push({ id: 'g1', name: 'Team', adminAddr: E, members: [{ address: A }, { address: E }] });
  await alice.ensurePeer(E);                       // fetched when the group is loaded
  const g = await send(eve, alice.card(), E, 'hello team', { meta: { grp: 'g1' } });
  ok('a group message from a fellow member is not a request', (await receive(alice, g)) === 'ok' && !alice.requests[E] && alice.thread.some((m) => m.k === 'grp:g1' && m.text === 'hello team'));
  const inv = await send(bob, alice.card(), B, '', { kind: 'group-invite', meta: { id: 'g2', name: 'Party', members: [] } });
  await receive(alice, inv);
  ok('a group invite from a stranger waits in the request', alice.requests[B]?.items?.at(-1)?.kind === 'invite' && !alice.invitesApplied.length);
  await alice.acceptRequest(B, 'Bob');
  ok('and is applied only after Accept', alice.invitesApplied.length === 1 && alice.invitesApplied[0].meta.id === 'g2');
}

console.log('9. Text only until the request is accepted');
{
  const [bob, ana, eve] = (await fresh()).slice(1, 3).concat([]).concat([await makeParty('Eve2', 'f'.repeat(56) + '.anyone')]);
  ana.addContact(bob);
  const img = encodeFrame('image', { mid: 'i1', type: 'image/png' }, new Uint8Array([1, 2, 3]));
  const deliverErr = async (P, card, frame) => { try { await P.deliver(card, frame); return 'sent'; } catch (e) { return e.code || e.message; } };
  ok('before any message: an image is refused', (await deliverErr(ana, bob.card(), img)) === 'TEXT_ONLY');
  ok('a call is refused', (await deliverErr(ana, bob.card(), encodeFrame('call', { op: 'invite', id: 'c1' }, new Uint8Array(0)))) === 'TEXT_ONLY');
  ok('text goes out', (await deliverErr(ana, bob.card(), encodeFrame('text', { mid: 't1' }, te.encode('Hi Bob')))) === 'sent');
  ok('still refused after sending text (no reply yet)', (await deliverErr(ana, bob.card(), img)) === 'TEXT_ONLY' && !ana.richSendAllowed(B));
  ok('group traffic is not restricted', (await deliverErr(ana, bob.card(), encodeFrame('image', { grp: 'g1', mid: 'gi' }, new Uint8Array([9])))) === 'sent');
  bob.wire.pop();                                    // that group frame is not part of this conversation
  await flush(bob);
  ok('Bob has the text as a request', bob.requests[E]?.items?.[0]?.text === 'Hi Bob');
  await bob.acceptRequest(E, 'Ana'); await tick();
  const signal = ana.wire.slice();
  ok('accepting sends Ana a silent accept signal', signal.length === 1);
  await flush(ana);
  ok('Ana is told the request was accepted', ana.toasts.includes('req.acceptedBy:Bob'));
  ok('nothing appears in Ana\u2019s chat for the signal', !ana.thread.some((m) => m.k === B));
  ok('Ana can now send an image', (await deliverErr(ana, bob.card(), img)) === 'sent' && ana.richSendAllowed(B));
  await flush(bob);
  ok('Bob receives it as a normal attachment', (bob.threads.get(E) || []).filter((m) => m.kind === 'image' && m.id === 'i1').length === 1 && !bob.requests[E]);

  const [carol, dave] = (await fresh()).slice(0, 2);
  carol.addContact(dave); dave.addContact(carol);   // added each other out of band
  await carol.deliver(dave.card(), encodeFrame('text', { mid: 'x' }, te.encode('hey')));
  await flush(dave); await tick();
  ok('a contact who already had us unlocks us at once', dave.wire.length === 0 && carol.wire.length === 1);
  await flush(carol);
  ok('...without an "accepted your request" message', carol.richSendAllowed(B) && !carol.toasts.some((x) => x.startsWith('req.acceptedBy')));

  const [al, , ev] = await fresh();
  ev.addContact(al);
  await ev.ensureSession(al.card());
  const s = ev.sessions.get(A); s.confirmed = true;     // a modified client skipping its own check
  await ev.deliver(al.card(), encodeFrame('accept', { via: 'request' }, new Uint8Array(0)));
  await flush(al);
  ok('a stranger\u2019s accept signal creates nothing', !al.requests[E] && !al.thread.length);
}

console.log('10. Quotes come from your own copy of the message');
{
  const [alice, bob] = await fresh();
  alice.addContact(bob); bob.addContact(alice);
  const sendText = async (from, to, mid, text, meta = {}) => { await from.deliver(to.card(), encodeFrame('text', { mid, ...meta }, te.encode(text))); await flush(to); await tick(); await flush(from); };
  await sendText(alice, bob, 'a-1', 'lunch at noon?');
  bob.thread.length = 0;
  bob.threads.get(A).push({ id: 'b-1', dir: 'out', kind: 'text', text: 'sure, see you there', ts: Date.now() });   // Bob's own reply in his history
  const idx = (P, k) => new Map((P.threads.get(k) || []).map((m) => [m.id, m]));
  // forged: quotes a message that never existed, claims Bob wrote it
  await sendText(alice, bob, 'a-2', 'sending the account number', { replyTo: { id: 'no-such-id', from: B, snippet: 'I agree to transfer the 500 EUR' } });
  const forged = (bob.threads.get(A) || []).find((m) => m.text === 'sending the account number');
  const q1 = bob.quoteFor(forged.replyTo, idx(bob, A));
  ok('a quote of a message you don\u2019t have shows "not available", no author', q1.found === false && q1.author === null && q1.text === 'reply.unavailable');
  ok('...and none of the sender\u2019s text is shown', !JSON.stringify(q1).includes('500 EUR'));
  // real id, lying author and snippet
  await sendText(alice, bob, 'a-3', 'great', { replyTo: { id: 'b-1', from: A, snippet: 'I will pay for everyone' } });
  const r3 = (bob.threads.get(A) || []).find((m) => m.text === 'great');
  const q3 = bob.quoteFor(r3.replyTo, idx(bob, A));
  ok('a real quote shows your own words and "You", ignoring what the sender claimed', q3.found && q3.author === 'react.you' && q3.text === 'sure, see you there');
  // id reuse: Alice sends a message using Bob's message id, then quotes that id
  await sendText(alice, bob, 'b-1', 'I will pay for everyone');
  const reused = (bob.threads.get(A) || []).filter((m) => m.text === 'I will pay for everyone');
  ok('a peer reusing one of your message ids gets a fresh local id', reused.length === 1 && reused[0].id !== 'b-1');
  const q4 = bob.quoteFor({ id: 'b-1' }, idx(bob, A));
  ok('quotes of that id still show your original message', q4.author === 'react.you' && q4.text === 'sure, see you there');
  // exact duplicate from the same sender is dropped
  const before = (bob.threads.get(A) || []).length;
  await sendText(alice, bob, 'a-1', 'lunch at noon?');
  ok('the same message id from the same sender twice is stored once', (bob.threads.get(A) || []).length === before);
  // quoting the other person's message
  const q5 = bob.quoteFor({ id: 'a-1' }, idx(bob, A));
  ok('a quote of the contact\u2019s message shows your nickname for them', q5.author === 'Alice' && q5.text === 'lunch at noon?');
}

console.log('8. Sessions saved before the identity pin');
{
  const [alice, bob] = await fresh();
  alice.addContact(bob);
  alice.sessions.set(B, { role: 'responder', verified: true, RK: 'x' });
  ok('checked-at-the-time session is kept', alice.pinnedSession(bob.card()) !== null);
  alice.sessions.set(B, { role: 'responder', verified: false, RK: 'x' });
  ok('unchecked session for a contact is dropped', alice.pinnedSession(bob.card()) === null && !alice.sessions.has(B));
  alice.sessions.set(B, { role: 'initiator', verified: true, remoteIk: 'OLDKEY', RK: 'x' });
  ok('session built with a key the contact no longer has is dropped', alice.pinnedSession(bob.card()) === null);
}

console.log('11. Groups: members who aren\u2019t contacts');
{
  const C = 'c'.repeat(56) + '.anyone';
  const [ana, bob, eve] = await fresh();
  const carl = await makeParty('Carl', C);
  // Bob is the admin and has both as contacts; Ana and Carl only have Bob.
  bob.addContact(ana); bob.addContact(carl); ana.addContact(bob); carl.addContact(bob);
  const G = { id: 'g1', name: 'Trip', adminAddr: B, members: [{ address: B, petname: 'Bob' }, { address: A, petname: 'Ana' }, { address: C, petname: 'Carl' }] };
  for (const P of [ana, bob, carl]) P.setGroups([JSON.parse(JSON.stringify(G))]);

  // The app fetches members' keys when the group is loaded (prefetchPeers); a message from a member whose keys aren't there yet is
  // retried after the background fetch instead of holding the session lock.
  const early = await send(ana, carl.card(), A, 'too early', { meta: { grp: 'g1' } });
  ok('a member’s message before the keys arrive is retried, not dropped or accepted unchecked', (await receive(carl, early)) === 'group member keys not fetched yet' && !texts(carl, 'grp:g1').includes('too early'));
  await carl.ensurePeer(A); await ana.ensurePeer(C);
  ok('…and goes through once they have', (await receive(carl, early)) === 'ok' && texts(carl, 'grp:g1').includes('too early'));
  // Ana → group: delivered to Bob and Carl, Carl not being Ana's contact
  const failed1 = await ana.deliverToGroup(G, encodeFrame('text', { grp: 'g1', mid: 'g-1' }, te.encode('hello all')));
  ok('a group message goes to members who aren\u2019t contacts too', failed1 === 0 && carl.wire.length === 1 && bob.wire.length === 1);
  ok('the keys for that member came from the member\u2019s own address', ana.peers.some((p) => p.address === C && p.ecdhPub === carl.ikPub));
  await flush(carl); await flush(bob);
  ok('Carl gets it in the group, not as a request', texts(carl, 'grp:g1').includes('hello all') && !carl.requests[A]);
  ok('…pinned to the key served at Ana\u2019s address', carl.peers.some((p) => p.address === A && p.ecdhPub === ana.ikPub));
  // Carl replies to the group; Ana answers on the same sessions
  await carl.deliverToGroup(G, encodeFrame('text', { grp: 'g1', mid: 'g-2' }, te.encode('hi Ana')));
  await flush(ana);
  ok('replies work both ways', texts(ana, 'grp:g1').includes('hi Ana'));
  ok('the sender is shown with the group name for the member', (ana.threads.get('grp:g1') || []).at(-1)?.senderName === 'Carl');

  // Eve claims to be Ana in the group, with her own keys
  const forged = await send(eve, carl.card(), A, 'send me money', { meta: { grp: 'g1' } });
  ok('a member impersonated with other keys is refused', (await receive(carl, forged)) === 'IK_MISMATCH' && !texts(carl, 'grp:g1').includes('send me money'));

  // Someone not in the group gets nothing special: a direct message from a member who isn't a contact is not shown
  const dm = await send(carl, ana.card(), C, 'psst');
  await receive(ana, dm);
  ok('a direct (non-group) message from a member who isn\u2019t a contact becomes a request', !!ana.requests[C]);

  // A non-member address can't get keys fetched through the peer endpoint
  const r = await ana.ensurePeer(E).then(() => 'fetched', (e) => e.message);
  ok('keys are only fetched for people in one of our groups', r === 'not a group member');
}

console.log('12. Group message that arrives before the updated member list');
{
  const D = 'd'.repeat(56) + '.anyone';
  const [ana, bob] = await fresh();
  const dan = await makeParty('Dan', D);
  bob.addContact(ana); bob.addContact(dan); ana.addContact(bob); dan.addContact(bob);
  const G = { id: 'g2', name: 'Club', adminAddr: B, members: [{ address: B, petname: 'Bob' }, { address: A, petname: 'Ana' }, { address: D, petname: 'Dan' }] };
  bob.setGroups([JSON.parse(JSON.stringify(G))]); ana.setGroups([JSON.parse(JSON.stringify(G))]);
  // Dan still has the old list without Ana
  dan.setGroups([{ ...JSON.parse(JSON.stringify(G)), members: G.members.filter((m) => m.address !== A) }]);
  await ana.deliverToGroup(G, encodeFrame('text', { grp: 'g2', mid: 'g2-1' }, te.encode('welcome me')));
  await flush(dan);
  ok('held: not shown yet, and not turned into a request', !texts(dan, 'grp:g2').includes('welcome me') && !dan.requests[A]);
  dan.setGroups([JSON.parse(JSON.stringify(G))]);       // the admin's full list arrives
  await dan.replayHeldGroupFrames('g2');
  ok('shown once the list names Ana, after her keys were checked', texts(dan, 'grp:g2').includes('welcome me'));
  // An impostor's held message is checked against the real keys on replay
  const eve = await makeParty('Eve', E);
  dan.setGroups([{ ...JSON.parse(JSON.stringify(G)), members: G.members.filter((m) => m.address !== A) }]);
  dan.peers.splice(0); dan.sessions.delete(A);
  const forged = await send(eve, dan.card(), A, 'fake welcome', { meta: { grp: 'g2' } });
  await receive(dan, forged);
  dan.setGroups([JSON.parse(JSON.stringify(G))]);
  await dan.replayHeldGroupFrames('g2');
  ok('a held message sent with someone else\u2019s keys is dropped on replay', !texts(dan, 'grp:g2').includes('fake welcome'));
}

console.log('13. A removed contact\u2019s next message arrives as a request (the session is kept, nothing is sent to them)');
{
  const [alice, bob] = await fresh();
  alice.addContact(bob); bob.addContact(alice);
  await receive(alice, await send(bob, alice.card(), B, 'hi'));
  await receive(bob, await send(alice, bob.card(), A, 'hello'));
  await tick(); bob.wire.length = 0;
  // Alice removes Bob: the contact goes, the session stays (removeContact keeps it unless blocking)
  alice.serverContacts = []; alice.contacts = [];
  const r = await receive(alice, await send(bob, alice.card(), B, 'are you there'));
  ok('his message is read and held as a request', r === 'ok' && !!alice.requests[B], r);
  ok('…not shown as a chat message', !texts(alice, B).includes('are you there'));
  await tick();
  ok('…and nothing went back to him', bob.wire.length === 0, JSON.stringify(bob.wire.map((w) => w.from)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
