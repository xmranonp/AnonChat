// A contact whose messages keep failing and who stays silent (lib/stalewatch.js): when the network's memory is cleared (NEWNYM), and
// that it stays cheap for a contact who is simply offline. No network, no clock of its own. Run: node tools/stalewatch-test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sw = require('../lib/stalewatch.js');
let passed = 0, failed = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n + (d ? '  [' + d + ']' : '')); } };
const MIN = 60 * 1000;
const A = 'a'.repeat(56) + '.anyone', B = 'b'.repeat(56) + '.anyone';
function rig(opts = {}) { const w = { t: 1_000_000_000_000, forgets: 0, recent: false }; const x = sw.create({ now: () => w.t, forget: () => { w.forgets++; }, userCircuitRecent: () => w.recent, ...opts }); return { w, x }; }
// failures arrive every 15 s, as the queue retries
function failFor(w, x, addr, ms) { const end = w.t + ms; let n = 0; while (w.t < end) { if (x.noteFail(addr)) n++; w.t += 15000; } return n; }

console.log('1. The first clear-out');
{ const { w, x } = rig();
  ok('failing for 2 minutes: nothing yet', failFor(w, x, A, 2 * MIN) === 0 && w.forgets === 0);
  ok('after 3 minutes of failing: one clear-out', failFor(w, x, A, 90 * 1000) === 1 && w.forgets === 1, String(w.forgets)); }
console.log('2. It stays cheap for a contact who is just offline');
{ const { w, x } = rig();
  failFor(w, x, A, 3 * MIN + 15000);                                    // 1st at 3 min
  ok('the next one is not due for 15 minutes', failFor(w, x, A, 14 * MIN) === 0 && w.forgets === 1, String(w.forgets));
  ok('…then it comes (the 2nd)', failFor(w, x, A, 2 * MIN) === 1 && w.forgets === 2);
  ok('then an hour apart (not before)', failFor(w, x, A, 58 * MIN) === 0 && w.forgets === 2, String(w.forgets));
  ok('…the 3rd', failFor(w, x, A, 3 * MIN) === 1 && w.forgets === 3);
  failFor(w, x, A, 125 * MIN); ok('then every 2 hours at most', w.forgets === 4, String(w.forgets));
}
{ const { w, x } = rig();
  failFor(w, x, A, 24 * 60 * MIN); ok('a whole day of failing: 14 clear-outs (at 3, 18 and 78 minutes, then every 2 hours), not hundreds', w.forgets >= 13 && w.forgets <= 15, String(w.forgets)); }
console.log('3. A success ends the series');
{ const { w, x } = rig();
  failFor(w, x, A, 2 * MIN); x.noteOk(A); failFor(w, x, A, 2 * MIN);
  ok('2 minutes, a success, 2 more minutes: the 3 minutes start again, so nothing', w.forgets === 0);
  failFor(w, x, A, 2 * MIN); ok('…and 3 minutes in a row after the success do count', w.forgets === 1); }
console.log('4. Many contacts, one network program');
{ const { w, x } = rig();
  for (let i = 0; i < 50; i++) { const addr = String(i).padStart(56, 'c') + '.anyone'; x.noteFail(addr); }
  w.t += 4 * MIN; let n = 0; for (let i = 0; i < 50; i++) { if (x.noteFail(String(i).padStart(56, 'c') + '.anyone')) n++; }
  ok('50 contacts all due at once: one clear-out serves them all', n === 1 && w.forgets === 1, String(n));
  w.t += 5 * MIN; for (let i = 0; i < 50; i++) x.noteFail(String(i).padStart(56, 'c') + '.anyone');
  ok('…and at most one in 10 minutes overall', w.forgets === 1, String(w.forgets));
  w.t += 6 * MIN; let m = 0; for (let i = 0; i < 50; i++) { if (x.noteFail(String(i).padStart(56, 'c') + '.anyone')) m++; }
  ok('…after the 10 minutes a contact that is still due may use the next one', m === 1 && w.forgets === 2, `${m} ${w.forgets}`); }
console.log('5. Not while the user has just built a circuit');
{ const { w, x } = rig();
  failFor(w, x, A, 2 * MIN); w.recent = true; ok('a hand-built circuit: no clear-out although it is due', failFor(w, x, A, 2 * MIN) === 0 && w.forgets === 0);
  w.recent = false; ok('…it goes once the circuit is no longer recent', x.noteFail(A) === true && w.forgets === 1);
  const r = rig({ userCircuitRecent: () => { throw new Error('x'); } }); failFor(r.w, r.x, A, 4 * MIN);
  ok('a failing check of that does not stop it', r.w.forgets === 1); }
console.log('6. After a sleep');
{ const { w, x } = rig();
  failFor(w, x, A, 2 * MIN); x.clear(); w.t += 3600000; ok('the time asleep is not failing: clear() starts the count again', x.noteFail(A) === false && w.forgets === 0);
  ok('…status shows the contact again, not before', x.status().contacts === 1); }
console.log('7. Limits');
{ const { w, x } = rig({ maxContacts: 100 }); for (let i = 0; i < 500; i++) x.noteFail(String(i).padStart(56, 'd') + '.anyone');
  ok('a flood of different addresses cannot grow it without limit', x.status().contacts <= 100, String(x.status().contacts)); }
{ const x = sw.create({ forget: () => { throw new Error('control port'); } }); let threw = false; try { for (let i = 0; i < 10; i++) x.noteFail(A); } catch { threw = true; }
  ok('a failing forget() never breaks sending', !threw); }

console.log('8. A series ends when the failures stop');
{ const { w, x } = rig();
  failFor(w, x, A, 4 * MIN); ok('a series that fired once', w.forgets === 1);
  w.t += 2 * 24 * 60 * MIN;                                           // the message expired; days later a new one
  ok('days later the first failure of a new message: no clear-out at once', x.noteFail(A) === false && w.forgets === 1);
  failFor(w, x, A, 2 * MIN); ok('…it needs its own 3 minutes of failing', w.forgets === 1);
  failFor(w, x, A, 90 * 1000); ok('…then it comes', w.forgets === 2, String(w.forgets)); }
{ const { w, x } = rig();
  failFor(w, x, A, 2 * MIN); x.noteGone(A); failFor(w, x, A, 2 * MIN);
  ok('noteGone (expired, contact removed) ends the series too', w.forgets === 0); }
{ const { w, x } = rig({ maxContacts: 3 });
  failFor(w, x, A, 2 * MIN);                                          // a real contact, failing all along
  for (let i = 0; i < 80; i++) { x.noteFail(String(i).padStart(56, 'e') + '.anyone'); x.noteFail(A); w.t += 1000; }          // 80 s more: past its 3 minutes
  ok('a flood of new addresses does not push out a contact that keeps failing (its clear-out still comes)', w.forgets === 1, String(w.forgets)); }

console.log('Clock set back (1.0.8 audit)');
{ const { w, x } = rig();
  failFor(w, x, A, 3 * MIN + 15000);                                    // 1st clear-out
  w.t -= 6 * 60 * MIN;                                                  // the clock goes back 6 hours
  ok('after the clock is set back the series starts over, it is not frozen for 6 hours', failFor(w, x, A, 4 * MIN) === 1 && w.forgets === 2, String(w.forgets)); }
{ const { w, x } = rig();
  failFor(w, x, A, 3 * MIN + 15000); w.t -= 60 * MIN; failFor(w, x, B, 4 * MIN);
  ok('the one-in-10-minutes cap does not hold a contact for the length of the step back', w.forgets === 2, String(w.forgets)); }

console.log('A forget that cannot go now keeps the step (1.0.8 audit)');
{ let allow = false; const { w, x } = rig({ forget: () => { if (allow) w.forgets++; return allow; } });
  failFor(w, x, A, 4 * MIN);
  ok('the clear-out could not go (one went moments ago): nothing counted, the step is still due', w.forgets === 0 && x.status().fired === 0, JSON.stringify(x.status()));
  allow = true; ok('…the next failure uses it', failFor(w, x, A, 30000) === 1 && w.forgets === 1);
  ok('…and the ladder moved on only then (next step 15 minutes away)', failFor(w, x, A, 10 * MIN) === 0); }
{ const { w, x } = rig();
  failFor(w, x, A, 3 * MIN + 15000); w.t -= 20000;
  ok('a step back of 20 s (time sync) does not open the one-in-10-minutes cap', failFor(w, x, B, 4 * MIN) === 0 && w.forgets === 1, String(w.forgets)); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
