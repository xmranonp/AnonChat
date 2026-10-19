// Development stand-in for server.js used by tools/e2e/run-calls.py: the same endpoints the UI uses, the real lib/store and the real
// call bridge. Two of these (NAME=A / NAME=B) plus socks.mjs let two UIs ring each other without an Anyone network.
// A stand-in for server.js (express is not installable here): same endpoints the UI uses, same lib/store, real call bridge.
// Peers talk to each other directly over HTTP (the onion hop is not under test); call audio goes through the fake SOCKS.
import { fileURLToPath } from 'node:url';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const NAME = process.env.NAME, DATA = process.env.DATA_DIR;
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = createRequire(ROOT + '/server.js');
const { WebSocketServer } = require('ws');
const store = require(ROOT + '/lib/store.js');
const { createCallBridge } = require(ROOT + '/lib/callbridge.js');
const PUBLIC = ROOT + '/public';
const PORTS = { A: { ui: 5101, pub: 5102 }, B: { ui: 5201, pub: 5202 } };
const ADDR = { A: 'a'.repeat(56) + '.anyone', B: 'b'.repeat(56) + '.anyone' };
const me = NAME, other = NAME === 'A' ? 'B' : 'A';
const bridge = createCallBridge({ socks: 'socks5h://127.0.0.1:5300' });
const wsClients = new Set();
const json = (res, obj, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => b += d); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const mime = (f) => f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.html') ? 'text/html' : f.endsWith('.png') ? 'image/png' : f.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream';
const peer = (p, opts = {}) => new Promise((resolve, reject) => {
  const rq = http.request({ host: '127.0.0.1', port: PORTS[other].pub, path: p, method: opts.body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' } }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => { try { resolve({ status: r.statusCode, data: JSON.parse(d || '{}') }); } catch { resolve({ status: r.statusCode, data: {} }); } }); });
  rq.on('error', reject); if (opts.body) rq.write(JSON.stringify(opts.body)); rq.end();
});

const pub = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/api/profile') { const id = store.getIdentity(); return json(res, { name: id?.name || null, avatar: id?.avatar || null, bio: null }); }
  if (u === '/api/identity') { const id = store.getIdentity(); if (!id) return json(res, { error: 'no identity' }, 503); const c = store.claimPrekey(); return json(res, { address: ADDR[me], ...id, opkId: c ? c.id : null, opkPub: c ? c.pub : null }); }
  if (u === '/api/inbox' && req.method === 'POST') {
    const env = await body(req);
    const stored = store.addToInbox({ id: crypto.randomUUID(), from: env.from, dh: env.dh, pn: env.pn || 0, n: env.n, ct: env.ct, x3dh: env.x3dh || null, receivedAt: Date.now() });
    for (const s of wsClients) if (s.readyState === 1) s.send(JSON.stringify({ type: 'inbox', envelope: stored }));
    return json(res, { ok: true });
  }
  json(res, { error: 'not found' }, 404);
});
pub.on('upgrade', (q, s, h) => /^\/call\//.test(q.url) ? bridge.handlePublicUpgrade(q, s, h) : s.destroy());

const sent = [];                       // every /api/send body, for assertions
const ui = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/stub/sent') return json(res, sent);
  if (!u.startsWith('/api/')) {
    const f = path.join(PUBLIC, u === '/' ? 'index.html' : u);
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', mime(f)); res.setHeader('cache-control', 'no-store'); return res.end(fs.readFileSync(f));
  }
  const b = req.method === 'GET' ? {} : await body(req);
  switch (u) {
    case '/api/whoami': return json(res, { address: ADDR[me], hasIdentity: !!store.getIdentity(), name: store.getIdentity()?.name || null, network: 'ready' });
    case '/api/identity': { if (req.method === 'POST') { store.setIdentity({ ...(store.getIdentity() || {}), ...b }); return json(res, { ok: true, address: ADDR[me] }); } return json(res, store.getIdentity() || {}); }
    case '/api/contacts':
      if (req.method === 'GET') return json(res, store.getContacts().map((c) => ({ ...c, online: true })));
      if (req.method === 'DELETE') { store.removeContact(b.address); return json(res, { ok: true }); }
      { const r = await peer('/api/identity'); if (!r.data.ecdhPub) return json(res, { error: 'peer has no keys' }, 502);
        return json(res, store.upsertContact({ petname: b.petname, address: b.address, ecdhPub: r.data.ecdhPub, ratchetPub: r.data.ratchetPub, ikSigPub: r.data.ikSigPub || null, spkSig: r.data.spkSig || null, opkId: r.data.opkId || null, opkPub: r.data.opkPub || null, avatar: null, bio: null, addedAt: Date.now() })); }
    case '/api/contacts/opk-used': { const c = store.getContacts().find((x) => x.address === b.address); if (c) store.upsertContact({ ...c, opkId: null, opkPub: null }); return json(res, { ok: true }); }
    case '/api/groups': if (req.method === 'GET') return json(res, store.getGroups()); if (req.method === 'POST') store.upsertGroup(b); else store.removeGroup(b.id); return json(res, { ok: true });
    case '/api/messages': return json(res, store.getInbox());
    case '/api/messages/ack': if (Array.isArray(b.ids) && b.ids.length) store.deleteFromInbox(b.ids); return json(res, { ok: true });
    case '/api/prekeys': if (req.method === 'POST') { if (Array.isArray(b.keys) && b.keys.length) store.addPrekeys(b.keys); } return json(res, { ok: true, count: store.prekeyCount() });
    case '/api/settings': return json(res, store.getSettings());
    case '/api/version': return json(res, { version: '0.0.0' });
    case '/api/send': {
      sent.push({ ephemeral: b.ephemeral === true, to: b.toAddress, ts: Date.now() });
      const r = await peer('/api/inbox', { body: { ...b.envelope, from: ADDR[me] } }).catch(() => null);
      if (!r) return b.ephemeral ? json(res, { error: 'unreachable' }, 502) : json(res, { ok: true, queued: true });
      return json(res, { ok: true, queued: false });
    }
    case '/api/outbox': return json(res, { items: [] });
    case '/api/circuits': return json(res, { circuits: [] });
    default: return json(res, {});
  }
});
const wss = new WebSocketServer({ noServer: true });
const callWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4096 });
ui.on('upgrade', (q, s, h) => { const p = q.url.split('?')[0]; const t = p === '/ws' ? wss : p === '/call-ws' ? callWss : null; if (!t) return s.destroy(); t.handleUpgrade(q, s, h, (ws) => t.emit('connection', ws)); });
wss.on('connection', (s) => { wsClients.add(s); s.on('close', () => wsClients.delete(s)); });
callWss.on('connection', (s) => bridge.attachLocal(s));
pub.listen(PORTS[me].pub, '127.0.0.1'); ui.listen(PORTS[me].ui, '127.0.0.1', () => console.log('up ' + me));
