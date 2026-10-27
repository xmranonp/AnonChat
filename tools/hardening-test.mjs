// Fixes from the October 2026 audits: the address's port held by another program stops the app; a contact is never added twice (which
// would replace their saved keys); requests on the public port other than a message stay small; a recipient can't ask for an endless
// proof of work; the country download's unpacker can't be made to allocate without limit; names of saved files are safe on Windows; the
// app's own downloads go out on routes of their own. Run: node tools/hardening-test.mjs   (the backend part needs `npm install`)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(import.meta.url);
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else fail++; console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  [' + detail + ']')); };
const ME = 'a'.repeat(56) + '.anyone', FRIEND = 'f'.repeat(56) + '.anyone';
const TOKEN = 'c'.repeat(64);

function node(dir, pub, uiPort) {
  return spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env, PUBLIC_PORT: String(pub), UI_PORT: String(uiPort),
    DATA_DIR: dir + '/data', ANON_DIR: dir + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: '1', PEERS: '{}' } });
}
function freshDir(withContact) {
  const d = mkdtempSync(join(tmpdir(), 'hard-')); mkdirSync(d + '/anon/anon_service', { recursive: true }); mkdirSync(d + '/data');
  writeFileSync(d + '/anon/anon_service/hostname', ME + '\n');
  if (withContact) writeFileSync(join(d, 'data', 'contacts.json'), JSON.stringify([{ address: FRIEND, petname: 'Friend', ecdhPub: 'K1', ratchetPub: 'R1' }]));
  return d;
}

console.log('The address’s port');
{
  const squatter = net.createServer(() => {}).listen(6402, '127.0.0.1');
  await new Promise((r) => squatter.once('listening', r));
  const srv = node(freshDir(false), 6402, 6401);
  const code = await new Promise((r) => { const t = setTimeout(() => { srv.kill(); r('still running'); }, 20000); srv.once('exit', (c) => { clearTimeout(t); r(c); }); });
  ok('another program holding it stops the backend (exit 5), instead of running without it', code === 5, code);
  squatter.close();
}

console.log('Contacts and the public port');
const d = freshDir(true);
const srv = node(d, 6412, 6411);
const ui = (p, m = 'GET', body) => fetch('http://127.0.0.1:6411' + p, { method: m, headers: { 'X-AnonChat-Token': TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const pubPost = (path, data) => new Promise((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port: 6412, path, method: 'POST', headers: { Host: ME, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
    (resp) => { resp.resume(); resp.on('end', () => res(resp.statusCode)); });
  r.on('error', rej); r.end(data);
});
try {
  for (let i = 0; i < 200; i++) { try { await ui('/api/version'); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
  const again = await ui('/api/contacts', 'POST', { petname: 'Someone', address: FRIEND });
  ok('adding someone already in the contacts is refused, before any network fetch', again.status === 409 && again.body?.error === 'already_contact', JSON.stringify(again));
  const kept = await ui('/api/contacts');
  ok('…and their saved keys and name stay as they were', kept.body.length === 1 && kept.body[0].ecdhPub === 'K1' && kept.body[0].petname === 'Friend');
  ok('a small notice on the public port is read', (await pubPost('/api/profile-bump', JSON.stringify({ from: FRIEND }))) === 200);
  ok('a large body on the public port is refused unless it is a message', (await pubPost('/api/profile-bump', JSON.stringify({ from: FRIEND, pad: 'x'.repeat(20000) }))) === 413);
  ok('…a message may still be large', (await pubPost('/api/inbox', JSON.stringify({ pad: 'x'.repeat(20000) }))) === 400);   // read, then refused as malformed
  // Compressed request bodies are refused, never unpacked (body-parser <1.20.9: trailing bytes after a compressed body).
  const raw = (port, path, buf, headers) => new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length, ...headers } },
      (resp) => { resp.resume(); resp.on('end', () => res(resp.statusCode)); });
    r.on('error', rej); r.end(buf);
  });
  const json = JSON.stringify({ from: FRIEND });
  ok('a gzip body on the public port is refused (415)', (await raw(6412, '/api/profile-bump', zlib.gzipSync(json), { Host: ME, 'Content-Encoding': 'gzip' })) === 415);
  ok('…with bytes after it too', (await raw(6412, '/api/profile-bump', Buffer.concat([zlib.gzipSync(json), Buffer.from('trailing')]), { Host: ME, 'Content-Encoding': 'gzip' })) === 415);
  ok('…deflate and brotli too', (await raw(6412, '/api/profile-bump', zlib.deflateSync(json), { Host: ME, 'Content-Encoding': 'deflate' })) === 415
    && (await raw(6412, '/api/inbox', zlib.brotliCompressSync(json), { Host: ME, 'Content-Encoding': 'br' })) === 415);
  ok('a gzip body on the window’s port is refused as well', (await raw(6411, '/api/network/dynamic-port', zlib.gzipSync('{}'), { 'X-AnonChat-Token': TOKEN, 'Content-Encoding': 'gzip' })) === 415);
  ok('a plain body is still read after all that', (await pubPost('/api/profile-bump', json)) === 200);
} finally { srv.kill(); }

console.log('Who our contacts are (proof of work asked before any check that depends on the claimed address)');
{
  const BLOCKED = 'b'.repeat(56) + '.anyone', OTHER = 'o'.repeat(56) + '.anyone';
  const dd = freshDir(true);
  writeFileSync(join(dd, 'data', 'mailbox.json'), JSON.stringify({ [FRIEND]: Buffer.alloc(32, 7).toString('base64') }));
  writeFileSync(join(dd, 'data', 'blocked.json'), JSON.stringify([BLOCKED]));
  writeFileSync(join(dd, 'data', 'settings.json'), JSON.stringify({ powAlways: true }));
  const s3 = node(dd, 6432, 6431);
  const post3 = (data) => new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: 6432, path: '/api/inbox', method: 'POST', headers: { Host: ME, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (resp) => { resp.resume(); resp.on('end', () => res(resp.statusCode)); });
    r.on('error', rej); r.end(data);
  });
  try {
    for (let i = 0; i < 200; i++) { try { await fetch('http://127.0.0.1:6431/api/version', { headers: { 'X-AnonChat-Token': TOKEN } }); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    let k = 0;
    const probe = (from) => post3(JSON.stringify({ from, dh: 'd', ct: 'probe' + (k++), n: 0, x3dh: { ik: 'WRONG', ek: 'E' } }));
    const contact = await probe(FRIEND), blocked = await probe(BLOCKED), stranger = await probe(OTHER);
    ok('while proof of work is asked for, claiming a contact (with the wrong key) gets the same answer as a stranger', contact === 402 && stranger === 402, contact + ' / ' + stranger);
    ok('…and so does claiming a blocked address', blocked === 402, blocked);
  } finally { s3.kill(); }
}

console.log('Profile notices');
{
  // A SOCKS proxy that only counts connections: a notice that does something makes the backend fetch that contact's profile through it.
  let conns = 0;
  const socks = net.createServer((c) => { conns++; c.on('error', () => {}); c.destroy(); }).listen(6423, '127.0.0.1');
  await new Promise((r) => socks.once('listening', r));
  const d2 = freshDir(true);
  const s2 = spawn('node', [join(APP, 'server.js')], { cwd: APP, stdio: 'ignore', env: { ...process.env, PUBLIC_PORT: '6422', UI_PORT: '6421',
    DATA_DIR: d2 + '/data', ANON_DIR: d2 + '/anon', ANONCHAT_UI_TOKEN: TOKEN, ANON_CTRL_PORT: '1', PEERS: '{}', SOCKS: 'socks5h://127.0.0.1:6423',
    PRESENCE_FIRST_MS: '3600000', PRESENCE_INTERVAL_MS: '3600000', ANNOUNCE_MAX_WAIT_MS: '3600000' } });
  const post = (from) => new Promise((res, rej) => {
    const data = JSON.stringify({ from });
    const r = http.request({ host: '127.0.0.1', port: 6422, path: '/api/profile-bump', method: 'POST', headers: { Host: ME, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (resp) => { resp.resume(); resp.on('end', () => res(resp.statusCode)); });
    r.on('error', rej); r.end(data);
  });
  try {
    for (let i = 0; i < 200; i++) { try { await fetch('http://127.0.0.1:6421/api/version', { headers: { 'X-AnonChat-Token': TOKEN } }); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    const A32 = 'abcdefghijklmnopqrstuvwxyz234567';
    const stranger = (i) => Array.from({ length: 56 }, (_, k) => A32[(i * 7 + k * 13 + (i >> 3)) % 32]).join('') + '.anyone';
    for (let i = 0; i < 80; i++) await post(stranger(i));
    await new Promise((r) => setTimeout(r, 800));
    ok('notices claiming strangers’ addresses do nothing', conns === 0, conns);
    await post(FRIEND);
    await new Promise((r) => setTimeout(r, 1500));
    ok('…and don’t use up the allowance: a contact’s notice right after still works', conns >= 1, conns);
  } finally { s2.kill(); socks.close(); }
}

console.log('Country database download');
{
  // A local SOCKS5 proxy that asks for a user name (as the Anyone network accepts one) and sends every request to a local web server.
  let users = [];
  const web = http.createServer((req, res) => {
    if (req.url === '/redirect.xz') { res.writeHead(302, { Location: 'http://elsewhere.test/location.db.xz' }); return res.end(); }
    res.end(Buffer.from('not an xz file at all'));
  }).listen(6431, '127.0.0.1');
  const socks = net.createServer((c) => {
    c.on('error', () => {});
    c.once('data', (hello) => {
      const methods = [...hello.subarray(2, 2 + hello[1])];
      if (!methods.includes(2)) { c.end(Buffer.from([5, 0xff])); return; }
      c.write(Buffer.from([5, 2]));
      c.once('data', (auth) => {
        const ul = auth[1]; users.push(auth.subarray(2, 2 + ul).toString());
        c.write(Buffer.from([1, 0]));
        c.once('data', () => {
          const up = net.connect(6431, '127.0.0.1', () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); c.pipe(up); up.pipe(c); });
          up.on('error', () => c.destroy());
        });
      });
    });
  }).listen(6432, '127.0.0.1');
  await new Promise((r) => socks.once('listening', r));
  const geo = mkdtempSync(join(tmpdir(), 'geo-'));
  writeFileSync(geo + '/location.db', 'THE COPY IN USE');
  // Left behind by a download cut short (the app stopped between writing and moving it into place), and two files that aren't.
  writeFileSync(geo + '/location.db.4242.new', 'HALF A DOWNLOAD'); writeFileSync(geo + '/location.db.keep', 'x'); writeFileSync(geo + '/other.123.new', 'x');
  const run = (url) => new Promise((res) => {
    const code = `process.env.SOCKS='socks5h://127.0.0.1:6432'; process.env.GEO_DIR=${JSON.stringify(geo)}; process.env.LIBLOC_DB_URL=${JSON.stringify(url)};
      process.env.LOCATION_BINARY='/nonexistent/location';
      require(${JSON.stringify(join(APP, 'lib/relaygeo.js'))}).updateDatabase({ force: true }).then(() => console.log('UPDATED'), (e) => console.log('REFUSED ' + e.message));`;
    const p = spawn('node', ['-e', code], { cwd: APP }); let out = ''; p.stdout.on('data', (b) => out += b); p.on('exit', () => res(out.trim()));
  });
  const r1 = await run('http://dbhost.test/location.db.xz');
  ok('a download that isn’t a database is refused', r1.startsWith('REFUSED'), r1);
  ok('…and the copy in use stays', readFileSync(geo + '/location.db', 'utf8') === 'THE COPY IN USE');
  const left = readdirSync(geo).sort();
  ok('a half-finished download left from before is removed at start; nothing else is', !left.includes('location.db.4242.new') && left.includes('location.db.keep') && left.includes('other.123.new') && !left.some((f) => f.endsWith('.new') && f.startsWith('location.db.')), left);
  const r2 = await run('http://dbhost.test/redirect.xz');
  ok('a redirect is not followed', r2.startsWith('REFUSED'), r2);
  ok('…the copy in use still stays', readFileSync(geo + '/location.db', 'utf8') === 'THE COPY IN USE');
  ok('the download went out under its own SOCKS user name', users.length >= 2 && users.every((u) => u === 'anonchat-geo'), users);
  socks.close(); web.close();
}

console.log('Proof of work asked by a recipient');
{
  const pow = require(join(APP, 'lib/pow.js'));
  const t0 = Date.now();
  let refused = false; try { await pow.solveAsync({ challenge: 'c', from: ME, ct: 'x', bits: 200 }); } catch (e) { refused = /refused/.test(e.message); }
  ok('an impossible difficulty is refused at once', refused && Date.now() - t0 < 1000, Date.now() - t0);
  let refused2 = false; try { await pow.solveAsync({ challenge: 'c', from: ME, ct: 'x', bits: '20' }); } catch (e) { refused2 = true; }
  ok('a difficulty that isn’t a whole number is refused', refused2);
  const n = await pow.solveAsync({ challenge: 'c'.repeat(32), from: ME, ct: 'x', bits: 12 });
  ok('a normal difficulty is still solved, and the proof checks', typeof n === 'string' && n.length > 0);
}

console.log('Country database unpacker');
{
  const { decompressXz } = require(join(APP, 'lib/xz.js'));
  let haveXz = true; try { execFileSync('xz', ['--version'], { stdio: 'ignore' }); } catch { haveXz = false; }
  if (haveXz) {
    const dir = mkdtempSync(join(tmpdir(), 'xzh-'));
    writeFileSync(dir + '/a.bin', Buffer.alloc(3 * 1024 * 1024, 7));
    execFileSync('xz', ['-k', '-6', '--check=crc32', dir + '/a.bin']);
    const packed = readFileSync(dir + '/a.bin.xz');
    ok('a normal file unpacks as before', decompressXz(packed).length === 3 * 1024 * 1024);
    let capped = false; try { decompressXz(packed, { maxBytes: 1024 * 1024 }); } catch (e) { capped = /larger than allowed/.test(e.message); }
    ok('unpacking stops at the size limit', capped);
    // The block header names a 4 GB dictionary (property byte 40): it must not be allocated.
    const hostile = Buffer.from(packed); const at = hostile.indexOf(Buffer.from([0x21, 0x01]), 12);
    hostile[at + 2] = 40;
    let outcome = 'ok'; try { decompressXz(hostile, { maxBytes: 256 * 1024 * 1024 }); } catch (e) { outcome = e instanceof RangeError ? 'allocation failed' : 'refused'; }
    ok('a file claiming a 4 GB dictionary doesn’t make it allocate one', outcome !== 'allocation failed', outcome);
  } else console.log('  (xz not installed: unpacker checks skipped)');
}

console.log('Names of saved files');
{
  const { safeFileName } = require(join(APP, 'desktop/filename.js'));
  const cases = [
    ['invoice.exe::$DATA', 'invoice.exe__$DATA'], ['..\\..\\evil.exe', 'evil.exe'], ['a/b/c.txt', 'c.txt'],
    ['photo\u202Egpj.exe', 'photo_gpj.exe'], ['x.exe. . ', 'x.exe'], ['CON.txt', '_CON.txt'], ['nul', '_nul'],
    ['report (2).pdf', 'report (2).pdf'], ['', 'download'], ['...', 'download'], ['a"b<c>d|e?f*.txt', 'a_b_c_d_e_f_.txt'],
  ];
  for (const [i, want] of cases) ok(`${JSON.stringify(i)} → ${JSON.stringify(want)}`, safeFileName(i) === want, safeFileName(i));
  ok('a very long name keeps its ending', (() => { const n = safeFileName('a'.repeat(400) + '.pdf'); return n.length === 200 && n.endsWith('.pdf'); })());
}

console.log('The app’s own downloads');
{
  const { isolatedSocks, normalizeSocks } = require(join(APP, 'lib/netlock.js'));
  const g = new URL(isolatedSocks('socks5h://127.0.0.1:9050', 'geo')), u = new URL(isolatedSocks('socks5h://127.0.0.1:9050', 'update'));
  ok('they carry a name of their own, so the network gives them their own routes', g.username === 'anonchat-geo' && u.username === 'anonchat-update' && g.password && g.password === u.password);
  ok('…through the same local proxy only', g.hostname === '127.0.0.1' && g.port === '9050' && g.protocol === 'socks5h:');
  let refused = false; try { isolatedSocks('socks5h://10.0.0.1:9050', 'geo'); } catch { refused = true; }
  ok('…never a proxy elsewhere', refused && normalizeSocks('socks5h://127.0.0.1:9050') === 'socks5h://127.0.0.1:9050');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
