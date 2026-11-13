'use strict';
// Is the Anyone network ready to look addresses up? Sending, the online checks and the "back online" notices wait for it.
//
// Why: a lookup of someone's address that fails is remembered by the network program for 15 minutes (the directories asked are not asked
// again), so a try made too early can keep a contact out of reach long after they are there. Early means: the network is still
// starting, or it started from the list of relays it saved the day before (a day old) and has not yet fetched a current one, so it
// looks in the wrong places. Messages made meanwhile wait in the queue as always and go out when this says ready.
//
// Ready means: progress 100%, and a current relay list (a consensus that began in the last 2 hours). If the list never looks current
// (a wrong clock, a network that blocks it) the wait ends after `consensusWaitMs` all the same: waiting forever would be worse. If the
// network program can't be asked at all, the wait ends after `unknownWaitMs`.
//
// Once ready it stays ready, unless the network reports less than 100% again (a connection that dropped); on coming back to 100% it
// is ready again, and `onReady` is called each time (the app clears the network's lookup memory once, then sends what waits).
// Every dependency is passed in, so this is testable without a network or a clock of its own.

const FRESH_MS = 2 * 60 * 60 * 1000;

function create({ bootstrapPct, consensusTimes, onReady = () => {}, now = () => Date.now(), enabled = true,
  consensusWaitMs = 3 * 60 * 1000, unknownWaitMs = 4 * 60 * 1000,
  circuitUp = null, resumeHoldMs = 10 * 1000, resumeWaitMs = 3 * 60 * 1000 } = {}) {
  // Time elapsed since t. The wall clock can be set back (time sync after a wake): a negative answer then counts as "long enough", so a wait
  // never gets longer than its limit because the clock moved.
  const since = (t) => { const d = now() - t; return d >= 0 ? d : d > -60000 ? 0 : Infinity; };          // a step back of up to a minute is time sync (no time has passed); a bigger one is a real correction
  const st = { ready: !enabled, reason: enabled ? 'starting' : 'off', since: now(), at100: null, consensusAgeMs: null, everReady: !enabled, hold: null, afterResume: false };
  const set = (ready, reason) => {
    const edge = ready && !st.ready;
    st.ready = ready; st.reason = reason;
    if (edge) { st.everReady = true; st.afterResume = false; try { onReady(reason); } catch {} }          // any way back to ready ends "after a wake"
  };

  // The computer woke from sleep: the network program still says 100%, but the connection under it was cut and the first lookups would
  // fail (and be remembered for 15 minutes). Not ready for a few seconds, then until a circuit works (never for ever); the edge back to
  // ready runs onReady like any other, which clears the network's memory and sends what waits.
  let gen = 0;          // a check that began before a reset() must not finish after it (its answer is from before the sleep)
  function reset() {
    if (!enabled) return false;
    gen++;
    st.hold = { since: now(), until: now() + resumeHoldMs };
    st.afterResume = true; st.ready = false; st.reason = 'resumed'; st.at100 = null;
    return true;
  }

  async function check() {
    if (!enabled) return true;
    const g = gen;
    if (st.hold) {
      if (since(st.hold.since) < resumeHoldMs) { st.reason = 'resumed'; return false; }
      const h = st.hold;          // another check may run meanwhile (they start every 3 s) and end the hold first
      let up = true;
      if (circuitUp) { try { up = !!(await circuitUp()); } catch { up = true; } }          // can't ask: go on
      if (g !== gen || st.hold !== h) return st.ready;          // a reset meanwhile, or another check already ended this hold: its answer stands
      if (!up && since(h.since) < resumeWaitMs) { st.reason = 'no-circuit'; return false; }
      st.resumeSince = h.since; st.hold = null;
    }
    let pct = null;
    try { pct = await bootstrapPct(); } catch {}
    if (g !== gen) return st.ready;
    if (pct == null) {
      // Nothing to go by: leave the state as it is, but don't wait for ever (the first time, or after a wake).
      if (!st.ready && !st.everReady && since(st.since) >= unknownWaitMs) set(true, 'assumed');
      else if (!st.ready && st.afterResume && since(st.resumeSince) >= resumeWaitMs) set(true, 'assumed');          // after a wake: the same 3 minutes as the rest of the wait
      return st.ready;
    }
    if (pct < 100) {
      st.at100 = null;
      if (st.ready) set(false, 'bootstrapping');          // dropped: wait until it is back
      else st.reason = 'bootstrapping';
      return st.ready;
    }
    if (st.ready) return true;
    if (st.at100 == null) st.at100 = now();
    if (st.everReady && st.afterResume) {
      // After a sleep the relay list can be hours old (overnight), and lookups made with it go to the wrong places: as at a first start,
      // wait for a current one, but within the same 3 minutes as the rest of the wake.
      let times = null;
      try { times = await consensusTimes(); } catch {}
      if (g !== gen) return st.ready;
      const after = times && Number.isFinite(times.validAfter) ? times.validAfter : null;
      st.consensusAgeMs = after == null ? null : now() - after;
      if (after != null && st.consensusAgeMs >= FRESH_MS && since(st.resumeSince) < resumeWaitMs) { st.reason = 'relay-list'; return false; }
      set(true, 'resumed'); return true;
    }
    if (st.everReady) { set(true, 'back'); return true; }          // came back after a drop: the list was current before
    // First time: a current relay list as well.
    let times = null;
    try { times = await consensusTimes(); } catch {}
    if (g !== gen) return st.ready;
    const after = times && Number.isFinite(times.validAfter) ? times.validAfter : null;
    st.consensusAgeMs = after == null ? null : now() - after;
    if (after != null && st.consensusAgeMs < FRESH_MS) { set(true, 'ready'); return true; }
    // A wake during the very first start: the 3 minutes after the wake are all there are, not the first start's wait on top of them.
    if (since(st.at100) >= consensusWaitMs || (st.afterResume && since(st.resumeSince) >= resumeWaitMs)) { set(true, after == null ? 'no-list' : 'old-list'); return true; }
    st.reason = 'relay-list';
    return false;
  }

  return { check, reset, isReady: () => st.ready, status: () => ({ ready: st.ready, reason: st.reason, consensusAgeMs: st.consensusAgeMs }) };
}

// The relay list's times from the network program ("YYYY-MM-DD HH:MM:SS", UTC), or null.
async function readConsensusTimes(ctrl) {
  const get = async (key) => {
    const m = new RegExp('^250[- ]consensus/' + key + '=(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d)', 'm').exec(String(await ctrl('GETINFO consensus/' + key)));
    return m ? Date.parse(m[1].replace(' ', 'T') + 'Z') : null;
  };
  try { return { validAfter: await get('valid-after') }; } catch { return null; }
}

module.exports = { create, readConsensusTimes, FRESH_MS };
