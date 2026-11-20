// 1.0.10, start.js and the real backend with a stand-in for anon (tools/fake-anon.mjs) whose address can't be reached and which logs
// that it gives up on connections to its service: the backend's self-test asks start.js to restart the network program; start.js does,
// once, and keeps its own limit; everything keeps running; a network program that stops on its own still stops everything.
// Needs `npm install`. Not on Windows (the stand-in is a script run by its #! line).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform === 'win32') { console.log('  (the stand-in for anon is run by its #! line, which Windows does not have: not run here)\n0 passed, 0 failed'); process.exit(0); }
const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SHIM = process.argv[3] || process.env.NODE_PATH || '';
const TOKEN = 'f'.repeat(64), UI = 6833, PUB = 6834;
const d = mkdtempSync(join(tmpdir(), 'restart-')); mkdirSync(d + '/anon'); mkdirSync(d + '/data');
const REC = d + '/launches';
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + x + ']')); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await f()) return true; } catch {} await wait(300); } return false; };
const launches = () => (existsSync(REC) ? readFileSync(REC, 'utf8').trim().split('\n').filter(Boolean) : []);
const ui = (p) => fetch(`http://127.0.0.1:${UI}${p}`, { headers: { 'X-AnonChat-Token': TOKEN } }).then((r) => r.json());

const start = spawn(process.execPath, [join(APP, 'start.js')], { cwd: APP, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(SHIM ? { NODE_PATH: SHIM } : {}),
  ANON_BINARY: join(APP, 'tools/fake-anon.mjs'), ANON_DIR: d + '/anon', DATA_DIR: d + '/data', PUBLIC_PORT: String(PUB), UI_PORT: String(UI),
  ANONCHAT_UI_TOKEN: TOKEN, SELFTEST_FAST: '1', ANONCHAT_TEST_RESTART_GAP_MS: '600000', FAKE_ANON_RECORD: REC, FAKE_ANON_GIVEUP: '1', FAKE_ANON_HTTP: '6835' } });
let out = ''; start.stdout.on('data', (c) => { out += c; }); start.stderr.on('data', (c) => { out += c; });
let exitCode = null; start.on('exit', (c) => { exitCode = c; });
try {
  ok('the network program is started once', await until(() => launches().length === 1, 15000), String(launches().length));
  ok('the backend answers', await until(async () => (await ui('/api/hs/health')).network, 20000));
  ok('our address can\'t be found, the network program gives up on connections to it: restarted (once)', await until(() => launches().length === 2, 60000), String(launches().length) + ' ' + out.slice(-600));
  ok('start.js and the backend keep running through it', exitCode === null && await until(async () => !!(await ui('/api/hs/health')), 10000));
  ok('the log says the network program was restarted', /AnonChat restarted the network program/.test(readFileSync(d + '/anon/anon.log', 'utf8')));
  ok('the backend counts the restart', await until(async () => (await ui('/api/hs/health')).selfTest.restarts === 1, 10000), JSON.stringify((await ui('/api/hs/health')).selfTest));
  ok('the network is ready again after it', await until(async () => (await ui('/api/hs/health')).network.ready === true, 30000), JSON.stringify((await ui('/api/hs/health')).network));
  await wait(45000);          // the backend may ask again after 30 s here; start.js's own limit (10 minutes here, 6 hours for real) says no
  ok('start.js keeps its own limit: no second restart although still unfindable', launches().length === 2, String(launches().length));
  ok('…and nothing stopped', exitCode === null);
  const pid = Number(launches().pop().split(' ')[1]);
  process.kill(pid, 'SIGKILL');          // the network program dies on its own
  ok('a network program that stops on its own still stops everything (exit 7)', await until(() => exitCode !== null, 15000) && exitCode === 7, String(exitCode));
} finally { try { start.kill('SIGTERM'); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
