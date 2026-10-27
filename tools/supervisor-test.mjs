// The supervisor (start.js) stops everything when the Anyone network program isn't the one holding the network's port: when it stops
// (before or after publishing), and when port 9050 is held by another program while "Dynamic port" is off. Otherwise the backend would
// send contact addresses, envelopes and the key lookups of contacts being added to whatever holds the port.
// Runs the real start.js and server.js with a stand-in network program. Needs `npm install`. Not on Windows (the stand-in is a script).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); } };
if (process.platform === 'win32') { console.log('skipped on Windows\n0 passed, 0 failed'); process.exit(0); }

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listening = (port) => new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.on('error', () => res(false)); s.on('connect', () => { s.destroy(); res(true); }); });
const stubPid = (dir) => { try { return Number(readFileSync(join(dir, 'stub-ran'), 'utf8')) || 0; } catch { return 0; } };

// The stand-in network program: notes that it ran, can publish an address, then stays up, exits, or exits at once.
const BIN = mkdtempSync(join(tmpdir(), 'sup-bin-'));
const STUB = join(BIN, 'anon');
writeFileSync(STUB, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const dir = process.env.ANON_DIR, mode = process.env.STUB_MODE;
fs.writeFileSync(path.join(dir, 'stub-ran'), String(process.pid));
if (mode === 'die-now') process.exit(1);
fs.mkdirSync(path.join(dir, 'anon_service'), { recursive: true });
fs.writeFileSync(path.join(dir, 'anon_service', 'hostname'), 'a'.repeat(56) + '.anyone\\n');
if (mode === 'die-later') setTimeout(() => process.exit(0), 3000);
else setInterval(() => {}, 1000);
`);
chmodSync(STUB, 0o755);

async function run(mode, { network } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sup-'));
  const ANON_DIR = join(root, 'anon'), DATA_DIR = join(root, 'data');
  mkdirSync(ANON_DIR, { recursive: true }); mkdirSync(DATA_DIR, { recursive: true });
  if (network) writeFileSync(join(DATA_DIR, 'network.json'), JSON.stringify(network));
  const env = { ...process.env, ANON_DIR, DATA_DIR, ANON_BINARY: STUB, STUB_MODE: mode,
    PUBLIC_PORT: String(await freePort()), UI_PORT: String(await freePort()) };
  delete env.ANONCHAT_UI_TOKEN; delete env.ANONCHAT_KEY_STDIN; delete env.ANONCHAT_PARENT_PID;
  const child = spawn(process.execPath, [join(APP, 'start.js')], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => { out += b; }); child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((res) => child.on('exit', (code) => res(code)));
  return { root, ANON_DIR, child, exited, out: () => out, uiPort: Number(env.UI_PORT) };
}
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => 'still running')]);

// 1. The network program stops after publishing: everything stops, with code 7.
{
  const r = await run('die-later');
  const code = await within(r.exited, 20000);
  ok('the network program stopping after publishing stops AnonChat (exit 7)', code === 7, String(code) + ' ' + r.out().slice(-300));
  ok('…and says why', /anon stopped/.test(r.out()));
  await sleep(500);
  ok('…and the backend is stopped too (nothing on the UI port)', !(await listening(r.uiPort)));
  rmSync(r.root, { recursive: true, force: true });
}
// 2. It stops at once: everything stops, with code 7.
{
  const r = await run('die-now');
  const code = await within(r.exited, 20000);
  ok('the network program failing to start stops AnonChat (exit 7)', code === 7, String(code) + ' ' + r.out().slice(-300));
  ok('…and says it exited before publishing', /before publishing/.test(r.out()));
  rmSync(r.root, { recursive: true, force: true });
}
// 3. Port 9050 held by another program and "Dynamic port" off: stop before starting anything, with code 6.
{
  const holder = net.createServer();
  const held = await new Promise((res) => { holder.once('error', () => res(false)); holder.listen(9050, '127.0.0.1', () => res(true)); });
  // If something else already holds 9050 here, that serves the test just as well.
  const r = await run('stay', { network: { dynamicPort: false } });
  const code = await within(r.exited, 20000);
  ok('port 9050 taken with Dynamic port off stops AnonChat (exit 6)', code === 6, String(code) + ' ' + r.out().slice(-300));
  ok('…before the network program or the backend is started', !existsSync(join(r.ANON_DIR, 'stub-ran')) && !/listening/i.test(r.out()), r.out().slice(-200));
  if (held) holder.close();
  rmSync(r.root, { recursive: true, force: true });
}
// 4. All well: it keeps running, and stops cleanly on request, taking the network program with it.
{
  const r = await run('stay');
  const code = await within(r.exited, 6000);
  ok('with the network program running, AnonChat keeps running', code === 'still running', String(code) + ' ' + r.out().slice(-300));
  ok('…with its backend up', await listening(r.uiPort));
  const pid = stubPid(r.ANON_DIR);
  r.child.kill('SIGTERM');
  const code2 = await within(r.exited, 15000);
  ok('…and stops cleanly when asked (exit 0)', code2 === 0, String(code2));
  await sleep(500);
  ok('…taking the network program with it', pid > 0 && !alive(pid), String(pid));
  rmSync(r.root, { recursive: true, force: true });
}
rmSync(BIN, { recursive: true, force: true });
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
