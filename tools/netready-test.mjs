// "Is the network ready?" (lib/netready.js): nothing is sent before progress is 100% and the relay list is current; the waits end;
// ready again after a drop; the clear-out runs on each edge, once. No network. Run: node tools/netready-test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const nr = require('../lib/netready.js');

let passed = 0, failed = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n + (d ? '  [' + d + ']' : '')); } };
const MIN = 60 * 1000, HOUR = 60 * MIN;

function rig(opts = {}) {
  const w = { t: 1_000_000_000_000, pct: 0, after: null, ready: [] };
  const r = nr.create({
    bootstrapPct: async () => (typeof w.pct === 'function' ? w.pct() : w.pct),
    consensusTimes: async () => (w.after === 'throw' ? (() => { throw new Error('x'); })() : w.after == null ? null : { validAfter: w.t - w.after }),
    onReady: (why) => w.ready.push(why), now: () => w.t, ...opts,
  });
  return { w, r };
}

console.log('1. Waiting');
{ const { w, r } = rig();
  ok('starts not ready', !r.isReady());
  w.pct = 40; ok('40% is not ready', (await r.check()) === false && r.status().reason === 'bootstrapping');
  w.pct = 100; w.after = 30 * HOUR; ok('100% with a day-old relay list is not ready', (await r.check()) === false && r.status().reason === 'relay-list');
  w.t += 2 * MIN; ok('…still not ready 2 minutes later', (await r.check()) === false);
  w.after = 20 * MIN; ok('a current relay list makes it ready', (await r.check()) === true && r.isReady());
  ok('…and onReady ran once, with the reason', w.ready.length === 1 && w.ready[0] === 'ready', w.ready.join()); }

console.log('2. The waits end');
{ const { w, r } = rig();
  w.pct = 100; w.after = 30 * HOUR; await r.check(); w.t += 3 * MIN + 1000;
  ok('a list that never looks current: ready after 3 minutes', (await r.check()) === true && w.ready[0] === 'old-list', w.ready.join()); }
{ const { w, r } = rig();
  w.pct = 100; w.after = null; await r.check(); w.t += 3 * MIN + 1000;
  ok('no relay list readable: ready after 3 minutes', (await r.check()) === true && w.ready[0] === 'no-list'); }
{ const { w, r } = rig();
  w.pct = 100; w.after = 'throw'; await r.check(); w.t += 3 * MIN + 1000;
  ok('a failing question about the list does not stop it', (await r.check()) === true); }
{ const { w, r } = rig();
  w.pct = null;
  ok('network program not answering: not ready at first', (await r.check()) === false);
  w.t += 3 * MIN; ok('…still not ready after 3 minutes', (await r.check()) === false);
  w.t += 1 * MIN + 1000; ok('…ready after 4 minutes (never waits for ever)', (await r.check()) === true && w.ready[0] === 'assumed'); }

console.log('3. Staying ready, and coming back');
{ const { w, r } = rig();
  w.pct = 100; w.after = 10 * MIN; await r.check();
  w.pct = null; ok('a question that goes unanswered does not unset it', (await r.check()) === true && r.isReady());
  w.pct = 100; await r.check(); ok('answering again changes nothing, no second onReady', w.ready.length === 1);
  w.pct = 60; ok('progress below 100% again: not ready', (await r.check()) === false);
  w.after = 40 * HOUR; w.pct = 100; ok('back at 100%: ready at once (the list was current before)', (await r.check()) === true);
  ok('…and onReady ran again, as "back"', w.ready.length === 2 && w.ready[1] === 'back', w.ready.join()); }

console.log('4. Off (a backend run on its own)');
{ const { w, r } = rig({ enabled: false });
  ok('always ready', r.isReady() && (await r.check()) === true);
  ok('onReady never runs', w.ready.length === 0); }

console.log('5. Reading the relay list\'s time from the network program');
{ const ctrl = async () => '250-consensus/valid-after=2026-10-26 12:00:00\r\n250 OK\r\n';
  const t = await nr.readConsensusTimes(ctrl);
  ok('a time is read as UTC', t && t.validAfter === Date.UTC(2026, 9, 26, 12, 0, 0), JSON.stringify(t)); }
{ const t = await nr.readConsensusTimes(async () => '552 No consensus available\r\n');
  ok('no relay list: no time', t && t.validAfter === null); }
{ const t = await nr.readConsensusTimes(async () => { throw new Error('control port timeout'); });
  ok('no answer: null', t === null); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
