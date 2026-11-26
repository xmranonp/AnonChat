// A real mailbox peer for the browser suites (MAILBOX_PEER_DIR: a mailbox-peer source folder), on a local TCP port the fake SOCKS proxy
// maps its address to, with Bob's mailbox already joined (the owner's side comes in a later release). A small control port for the
// suite: GET /details (Bob's swarm frame, as his window would send it), GET /invite (a new invite: an app joins with it), POST /collect (collects and acks everything waiting: the
// envelopes, as Bob's app would take them in).
// Run: node mbxpeer.mjs <APP> <bridge port> <control port>
import net from 'node:net'; import http from 'node:http';
import { join } from 'node:path'; import { pathToFileURL } from 'node:url'; import { createRequire } from 'node:module';
const [APP, BRIDGE, CTL] = [process.argv[2], +process.argv[3], +process.argv[4]];
const require = createRequire(import.meta.url);
const S = require(join(APP, 'lib/swarm/seal.js')), H = require(join(APP, 'lib/swarm/hpke.js')), PC = require(join(APP, 'lib/swarm/peerclient.js'));
const ph = await import(pathToFileURL(join(process.env.MAILBOX_PEER_DIR, 'test/helpers.mjs')).href);
const h = await ph.startPeer({ clock: { get t() { return Date.now(); }, set t(_) {} }, waitMax: 50 });
const PA = ph.ADDR;
net.createServer((c) => { const up = net.connect(h.sock); c.pipe(up); up.pipe(c); c.on('error', () => up.destroy()); up.on('error', () => c.destroy()); }).listen(BRIDGE, '127.0.0.1');
// the owner talks to the peer straight over its socket (no SOCKS needed here)
const ag = new http.Agent({ keepAlive: true }); ag.createConnection = (_o, cb) => { const s = net.connect(h.sock); if (cb) s.once('connect', () => cb(null, s)); return s; };
const owner = PC.create({ address: PA, socksUrl: 'socks5h://127.0.0.1:1', agentFor: () => ag });
const inv = await h.store.createInvite({});
const sec = S.newSecret(), o = { secret: S.b64u(sec) };
o.mailbox = (await owner.join(inv.invite, S.sha256hex(sec))).mailbox;
const keys = H.generateKeyPair(), kid = S.kidOf(PA, keys.pk), tok = S.newSecret();
await owner.tokens(o, { add: [S.sha256hex(tok)], kids: [kid] });
const details = { v: 1, seq: Date.now(), keepFor: 7 * 86400, peers: [{ address: PA, kid, pk: S.b64u(keys.pk), token: S.b64u(tok) }] };
http.createServer(async (req, res) => {
  try {
    if (req.url === '/details') return res.end(JSON.stringify({ address: PA, details }));
    if (req.url === '/invite') { const i = await h.store.createInvite({}); return res.end(JSON.stringify({ address: PA, invite: i.invite })); }
    if (req.url === '/collect') {
      const f = await owner.collect(o, { cursor: '0' });
      const envs = f.drops.map((d) => S.openDrop({ body: d.body, peerAddress: PA, sk: keys.sk, pk: keys.pk, expiry: d.expiry }));
      if (f.drops.length) await owner.ack(o, f.drops.map((d) => ({ id: d.id, result: 'stored' })));
      return res.end(JSON.stringify({ envelopes: envs }));
    }
    res.statusCode = 404; res.end('{}');
  } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
}).listen(CTL, '127.0.0.1', () => console.log('mailbox peer up'));
