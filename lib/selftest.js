'use strict';
// Can our own address be found through the network? The Service line says the address is published and its introduction circuits are
// open, which is what the local network program knows. It can't say that anyone can find it. This asks the way a contact would: one
// request to our own address through the network (the same one the online check makes of a contact).
//
// What it does when the answer is no, in order, each only when the one before did not help:
//   1. clear the network's lookup memory (the failed lookup of our own address may itself be remembered for 15 minutes) and look again;
//   2. send our address details to the directories again (HSPOST, from the copy the network program holds) and look again;
//   3. keep looking, and send again at most every 10 minutes.
// Nothing else is changed, and nothing leaves the Anyone network. Every dependency is passed in, so this is testable without a network.

const { reasonFor } = require('./deliverylog');

// How often it looks: rarely while all is well, often while it is not.
const OK_EVERY_MS = 10 * 60 * 1000, BAD_EVERY_MS = 3 * 60 * 1000, SETTLE_MS = 30 * 1000;
const REPUBLISH_EVERY_MS = 10 * 60 * 1000;
const AGAIN_AFTER_FIX_MS = 45 * 1000;
// Failures that say nothing about our address: the network program isn't running or has no network.
const NOT_OURS = new Set(['SOCKS port refused', 'network unreachable']);

// `timing` overrides the waits (the tests shorten them).
function create({ probe, isPublished, clearLookups, republish, isReady = () => true, now = () => Date.now(), log = () => {}, timing = {} }) {
  const T = { okEveryMs: OK_EVERY_MS, badEveryMs: BAD_EVERY_MS, settleMs: SETTLE_MS, republishEveryMs: REPUBLISH_EVERY_MS, againMs: AGAIN_AFTER_FIX_MS, ...timing };
  const st = { state: 'idle', checkedAt: null, okAt: null, fails: 0, term: null, republished: 0, republishedAt: null };
  let running = null, publishedAt = null, nextAt = 0, fixed = { clear: false };

  async function run() {
    if (running) return running;
    running = (async () => {
      const t = now();
      st.state = 'checking';
      let ok = false, term = null;
      try { await probe(); ok = true; } catch (e) { term = reasonFor(e).term; }
      st.checkedAt = now();
      if (ok) {
        if (st.fails > 0) log(`your address can be found again (after ${st.fails} failed ${st.fails === 1 ? 'look' : 'looks'})`);
        Object.assign(st, { state: 'findable', okAt: st.checkedAt, fails: 0, term: null });
        fixed = { clear: false };
        nextAt = st.checkedAt + T.okEveryMs;
        return st;
      }
      if (NOT_OURS.has(term)) { Object.assign(st, { state: 'unknown', term }); nextAt = now() + T.badEveryMs; return st; }
      st.fails++; st.term = term; st.state = 'not-findable';
      if (st.fails === 1) log(`your own address could not be found through the network (${term}); looking again`);
      nextAt = now() + T.badEveryMs;
      // 1. The first failure: it may be the lookup memory, not the publishing.
      if (!fixed.clear) {
        fixed.clear = true;
        try { await clearLookups(); } catch {}
        nextAt = now() + T.againMs;
      // 2. Still not found: send the address details again, then every 10 minutes at most.
      } else if (!st.republishedAt || now() - st.republishedAt >= T.republishEveryMs) {
        let sent = false;
        try { sent = await republish(); } catch {}
        st.republishedAt = now();
        if (sent) { st.republished++; log('your address details were sent to the network again'); }
        nextAt = now() + T.againMs;
      }
      return st;
    })().finally(() => { running = null; });
    return running;
  }

  // Called every few seconds: looks when it is time, once the network is ready and our address is published.
  async function tick() {
    if (running || !isReady()) return;
    let pub = false;
    try { pub = await isPublished(); } catch {}
    if (!pub) { publishedAt = null; if (st.state !== 'idle' && st.state !== 'not-findable') st.state = 'idle'; return; }
    if (publishedAt == null) { publishedAt = now(); nextAt = publishedAt + T.settleMs; }       // the details reach the directories a little after
    if (now() >= nextAt) await run();
  }

  // Used by "Test connection": looks now unless a look has just been made.
  async function runNow(maxAgeMs = 20000) {
    if (running) return running;
    if (st.checkedAt != null && now() - st.checkedAt < maxAgeMs && st.state !== 'checking') return st;
    return run();
  }

  return { tick, run, runNow, status: () => ({ ...st }) };
}

module.exports = { create, OK_EVERY_MS, BAD_EVERY_MS, SETTLE_MS, REPUBLISH_EVERY_MS, AGAIN_AFTER_FIX_MS };
