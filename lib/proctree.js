'use strict';

// Reliable shutdown of the backend process tree: SIGTERM, then SIGKILL; taskkill /T /F on Windows.

const { spawnSync } = require('child_process');

const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Linux: zombies (exited but not yet reaped, e.g. in a container without an init) must not count as alive.
function linuxStat(pid) {
  try {
    const stat = require('fs').readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: f[0], pgrp: Number(f[2]) };
  } catch { return null; }
}
const isDead = (state) => state === 'Z' || state === 'X';

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); }
  catch (e) { return e.code === 'EPERM'; }
  if (process.platform === 'linux') {
    const st = linuxStat(pid);
    if (st && isDead(st.state)) return false;
  }
  return true;
}

function linuxGroupHasLive(pgid) {
  let names;
  try { names = require('fs').readdirSync('/proc'); } catch { return null; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const st = linuxStat(n);
    if (st && st.pgrp === pgid && !isDead(st.state)) return true;
  }
  return false;
}

// POSIX: pid must be a process-group leader (spawned detached). Windows: only the root process is checked.
function groupAlive(pid) {
  if (!pid) return false;
  if (isWin) return pidAlive(pid);
  try { process.kill(-pid, 0); }
  catch (e) { return e.code === 'EPERM'; }
  if (process.platform === 'linux') {
    const live = linuxGroupHasLive(pid);
    if (live !== null) return live;
  }
  return true;
}

function taskkill(pid) {
  try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
}

function signalTree(pid, sig) {
  if (!pid) return;
  if (isWin) return taskkill(pid);
  try { process.kill(-pid, sig); }
  catch { try { process.kill(pid, sig); } catch {} }
}

async function waitUntil(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(50); }
  return pred();
}

async function terminateTree(pid, { graceMs = 4000, killMs = 1500 } = {}) {
  if (!groupAlive(pid)) return true;
  signalTree(pid, 'SIGTERM');
  if (await waitUntil(() => !groupAlive(pid), graceMs)) return true;
  signalTree(pid, 'SIGKILL');
  return waitUntil(() => !groupAlive(pid), killMs);
}

function killTreeSync(pid) { signalTree(pid, 'SIGKILL'); }

const isRunning = (c) => c && c.pid !== undefined && c.exitCode === null && c.signalCode === null;

function signalChild(c, sig) {
  if (!isRunning(c)) return;
  if (isWin) return taskkill(c.pid);
  try { c.kill(sig); } catch {}
}

async function terminateChildren(children, { graceMs = 4000, killMs = 1500 } = {}) {
  const none = () => !children.some(isRunning);
  if (none()) return true;
  for (const c of children) signalChild(c, 'SIGTERM');
  if (await waitUntil(none, graceMs)) return true;
  for (const c of children) signalChild(c, 'SIGKILL');
  return waitUntil(none, killMs);
}

function killChildrenSync(children) {
  for (const c of children) signalChild(c, 'SIGKILL');
}

module.exports = { pidAlive, groupAlive, terminateTree, killTreeSync, terminateChildren, killChildrenSync };
