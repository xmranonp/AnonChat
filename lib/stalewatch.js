'use strict';
// A contact we can't reach although they may well be there. After a restart of their network program (or ours) the network can keep us
// from reaching them for many minutes, and clearing its memory of lookups and routes (NEWNYM) ends that in seconds. Usually there is
// reason to do it when they write to us while ours fail (server.js). This covers the rest: a contact whose messages keep failing and who
// stays silent.
//
// The same sign looks like a contact who is simply offline, for days maybe, so it must stay cheap: for each contact the first clear-out
// comes after 3 minutes of failing, then 15 minutes later, then an hour, then every 2 hours; at most one in 10 minutes for all contacts
// together (one NEWNYM serves every contact); never within 3 minutes of a circuit the user built by hand (NEWNYM would mark it unusable);
// and a success ends the series, as does an answer from them (busy, refused: they are reachable). A series also ends when the failures
// stop for a while (the message expired, the contact was removed: noteGone() or 30 minutes without a failure), so the next one starts
// from the beginning. Time asleep is not failing: clear() after a wake.
// Every dependency is passed in, so it is testable without a clock or a network.

const MIN = 60 * 1000;

function create({ now = () => Date.now(), forget = () => {}, userCircuitRecent = () => false, ladderMs = [3 * MIN, 15 * MIN, 60 * MIN, 120 * MIN], globalCapMs = 10 * MIN,
  maxContacts = 1000, restartAfterMs = 30 * MIN } = {}) {
  const per = new Map();
  const since = (t) => { const d = now() - t; return d >= 0 ? d : d > -60000 ? 0 : Infinity; };          // a small step back (time sync): no time has passed; a big one (a real correction) counts as "long enough" so no wait gets longer
  let lastAny = -Infinity, fired = 0;

  function noteFail(address) {
    const t = now();
    let e = per.get(address);
    if (e && since(e.last) > restartAfterMs) { per.delete(address); e = null; }          // the failures had stopped: a new series
    if (!e) {
      if (per.size >= maxContacts) {          // full: the one that failed least recently goes (a flood of new addresses can't keep a real contact's place)
        let oldK = null, oldT = Infinity;
        for (const [k, v] of per) if (v.last < oldT) { oldT = v.last; oldK = k; }
        per.delete(oldK);
      }
      e = { step: 0, at: t, last: t };
      per.set(address, e);
    }
    e.last = t;
    if (since(e.at) < ladderMs[e.step]) return false;
    if (since(lastAny) < globalCapMs) return false;          // stays due: tried again on the next failure
    let recent = false;
    try { recent = !!userCircuitRecent(); } catch {}
    if (recent) return false;
    let can = true;
    try { can = forget() !== false; } catch {}          // false: a clear-out went moments ago for another reason; this step stays due
    if (!can) return false;
    lastAny = t; fired++;
    e.step = Math.min(e.step + 1, ladderMs.length - 1);
    e.at = t;
    return true;
  }
  return {
    noteFail,
    noteOk(address) { per.delete(address); },
    noteGone(address) { per.delete(address); },          // nothing waits for them any more (expired, removed)
    clear() { per.clear(); },
    status: () => ({ contacts: per.size, fired }),
  };
}

module.exports = { create };
