// F-7: the desktop app sends its launch token only on a connection whose other end proved it is our backend (desktop/backend-check.js),
// stops waiting once its backend has exited, and lets the window send nothing to the port after that (desktop/main.js).
// Against a real server.js and against programs that took the port. Run: node tools/backend-check-test.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import net from 'node:net';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const { makeChecker, parseHttp } = createRequire(import.meta.url)(join(APP, 'desktop/backend-check.js'));
const TOKEN = 'f'.repeat(64), HEADER = 'X-AnonChat-Token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (m, c, x = '') => { c ? pass++ : fail++; console.log((c ? '  ✓ ' : '  ✗ ') + m + (c ? '' : '  [' + x + ']')); };
const check = (port) => new Promise((res) => makeChecker({ port, token: TOKEN, header: HEADER })(res));

// A program holding the port: records every byte it receives, answers with the given function.
function impostor(port, answer) {
  const seen = [];
  const srv = net.createServer((s) => { s.on('data', (d) => { seen.push(d.toString('latin1')); const a = answer(d.toString('latin1')); if (a != null) s.write(a); }); s.on('error', () => {}); });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({ seen, close: () => new Promise((c) => srv.close(c)) })));
}
const http200 = (body) => `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`;

try {
  ok('parseHttp: incomplete, without a length, and complete', parseHttp(Buffer.from('HTTP/1.1 200 OK\r\n')) === null
    && parseHttp(Buffer.from('HTTP/1.1 200 OK\r\n\r\nabc')).bad === true && parseHttp(Buffer.from(http200('{"a":1}'))).body === '{"a":1}');

  // 1. The real backend.
  const d = mkdtempSync(join(tmpdir(), 'bc-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
  writeFileSync(d + '/anon/anon_service/hostname', 'b'.repeat(56) + '.anyone\n');
  const srv = spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env,
    PUBLIC_PORT: '6242', UI_PORT: '6241', DATA_DIR: d + '/data', ANON_DIR: d + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: '1', PEERS: '{}' } });
  let r = { proven: false };
  for (let i = 0; i < 60 && !r.ready; i++) { r = await check(6241); if (!r.ready) await sleep(250); }
  ok('our backend proves itself and is ready (token used on the proven connection)', r.proven && r.ready, JSON.stringify(r));
  srv.kill(); await sleep(400);

  // 2. Another program took the port: answers the challenge with a made-up value.
  let imp = await impostor(6241, (req) => (req.startsWith('GET /api/hello') ? http200(JSON.stringify({ mac: 'a'.repeat(64) })) : http200('{"address":"x.anyone"}')));
  r = await check(6241);
  ok('a program answering 200 with a wrong proof is not trusted', !r.proven && !r.ready && r.foreign, JSON.stringify(r));
  ok('…and never receives the token', !imp.seen.join('').includes(TOKEN) && !/x-anonchat-token/i.test(imp.seen.join('')), imp.seen.join(' || ').slice(0, 300));
  await imp.close();

  // 3. It answers nothing useful, or without a length, or replays an earlier answer.
  const earlier = http200(JSON.stringify({ mac: 'b'.repeat(64) }));
  for (const [name, answer] of [['no answer', () => null], ['no Content-Length', () => 'HTTP/1.1 200 OK\r\n\r\n{"mac":"x"}'], ['a replayed proof', () => earlier], ['garbage', () => 'nonsense\r\n\r\n']]) {
    imp = await impostor(6241, answer);
    const t0 = Date.now(); r = await check(6241);
    ok(`${name}: not trusted, token never sent`, !r.proven && !imp.seen.join('').includes(TOKEN) && Date.now() - t0 < 5000, JSON.stringify(r));
    await imp.close();
  }

  // 4. Nobody on the port.
  r = await check(6241);
  ok('nothing listening: not trusted', !r.proven && !r.ready);

  // 5. desktop/main.js uses it, stops when the backend is gone, and blocks the window's requests afterwards.
  const main = readFileSync(join(APP, 'desktop/main.js'), 'utf8');
  ok('main.js: the start screen checks through backend-check.js only', /require\('\.\/backend-check'\)\.makeChecker/.test(main) && !/path: '\/api\/whoami'/.test(main) && !/http\.get\(/.test(main.slice(main.indexOf('function waitForReady'), main.indexOf('let splashWin'))));
  ok('main.js: waiting stops once the backend has exited, and the proof is repeated right before the window opens',
    /if \(!backendChild\) return;/.test(main) && /checkBackend\(\(again\) => \(again\.ready && backendChild \? onReady\(\)/.test(main));
  ok('main.js: after the backend exits, the window sends nothing (and no token) to the port',
    /backendGone = true;/.test(main) && /if \(backendGone && isUiServerUrl\(details\.url\)\) return cb\(\{ cancel: true \}\);/.test(main) && /\|\| backendGone\) return cb\(\{ requestHeaders: details\.requestHeaders \}\)/.test(main));
  const pkg = JSON.parse(readFileSync(join(APP, 'desktop/package.json'), 'utf8'));
  ok('package.json: backend-check.js is packaged', pkg.build.files.includes('backend-check.js'));
} catch (e) { fail++; console.log('  ✗ threw', e && e.message); }
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
