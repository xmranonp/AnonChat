// "Did the computer just wake?" (lib/wakewatch.js): a gap far longer than the tick means the process was frozen. No timers, no sleep.
// Run: node tools/wakewatch-test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ww = require('../lib/wakewatch.js');
let passed = 0, failed = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n + (d ? '  [' + d + ']' : '')); } };

function rig(opts = {}) { const w = { t: 1_000_000, wakes: [] }; const x = ww.create({ now: () => w.t, onWake: (i) => w.wakes.push(i), ...opts }); return { w, x }; }

console.log('1. Detecting a sleep');
{ const { w, x } = rig();
  for (let i = 0; i < 10; i++) { w.t += 2000; x.tick(); }
  ok('ordinary ticks: no wake', w.wakes.length === 0);
  w.t += 2000 + 8000; ok('a 8 s stall (a busy computer) is ignored', x.tick() === false && w.wakes.length === 0);
  w.t += 2000 + 19000; ok('19 s late: still ignored', x.tick() === false);
  w.t += 2000 + 20000; ok('20 s late: a wake, with the length of the gap', x.tick() === true && w.wakes.length === 1 && w.wakes[0].gapMs === 22000, JSON.stringify(w.wakes));
  w.t += 2000; ok('the tick after it is ordinary again (one wake, not many)', x.tick() === false && w.wakes.length === 1);
  w.t += 2000 + 3600000; ok('an hour asleep is a wake', x.tick() === true && w.wakes.length === 2 && w.wakes[1].gapMs === 3602000); }
console.log('2. Clocks that move');
{ const { w, x } = rig();
  w.t += 2000; x.tick(); w.t -= 3600000; ok('the clock set back by an hour is not a sleep', x.tick() === false && w.wakes.length === 0);
  w.t += 2000; ok('…and ticks go on normally afterwards', x.tick() === false);
  w.t += 2000 + 60000; ok('a forward jump of a minute counts (as a sleep would)', x.tick() === true); }
console.log('3. Robustness');
{ const { w, x } = rig({ onWake: () => { throw new Error('boom'); } });
  w.t += 60000; ok('a handler that throws does not break the timer', x.tick() === true); w.t += 2000; ok('…the next tick works', x.tick() === false); }
{ let started = 0, cleared = 0; const fakeTimer = { unref() { this.u = true; } };
  const x = ww.create({ setTimer: (fn, ms) => { started++; fakeTimer.ms = ms; return fakeTimer; }, clearTimer: () => { cleared++; } });
  x.start(); x.start(); ok('start() twice starts one timer, every 2 s, not keeping the process alive', started === 1 && fakeTimer.ms === 2000 && fakeTimer.u === true);
  x.stop(); x.stop(); ok('stop() twice clears once', cleared === 1); }

console.log('4. Asked before sending (poll)');
{ const fake = { unref() {} }; let w = { t: 1_000_000, wakes: 0 };
  const x = ww.create({ now: () => w.t, onWake: () => { w.wakes++; }, setTimer: () => fake, clearTimer: () => {} });
  w.t += 60000; ok('not running: a long quiet spell is not a sleep', x.poll() === false && w.wakes === 0);
  x.start(); w.t += 1500; ok('running, an ordinary moment: no wake', x.poll() === false);
  w.t += 60000; ok('running, a minute later before the next tick: the wake is noticed at once', x.poll() === true && w.wakes === 1);
  w.t += 1000; ok('…and the next tick does not report it again', x.tick() === false && w.wakes === 1); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
