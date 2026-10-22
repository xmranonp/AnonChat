// Circuit inspection and control over the anon control port (Tor control protocol).

const net = require('net');
const fs  = require('fs');
const path = require('path');
const EventEmitter = require('events');

const HOST       = '127.0.0.1';
const CTRL_PORT  = Number(process.env.ANON_CTRL_PORT) || 9051;
const ANON_DIR   = process.env.ANON_DIR || path.join(__dirname, '..', 'anon');
const COOKIE     = path.join(ANON_DIR, 'control_auth_cookie');

const CACHE = {
  relay:   new Map(),
  routers: null,
};
const RELAY_TTL   = 5 * 60 * 1000;
const ROUTER_TTL  = 30 * 60 * 1000;

function ctrl(cmd) {
  return new Promise((resolve, reject) => {
    let cookie;
    try { cookie = fs.readFileSync(COOKIE); }
    catch { return reject(new Error('control cookie not yet available')); }

    const sock = net.connect(CTRL_PORT, HOST, () => {
      sock.write(`AUTHENTICATE ${cookie.toString('hex')}\r\n${cmd}\r\nQUIT\r\n`);
    });
    let out = '';
    sock.on('data', d => { out += d.toString(); });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('control port timeout')); }, 8000);
    sock.on('end',  () => { clearTimeout(timer); resolve(out); });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function extractBlock(raw, prefix) {
  const lines = raw.split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (const l of lines) {
    if (l.startsWith(prefix)) { inBlock = true; continue; }
    if (inBlock) {
      if (l === '.' || /^250\s/.test(l)) break;
      out.push(l);
    }
  }
  return out;
}

function parseCircuitLine(line) {
  if (!line || line.startsWith('250') || line.startsWith('.')) return null;
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2 || !/^\d+$/.test(parts[0])) return null;

  const id = parts[0], state = parts[1];
  let path = '';
  const kv = {};
  for (let i = 2; i < parts.length; i++) {
    const p = parts[i];
    if (p.includes('=')) {
      const [k, v] = p.split('=', 2);
      kv[k] = v;
    } else if (!path && /^\$/.test(p)) {
      path = p;
    }
  }
  const relays = path ? path.split(',').map(seg => {
    const m = seg.match(/^\$([0-9A-Fa-f]+)(?:~(.+))?$/);
    return m ? { fingerprint: m[1].toUpperCase(), nickname: m[2] || null } : null;
  }).filter(Boolean) : [];

  return {
    id, state, relays,
    purpose:     kv.PURPOSE     || null,
    hsState:     kv.HS_STATE    || null,
    buildFlags:  kv.BUILD_FLAGS ? kv.BUILD_FLAGS.split(',') : [],
    timeCreated: kv.TIME_CREATED || null,
  };
}

async function getCircuits() {
  const raw = await ctrl('GETINFO circuit-status');
  // An empty list comes back as "250-circuit-status=" and a full one as a "250+" block. Anything else (a refused cookie, a dropped
  // connection) is a failure, not "no circuits": otherwise the window would briefly show every circuit as gone.
  if (!/^250[+-]circuit-status=/m.test(raw) || !/^250 OK/m.test(raw)) throw new Error('control port: no circuit-status answer');
  return extractBlock(raw, '250+circuit-status=').map(parseCircuitLine).filter(Boolean);
}

function parseRouterBlock(lines) {
  const out = { nickname: null, ip: null, orPort: null, dirPort: null, flags: [], bandwidth: 0 };
  for (const line of lines) {
    if (line.startsWith('r ')) {
      const p = line.split(/\s+/);
      out.nickname = p[1] || null;
      out.ip       = p[6] || null;
      out.orPort   = Number(p[7]) || null;
      out.dirPort  = Number(p[8]) || null;
    } else if (line.startsWith('s ')) {
      out.flags = line.slice(2).trim().split(/\s+/).filter(Boolean);
    } else if (line.startsWith('w ')) {
      const m = line.match(/Bandwidth=(\d+)/);
      if (m) out.bandwidth = Number(m[1]);
    }
  }
  return out;
}

async function getRelayInfo(fingerprint) {
  const fp = String(fingerprint || '').toUpperCase().replace(/^\$/, '');
  if (!/^[0-9A-F]{40}$/.test(fp)) return null;

  const cached = CACHE.relay.get(fp);
  if (cached && Date.now() - cached.ts < RELAY_TTL) return cached.info;

  let raw;
  try { raw = await ctrl(`GETINFO ns/id/${fp}`); }
  catch { return null; }

  const lines = extractBlock(raw, '250+ns/id/');
  if (!lines.length) return null;

  const info = parseRouterBlock(lines);
  info.fingerprint = fp;
  CACHE.relay.set(fp, { info, ts: Date.now() });
  return info;
}

// 30 s 'recently active' window: long enough to span a 3 s UI refresh, short enough to drop circuits that are really gone.
const RECENT_TTL_MS = 30 * 1000;

async function getCircuitsDetailed() {
  const [rawCircuits, streams] = await Promise.all([
    getCircuits(),
    getStreamStatus().catch(() => []),
  ]);

  const streamsByCircuit = new Map();
  for (const s of streams) {
    if (!s.circuitId || s.circuitId === '0') continue;
    if (!streamsByCircuit.has(s.circuitId)) streamsByCircuit.set(s.circuitId, []);
    streamsByCircuit.get(s.circuitId).push(s);
  }

  const recentlyActive = streamWatcher.getRecentCircuitIds();

  const enriched = await Promise.all(rawCircuits.map(async c => {
    const relays = await Promise.all(c.relays.map(async r => {
      const info = await getRelayInfo(r.fingerprint);
      return { ...r, ...(info || {}) };
    }));
    const cstreams = streamsByCircuit.get(c.id) || [];
    const isLiveNow = cstreams.some(s => /^(SUCCEEDED|SENTCONNECT|REMAP|NEW)$/.test(s.state || ''));
    const isRecent  = recentlyActive.has(c.id);

    // If the watcher saw recent activity but no stream is live, synthesise one so the circuit stays visible.
    let displayStreams = cstreams;
    if (!cstreams.length && isRecent) {
      const tgt = streamWatcher.getRecentTargetForCircuit(c.id);
      if (tgt) displayStreams = [{ streamId: 'recent', state: 'RECENT', circuitId: c.id, target: tgt }];
    }

    return {
      ...c,
      relays,
      streams: displayStreams,
      inUse: isLiveNow || isRecent,
    };
  }));
  return enriched.filter(c => !c.buildFlags.includes('ONEHOP_TUNNEL') && c.relays.length > 0);
}

// The window asks for circuits from two places at once (the Circuits tab every 3 s, the map every 2.5 s). They share one answer for
// up to a second, and concurrent requests share one query, so both always show the same circuits and the control port isn't asked
// twice. Anything that changes the circuits (a stream event, closing or building one) drops the shared answer.
let _shared = { at: 0, value: null, pending: null, gen: 0 };
function invalidateCircuits() { _shared.at = 0; _shared.value = null; _shared.pending = null; _shared.gen++; }   // a query already under way may predate the change: the next caller starts a fresh one
function getCircuitsShared(maxAgeMs = 1000) {
  if (_shared.value && Date.now() - _shared.at < maxAgeMs) return Promise.resolve(_shared.value);
  if (_shared.pending) return _shared.pending;
  const gen = _shared.gen;
  const p = getCircuitsDetailed().then((v) => {
    if (gen === _shared.gen) { _shared.value = v; _shared.at = Date.now(); }   // something changed meanwhile: don't keep a stale answer
    return v;
  }).finally(() => { if (_shared.pending === p) _shared.pending = null; });
  _shared.pending = p;
  return p;
}

async function getStreamStatus() {
  const raw = await ctrl('GETINFO stream-status');
  const lines = extractBlock(raw, '250+stream-status=');
  const streams = [];
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const [sid, state, cid, target] = parts;
    if (!/^\d+$/.test(sid)) continue;
    streams.push({ streamId: sid, state, circuitId: cid, target });
  }
  return streams;
}

async function getTraffic() {
  const [r, w] = await Promise.all([ctrl('GETINFO traffic/read'), ctrl('GETINFO traffic/written')]);
  const read    = Number((r.match(/traffic\/read=(\d+)/) || [])[1]) || 0;
  const written = Number((w.match(/traffic\/written=(\d+)/) || [])[1]) || 0;
  return { read, written, ts: Date.now() };
}

function b64ToHex(b64) {
  if (!b64) return '';
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  try { return Buffer.from(b64 + pad, 'base64').toString('hex').toUpperCase(); }
  catch { return ''; }
}

async function getRouterList() {
  if (CACHE.routers && Date.now() - CACHE.routers.ts < ROUTER_TTL) {
    return CACHE.routers.list;
  }
  const raw = await ctrl('GETINFO ns/all');
  const block = extractBlock(raw, '250+ns/all=');

  const out = [];
  let buf = null;
  for (const line of block) {
    if (line.startsWith('r ')) {
      if (buf) out.push(buf);
      const p = line.split(/\s+/);
      buf = {
        fingerprint: b64ToHex(p[2] || ''),
        nickname:    p[1] || null,
        ip:          p[6] || null,
        orPort:      Number(p[7]) || null,
        dirPort:     Number(p[8]) || null,
        flags: [], bandwidth: 0,
      };
    } else if (line.startsWith('s ') && buf) {
      buf.flags = line.slice(2).trim().split(/\s+/).filter(Boolean);
    } else if (line.startsWith('w ') && buf) {
      const m = line.match(/Bandwidth=(\d+)/);
      if (m) buf.bandwidth = Number(m[1]);
    }
  }
  if (buf) out.push(buf);

  CACHE.routers = { list: out, ts: Date.now() };
  return out;
}

async function extendCircuit() {
  invalidateCircuits();
  const raw = await ctrl('EXTENDCIRCUIT 0');
  const m = raw.match(/250 EXTENDED (\d+)/);
  return m ? m[1] : null;
}

async function closeCircuit(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('invalid circuit id');
  const raw = await ctrl(`CLOSECIRCUIT ${id}`);
  invalidateCircuits();
  return raw.includes('250 OK');
}

// Replace the circuits that carry ordinary (SOCKS5 / exit) traffic; hidden-service and housekeeping circuits are left alone.
const GENERAL_PURPOSES = new Set(['GENERAL', 'CONFLUX_LINKED', 'CONFLUX_UNLINKED', 'CONTROLLER']);
function selectGeneralTraffic(list) {
  return (list || []).filter((c) => GENERAL_PURPOSES.has(c.purpose) && !c.hsState);
}

// The replacement starts first (no gap) and nothing is closed if it can't start. No NEWNYM: it would mark the new circuit unusable.
async function renewGeneralCircuits(deps = {}) {
  const d = { getCircuits, extendCircuit, closeCircuit, ...deps };
  const old = selectGeneralTraffic(await d.getCircuits());
  const id = await d.extendCircuit();
  if (!id) return { ok: false, id: null, closed: 0 };
  let closed = 0;
  for (const c of old) {
    if (String(c.id) === String(id)) continue;
    try { if (await d.closeCircuit(c.id)) closed++; } catch {}
  }
  return { ok: true, id, closed };
}

async function rebuildCircuitForContact(address) {
  const addr = String(address || '').toLowerCase();
  const info = streamWatcher.getCircuitFor(addr);
  if (!info || !info.circuitId) return { closed: false, circuitId: null };
  let closed = false;
  try { closed = await closeCircuit(info.circuitId); } catch { closed = false; }
  streamWatcher.forget(addr);
  return { closed, circuitId: info.circuitId };
}

// The SOCKS circuit to show: the one carrying ordinary traffic right now. Same rule as the Circuits tab (live circuits, plus the one
// the user just built with "New circuit"), reduced to a single circuit: a built general-purpose circuit with live streams wins, then
// one used in the last 30 s, then a just-built one; ties go to the newest. Hidden-service circuits are never SOCKS traffic.
function pickSocksCircuit(list, userIds = []) {
  const mine = new Set((userIds || []).map(String));
  const general = (list || []).filter((c) => c.state === 'BUILT' && GENERAL_PURPOSES.has(c.purpose) && !c.hsState && !(c.buildFlags || []).includes('IS_INTERNAL'));
  const live = (c) => (c.streams || []).filter((s) => s.state !== 'RECENT').length;
  const newest = (a, b) => Number(b.id) - Number(a.id);
  const used = general.filter((c) => c.inUse).sort((a, b) => live(b) - live(a) || newest(a, b));
  if (used.length) return used[0];
  return general.filter((c) => mine.has(String(c.id))).sort(newest)[0] || null;
}

// The circuit that carries our messages to one contact. The stream watcher remembers which circuit the last stream to that
// contact used; that is only a hint, so it is checked against the live circuit list: it must still exist, be fully built and
// still be a hidden-service client circuit. Anything else is "none", never a stand-in circuit.
function resolveContactCircuit(info, list) {
  if (!info || !info.circuitId) return { status: 'none', reason: 'never' };
  const c = (list || []).find((x) => String(x.id) === String(info.circuitId));
  if (!c) return { status: 'none', reason: 'closed' };
  if (c.state !== 'BUILT') return { status: 'none', reason: 'not-built' };
  if (!/HS_CLIENT/.test(c.purpose || '')) return { status: 'none', reason: 'not-hs' };
  return { status: c.inUse ? 'active' : 'idle', circuit: c, lastUsed: info.ts || null };
}

// Only whether our address details exist yet (one light query, unlike getServiceHealth, which also lists every circuit).
async function isServicePublished(address) {
  const id = String(address || '').replace(/\.anyone$/i, '');
  if (!id) return false;
  try { return (await ctrl(`GETINFO hs/service/desc/id/${id}`)).includes('250+hs/service/desc/id/'); } catch { return false; }
}

async function getServiceHealth(address) {
  const id = String(address || '').replace(/\.anyone$/i, '');
  const health = {
    address: id ? id + '.anyone' : null,
    published: false,
    introPoints: null,
    hsCircuits: { intro: 0, rendezvous: 0, establishing: 0 },
    detail: 'unknown',
  };
  if (!id) { health.detail = 'no-address'; return health; }

  try {
    const raw = await ctrl(`GETINFO hs/service/desc/id/${id}`);
    // The introduction points are listed in the encrypted part of the descriptor, so they can't be counted from it: they are counted
    // below from the open introduction circuits instead.
    if (raw.includes('250+hs/service/desc/id/')) health.published = true;
  } catch (e) {
    health.error = e.message;
  }

  let established = 0;               // introduction points in place: the ones others can reach us through right now
  try {
    const raw = await ctrl('GETINFO circuit-status');
    for (const line of raw.split('\n')) {
      if (/PURPOSE=HS_SERVICE_INTRO/.test(line)) {
        health.hsCircuits.intro++;
        if (/HS_STATE=HSSI_ESTABLISHED/.test(line)) established++;
      }
      else if (/PURPOSE=HS_SERVICE_REND/.test(line))  health.hsCircuits.rendezvous++;
      if (/HS_STATE=HSSI_CONNECTING|HS_STATE=HSSR_CONNECTING/.test(line)) health.hsCircuits.establishing++;
    }
    if (health.published) health.introPoints = established;
  } catch {}

  if (!health.published && health.hsCircuits.establishing > 0) health.detail = 'establishing';
  else if (!health.published)                                  health.detail = 'not-published';
  else if (established === 0)                                  health.detail = 'published-no-intro';
  else                                                         health.detail = 'reachable';

  return health;
}

class StreamWatcher extends EventEmitter {
  constructor() {
    super();
    this.contactCircuit = new Map();
    this.recentCircuits = new Map();
    this.sock = null;
    this.alive = false;
    this.connectAttempts = 0;
  }
  start() {
    if (this.alive) return;
    this.alive = true;
    this._connect();
  }
  stop() {
    this.alive = false;
    if (this.sock) { try { this.sock.destroy(); } catch {} this.sock = null; }
  }
  _connect() {
    if (!this.alive) return;
    let cookie;
    try { cookie = fs.readFileSync(COOKIE); }
    catch {
      setTimeout(() => this._connect(), 1500);
      return;
    }
    this.sock = net.connect(CTRL_PORT, HOST, () => {
      this.connectAttempts = 0;
      this.sock.write(`AUTHENTICATE ${cookie.toString('hex')}\r\n`);
      this.sock.write(`SETEVENTS STREAM\r\n`);
    });
    let buf = '';
    this.sock.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trimEnd();
        buf = buf.slice(i + 1);
        this._handleLine(line);
      }
    });
    this.sock.on('error', () => {});
    this.sock.on('close', () => {
      this.sock = null;
      if (this.alive) {
        const delay = Math.min(30000, 1000 * Math.pow(2, this.connectAttempts++));
        setTimeout(() => this._connect(), delay);
      }
    });
  }
  _handleLine(line) {
    if (!line.startsWith('650 STREAM')) return;
    const parts = line.split(/\s+/);
    if (parts.length < 6) return;
    const state = parts[3];
    const circId = parts[4];
    const target = parts[5];
    if (!/^[0-9]+$/.test(circId) || circId === '0') return;

    // Track every STREAM event so chat circuits stay visible after the stream closes (chat messages are short POSTs).
    this.recentCircuits.set(circId, { lastSeen: Date.now(), target });
    invalidateCircuits();

    const m = target.match(/^([a-z2-7]{56}\.anyone):\d+/i);
    if (m) {
      const addr = m[1].toLowerCase();
      if (state === 'SUCCEEDED' || state === 'REMAP' || state === 'SENTCONNECT') {
        this.contactCircuit.set(addr, { circuitId: circId, ts: Date.now() });
      } else if (state === 'CLOSED' || state === 'FAILED') {
        const cur = this.contactCircuit.get(addr);
        if (cur) cur.closed = Date.now();
      }
    }

    if (this.recentCircuits.size > 200) {
      const cutoff = Date.now() - RECENT_TTL_MS;
      for (const [k, v] of this.recentCircuits) if (v.lastSeen < cutoff) this.recentCircuits.delete(k);
    }
  }
  getCircuitFor(address) {
    const v = this.contactCircuit.get(String(address || '').toLowerCase());
    if (!v) return null;
    if (Date.now() - v.ts > 10 * 60 * 1000) return null;
    return v;
  }
  forget(address) {
    this.contactCircuit.delete(String(address || '').toLowerCase());
  }
  getRecentCircuitIds() {
    const cutoff = Date.now() - RECENT_TTL_MS;
    const out = new Set();
    for (const [cid, v] of this.recentCircuits) {
      if (v.lastSeen >= cutoff) out.add(cid);
    }
    return out;
  }
  getRecentTargetForCircuit(circuitId) {
    const v = this.recentCircuits.get(String(circuitId));
    if (!v) return null;
    if (Date.now() - v.lastSeen > RECENT_TTL_MS) return null;
    return v.target;
  }
}

const streamWatcher = new StreamWatcher();

module.exports = {
  getCircuitsDetailed, getCircuitsShared, invalidateCircuits,
  extendCircuit, closeCircuit, renewGeneralCircuits, selectGeneralTraffic,
  rebuildCircuitForContact, resolveContactCircuit, pickSocksCircuit,
  getRouterList,
  getTraffic,
  getServiceHealth,
  isServicePublished,
  startStreamWatcher: () => streamWatcher.start(),
  getActiveCircuitForAddress: (addr) => streamWatcher.getCircuitFor(addr),
};
