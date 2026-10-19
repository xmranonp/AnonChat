'use strict';

// Sliding-window rate limiter for /api/inbox, per source IP and per claimed sender.

const PER_MIN_IP   = parseInt(process.env.INBOX_PER_MIN_IP   || '60', 10);
const PER_MIN_FROM = parseInt(process.env.INBOX_PER_MIN_FROM || '30', 10);
const BURST        = parseInt(process.env.INBOX_BURST        || '10', 10);
// Contacts and group members whose message carries a valid stamp (lib/stamp.js) are known to be who they say: they get their own, much
// larger allowance, so sending a dozen photos at once or a lively group chat is never throttled (or delivered late and out of order).
const TRUSTED_BURST   = parseInt(process.env.INBOX_TRUSTED_BURST   || '60', 10);
const TRUSTED_PER_MIN = parseInt(process.env.INBOX_TRUSTED_PER_MIN || '600', 10);
const WINDOW_MS    = 60_000;
const BURST_MS     = 1_000;

const buckets = new Map();
const MAX_KEYS = 5000;

function check(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { stamps: [], lastTouch: now }; buckets.set(key, b); }
  const cutoff = now - windowMs;
  while (b.stamps.length && b.stamps[0] < cutoff) b.stamps.shift();
  if (b.stamps.length >= limit) { b.lastTouch = now; return false; }
  b.stamps.push(now); b.lastTouch = now;
  return true;
}

// Lazy sweep: under a flood of fresh rotating IPs every bucket is recent, so a hard ceiling forces a sweep and memory stays bounded.
function sweep() {
  if (buckets.size <= MAX_KEYS) return;
  const cutoff = Date.now() - 5 * WINDOW_MS;
  for (const [k, b] of buckets) if (b.lastTouch < cutoff) buckets.delete(k);
  if (buckets.size > MAX_KEYS) {
    const sorted = [...buckets.entries()].sort((a, b) => a[1].lastTouch - b[1].lastTouch);
    const excess = buckets.size - MAX_KEYS;
    for (let i = 0; i < excess; i++) buckets.delete(sorted[i][0]);
  }
}
setInterval(sweep, WINDOW_MS).unref();

// Seconds until `key` has room again in a window of `windowMs` holding `limit` entries (for Retry-After).
function waitSeconds(key, limit, windowMs) {
  const b = buckets.get(key);
  if (!b || b.stamps.length < limit) return 1;
  return Math.max(1, Math.ceil((b.stamps[b.stamps.length - limit] + windowMs - Date.now()) / 1000));
}
const LIMITS = {
  burst_trusted: ['tfrom:', TRUSTED_BURST, BURST_MS], minute_trusted: ['tfromm:', TRUSTED_PER_MIN, WINDOW_MS],
  burst_ip: ['ip:', BURST, BURST_MS], burst_from: ['from:', BURST, BURST_MS],
  minute_ip: ['ipm:', PER_MIN_IP, WINDOW_MS], minute_from: ['fromm:', PER_MIN_FROM, WINDOW_MS],
};
// How long the sender should wait before trying again after `reason` (what classify returned).
function retryAfter(reason, { ip, from }) {
  const l = LIMITS[reason]; if (!l) return 60;
  return waitSeconds(l[0] + (l[0].startsWith('ip') ? ip : from), l[1], l[2]);
}

function classify({ ip, from, trusted = false }) {
  // Hard ceiling between scheduled sweeps: if a fast flood balloons the map,
  // sweep immediately so memory can't spike past ~2x the cap within one window.
  if (buckets.size > MAX_KEYS * 2) sweep();
  if (trusted) {
    if (!check('tfrom:'  + from, TRUSTED_BURST,   BURST_MS))  return 'burst_trusted';
    if (!check('tfromm:' + from, TRUSTED_PER_MIN, WINDOW_MS)) return 'minute_trusted';
    return null;
  }
  // ip null: a contact, limited per sender only (see server.js).
  if (ip != null && !check('ip:'   + ip,   BURST,        BURST_MS))  return 'burst_ip';
  if (!check('from:' + from, BURST,        BURST_MS))  return 'burst_from';
  if (ip != null && !check('ipm:'  + ip,   PER_MIN_IP,   WINDOW_MS)) return 'minute_ip';
  if (!check('fromm:'+ from, PER_MIN_FROM, WINDOW_MS)) return 'minute_from';
  return null;
}

function pressure({ ip, from }) {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const stamps = (key) => {
    const b = buckets.get(key);
    if (!b) return 0;
    while (b.stamps.length && b.stamps[0] < cutoff) b.stamps.shift();
    return b.stamps.length;
  };
  const ipPressure   = stamps('ipm:'   + ip)   >= Math.max(3, Math.floor(PER_MIN_IP   / 2));
  const fromPressure = stamps('fromm:' + from) >= Math.max(3, Math.floor(PER_MIN_FROM / 2));
  return ipPressure || fromPressure;
}

module.exports = { classify, pressure, retryAfter, _internals: { buckets, PER_MIN_IP, PER_MIN_FROM, BURST, TRUSTED_BURST, TRUSTED_PER_MIN } };
