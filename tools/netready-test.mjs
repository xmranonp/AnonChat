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

console.log('6. After a sleep: not ready until the connection is back, then the usual clear-out');
{ const { w, r } = rig();
  w.pct = 100; w.after = 20 * MIN; await r.check();
  ok('ready before the sleep', r.isReady() && w.ready.length === 1);
  ok('reset() reports it took effect', r.reset() === true);
  ok('…not ready at once, and no onReady for the fall', !r.isReady() && r.status().reason === 'resumed' && w.ready.length === 1);
  ok('…the network program still says 100%, yet check() says not ready during the hold', (await r.check()) === false && !r.isReady());
  w.t += 5000; ok('…also 5 seconds later', (await r.check()) === false);
  w.t += 6000; ok('after the hold (10 s) it is ready again, with the reason "resumed"', (await r.check()) === true && w.ready.length === 2 && w.ready[1] === 'resumed', w.ready.join());
  await r.check(); ok('onReady ran once for the sleep, not on every check', w.ready.length === 2); }
{ let up = false; const { w, r } = rig({ circuitUp: async () => up });
  w.pct = 100; w.after = 20 * MIN; await r.check(); r.reset(); w.t += 11000;
  ok('no working circuit yet: still not ready after the hold', (await r.check()) === false && r.status().reason === 'no-circuit');
  w.t += 60000; ok('…and a minute later', (await r.check()) === false);
  up = true; ok('a circuit works: ready', (await r.check()) === true && w.ready[1] === 'resumed'); }
{ const { w, r } = rig({ circuitUp: async () => false });
  w.pct = 100; w.after = 20 * MIN; await r.check(); r.reset(); w.t += 11000; await r.check(); w.t += 3 * MIN;
  ok('a circuit that never shows does not hold things for ever (3 minutes)', (await r.check()) === true && w.ready[1] === 'resumed'); }
{ const { w, r } = rig({ circuitUp: async () => { throw new Error('control port'); } });
  w.pct = 100; w.after = 20 * MIN; await r.check(); r.reset(); w.t += 11000;
  ok('a failing question about circuits does not stop it', (await r.check()) === true); }
{ const { w, r } = rig();
  w.pct = 100; w.after = 20 * MIN; await r.check(); r.reset(); w.t += 11000; w.pct = 60;
  ok('bootstrapping again after the sleep: waits for 100%', (await r.check()) === false && r.status().reason === 'bootstrapping');
  w.pct = 100; ok('…then ready, still as "resumed"', (await r.check()) === true && w.ready[1] === 'resumed', w.ready.join()); }
{ const { w, r } = rig();
  w.pct = 100; w.after = 20 * MIN; await r.check(); r.reset(); w.t += 11000; w.pct = null;
  ok('the network program does not answer after the sleep: not ready at first', (await r.check()) === false);
  w.t += 4 * MIN + 1000; ok('…but not for ever (4 minutes)', (await r.check()) === true && w.ready[1] === 'assumed', w.ready.join()); }
{ const { w, r } = rig({ enabled: false });
  ok('switched off (tests, web mode): reset() does nothing and it stays ready', r.reset() === false && r.isReady() && (await r.check()) === true); }
{ const { w, r } = rig();
  ok('before the first time ready, reset() just holds; the first-start rules still apply', r.reset() === true);
  w.pct = 100; w.after = 30 * HOUR; w.t += 11000; await r.check();
  ok('…a day-old list is still not ready', !r.isReady()); }

console.log('7. A check that began before the sleep must not finish after the wake');
{ const hold = { fn: null }; const { w: w3, r: r3 } = rig({ bootstrapPct: () => (hold.fn ? hold.fn() : Promise.resolve(100)) });
  w3.after = 20 * MIN; await r3.check(); ok('ready first', r3.isReady());
  let resolveAnswer; hold.fn = () => new Promise((res) => { resolveAnswer = () => res(100); });
  const pending = r3.check();                         // asks the network program; the answer is on its way when the computer goes to sleep
  r3.reset();                                         // the wake: the handler runs first
  hold.fn = null; resolveAnswer();                    // …then the answer from before the sleep arrives
  ok('the old check does not make it ready again', (await pending) === false && !r3.isReady() && r3.status().reason === 'resumed');
  ok('…no onReady for it', w3.ready.length === 1, w3.ready.join());
  w3.t += 11000; ok('after the hold the normal rules apply', (await r3.check()) === true && w3.ready[1] === 'resumed', w3.ready.join()); }
{ // the same while the relay list is being asked (first start, then a reset)
  const gate = { fn: null }; const { w, r } = rig({ consensusTimes: () => (gate.fn ? gate.fn() : Promise.resolve({ validAfter: w.t - 20 * MIN })) });
  w.pct = 100; let resolveTimes; gate.fn = () => new Promise((res) => { resolveTimes = () => res({ validAfter: w.t - 20 * MIN }); });
  const pending = r.check(); await Promise.resolve(); await Promise.resolve(); r.reset(); resolveTimes();
  ok('an answer about the relay list from before the reset does not make it ready', (await pending) === false && !r.isReady()); }

console.log('8. Checks that overlap (they start every 3 seconds, a slow answer can outlast one)');
{ let release; const gate = new Promise((res) => { release = res; });
  const { w, r } = rig({ circuitUp: async () => { await gate; return true; } });
  w.pct = 100; w.after = 20 * MIN; await r.check(); r.reset(); w.t += 11000;
  const a = r.check(), b = r.check();                       // both are waiting for the circuit question when the first one finishes
  release();
  let threw = null; try { await Promise.all([a, b]); } catch (e) { threw = e; }
  ok('two checks waiting for the same answer: neither throws', !threw, threw && threw.message);
  ok('…the network is ready once, as "resumed"', r.isReady() && w.ready.length === 2 && w.ready[1] === 'resumed', w.ready.join()); }
{ let n = 0; const { w, r } = rig({ circuitUp: async () => { n++; if (n === 1) { await new Promise((res) => setTimeout(res, 30)); return false; } return true; } });
  w.pct = 100; w.after = 20 * MIN; await r.check(); r.reset(); w.t += 11000;
  const first = r.check(); await new Promise((res) => setTimeout(res, 5)); const second = r.check();   // the second finishes first, with a working circuit
  const res = await Promise.all([first, second]);
  ok('a slow "no circuit" answer that arrives after a quicker "works" one does not undo it', r.isReady() && res.includes(true), JSON.stringify(res)); }

console.log('9. Audit fixes (November 2026)');
{ // a wake during the first start must not leave "after a wake" behind
  const { w, r } = rig();
  r.reset(); w.t += 11000; w.pct = 100; w.after = 20 * MIN; await r.check();
  ok('a wake before the first ready, then ready the normal way', r.isReady() && w.ready[0] === 'ready', w.ready.join());
  w.pct = 60; await r.check(); ok('…later the network drops', !r.isReady());
  w.pct = null; w.t += 10 * MIN;
  ok('…and the network program stops answering: stays not ready (no "assumed" left over from the old wake)', (await r.check()) === false && !r.isReady(), JSON.stringify(r.status())); }
{ // after a wake, a silent network program holds things 3 minutes, not 4
  const { w, r } = rig();
  w.pct = 100; w.after = 20 * MIN; await r.check(); r.reset(); w.t += 11000; w.pct = null;
  await r.check(); w.t += 3 * MIN - 11000 + 1000;
  ok('control port silent after a wake: ready (assumed) after 3 minutes from the wake', (await r.check()) === true && w.ready[1] === 'assumed', w.ready.join()); }
{ // overnight: the relay list is hours old after the wake
  const { w, r } = rig();
  w.pct = 100; w.after = 20 * MIN; await r.check(); w.t += 8 * HOUR; w.after = 8 * HOUR; r.reset(); w.t += 11000;          // the sleep, then the wake is noticed
  ok('after a long sleep with an old relay list: not ready yet', (await r.check()) === false && r.status().reason === 'relay-list', JSON.stringify(r.status()));
  w.after = 5 * MIN; ok('…a current list arrives: ready, as "resumed"', (await r.check()) === true && w.ready[1] === 'resumed', w.ready.join()); }
{ const { w, r } = rig();
  w.pct = 100; w.after = 20 * MIN; await r.check(); w.t += 8 * HOUR; w.after = 8 * HOUR; r.reset(); w.t += 11000;
  await r.check(); w.t += 3 * MIN;
  ok('…an old list that never gets current does not hold things longer than 3 minutes after the wake', (await r.check()) === true && w.ready[1] === 'resumed', w.ready.join()); }
{ // a slow "no circuit" answer that comes after a quicker "works" one leaves the state as it was: ready, with its reason
  let n = 0; const { w, r } = rig({ circuitUp: async () => { n++; if (n === 1) { await new Promise((res) => setTimeout(res, 30)); return false; } return true; } });
  w.pct = 100; w.after = 20 * MIN; await r.check(); r.reset(); w.t += 11000;
  const first = r.check(); await new Promise((res) => setTimeout(res, 5)); const second = r.check();
  const res = await Promise.all([first, second]);
  ok('overlapping checks: the slower answer keeps the outcome (ready, reason "resumed", both say ready)', r.isReady() && r.status().reason === 'resumed' && res[0] === true && res[1] === true, JSON.stringify({ res, st: r.status() })); }

console.log('Clock set back / wake during the first start (1.0.8 audit)');
{ // the wall clock set back an hour after a wake (time sync): the wait ends all the same, within its own limit
  const { w, r } = rig(); w.pct = 100; w.after = 20 * MIN; await r.check();
  r.reset(); w.t -= HOUR;
  w.after = 20 * MIN; const a = await r.check();
  ok('clock set back an hour after a wake: ready at once, not an hour later', a === true && r.isReady(), JSON.stringify(r.status())); }
{ const { w, r } = rig({ circuitUp: async () => false }); w.pct = 100; w.after = 20 * MIN; await r.check();
  r.reset(); w.t += 11000; await r.check(); const waiting = !r.isReady();
  w.t -= 2 * HOUR; const a = await r.check();
  ok('no circuit and the clock set back: the wait still ends (never longer than its limit)', waiting && a === true, JSON.stringify(r.status())); }
{ // a wake before the first start has finished, and the network gets back to 100% only 2.5 minutes after it: the 3 minutes after the wake are all there is
  const { w, r } = rig({ consensusWaitMs: 3 * MIN }); w.pct = 100; w.after = 30 * HOUR; await r.check(); w.t += 2 * MIN; await r.check();
  r.reset(); w.t += 11000; w.pct = 50; await r.check();
  w.t += 2.5 * MIN; w.pct = 100; await r.check(); const early = r.isReady();
  w.t += 31000;
  ok('wake during the first start: ready 3 minutes after the wake, not a first-start wait on top of it', !early && (await r.check()) === true, JSON.stringify(r.status()) + ' ' + w.ready.join()); }

console.log('A small step back of the clock (time sync) after a wake');
{ const { w, r } = rig({ circuitUp: async () => true }); w.pct = 100; w.after = 20 * MIN; await r.check();
  r.reset(); w.t -= 5000; const a = await r.check();
  ok('the clock 5 s back right after a wake: still in the 10 s hold, not ready', a === false && !r.isReady() && r.status().reason === 'resumed', JSON.stringify(r.status()));
  w.t += 16000; ok('…and ready once the hold is over', (await r.check()) === true); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
