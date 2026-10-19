// Tests that the shutdown helpers really stop process trees (POSIX only).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const pt = createRequire(import.meta.url)('../lib/proctree.js');

if (process.platform === 'win32') { console.log('skipped on win32\n0 passed, 0 failed'); process.exit(0); }

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : (failed++, console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (script, opts = {}) => spawn('sh', ['-c', script], { stdio: 'ignore', ...opts });
const STUBBORN = 'trap "" TERM; while :; do sleep 1; done';

{
  const c = sh('sleep 60 & sleep 60 & wait', { detached: true });
  await sleep(200);
  eq('group alive before', pt.groupAlive(c.pid), true);
  const t0 = Date.now();
  eq('terminateTree returns true', await pt.terminateTree(c.pid), true);
  eq('group gone after', pt.groupAlive(c.pid), false);
  eq('graceful stop is fast', Date.now() - t0 < 2000, true);
}

{
  const c = sh(`sh -c '${STUBBORN}' & ${STUBBORN}`, { detached: true });
  await sleep(300);
  eq('stubborn alive before', pt.groupAlive(c.pid), true);
  eq('escalates to SIGKILL', await pt.terminateTree(c.pid, { graceMs: 400, killMs: 2000 }), true);
  eq('stubborn group gone', pt.groupAlive(c.pid), false);
}

{
  const a = sh('sleep 60'), b = sh(STUBBORN);
  await sleep(300);
  eq('children stopped', await pt.terminateChildren([a, b], { graceMs: 400, killMs: 2000 }), true);
  await sleep(100);
  eq('polite child gone', pt.pidAlive(a.pid), false);
  eq('stubborn child gone', pt.pidAlive(b.pid), false);
}

eq('no pid', pt.groupAlive(undefined), false);
eq('dead pid', await pt.terminateTree(999999), true);
eq('no children', await pt.terminateChildren([]), true);
{
  const c = spawn('/nonexistent/binary', [], { stdio: 'ignore' });
  c.on('error', () => {});
  eq('failed spawn is not "running"', await pt.terminateChildren([c]), true);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
