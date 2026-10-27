// The backend's client for other nodes (server.js onion()): answers are never unpacked. Runs the shipped onion() against a local
// server that answers compressed, and checks that the request asks for a plain answer and that a compressed answer is not decoded
// (so a peer can't feed its bytes to a decompressor). Also: no redirects followed, the size limit applies. Needs `npm install`.
// Run: node tools/peer-client-test.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import zlib from 'node:zlib';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(join(root, 'server.js'));
const axios = require('axios');
const src = readFileSync(join(root, 'server.js'), 'utf8');
const i0 = src.indexOf('const PEER_DEADLINE_MS'), i = src.indexOf('function onion()');
const fnSrc = src.slice(i0, src.indexOf('\n}\n', i) + 2);           // the deadline wrapper and onion() itself
const MAX_ENVELOPE = Number(eval(/^const MAX_ENVELOPE\s*=\s*([^;]+);/m.exec(src)[1]));
// The SOCKS agent is replaced by a plain one, so the request goes straight to the local test server; everything else is the shipped config.
const onion = new Function('axios', 'SocksProxyAgent', 'SOCKS', 'MAX_ENVELOPE', fnSrc + '\nreturn onion;')(
  axios, function PlainAgent() { return new http.Agent(); }, '', MAX_ENVELOPE);

let passed = 0, failed = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n + (d ? '  [' + d + ']' : '')); } };

const seen = [];
const body = JSON.stringify({ ecdhPub: 'x', ok: true });
const srv = http.createServer((req, res) => {
  seen.push(req.headers['accept-encoding']);
  if (req.url === '/gzip') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }); return res.end(zlib.gzipSync(body)); }
  if (req.url === '/deflate') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate' }); return res.end(zlib.deflateSync(body)); }
  if (req.url === '/plain') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(body); }
  if (req.url === '/redirect') { res.writeHead(302, { Location: '/plain' }); return res.end(); }
  if (req.url === '/drip') { res.writeHead(200, { 'Content-Type': 'application/json' }); const t = setInterval(() => res.write(' '), 300); req.on('close', () => clearInterval(t)); return; }
  if (req.url === '/huge') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(Buffer.alloc(MAX_ENVELOPE + 1024, 0x20)); }
  res.writeHead(404); res.end();
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

console.log('1. Answers from other nodes are taken as sent, never unpacked');
const plain = await onion().get(base + '/plain');
ok('a plain answer is read as JSON', plain.data && plain.data.ok === true);
ok('the request asks for a plain answer (Accept-Encoding: identity)', seen[0] === 'identity', String(seen[0]));
const gz = await onion().get(base + '/gzip');
ok('a gzip answer is not decoded', !(gz.data && gz.data.ok === true));
const df = await onion().get(base + '/deflate');
ok('a deflate answer is not decoded', !(df.data && df.data.ok === true));
ok('every request asked for a plain answer', seen.every((e) => e === 'identity'), JSON.stringify(seen));

console.log('2. Other limits still hold');
let redirected = null; try { await onion().get(base + '/redirect'); redirected = true; } catch (e) { redirected = e.response ? e.response.status : 'error'; }
ok('a redirect is not followed', redirected === 302, String(redirected));
let huge = null; try { await onion().get(base + '/huge'); huge = 'read'; } catch (e) { huge = 'refused'; }
ok('an answer over the size limit is refused', huge === 'refused');

console.log('3. Every request has a hard deadline, from start to the last byte');
const t0 = Date.now(); let drip = null;
try { await onion().get(base + '/drip', { timeout: 1500 }); drip = 'read'; } catch (e) { drip = e.code + ' ' + e.message; }
const took = Date.now() - t0;
ok('an answer trickling in a byte at a time is cut off at the deadline', took < 3000 && /^ECONNABORTED timeout of 1500ms/.test(drip), took + ' ms, ' + drip);
ok('…and fails as a timeout does (same error code and wording)', /timeout/.test(drip));

srv.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
