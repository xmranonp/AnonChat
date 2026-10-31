// F-1: the browser-mode UI has no cookie. The access token lives in the link's fragment, the tab keeps it, and every call carries it as a header.
// Static pages are open (a browser cannot attach headers to them); /api and the WebSocket need the token; cross-site requests are refused even with it.
import { spawn } from 'node:child_process'; import http from 'node:http'; import net from 'node:net'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url); const WebSocket = require('ws');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const free = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let pass = 0, fail = 0; const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('✗', n, x ?? ''); } };
const UI = await free(), PUB = await free();
const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uiauth-'));
fs.mkdirSync(d + '/anon/anon_service', { recursive: true }); fs.mkdirSync(d + '/data');
fs.writeFileSync(d + '/anon/anon_service/hostname', 'c'.repeat(56) + '.anyone\n');
fs.writeFileSync(d + '/anon/anon_service/hs_ed25519_secret_key', Buffer.concat([Buffer.from('== ed25519v1-secret: type0 ==\0\0\0'), Buffer.alloc(64, 83)]));
fs.writeFileSync(d + '/anon/anon_service/hs_ed25519_public_key', Buffer.concat([Buffer.from('== ed25519v1-public: type0 ==\0\0\0'), Buffer.alloc(32, 80)]));
const env = { ...process.env, UI_PORT: String(UI), PUBLIC_PORT: String(PUB), DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANON_CTRL_PORT: '1' }; delete env.ANONCHAT_UI_TOKEN;
let log = ''; const srv = spawn('node', [path.join(root, 'server.js')], { env, cwd: root }); srv.stdout.on('data', (b) => log += b); srv.stderr.on('data', (b) => log += b);
let tok = null; for (let i = 0; i < 80 && !tok; i++) { await new Promise((r) => setTimeout(r, 250)); tok = (log.match(/localhost:\d+\/#t=([0-9a-f]{64})/) || [])[1]; }
ok(!!tok, 'the start-up link carries the token in the fragment');
const req = (p, headers = {}) => new Promise((res) => { const r = http.request({ host: '127.0.0.1', port: UI, path: p, headers: { host: `127.0.0.1:${UI}`, ...headers } }, (x) => { let b = ''; x.on('data', (c) => b += c); x.on('end', () => res({ s: x.statusCode, h: x.headers, b })); }); r.on('error', () => res({ s: 0, h: {}, b: '' })); r.end(); });
const ws = (protocols, headers = {}) => new Promise((res) => { const w = new WebSocket(`ws://127.0.0.1:${UI}/ws`, protocols, { headers: { host: `127.0.0.1:${UI}`, origin: `http://127.0.0.1:${UI}`, ...headers } }); w.on('open', () => { const p = w.protocol; w.close(); res('open:' + p); }); w.on('error', () => res('refused')); w.on('unexpected-response', () => res('refused')); setTimeout(() => res('timeout'), 4000); });
try {
  let r = await req('/'); ok(r.s === 200 && !r.h['set-cookie'], 'the page is served without a cookie', r.h['set-cookie']);
  r = await req('/index.html'); ok(r.s === 200 && !r.h['set-cookie'], 'index.html: no cookie');
  r = await req('/auth.js'); ok(r.s === 200, 'auth.js is served');
  r = await req('/api/whoami'); ok(r.s === 403 && !r.h['set-cookie'], '/api without the token: refused', r.s);
  r = await req('/api/whoami', { 'x-anonchat-token': 'f'.repeat(64) }); ok(r.s === 403, '/api with a wrong token: refused', r.s);
  r = await req('/api/whoami', { 'x-anonchat-token': tok }); ok(r.s === 200, '/api with the token: answered', r.s);
  r = await req('/api/whoami', { 'x-anonchat-token': tok, 'sec-fetch-site': 'same-origin' }); ok(r.s === 200, 'same-origin fetch: answered');
  r = await req('/api/backup/hs', { 'x-anonchat-token': tok, 'sec-fetch-site': 'cross-site' }); ok(r.s === 403, 'cross-site request is refused even with the token', r.s);
  r = await req('/api/backup/hs', { 'x-anonchat-token': tok, 'sec-fetch-site': 'same-site' }); ok(r.s === 403, 'same-site (another local port) is refused even with the token', r.s);
  r = await req('/api/whoami', { 'x-anonchat-token': tok, origin: 'http://localhost:9999' }); ok(r.s === 403, 'a foreign Origin is refused even with the token', r.s);
  r = await req('/api/whoami', { cookie: `anonchat_ui_${UI}=${tok}; anonchat_ui=${tok}`, 'x-anonchat-token': '' }); ok(r.s === 403, 'a cookie no longer counts', r.s);
  r = await req('/api/whoami', { 'x-anonchat-token': tok, host: 'evil.example' }); ok(r.s === 403 || r.s === 400, 'a foreign Host is refused', r.s);
  r = await req(`/?t=${tok}`); ok(r.s === 303 && r.h.location === `/#t=${tok}` && !r.h['set-cookie'], 'old ?t= links move the token into the fragment', [r.s, r.h.location]);
  ok((await ws(['anonchat', 'anonchat.' + tok])) === 'open:anonchat', 'WebSocket with the token as sub-protocol connects (plain "anonchat" is selected)');
  ok((await ws(['anonchat', 'anonchat.' + 'e'.repeat(64)])) === 'refused', 'WebSocket with a wrong token is refused');
  ok((await ws(['anonchat'])) === 'refused', 'WebSocket without a token is refused');
  ok((await ws(['anonchat', 'anonchat.' + tok], { origin: 'http://localhost:9999' })) === 'refused', 'WebSocket from another origin is refused');
  ok((await ws(['anonchat', 'anonchat.' + tok], { host: 'evil.example' })) === 'refused', 'WebSocket with a foreign Host is refused');
  const big = await new Promise((res) => { const w = new WebSocket(`ws://127.0.0.1:${UI}/ws`, ['anonchat', 'anonchat.' + tok], { headers: { host: `127.0.0.1:${UI}`, origin: `http://127.0.0.1:${UI}` } }); w.on('open', () => w.send(Buffer.alloc(100000))); w.on('close', (c) => res(c)); w.on('error', () => res('err')); setTimeout(() => res('timeout'), 4000); });
  ok(big === 1009, 'an oversized WebSocket message closes the connection (1009)', big);
  const authJs = fs.readFileSync(path.join(root, 'public/auth.js'), 'utf8'), html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  ok(/document\.cookie/.test(authJs) === false && !/document\.cookie/.test(fs.readFileSync(path.join(root, 'public/app.js'), 'utf8')), 'no page script touches cookies');
  ok(html.indexOf('auth.js') > html.indexOf('no-rtc.js') && html.indexOf('auth.js') < html.indexOf('type="module"'), 'index.html loads auth.js before the app');
} finally { srv.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500)); try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* Windows may still hold the folder for a moment; the temp folder is cleaned later */ } }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
