'use strict';

// callbridge.js — carries the audio of a voice call between two nodes.
//
// The browser end-to-end encrypts every audio frame (see public/call.js); this module only moves opaque bytes.
//   * dial   (caller): opens ONE WebSocket to  ws://<peer>.anyone/call/<callId>  through the loopback SOCKS proxy (socks5h: the
//             .anyone name is resolved inside the Anyone network, never by the system resolver). There is no other way out.
//   * expect (callee): registers a callId; the peer's WebSocket is accepted on the public (hidden-service) port, and only for that id.
//   * Frames are forwarded both ways. When the link is congested, frames are DROPPED instead of queued: late audio is useless
//     and a queue would only add delay.
//   * If the circuit breaks, the caller redials the same path for up to RECONNECT_MS; the callee keeps accepting the same callId.
//
// Nothing here uses UDP, STUN, TURN or WebRTC.

const { WebSocketServer, WebSocket } = require('ws');
const { SocksProxyAgent } = require('socks-proxy-agent');
const netlock = require('./netlock');

const ID_RE        = /^[0-9a-f]{32}$/;
const ADDR_RE      = /^[a-z2-7]{56}\.anyone$/;
const MAX_FRAME    = 1024;             // an encrypted audio frame is a few hundred bytes
const MAX_BUFFERED = 48 * 1024;        // beyond this a link is stalled: drop audio rather than queue it
const WAIT_MS      = 90_000;           // callee: how long to wait for the caller's connection to arrive
const DIAL_TIMEOUT = 45_000;
const RECONNECT_MS = 60_000;
const DIAL_PAUSE   = 2_500;

function createCallBridge({ socks, log = () => {} }) {
  const socksUrl = netlock.normalizeSocks(socks);       // throws unless loopback + remote-DNS SOCKS
  const agent    = new SocksProxyAgent(socksUrl);
  const stats    = { dials: 0, accepted: 0, rejected: 0, dropped: 0 };
  let call = null;                                      // at most one call at a time

  const send = (ws, obj) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} };

  function teardown(reason, notify = true) {
    const c = call; if (!c) return;
    call = null;
    clearTimeout(c.waitTimer); clearTimeout(c.redialTimer); c.dead = true;
    if (c.remote) { try { c.remote.removeAllListeners('close'); c.remote.close(1000); } catch {} try { c.remote.terminate(); } catch {} c.remote = null; }
    if (notify) send(c.local, { op: 'closed', reason });
  }

  function adoptRemote(c, ws) {
    if (c.remote) { try { c.remote.removeAllListeners('close'); c.remote.terminate(); } catch {} }
    c.remote = ws;
    clearTimeout(c.waitTimer); clearTimeout(c.redialTimer);
    c.lastRemoteAt = Date.now(); c.brokenAt = 0;
    ws.on('message', (data, isBinary) => {
      if (call !== c || c.remote !== ws) return;
      if (!isBinary || data.length > MAX_FRAME || data.length < 1) return;   // only audio frames travel here
      if (c.local.readyState !== 1 || c.local.bufferedAmount > MAX_BUFFERED) { stats.dropped++; return; }
      try { c.local.send(data, { binary: true }); } catch {}
    });
    ws.on('error', () => {});
    // A clean close (1000) is the other side hanging up; anything else (1006 etc.) is a broken circuit, which is redialled.
    ws.on('close', (code) => { if (call === c && c.remote === ws) { c.remote = null; if (code === 1000) teardown('remote-closed'); else linkLost(c); } });
    send(c.local, { op: 'open' });
  }

  function linkLost(c) {
    if (call !== c || c.dead) return;
    c.brokenAt = c.brokenAt || Date.now();
    send(c.local, { op: 'reconnecting' });
    if (c.role === 'caller') redial(c);
    else {                                              // callee: the same id is accepted again
      clearTimeout(c.waitTimer);
      c.waitTimer = setTimeout(() => { if (call === c) teardown('lost'); }, RECONNECT_MS);
    }
  }

  function redial(c) {
    if (call !== c || c.dead) return;
    const limit = c.brokenAt ? RECONNECT_MS : WAIT_MS;
    const since = c.brokenAt || c.startedAt;
    if (Date.now() - since > limit) return teardown(c.brokenAt ? 'lost' : 'unreachable');
    stats.dials++;
    let ws;
    try {
      ws = new WebSocket(`ws://${c.peer}/call/${c.id}`, {
        agent, perMessageDeflate: false, handshakeTimeout: DIAL_TIMEOUT, maxPayload: MAX_FRAME, followRedirects: false,
      });
    } catch (e) { log('[call] dial setup failed: ' + e.message); return; }
    let opened = false;
    ws.on('open', () => { opened = true; if (call === c && !c.dead) adoptRemote(c, ws); else ws.terminate(); });
    ws.on('error', (e) => { log('[call] dial error: ' + (e && e.message)); });
    ws.on('close', () => {
      if (opened || call !== c || c.dead) return;
      c.redialTimer = setTimeout(() => redial(c), DIAL_PAUSE);   // the peer's service is often not reachable on the first try
    });
  }

  // The browser's end (loopback only). Binary = audio frames; text = control.
  function attachLocal(ws) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const c = call;
        if (!c || c.local !== ws || !c.remote || c.remote.readyState !== 1) return;
        if (data.length > MAX_FRAME || data.length < 1) return;
        if (c.remote.bufferedAmount > MAX_BUFFERED) { stats.dropped++; return; }
        try { c.remote.send(data, { binary: true }); } catch {}
        return;
      }
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.op === 'hangup') { if (call && call.local === ws) teardown('hangup', false); return; }
      if (m.op !== 'dial' && m.op !== 'expect') return;
      if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return send(ws, { op: 'error', reason: 'bad-id' });
      if (typeof m.peer !== 'string' || !ADDR_RE.test(m.peer)) return send(ws, { op: 'error', reason: 'bad-peer' });
      if (call) return send(ws, { op: 'error', reason: 'busy' });
      const c = call = { id: m.id, peer: m.peer, role: m.op === 'dial' ? 'caller' : 'callee', local: ws, remote: null, startedAt: Date.now(), brokenAt: 0, dead: false, waitTimer: null, redialTimer: null };
      if (c.role === 'caller') { send(ws, { op: 'dialing' }); redial(c); }
      else {
        send(ws, { op: 'ready' });
        c.waitTimer = setTimeout(() => { if (call === c && !c.remote) teardown('timeout'); }, WAIT_MS);
      }
    });
    ws.on('close', () => { if (call && call.local === ws) teardown('local-closed', false); });
    ws.on('error', () => {});
  }

  // The hidden service's end: the caller's connection. Accepted only for the id of a call that is waiting for it.
  const pubWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME });
  function handlePublicUpgrade(req, socket, head) {
    const m = /^\/call\/([0-9a-f]{32})$/.exec((req.url || '').split('?')[0]);
    const c = call;
    if (!m || !c || c.role !== 'callee' || c.dead || c.id !== m[1]) {
      stats.rejected++;
      try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch {}
      socket.destroy(); return;
    }
    pubWss.handleUpgrade(req, socket, head, (ws) => { stats.accepted++; if (call === c && !c.dead) adoptRemote(c, ws); else ws.terminate(); });
  }

  // The contact this app is calling right now over a connection it opened (the caller's side), for marking that route in the
  // Circuits tab and on the map. The callee's side receives the call on its own address and has no route of its own to them.
  const dialing = () => (call && !call.dead && call.role === 'caller' && call.remote ? call.peer : null);
  return { attachLocal, handlePublicUpgrade, stats, dialing, active: () => !!call, close: () => teardown('shutdown', false) };
}

module.exports = { createCallBridge, MAX_FRAME, ID_RE, ADDR_RE };
