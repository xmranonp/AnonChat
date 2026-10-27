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
  consensusWaitMs = 3 * 60 * 1000, unknownWaitMs = 4 * 60 * 1000 } = {}) {
  const st = { ready: !enabled, reason: enabled ? 'starting' : 'off', since: now(), at100: null, consensusAgeMs: null, everReady: !enabled };
  const set = (ready, reason) => {
    const edge = ready && !st.ready;
    st.ready = ready; st.reason = reason;
    if (edge) { st.everReady = true; try { onReady(reason); } catch {} }
  };

  async function check() {
    if (!enabled) return true;
    let pct = null;
    try { pct = await bootstrapPct(); } catch {}
    if (pct == null) {
      // Nothing to go by: leave the state as it is, but don't wait for ever the first time.
      if (!st.ready && !st.everReady && now() - st.since >= unknownWaitMs) set(true, 'assumed');
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
    if (st.everReady) { set(true, 'back'); return true; }          // came back after a drop: the list was current before
    // First time: a current relay list as well.
    let times = null;
    try { times = await consensusTimes(); } catch {}
    const after = times && Number.isFinite(times.validAfter) ? times.validAfter : null;
    st.consensusAgeMs = after == null ? null : now() - after;
    if (after != null && st.consensusAgeMs < FRESH_MS) { set(true, 'ready'); return true; }
    if (now() - st.at100 >= consensusWaitMs) { set(true, after == null ? 'no-list' : 'old-list'); return true; }
    st.reason = 'relay-list';
    return false;
  }

  return { check, isReady: () => st.ready, status: () => ({ ready: st.ready, reason: st.reason, consensusAgeMs: st.consensusAgeMs }) };
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
