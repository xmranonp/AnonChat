'use strict';
// The mailbox sending, wired into the backend (server.js stays small): one peer client per peer address, contacts' details, the
// sending module, the window's endpoints and its live events.
//
//   POST /api/swarm/details   {address, details}   a contact's swarm frame, as the window decrypted it (contacts only)
//   GET  /api/swarm/states                           every message the mailbox sending owns, with what it shows (⏳ 📮 ✓ ⚠)
//   GET  /api/swarm/contacts                         which contacts have a mailbox (their addresses only)
//   POST /api/swarm/flush     {ms}                   waits up to ms (at most 20 s) for drops that are due (quit, logoff)
//   GET  /api/swarm/own                              our peers (address, state, last collection), and whether joining is allowed here
//   POST /api/swarm/join      {address, invite}     join a peer (test builds only: ANONCHAT_SWARM_TEST=1)
//   POST /api/swarm/leave     {address}
//   POST /api/swarm/capable   {address}             a contact's frames carry sw: 1
//   POST /api/swarm/request   {address}             a contact asked for our details
//   GET  /api/swarm/details-for?address=            the swarm frame's meta for that contact (the window sends it)
//   POST /api/swarm/details-sent {address, seq}
//   GET  /api/swarm/due                              contacts who haven't got our latest details
// WebSocket: swarm:state {id, msgId, toAddress, shown, keepUntil}, swarm:want-details {toAddress}, swarm:full {toAddress},
//            swarm:send-details {toAddress}, swarm:own (our peers changed), swarm:other-install, swarm:mailbox-gone {peer}
const Contacts = require('./contacts');
const Send = require('./send');
const PC = require('./peerclient');
const Own = require('./own');
const Collect = require('./collect');

function create({ dataDir, outbox, socksUrl, hsFetch, isContact, listContacts, payloadFor, accept, presence, ready, broadcast, joinAllowed = false, log = (m) => console.log(m) }) {
  const clients = new Map();
  const clientFor = (address) => {
    let c = clients.get(address);
    if (!c) { c = PC.create({ address, socksUrl, hsFetch, log }); clients.set(address, c); }
    return c;
  };
  const contacts = Contacts.create({ dataDir, log });
  const send = Send.create({ dataDir, outbox, contacts, clientFor, payloadFor, presence, ready, log });
  send.on('state', (s) => broadcast({ type: 'swarm:state', ...s }));
  send.on('want-details', (e) => broadcast({ type: 'swarm:want-details', toAddress: e.toAddress, seq: contacts.seq(e.toAddress) }));
  send.on('full', (e) => broadcast({ type: 'swarm:full', toAddress: e.toAddress }));
  send.on('refused', (e) => broadcast({ type: 'swarm:refused', toAddress: e.toAddress }));

  // Our own mailbox: the peers we joined, and collecting from them.
  let collect = null;
  // before a peer is left: one last collection, so nothing waiting there is lost
  const own = Own.create({ dataDir, clientFor, contacts: listContacts, log, ready, beforeLeave: (a) => (collect ? collect.sessionNow(a) : Promise.resolve()) });
  collect = Collect.create({ own, clientFor, accept, ready, log });
  own.on('changed', () => {
    collect.pump(); broadcast({ type: 'swarm:own' }); for (const c of own.due()) broadcast({ type: 'swarm:send-details', toAddress: c }); });
  own.on('join-failed', () => broadcast({ type: 'swarm:own' }));
  own.on('other-install', () => broadcast({ type: 'swarm:other-install' }));
  own.on('mailbox-gone', (e) => broadcast({ type: 'swarm:mailbox-gone', peer: e.peer }));
  // The problems the app explains (design section 15), said to the window whenever they change (and checked every minute: some are
  // a matter of time, like a peer unreachable for more than 2 minutes or a week)
  let lastProblems = '[]';
  const sayProblems = () => { const p = own.problems(), k = JSON.stringify(p); if (k !== lastProblems) { lastProblems = k; broadcast({ type: 'swarm:problems', problems: p }); } };
  own.on('health', sayProblems); own.on('changed', sayProblems);
  const probT = setInterval(sayProblems, 60e3); probT.unref?.();
  // The quit notice's text, in the person's language: the window hands it over (the desktop app has no texts of its own)
  let quitText = null;
  collect.on('other-install', () => broadcast({ type: 'swarm:other-install' }));
  collect.on('mailbox-gone', (e) => broadcast({ type: 'swarm:mailbox-gone', peer: e.peer }));
  const errCode = (e) => (e && (e.code || (e.kind === 'answer' ? `http-${e.status}` : e.kind))) || 'failed';

  function routes(ui) {          // an express router mounted at /api/swarm
    ui.post('/details', (req, res) => {
      const { address, details } = req.body || {};
      if (typeof address !== 'string' || !isContact(address)) return res.status(403).json({ error: 'not a contact' });          // ignored from non-contacts
      res.json({ result: contacts.setDetails(address, details) });
    });
    ui.get('/states', (_req, res) => res.json({ states: send.states() }));
    ui.get('/contacts', (_req, res) => res.json({ contacts: contacts.list().filter((a) => contacts.get(a)) }));
    ui.get('/own', (_req, res) => res.json({ peers: own.list(), joinAllowed: !!joinAllowed, seq: own.seq(), problems: own.problems() }));
    ui.post('/texts', (req, res) => { const q = req.body?.quit; if (typeof q === 'string' && q.length <= 300) quitText = q; res.json({ ok: true }); });
    ui.get('/pending', (_req, res) => res.json({ count: send.pending(), text: quitText }));
    ui.post('/join', async (req, res) => {
      if (!joinAllowed) return res.status(403).json({ error: 'not-allowed' });
      try { const r = await own.join(req.body?.address, req.body?.invite); collect.kick(); res.json({ ok: true, ...r }); }
      catch (e) { if (e.pending) return res.status(202).json({ pending: true }); res.status(400).json({ error: errCode(e) }); }          // pending: no route yet, finished by itself
    });
    ui.post('/switch', async (req, res) => {
      if (!joinAllowed) return res.status(403).json({ error: 'not-allowed' });
      try { const r = await own.switchPeer(String(req.body?.from || ''), req.body?.address, req.body?.invite); collect.kick(); res.json({ ok: true, ...r }); }
      catch (e) { if (e.pending) return res.status(202).json({ pending: true }); res.status(400).json({ error: errCode(e) }); }
    });
    ui.post('/turn-off', (_req, res) => res.json({ ok: true, peers: own.turnOff() }));
    ui.post('/leave', async (req, res) => {
      const a = String(req.body?.address || '');
      try { const r = await own.leave(a); res.json(r && typeof r === 'object' ? r : { ok: !!r }); } catch (e) { res.status(400).json({ error: errCode(e) }); }
    });
    ui.post('/capable', (req, res) => {
      const a = req.body?.address;
      if (typeof a !== 'string' || !isContact(a)) return res.status(403).json({ error: 'not a contact' });
      res.json({ send: own.capable(a) });
    });
    ui.post('/request', (req, res) => {
      const a = req.body?.address;
      if (typeof a !== 'string' || !isContact(a)) return res.status(403).json({ error: 'not a contact' });
      own.capable(a);
      res.json({ send: !!own.detailsFor(a) });
    });
    ui.get('/details-for', (req, res) => {
      const a = String(req.query.address || '');
      if (!isContact(a)) return res.status(403).json({ error: 'not a contact' });
      res.json({ details: own.detailsFor(a) });
    });
    ui.post('/details-sent', (req, res) => { const a = req.body?.address; if (typeof a === 'string' && isContact(a)) own.sent(a, req.body.seq); res.json({ ok: true }); });
    ui.get('/due', (_req, res) => res.json({ contacts: own.due() }));
    // The backup's swarm field (the window encrypts it into the backup file with the rest; it never leaves this computer in the clear)
    ui.get('/backup', (_req, res) => res.json({ swarm: { ...own.backup(), contacts: contacts.backup() } }));
    ui.post('/flush', async (req, res) => {
      const ms = Math.min(20000, Math.max(0, Number(req.body?.ms) || 0)), t0 = Date.now();
      while (send.pending() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 200));
      send.saveNow();
      res.json({ left: send.pending() });
    });
  }

  return {
    routes,
    start: () => { send.start(); own.start(); collect.start(); },
    stop: () => { send.stop(); own.stop(); collect.stop(); for (const c of clients.values()) c.close(); },
    plan: (o) => send.plan(o),
    track: (o) => send.track(o),
    copy: (o) => send.copy(o),
    directFailed: (qid) => send.directFailed(qid),
    kick: () => { send.kick(); collect.kick(); own.kick().catch(() => {}); },
    stampKeysArrived: () => collect.kick(),
    contactsChanged: () => own.sync().catch(() => {}),
    cameOnline: (a) => send.cameOnline(a),
    removeContact: (a) => { send.removeContact(a); contacts.remove(a); own.forget(a).catch(() => {}); },
    hasMailbox: (a) => !!contacts.get(a),
    // Called by /api/restore on a fresh install, before the restart
    restore: (b) => {
      if (!b || typeof b !== 'object') { own.restoredWithoutMailbox(); return { restored: 0 }; }
      const r = own.restore(b);
      if (r.error === 'too-new' || r.error === 'invalid') own.restoredWithoutMailbox();
      const d = r.error === 'too-new' ? 0 : contacts.restore(b.contacts);
      return { ...r, details: d };
    },
    _send: send, _contacts: contacts, _own: own, _collect: collect,
  };
}
module.exports = { create };
