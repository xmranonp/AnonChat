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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
