// "Can our own address be found?" (lib/selftest.js): when it looks, what it does about a no, and that it never makes things worse.
// No network, a clock of its own. Run: node tools/selftest-test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const st = require('../lib/selftest.js');

let passed = 0, failed = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n + (d ? '  [' + d + ']' : '')); } };
const MIN = 60 * 1000;
const socks = (name) => new Error('Socks5 proxy rejected connection - ' + name);

function rig(over = {}) {
  const w = { t: 1_000_000_000_000, probeErr: null, published: true, ready: true, probes: 0, cleared: 0, reposts: 0, repostOk: true, log: [] };
  const s = st.create({
    probe: async () => { w.probes++; if (w.probeErr) throw w.probeErr; },
    isPublished: async () => w.published,
    clearLookups: async () => { w.cleared++; },
    republish: async () => { w.reposts++; return w.repostOk; },
    isReady: () => w.ready, now: () => w.t, log: (m) => w.log.push(m), ...over,
  });
  const tickAt = async (ms) => { w.t += ms; await s.tick(); };
  return { w, s, tickAt };
}

console.log('1. When it looks');
{ const { w, s, tickAt } = rig();
  await tickAt(0); ok('not at once: the address details need a moment to reach the directories', w.probes === 0 && s.status().state === 'idle');
  await tickAt(st.SETTLE_MS + 1000); ok('after that moment, it looks', w.probes === 1 && s.status().state === 'findable');
  await tickAt(5 * MIN); ok('…and not again for ten minutes while all is well', w.probes === 1);
  await tickAt(5 * MIN + 1000); ok('…then it does', w.probes === 2); }
{ const { w, tickAt } = rig(); w.ready = false;
  await tickAt(10 * MIN); ok('not before the network is ready', w.probes === 0); }
{ const { w, tickAt } = rig(); w.published = false;
  await tickAt(10 * MIN); ok('not while the address is not published', w.probes === 0); }

console.log('2. A no: clear the lookup memory first, then send the details again');
{ const { w, s, tickAt } = rig(); w.probeErr = socks('HsDescNotFound');
  await tickAt(0); await tickAt(st.SETTLE_MS + 1000);
  ok('first no: not findable, lookup memory cleared, nothing sent yet', s.status().state === 'not-findable' && w.cleared === 1 && w.reposts === 0, JSON.stringify(s.status()));
  ok('…the reason is kept in the network\'s own words', s.status().term === 'descriptor not found');
  ok('…and said once in the log', w.log.length === 1 && /could not be found/.test(w.log[0]), w.log.join('|'));
  await tickAt(st.AGAIN_AFTER_FIX_MS + 1000); ok('looks again soon after the clear-out', w.probes === 2);
  ok('second no: the details are sent again', w.reposts === 1 && s.status().republished === 1 && w.cleared === 1, JSON.stringify([w.reposts, w.cleared]));
  await tickAt(st.AGAIN_AFTER_FIX_MS + 1000); ok('and again soon after', w.probes === 3);
  ok('third no: not sent again so soon (every 10 minutes at most)', w.reposts === 1);
  await tickAt(st.REPUBLISH_EVERY_MS); ok('after ten minutes, it may send once more', w.reposts === 2); }
{ const { w, s, tickAt } = rig(); w.probeErr = socks('HsDescNotFound'); w.repostOk = false;
  await tickAt(0); await tickAt(st.SETTLE_MS + 1000); await tickAt(st.AGAIN_AFTER_FIX_MS + 1000);
  ok('a send the network program refused is not counted, nor logged as sent', s.status().republished === 0 && !w.log.some((m) => /sent to the network again/.test(m))); }
{ const { w, s, tickAt } = rig({ republish: async () => { throw new Error('control port timeout'); } }); w.probeErr = socks('HsDescNotFound');
  await tickAt(0); await tickAt(st.SETTLE_MS + 1000); await tickAt(st.AGAIN_AFTER_FIX_MS + 1000);
  ok('a send that fails does not stop the looking', s.status().state === 'not-findable' && w.probes === 2); }

console.log('3. Found again');
{ const { w, s, tickAt } = rig(); w.probeErr = socks('HsDescNotFound');
  await tickAt(0); await tickAt(st.SETTLE_MS + 1000); w.probeErr = null; await tickAt(st.AGAIN_AFTER_FIX_MS + 1000);
  ok('findable, failures reset', s.status().state === 'findable' && s.status().fails === 0);
  ok('…and the log says so', w.log.some((m) => /can be found again/.test(m)), w.log.join('|'));
  w.probeErr = socks('HsDescNotFound'); await tickAt(st.OK_EVERY_MS + 1000);
  ok('a later no starts again with the clear-out, not the send', w.cleared === 2 && w.reposts === 0, JSON.stringify([w.cleared, w.reposts])); }

console.log('4. A no that is not about our address');
{ const { w, s, tickAt } = rig(); w.probeErr = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9050'), { code: 'ECONNREFUSED' });
  await tickAt(0); await tickAt(st.SETTLE_MS + 1000);
  ok('network program not running: "unknown", nothing cleared or sent', s.status().state === 'unknown' && w.cleared === 0 && w.reposts === 0, JSON.stringify(s.status()));
  ok('…and nothing is logged about our address', w.log.length === 0); }

console.log('5. Test connection asks now');
{ const { w, s } = rig();
  await s.runNow(); ok('looks at once', w.probes === 1 && s.status().state === 'findable');
  await s.runNow(); ok('not again within 20 seconds', w.probes === 1);
  w.t += 21000; await s.runNow(); ok('after that, again', w.probes === 2);
  const a = s.run(), b = s.run(); await Promise.all([a, b]); ok('two at once share one look', w.probes === 3); }

console.log('6. Still unfindable after 20 minutes, plainly our fault: restart the network program (1.0.10)');
// a rig with the restart wired; ticks every 15 s like the server, for `ms`
function rigR(o = {}) {
  const x = { restarts: 0, accept: true, otherOk: null, givesUp: false, call: false, m: 0 };
  const r = rig({ restartNetwork: async () => { x.restarts++; return x.accept; }, otherOkAt: () => x.otherOk, serviceGivesUp: async () => x.givesUp,
    canRestart: () => !x.call, mono: () => x.m, ...o });
  r.w.probeErr = socks('IntroductionFailed');
  const run = async (ms) => { for (let d = 0; d < ms; d += 15000) { r.w.t += 15000; x.m += 15000; await r.s.tick(); } };
  return { ...r, x, run };
}
{ const { w, s, x, run } = rigR(); x.givesUp = true;
  await run(st.SETTLE_MS + 19 * MIN);
  ok('not before 20 minutes of failing', x.restarts === 0 && w.reposts >= 1, JSON.stringify([x.restarts, w.reposts]));
  await run(3 * MIN);
  ok('after 20 minutes, with the network program giving up on connections to us: restarted once', x.restarts === 1 && s.status().restarts === 1);
  ok('…and the log says why', w.log.some((m) => /network program was restarted/.test(m) && /giving up/.test(m)), w.log.join('|'));
  await run(5 * 60 * MIN);
  ok('still failing: not again within 6 hours', x.restarts === 1);
  await run(70 * MIN);
  ok('after 6 hours it may restart once more', x.restarts === 2, String(x.restarts)); }
{ const { w, x, run } = rigR();
  x.otherOk = x.m; await run(st.SETTLE_MS + 22 * MIN);
  ok('no rendezvous give-ups, but other addresses were reached 22 minutes ago: not "recent", no restart', x.restarts === 0);
  const go = async () => { x.otherOk = x.m; await run(15000); };
  for (let i = 0; i < 16; i++) await go();
  ok('other addresses reached a moment ago: restarted', x.restarts === 1, String(x.restarts)); }
{ const { x, run } = rigR();
  await run(3 * 60 * MIN);
  ok('nobody else reached and no give-ups (the network may be down): never restarted', x.restarts === 0); }
{ const { x, run } = rigR(); x.givesUp = true; x.call = true;
  await run(st.SETTLE_MS + 30 * MIN);
  ok('never during a call', x.restarts === 0);
  x.call = false; await run(4 * MIN);
  ok('…and once the call is over', x.restarts === 1); }
{ const { w, x, run } = rigR(); x.givesUp = true; w.repostOk = false;
  await run(st.SETTLE_MS + 60 * MIN);
  ok('not unless sending the details again was tried first (a refused send is not a try)', x.restarts === 0); }
{ const { w, s, x, run } = rigR(); x.givesUp = true; x.accept = false;
  await run(st.SETTLE_MS + 25 * MIN);
  ok('a refused restart is not counted or logged…', x.restarts === 1 && s.status().restarts === 0 && !w.log.some((m) => /was restarted/.test(m)));
  await run(60 * MIN); ok('…and not asked again for 6 hours', x.restarts === 1); }
{ const { w, s, x, run } = rigR(); x.givesUp = true;
  await run(st.SETTLE_MS + 10 * MIN); w.probeErr = null; await run(4 * MIN);
  ok('found again meanwhile: the 20 minutes start over', s.status().state === 'findable');
  w.probeErr = socks('IntroductionFailed'); await run(st.OK_EVERY_MS + 15 * MIN);
  ok('…so 15 minutes of a new series are not enough', x.restarts === 0, String(x.restarts)); }
{ const { w, x, run } = rigR(); x.givesUp = true; w.probeErr = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9050'), { code: 'ECONNREFUSED' });
  await run(60 * MIN); ok('the network program not running is not our address\'s fault: no restart', x.restarts === 0); }
{ const { w, x, run } = rigR(); x.givesUp = true;
  await run(st.SETTLE_MS + 10 * MIN); w.t -= 2 * 60 * MIN;          // the wall clock set back two hours
  await run(11 * MIN); ok('a clock set back does not hold the restart up (a steady clock counts the 20 minutes)', x.restarts === 1); }
{ const { s, x, run, w } = rigR(); x.givesUp = true; let pub = true;
  w.published = true; await run(st.SETTLE_MS + 21 * MIN);
  ok('after the restart the address is looked at again only once it is published and settled', s.status().state === 'restarting' || s.status().state === 'idle', s.status().state); }
{ const { x, run } = rigR({ restartNetwork: null }); x.givesUp = true;
  await run(60 * MIN); ok('without a way to restart (the backend run on its own) nothing is tried', x.restarts === 0); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
