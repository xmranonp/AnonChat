// Error answers carry a status and a one-word reason only: never a stack trace or a file path (on Windows the install path contains the
// user name, and the public port is reachable by anyone who knows the address). Run: node tools/error-page-test.mjs  (needs `npm install`)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const d = mkdtempSync(join(tmpdir(), 'errpage-'));
mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
const ADDR = 'a'.repeat(56) + '.anyone', TOKEN = 'e'.repeat(64), PUB = 6412, UI = 6411;
writeFileSync(d + '/anon/anon_service/hostname', ADDR + '\n');
const srv = spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env, NODE_ENV: '', PUBLIC_PORT: String(PUB), UI_PORT: String(UI),
  DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: '1', SOCKS: 'socks5h://127.0.0.1:1' } });

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else fail++; console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  [' + detail + ']')); };
const req = (port, method, path, headers, body) => new Promise((res) => {
  const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (rs) => { let s = ''; rs.on('data', (c) => (s += c)); rs.on('end', () => res({ status: rs.statusCode, body: s })); });
  r.on('error', (e) => res({ status: 0, body: e.message })); if (body) r.write(body); r.end();
});
const leaks = (s) => /node_modules|[\\/][\w.-]+\.js:\d+|\bat \w|<!DOCTYPE|<pre>/i.test(s);
try {
  for (let i = 0; i < 40; i++) { if ((await req(UI, 'GET', '/api/version', { 'X-AnonChat-Token': TOKEN })).status === 200) break; await new Promise((r) => setTimeout(r, 150)); }
  const big = '{"x":"' + 'a'.repeat(11 * 1024 * 1024) + '"}';
  for (const [name, port, headers] of [['public port', PUB, { Host: ADDR }], ['window port', UI, { 'X-AnonChat-Token': TOKEN }]]) {
    for (const [what, body] of [['malformed JSON', '{bad'], ['null body', 'null'], ['11 MB body', big]]) {
      const r = await req(port, 'POST', '/api/inbox', { ...headers, 'Content-Type': 'application/json' }, body);
      ok(`${name}, ${what}: status and reason only`, r.status >= 400 && !leaks(r.body), `${r.status} ${r.body.slice(0, 120)}`);
    }
    const r = await req(port, 'GET', '/no/such/path', headers);
    ok(`${name}, unknown path: plain 404`, r.status === 404 && !leaks(r.body), `${r.status} ${r.body.slice(0, 120)}`);
  }
} finally { srv.kill(); }
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
