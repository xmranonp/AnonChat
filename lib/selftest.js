'use strict';
// Can our own address be found through the network? The Service line says the address is published and its introduction circuits are
// open, which is what the local network program knows. It can't say that anyone can find it. This asks the way a contact would: one
// request to our own address through the network (the same one the online check makes of a contact).
//
// What it does when the answer is no, in order, each only when the one before did not help:
//   1. clear the network's lookup memory (the failed lookup of our own address may itself be remembered for 15 minutes) and look again;
//   2. send our address details to the directories again (HSPOST, from the copy the network program holds) and look again;
//   3. keep looking, and send again at most every 10 minutes;
//   4. (1.0.10) when it has stayed unfindable for 20 minutes although sending again was tried, and the fault is plainly ours (other
//      addresses are reached, or the network program reports that it gives up on the connections people make to us: "Giving up on
//      launching a rendezvous circuit"), restart the network program, at most once in 6 hours and never during a call. Measured on a
//      mailbox peer (19 November 2026): its address stopped answering after almost three days, with that line every few seconds, and only
//      a restart brought it back. Contacts' apps (1.0.9 and later) find the address again within minutes after it (and we tell them).
// Nothing leaves the Anyone network. Every dependency is passed in, so this is testable without a network.

const { reasonFor } = require('./deliverylog');

// How often it looks: rarely while all is well, often while it is not.
const OK_EVERY_MS = 10 * 60 * 1000, BAD_EVERY_MS = 3 * 60 * 1000, SETTLE_MS = 30 * 1000;
const REPUBLISH_EVERY_MS = 10 * 60 * 1000;
const AGAIN_AFTER_FIX_MS = 45 * 1000;
const RESTART_AFTER_MS = 20 * 60 * 1000, RESTART_GAP_MS = 6 * 60 * 60 * 1000, OTHERS_OK_WITHIN_MS = 15 * 60 * 1000;
// Failures that say nothing about our address: the network program isn't running or has no network.
const NOT_OURS = new Set(['SOCKS port refused', 'network unreachable']);

// `timing` overrides the waits (the tests shorten them).
// restartNetwork: asks for the restart, true if it was accepted. otherOkAt: when another address was last reached (or null).
// serviceGivesUp: whether the network program has reported giving up on rendezvous circuits since the last look. canRestart: false
// during a call.
function create({ probe, isPublished, clearLookups, republish, restartNetwork = null, otherOkAt = () => null, serviceGivesUp = async () => false,
  canRestart = () => true, isReady = () => true, now = () => Date.now(), mono = null, log = () => {}, timing = {} }) {
  const T = { okEveryMs: OK_EVERY_MS, badEveryMs: BAD_EVERY_MS, settleMs: SETTLE_MS, republishEveryMs: REPUBLISH_EVERY_MS, againMs: AGAIN_AFTER_FIX_MS,
    restartAfterMs: RESTART_AFTER_MS, restartGapMs: RESTART_GAP_MS, othersOkWithinMs: OTHERS_OK_WITHIN_MS, ...timing };
  const st = { state: 'idle', checkedAt: null, okAt: null, fails: 0, term: null, republished: 0, republishedAt: null, restarts: 0, restartedAt: null };
  let running = null, publishedAt = null, nextAt = 0, republishedMono = null, checkedMono = null, fixed = { clear: false }, failingSince = null, gaveUp = false, lastRestart = -Infinity;
  const steady = mono || now;
  const otherOkWithin = (ms) => { const t = otherOkAt(); if (t == null) return false; const d = steady() - t; return d >= 0 && d < ms; };          // otherOkAt is on the steady clock

  async function run() {
    if (running) return running;
    running = (async () => {
      st.state = 'checking';
      let ok = false, term = null;
      try { await probe(); ok = true; } catch (e) { term = reasonFor(e).term; }
      st.checkedAt = now(); checkedMono = steady();
      if (ok) {
        if (st.fails > 0) log(`your address can be found again (after ${st.fails} failed ${st.fails === 1 ? 'look' : 'looks'})`);
        Object.assign(st, { state: 'findable', okAt: st.checkedAt, fails: 0, term: null });
        fixed = { clear: false }; failingSince = null; gaveUp = false;
        nextAt = checkedMono + T.okEveryMs;
        return st;
      }
      if (NOT_OURS.has(term)) { Object.assign(st, { state: 'unknown', term }); nextAt = steady() + T.badEveryMs; return st; }
      st.fails++; st.term = term; st.state = 'not-findable';
      if (failingSince == null) failingSince = steady();
      try { if (await serviceGivesUp()) gaveUp = true; } catch {}
      if (st.fails === 1) log(`your own address could not be found through the network (${term}); looking again`);
      nextAt = steady() + T.badEveryMs;
      // 1. The first failure: it may be the lookup memory, not the publishing.
      if (!fixed.clear) {
        fixed.clear = true;
        try { await clearLookups(); } catch {}
        nextAt = steady() + T.againMs;
      // 4. Unfindable for 20 minutes although the details were sent again, and plainly our fault: restart the network program.
      } else if (restartNetwork && fixed.republished && steady() - failingSince >= T.restartAfterMs && steady() - lastRestart >= T.restartGapMs
          && (gaveUp || otherOkWithin(T.othersOkWithinMs)) && canRestart()) {
        let accepted = false;
        try { accepted = await restartNetwork(); } catch {}
        lastRestart = steady();          // also when refused: not asked again for 6 hours
        if (accepted) {
          st.restarts++; st.restartedAt = now(); st.state = 'restarting';
          log(`your address could not be found for ${Math.round((steady() - failingSince) / 60000)} minutes${gaveUp ? ', and the network program kept giving up on connections to it' : ' while other addresses were reached'}: the network program was restarted`);
          publishedAt = null; failingSince = null; gaveUp = false; fixed = { clear: false };          // a fresh start: settle, then look again
        }
        nextAt = steady() + T.againMs;
      // 2. Still not found: send the address details again, then every 10 minutes at most.
      } else if (republishedMono == null || steady() - republishedMono >= T.republishEveryMs) {
        let sent = false;
        try { sent = await republish(); } catch {}
        st.republishedAt = now(); republishedMono = steady();
        if (sent) { st.republished++; fixed.republished = true; log('your address details were sent to the network again'); }
        nextAt = steady() + T.againMs;
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
    if (publishedAt == null) { publishedAt = steady(); nextAt = publishedAt + T.settleMs; }       // the details reach the directories a little after
    if (steady() >= nextAt) await run();
  }

  // Used by "Test connection": looks now unless a look has just been made.
  async function runNow(maxAgeMs = 20000) {
    if (running) return running;
    if (checkedMono != null && steady() - checkedMono < maxAgeMs && st.state !== 'checking') return st;
    return run();
  }

  return { tick, run, runNow, status: () => ({ ...st }) };
}

module.exports = { create, OK_EVERY_MS, BAD_EVERY_MS, SETTLE_MS, REPUBLISH_EVERY_MS, AGAIN_AFTER_FIX_MS, RESTART_AFTER_MS, RESTART_GAP_MS };
