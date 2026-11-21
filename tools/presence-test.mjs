// The online check (1.0.11): four contacts at a time, so a list of contacts who are away no longer takes many times the 3 minutes between
// sweeps. The real backend, a fake Anyone control port, a fake SOCKS port that holds every connection 2 s and then says "not found".
// Needs `npm install`. Run: node tools/presence-test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SHIM = process.argv[3] || process.env.NODE_PATH || '';
const TOKEN = 'b'.repeat(64), ME = 'q'.repeat(56) + '.anyone';
const CTL = 6841, HTTP = 6842, UI = 6843, PUB = 6844;
const A32 = 'abcdefghijklmnopqrstuvwxyz234567';
const contacts = Array.from({ length: 10 }, (_, i) => A32[i].repeat(56) + '.anyone');
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + String(x).slice(0, 300) + ']')); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let open = 0, maxOpen = 0; const firstAt = new Map();
const socks = net.createServer((c) => {
  let step = 0, buf = Buffer.alloc(0);
  c.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (step === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) { buf = buf.subarray(2 + buf[1]); c.write(Buffer.from([5, 0])); step = 1; }
    if (step === 1 && buf.length >= 5 && buf[3] === 3 && buf.length >= 7 + buf[4]) {
      step = 2; const host = buf.subarray(5, 5 + buf[4]).toString();
      if (!contacts.includes(host)) { c.end(Buffer.from([5, 0xF0, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      if (!firstAt.has(host)) firstAt.set(host, Date.now());
      open++; maxOpen = Math.max(maxOpen, open);
      setTimeout(() => { open--; try { c.end(Buffer.from([5, 0xF0, 0, 1, 0, 0, 0, 0, 0, 0])); } catch {} }, 2000);
    }
  });
  c.on('error', () => {});
});
await new Promise((r) => socks.listen(0, '127.0.0.1', r));
const d = mkdtempSync(join(tmpdir(), 'presence-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
writeFileSync(join(d, 'data', 'contacts.json'), JSON.stringify(contacts.map((a, i) => ({ address: a, petname: 'C' + i, ecdhPub: 'K' + i, ratchetPub: 'R' + i }))));
const fk = spawn('node', [join(APP, 'tools/fake-control-port.mjs'), String(CTL), String(HTTP), d + '/anon'], { stdio: 'ignore' });
await wait(500);
const t0 = Date.now();
const srv = spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env, ...(SHIM ? { NODE_PATH: SHIM } : {}),
  PUBLIC_PORT: String(PUB), UI_PORT: String(UI), DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: String(CTL), PEERS: '{}',
  SOCKS: `socks5h://127.0.0.1:${socks.address().port}`, ANONCHAT_WAIT_NETWORK: '1',
  PRESENCE_FIRST_MS: '1000', PRESENCE_INTERVAL_MS: '600000', PRESENCE_RECHECK_MS: '600000', PRESENCE_STAGGER_MS: '300' } });
try {
  const t = Date.now(); while (firstAt.size < contacts.length && Date.now() - t < 40000) await wait(200);
  ok('every contact is checked', firstAt.size === contacts.length, `${firstAt.size} of ${contacts.length}`);
  ok('four at a time, never more', maxOpen === 4, `at most ${maxOpen} at once`);
  const times = [...firstAt.values()].sort((a, b) => a - b), span = times[times.length - 1] - times[0];
  ok('ten contacts away (2 s each) checked within about three rounds, not ten', span < 3 * 2300 + 1500, `${span} ms from the first to the last`);
} finally { srv.kill(); fk.kill(); socks.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
