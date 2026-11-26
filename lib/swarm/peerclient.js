'use strict';
// Talking to one mailbox peer (design section 5). Everything here is about the connection and the answers; what to do with them is
// decided by the callers (sending, collecting).
//
// - One isolated route per (peer, purpose): a SOCKS user name per purpose and per peer, so the network never puts two purposes, or two
//   peers, on one route. Purposes: swarm-drop (drops, one-shot status), swarm-status (status long-polls), swarm-owner (hello, join,
//   tokens, info, collect, ack, leave), swarm-wait (the owner's live waits).
// - At most 6 requests at a time per purpose. More wait in a queue of our own, and that wait is not counted against any deadline or as a
//   failure of the route (independent review, 22 November: with the queue inside the HTTP agent, the 7th request's wait counted as "no
//   route", and the new route that followed cut off the six that were working).
// - Keep-alive: sockets are kept between requests for as long as the peer says (its Keep-Alive header; 75 s on the peer, so 74 s here).
//   A socket carrying a request never times out on its own: the deadlines below end requests.
// - A request that fails on a reused socket before any answer is sent again once, on a new socket. The peer may already have done it;
//   that is harmless for every request (a drop again returns its id; ack, tokens, join again do nothing new), except that collect and
//   wait then report our own first try as the previous collection, and leave answers 404: the result says `resent` so callers can tell.
// - Deadlines that end the request themselves (the soak test found two ways a request could hang for hours without them): the route must
//   be up within 15 s (30 s if the peer hasn't answered in the last 10 minutes), counted from when a socket is asked for; the answer must
//   be complete within 30 s plus 20 s per MiB of what is sent and the most that may come back, plus any wait asked for. An answer cut off
//   in the middle is an error, never a short answer. A SOCKS connection that is given up is closed within 30 s, so it can't hold a place.
// - Every answer is checked before anyone sees it (lib/swarm/answers.js). Anything that doesn't fit is a malformed answer: an error like
//   a failed request, logged without identifiers.
// - Failures are counted per purpose: after 4 in a row the purpose gets a new route (the old one finishes what it carries and is then
//   closed); after 2 in a row without any answer the peer's address details are fetched again (by the caller's hsFetch, which limits how
//   often). An answer, even "busy", ends the series and costs nothing. Bad values from the caller are refused before anything is sent and
//   are not counted.
// - The peer's clock: every answer says what it is (X-Swarm-Time, when its headers left). It is read when the headers arrive, and the
//   offset of the answer that came fastest in the last 10 minutes is used. A time more than a year from ours is malformed.
// Tokens, owner secrets and mailbox IDs are never logged and never put in an error message.
const http = require('http');
const crypto = require('crypto');
const { SocksProxyAgent } = require('socks-proxy-agent');
const A = require('./answers');
const netlock = require('../netlock');

const ADDR = /^[a-z2-7]{56}\.anyone$/;
const ID = /^[0-9a-f]{32}$/, KID = /^[0-9a-f]{16}$/, HASH = /^[0-9a-f]{64}$/, SECRET = /^[A-Za-z0-9_-]{43}$/;
const PURPOSES = ['swarm-drop', 'swarm-status', 'swarm-owner', 'swarm-wait'];
const MiB = 1024 * 1024, YEAR = 366 * 24 * 3600 * 1000;
const RUN_TAG = crypto.randomBytes(8).toString('hex');          // new routes at every start

class SwarmError extends Error {
  // kind: 'answer' (the peer answered with an error status), 'network' (no connection), 'deadline', 'cut' (answer cut off),
  // 'malformed', 'local' (a bad value from the caller: nothing was sent)
  constructor(kind, message, extra = {}) { super(message); this.name = 'SwarmError'; this.kind = kind; Object.assign(this, extra); }
  get reached() { return this.kind === 'answer'; }          // the peer itself answered
}
const local = (what) => new SwarmError('local', 'bad value: ' + what);

// A SOCKS agent whose connection attempt gives up within `handshakeMs`, and whose sockets have no timeout of their own afterwards
// (socks-proxy-agent would otherwise keep its timeout on the socket and destroy it in the middle of a long answer).
class Agent extends SocksProxyAgent {
  async connect(req, opts) {
    const s = await super.connect(req, opts);
    s.setTimeout(0); s.removeAllListeners('timeout');
    return s;
  }
}

function create({ address, socksUrl, hsFetch = () => {}, log = () => {}, now = () => Date.now(), agentFor = null, timing = {} }) {
  if (!ADDR.test(address)) throw new Error('not a .anyone address');
  const T = { connectMs: 15000, connectColdMs: 30000, warmMs: 10 * 60 * 1000, baseMs: 30000, perMiBMs: 20000, parallel: 6,
    rotateAfter: 4, fetchAfter: 2, offsetWindowMs: 10 * 60 * 1000, ...timing };
  const base = agentFor ? null : new URL(netlock.normalizeSocks(socksUrl));          // loopback, socks5h, a port: or it throws
  const tag = crypto.createHash('sha256').update(address).digest('hex').slice(0, 8);
  const agents = new Map(), gen = new Map(), fails = new Map(), slots = new Map();
  let lastAnswerAt = -Infinity, noAnswerRun = 0;
  let clock = null;          // {offset, rtt, at}

  // ---- agents and routes ----
  function agent(purpose) {
    if (agentFor) return agentFor(purpose);          // the tests: a local socket
    let a = agents.get(purpose);
    if (!a) {
      const user = `${purpose}-${tag}`, pass = `${RUN_TAG}-${gen.get(purpose) || 0}`;
      a = new Agent(`socks5h://${user}:${pass}@${base.hostname}:${base.port}`, { keepAlive: true, maxSockets: 2 * T.parallel, maxFreeSockets: T.parallel, timeout: T.connectColdMs, scheduling: 'lifo' });
      a.inUse = 0; a.retired = false;
      agents.set(purpose, a);
    }
    return a;
  }
  function retire(a) { if (!a || a.retired) return; a.retired = true; if (!a.inUse) try { a.destroy(); } catch {} }
  function rotate(purpose) {
    gen.set(purpose, (gen.get(purpose) || 0) + 1);
    const a = agents.get(purpose); agents.delete(purpose);
    retire(a);          // what it carries now finishes on the old route; then it is closed
  }
  function noteResult(purpose, err) {
    if (err && err.kind === 'local') return;
    if (!err || err.kind === 'answer' || (err.kind === 'malformed' && err.answered)) { fails.set(purpose, 0); noAnswerRun = 0; return; }
    const n = (fails.get(purpose) || 0) + 1; fails.set(purpose, n);
    if (n >= T.rotateAfter) { fails.set(purpose, 0); rotate(purpose); log(`[swarm] a peer's ${purpose} route failed ${T.rotateAfter} times: a new route`); }
    if (++noAnswerRun >= T.fetchAfter) { noAnswerRun = 0; Promise.resolve().then(() => hsFetch(address)).catch(() => {}); }
  }

  // ---- at most `parallel` requests per purpose; the rest wait here, outside every deadline ----
  function slot(purpose) {
    let s = slots.get(purpose); if (!s) { s = { busy: 0, queue: [] }; slots.set(purpose, s); }
    return new Promise((resolve) => {
      const go = () => { s.busy++; let freed = false; resolve(() => { if (freed) return; freed = true; s.busy--; const next = s.queue.shift(); if (next) next(); }); };
      if (s.busy < T.parallel) go(); else s.queue.push(go);
    });
  }

  // ---- the peer's clock ----
  function sampleClock(peerTime, rtt) {
    const t = now(), offset = peerTime - t;
    if (!clock || rtt <= clock.rtt || t - clock.at > T.offsetWindowMs) clock = { offset, rtt, at: t };
  }

  // One request on one socket. Resolves {status, headers, body, peerTime} for any complete answer; rejects SwarmError otherwise.
  function once(purpose, method, path, { headers = {}, body = null, maxBytes, waitMs = 0 }) {
    return new Promise((resolve, reject) => {
      let done = false, connectTimer = null, hardTimer = null, socketReused = false, sentAt = 0;
      const ag = agent(purpose); if (ag && ag.inUse !== undefined) ag.inUse++;
      const finish = (err, val) => {
        if (done) return; done = true; clearTimeout(connectTimer); clearTimeout(hardTimer);
        if (ag && ag.inUse !== undefined) { ag.inUse--; if (ag.retired && !ag.inUse) try { ag.destroy(); } catch {} }
        if (err) { err.reusedSocket = socketReused; reject(err); } else resolve(val);
      };
      const sizeIn = body ? body.length : 0;
      const answerMs = T.baseMs + Math.ceil((sizeIn + maxBytes.expected) / MiB) * T.perMiBMs + waitMs;
      const req = http.request({ host: address, port: 80, method, path: '/swarm/v1' + path, agent: ag,
        headers: { ...(body ? { 'Content-Type': body.json ? 'application/json' : 'application/octet-stream', 'Content-Length': sizeIn } : { 'Content-Length': 0 }), ...headers } }, (res) => {
        const raw = String(res.headers['x-swarm-time'] ?? '');
        const t = /^\d{1,16}$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isFinite(t) || Math.abs(t - now()) > YEAR) { req.destroy(); return finish(new SwarmError('malformed', 'no usable X-Swarm-Time', { answered: true, status: res.statusCode })); }
        sampleClock(t, now() - sentAt);
        const cl = res.headers['content-length'];
        if (!/^\d{1,12}$/.test(String(cl ?? ''))) { req.destroy(); return finish(new SwarmError('malformed', 'no Content-Length', { answered: true, status: res.statusCode })); }
        if (Number(cl) > maxBytes.limit) { req.destroy(); return finish(new SwarmError('malformed', 'answer too big', { answered: true, status: res.statusCode })); }
        const chunks = []; let n = 0;
        res.on('data', (c) => { n += c.length; if (n > Number(cl)) { req.destroy(); finish(new SwarmError('malformed', 'answer longer than it said', { answered: true })); return; } chunks.push(c); });
        res.on('error', () => finish(new SwarmError('cut', 'answer cut off')));
        res.on('close', () => { if (!res.complete) finish(new SwarmError('cut', 'answer cut off')); });
        res.on('end', () => { if (n !== Number(cl)) return finish(new SwarmError('cut', 'answer cut off')); finish(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), peerTime: t }); });
      });
      req.on('socket', (s) => {
        socketReused = !!req.reusedSocket;
        s.setTimeout(0);          // no idle timer while it carries a request: the deadlines end requests
        const up = () => { clearTimeout(connectTimer); sentAt = now(); };
        if (s.connecting) s.once('connect', up); else up();
      });
      const cold = now() - lastAnswerAt > T.warmMs, connectMs = cold ? T.connectColdMs : T.connectMs;
      connectTimer = setTimeout(() => { req.destroy(); finish(new SwarmError('network', 'no route to the peer in time')); }, connectMs);
      hardTimer = setTimeout(() => { req.destroy(); finish(new SwarmError('deadline', 'no complete answer in time')); }, connectMs + answerMs);
      req.on('error', (e) => finish(new SwarmError('network', 'request failed: ' + (e.code || 'error'))));
      req.end(body || undefined);
    });
  }

  // A request with the checks: a place among the 6, one resend on a reused socket that failed before any answer, the answer checked.
  async function request(purpose, method, path, { headers, json, raw, maxBytes = { limit: A.MAX_JSON, expected: 0 }, waitMs = 0, check }) {
    let body = null;
    if (raw) body = raw;
    else if (json !== undefined) { body = Buffer.from(JSON.stringify(json)); body.json = true; }
    const free = await slot(purpose);
    let res, err, resent = false;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { res = await once(purpose, method, path, { headers, body, maxBytes, waitMs }); err = null; break; }
        catch (e) { err = e; if (!(e.reusedSocket && e.kind === 'network') || attempt) break; resent = true; }
      }
    } finally { free(); }
    if (err) { noteResult(purpose, err); throw err; }
    lastAnswerAt = now();
    const ctype = String(res.headers['content-type'] || '');
    let out;
    try {
      if (res.status >= 400) {
        const j = A.json(res.body, ctype);
        const e = A.error(j, res.status);
        err = new SwarmError('answer', `${res.status} ${e.code}`, { status: res.status, code: e.code, retryAfter: A.retryAfter(res.headers['retry-after'], j.retryAfter), resent });
      } else { out = check(res, ctype); if (out && typeof out === 'object') Object.defineProperty(out, 'resent', { value: resent, enumerable: false }); }
    } catch (e) {
      err = e instanceof SwarmError ? e : new SwarmError('malformed', 'malformed answer: ' + e.message, { answered: true, status: res.status });
      log(`[swarm] a malformed answer from a peer (${path}): ${err.message}`);
    }
    noteResult(purpose, err);
    if (err) throw err;
    return out;
  }

  // ---- what callers give: checked before anything is sent ----
  function ownerHeaders(o) {
    if (!o || !ID.test(String(o.mailbox)) || !SECRET.test(String(o.secret))) throw local('owner');
    return { 'X-Swarm-Mailbox': o.mailbox, 'X-Swarm-Owner': o.secret };
  }
  const hashes = (v) => v === undefined || (Array.isArray(v) && v.length <= 2000 && v.every((h) => HASH.test(String(h))));
  const jsonOk = (want, schema) => (res, ctype) => { if (res.status !== want) throw new Error('status ' + res.status); return schema(A.json(res.body, ctype)); };
  const guard = (f) => (...args) => { try { return f(...args); } catch (e) { return Promise.reject(e); } };          // a bad value: a rejected promise, never a throw

  return {
    address,
    // The peer's clock, as an offset from ours (null before any answer); a time the peer reports, on our clock.
    clockOffset: () => (clock ? clock.offset : null),
    toLocal: (peerMs) => peerMs - (clock ? clock.offset : 0),
    lastAnswerAt: () => lastAnswerAt,
    hello: guard(() => request('swarm-owner', 'GET', '/hello', { check: jsonOk(200, A.hello) })),
    join: guard((invite, ownerHash) => {
      if (!ID.test(String(invite)) || !HASH.test(String(ownerHash))) throw local('invite or owner hash');
      return request('swarm-owner', 'POST', '/join', { json: { invite, ownerHash }, check: jsonOk(200, A.join) });
    }),
    tokens: guard((owner, change = {}) => {
      const h = ownerHeaders(owner);
      if (!hashes(change.add) || !hashes(change.delete) || !hashes(change.replace) || (change.replace && (change.add || change.delete))) throw local('token hashes');
      if (change.kids !== undefined && !(Array.isArray(change.kids) && change.kids.length <= 16 && change.kids.every((k) => KID.test(String(k))))) throw local('kids');
      return request('swarm-owner', 'POST', '/tokens', { headers: h, json: change, check: jsonOk(200, A.tokens) });
    }),
    info: guard((owner) => request('swarm-owner', 'POST', '/info', { headers: ownerHeaders(owner), json: {}, check: jsonOk(200, A.info) })),
    leave: guard((owner) => request('swarm-owner', 'POST', '/leave', { headers: ownerHeaders(owner), json: {}, check: jsonOk(200, A.ok) })),
    ack: guard((owner, acks) => {
      if (!Array.isArray(acks) || acks.length > 1000 || !acks.every((a) => a && ID.test(String(a.id)) && (a.result === 'stored' || a.result === 'discarded'))) throw local('acks');
      return request('swarm-owner', 'POST', '/ack', { headers: ownerHeaders(owner), json: { acks: acks.map((a) => ({ id: a.id, result: a.result })) }, check: jsonOk(200, A.ok) });
    }),
    // A sealed drop: body is the sealed bytes (a size step).
    drop: guard(({ token, kid, expiry, body }) => {
      if (!SECRET.test(String(token)) || !KID.test(String(kid)) || !Number.isInteger(expiry) || expiry <= 0 || expiry % 3600 || !Buffer.isBuffer(body) || !require('./seal').isStep(body.length)) throw local('drop');
      return request('swarm-drop', 'POST', '/drop', { headers: { 'X-Swarm-Token': token, 'X-Swarm-Kid': kid, 'X-Swarm-Expiry': String(expiry) }, raw: body, check: jsonOk(202, A.dropped) });
    }),
    // status: one-shot (swarm-drop route) or, with wait (seconds, at most 50), a long-poll (swarm-status route). tokens: 1 to 8.
    status: guard((tokens, { since, ids, wait } = {}) => {
      if (!Array.isArray(tokens) || !tokens.length || tokens.length > 8 || !tokens.every((t) => SECRET.test(String(t)))) throw local('tokens');
      if (ids !== undefined && !(Array.isArray(ids) && ids.length <= 64 && ids.every((i) => ID.test(String(i))))) throw local('ids');
      if (since !== undefined && !/^\d{1,16}$/.test(String(since))) throw local('since');
      const w = wait ? Math.min(50, Math.max(1, Math.floor(Number(wait) || 0))) : 0;
      return request(w ? 'swarm-status' : 'swarm-drop', 'POST', '/status', {
        headers: { 'X-Swarm-Token': tokens.join(',') }, json: { ...(since !== undefined ? { since: String(since) } : {}), ...(ids ? { ids } : {}), ...(w ? { wait: w } : {}) },
        waitMs: w * 1000, check: jsonOk(200, A.status) });
    }),
    // The owner's live wait: a frame, or {closed:'superseded'}. Acks ride along.
    wait: guard((owner, { cursor, acks } = {}) => {
      const h = ownerHeaders(owner);
      if (cursor !== undefined && !/^\d{1,16}$/.test(String(cursor))) throw local('cursor');
      if (acks !== undefined && !(Array.isArray(acks) && acks.length <= 1000 && acks.every((a) => a && ID.test(String(a.id)) && (a.result === 'stored' || a.result === 'discarded')))) throw local('acks');
      return request('swarm-wait', 'POST', '/wait', { headers: h, json: { ...(cursor !== undefined ? { cursor: String(cursor) } : {}), ...(acks && acks.length ? { acks: acks.map((a) => ({ id: a.id, result: a.result })) } : {}) },
        maxBytes: { limit: A.MAX_WAIT_FRAME, expected: A.MAX_WAIT_FRAME }, waitMs: 50000, check: (res, ctype) => A.waitAnswer(res, ctype) });
    }),
    collect: guard((owner, sel = {}) => {
      const h = ownerHeaders(owner);
      if (sel.ids !== undefined && !(Array.isArray(sel.ids) && sel.ids.length <= 256 && sel.ids.every((i) => ID.test(String(i))))) throw local('ids');
      if (sel.cursor !== undefined && !/^\d{1,16}$/.test(String(sel.cursor))) throw local('cursor');
      const body = sel.ids ? { ids: sel.ids } : (sel.cursor !== undefined ? { cursor: String(sel.cursor) } : {});
      return request('swarm-owner', 'POST', '/collect', { headers: h, json: body, maxBytes: { limit: A.MAX_FRAME, expected: A.MAX_FRAME },
        check: (res, ctype) => { if (res.status !== 200) throw new Error('status ' + res.status); return A.frame(res.body, ctype, { byIds: Array.isArray(sel.ids) }); } });
    }),
    close() { for (const a of agents.values()) { try { a.destroy(); } catch {} } agents.clear(); },
    _fails: () => Object.fromEntries(fails),          // the tests
  };
}

module.exports = { create, SwarmError, PURPOSES, ADDR };
