'use strict';
// "Test connection" for one contact (conversation menu): what is known about the way to them, boiled down to a verdict the window
// words in the person's language. This file holds only the reading of the results (no network, no clock of its own), so it can be tested.
//
// The checks, run by server.js:
//   own    our own address: published, with introduction points (circuits.getServiceHealth)
//   probe  one small request to their app (GET /api/profile, the same one the online check makes): finds their address on the network,
//          builds the route to it and gets an answer. How it fails says which step went wrong (deliverylog.reasonFor).
//   clock  their app's clock (the Date header of its answer) against ours. Addresses are published under a daily period worked out from
//          the time, so two clocks that disagree can't find each other.
//   queue  what is waiting for them, and the last answer their app gave to it

const { reasonFor } = require('./deliverylog');

const SKEW_WARN_MS = 2 * 60 * 1000;     // a few seconds are normal (the header has whole seconds, the route takes time); minutes are not

// A failed request, as { found, term, key }: `found` is whether their address was found on the network at all.
function readProbeError(err) {
  const r = reasonFor(err);
  const status = err && err.response ? err.response.status : null;
  // Found: they answered (with an error), or the network got as far as their introduction points or the meeting route.
  const found = !!status || /^(introduction|rendezvous)/.test(r.term);
  return { found, key: r.key, term: r.term, status: status || null };
}

// Clock difference, theirs minus ours, in ms, from the answer's Date header; null when there is none or it is unreadable.
// `sentAt` / `gotAt` are our clock before the request and when the answer came: the middle is the best guess for when they answered.
function clockSkew(dateHeader, sentAt, gotAt) {
  if (typeof dateHeader !== 'string') return null;
  const theirs = Date.parse(dateHeader);
  if (!Number.isFinite(theirs)) return null;
  return theirs - Math.round((sentAt + gotAt) / 2);
}

// own: getServiceHealth() result; probe: { ok, error?, skewMs? }; queue: { count, lastStatus } (outbox.stateFor);
// self: the self-test's answer (lib/selftest.js): can our own address be found through the network.
// Returns { own, find, clock, queue, verdict } where every part is a short code and verdict is the one thing to tell the person.
function summarize({ own, probe, queue, self }) {
  const ownDetail = own && own.detail ? own.detail : 'unknown';
  const published = ownDetail === 'reachable' ? 'ok' : ownDetail === 'establishing' ? 'wait' : 'fail';
  // Published is what the network program says; findable is whether a lookup through the network finds it (unknown: not looked yet).
  const findable = self && self.state === 'findable' ? 'yes' : self && self.state === 'not-findable' ? 'no' : 'unknown';
  const ownState = published === 'ok' && findable === 'no' ? 'warn' : published;

  let find, reach;
  if (probe.ok) { find = { state: 'ok' }; reach = { state: 'ok' }; }
  else {
    const e = probe.error || { found: false, key: 'other', term: 'unknown', status: null };
    find = e.term === 'descriptor not found' || e.term === 'descriptor invalid'
      ? { state: 'fail', term: e.term }
      : e.found || e.status ? { state: 'ok' } : { state: 'unknown', term: e.term };
    reach = e.status ? { state: 'refused', status: e.status } : { state: 'fail', term: e.term };
  }

  const skew = probe.skewMs;
  const clock = skew == null ? { state: 'unknown' }
    : { state: Math.abs(skew) > SKEW_WARN_MS ? 'warn' : 'ok', skewSec: Math.round(skew / 1000) };

  const q = { count: queue && queue.count || 0, lastStatus: queue && queue.lastStatus || null };

  let verdict;
  const term = probe.error && probe.error.term;
  if (probe.ok) {
    // They can be reached from here; what is left is what stops them reaching us, or the clocks.
    if (clock.state === 'warn') verdict = 'clock';
    else if (ownState === 'fail') verdict = 'own-not-published';
    else if (findable === 'no') verdict = 'own-not-findable';
    else verdict = q.count && q.lastStatus && q.lastStatus !== 429 ? 'ok-but-refused' : 'ok';
  }
  else if (term === 'SOCKS port refused' || term === 'network unreachable') verdict = 'network-down';
  // Their address can't be found, and ours can't either: the lookup itself is failing on this computer, not their address.
  else if (find.state === 'fail' && findable === 'no') verdict = 'lookup-broken';
  else if (find.state === 'fail') verdict = 'not-found';
  else if (reach.state === 'refused') verdict = 'refused';
  else verdict = 'unreachable';

  return { own: { state: ownState, detail: ownDetail, findable, introPoints: own && own.introPoints != null ? own.introPoints : null }, find, reach, clock, queue: q, verdict };
}

module.exports = { summarize, readProbeError, clockSkew, SKEW_WARN_MS };
