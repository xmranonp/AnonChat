'use strict';
// Why messages to someone are waiting: one line in the Status log (network panel) when tries to an address start failing, again when
// the reason changes or at most once a minute while it stays the same, and one when a message gets through. Kept in memory only (gone
// when the app closes), never written to disk, and an address is shown shortened, so a log copied to ask for help doesn't list contacts.
// English in every language, like the rest of that log; the network's own term is in brackets.

// The Anyone network says why it couldn't reach an onion address with its own SOCKS reply codes (SocksPort ExtendedErrors, start.js).
// The SOCKS library knows only the standard ones and names the reply after them: these names are added for the network's codes, so the
// error says which one it was ("… - HsDescNotFound"). Every name starts with "Hs", which server.js treats as worth a second try.
const HS_REPLIES = {
  0xF0: 'HsDescNotFound', 0xF1: 'HsDescInvalid', 0xF2: 'HsIntroFailed', 0xF3: 'HsRendFailed',
  0xF4: 'HsMissingClientAuth', 0xF5: 'HsWrongClientAuth', 0xF6: 'HsBadAddress', 0xF7: 'HsIntroTimedOut',
};
function nameSocksReplies() {
  try {
    const c = require('socks/build/common/constants');
    for (const [code, name] of Object.entries(HS_REPLIES)) if (c.Socks5Response[code] === undefined) c.Socks5Response[code] = name;
  } catch {}
}
nameSocksReplies();

// A failed try, in plain words. `err` is what axios threw.
const SOCKS_REASONS = [
  [/HsDescNotFound/,      'address not found on the network', 'descriptor not found'],
  [/HsDescInvalid/,       'its address details could not be read', 'descriptor invalid'],
  [/HsIntroTimedOut/,     'no answer from its address', 'introduction timed out'],
  [/HsIntroFailed/,       'found its address, but could not reach it', 'introduction failed'],
  [/HsRendFailed/,        'found its address, but the route to it failed', 'rendezvous failed'],
  [/HsBadAddress/,        'not a valid address', 'invalid address'],
  [/HsMissingClientAuth|HsWrongClientAuth/, 'its address is restricted', 'client authorization'],
  [/TTLExpired/,          'the route timed out', 'TTL expired'],
  [/HostUnreachable/,     'unreachable', 'host unreachable'],
  [/ConnectionRefused/,   'its app is not taking connections', 'connection refused'],
  [/NetworkUnreachable/,  'the network is unreachable', 'network unreachable'],
  [/Socks5ProxyRejected|proxy rejected|FinalHandshakeRejected/i, 'the network could not connect to it', 'SOCKS failure'],
];
function reasonFor(err) {
  const status = err && err.response ? err.response.status : null;
  if (status) {
    const what = String((err.response.data && err.response.data.error) || '');
    if (status === 429) return { key: 'h429', text: 'reached; its app asks to slow down, retrying', term: 'HTTP 429' };
    if (status === 503 && /full/.test(what)) return { key: 'h503full', text: 'reached; its inbox is full, retrying', term: 'HTTP 503' };
    if (status === 503) return { key: 'h503', text: 'reached; its app needs a moment (keys not ready), retrying', term: 'HTTP 503' };
    if (status === 402) return { key: 'h402', text: 'reached; its app asked for proof of work, which did not go through', term: 'HTTP 402' };
    return { key: 'h' + status, text: 'reached; its app refused the message', term: 'HTTP ' + status };
  }
  const m = String((err && err.message) || err || '');
  const code = String((err && err.code) || '');
  for (const [re, text, term] of SOCKS_REASONS) if (re.test(m)) return { key: term, text, term };
  if (code === 'ECONNABORTED' || /timeout|timed out/i.test(m)) return { key: 'timeout', text: 'no answer in time', term: 'timeout' };
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(m)) return { key: 'socks-down', text: 'the network program is not running', term: 'SOCKS port refused' };
  if (code === 'ECONNRESET' || /socket hang up|ECONNRESET/i.test(m)) return { key: 'reset', text: 'the connection dropped', term: 'connection reset' };
  return { key: 'other', text: 'could not reach it', term: m.slice(0, 80) || 'unknown' };
}

function shortAddress(addr) {
  const id = String(addr || '').replace(/\.anyone$/i, '');
  return id.length > 12 ? id.slice(0, 6) + '…' + id.slice(-2) + '.anyone' : String(addr || '');
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
// The network's own log format (local time), so both read alike and sort together.
function stamp(ts) {
  const d = new Date(ts);
  return `${MON[d.getMonth()]} ${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

const REPEAT_MS = 60 * 1000;
const MAX_LINES = 100;
const MAX_ADDRS = 500;

function create({ now = () => Date.now() } = {}) {
  const lines = [];                 // { ts, text }
  const state = new Map();          // address -> { key, tries, lastLine }
  const push = (text) => { lines.push({ ts: now(), text: `${stamp(now())} [AnonChat] ${text}` }); if (lines.length > MAX_LINES) lines.shift(); };
  return {
    failed(address, err) {
      const r = reasonFor(err);
      let s = state.get(address);
      if (!s) {
        if (state.size >= MAX_ADDRS) state.delete(state.keys().next().value);
        s = { key: null, tries: 0, lastLine: 0 };
        state.set(address, s);
      }
      s.tries++;
      if (s.key === r.key && now() - s.lastLine < REPEAT_MS) return;
      const again = s.key === r.key ? ` (${s.tries} tries so far)` : '';
      s.key = r.key; s.lastLine = now();
      push(`To ${shortAddress(address)}: ${r.text} (${r.term}). Retrying${again}.`);
    },
    delivered(address) {
      const s = state.get(address);
      if (!s) return;
      state.delete(address);
      push(`To ${shortAddress(address)}: delivered after ${s.tries + 1} tries.`);
    },
    lines() { return lines.slice(); },
  };
}

// Sort key for a log line that starts with "Mon DD HH:MM:SS.mmm" (no year: lines from late December sort before early January's, which
// only matters for an app left running over New Year).
function lineKey(line) {
  const m = /^(\w{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d)(?:\.(\d{1,3}))?/.exec(line);
  if (!m) return null;
  const mon = MON.indexOf(m[1]);
  if (mon < 0) return null;
  return ((((mon * 32 + Number(m[2])) * 24 + Number(m[3])) * 60 + Number(m[4])) * 60 + Number(m[5])) * 1000 + Number((m[6] || '0').padEnd(3, '0'));
}
// The network's log lines and ours, in time order; a line without a time stays right after the one before it.
function merge(netLines, ours, keep = 200) {
  const all = [];
  let last = -1, seq = 0;
  for (const l of netLines) { const k = lineKey(l); if (k != null) last = k; all.push({ k: last, seq: seq++, l }); }
  for (const l of ours) all.push({ k: lineKey(l) ?? last, seq: seq++, l });
  all.sort((a, b) => a.k - b.k || a.seq - b.seq);
  return all.slice(-keep).map((x) => x.l);
}

module.exports = { create, reasonFor, shortAddress, merge, lineKey, HS_REPLIES, nameSocksReplies };
