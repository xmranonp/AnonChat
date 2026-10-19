// A hostile "contact": serves whatever identity/profile is configured in argv[3] (json) on port argv[2].
import http from 'node:http';
import { webcrypto } from 'node:crypto';
const port = +process.argv[2]; const mode = process.argv[3];
const big = 'data:image/png;base64,' + 'A'.repeat(7 * 1024 * 1024);
// Real keys (keys that aren't points on the curve are refused before anything else is looked at); the rest is hostile.
const key = async () => Buffer.from(await webcrypto.subtle.exportKey('raw', (await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])).publicKey)).toString('base64');
const profiles = {
  bigavatar: { ecdhPub: await key(), ratchetPub: await key(), avatar: big, bio: 'B'.repeat(300000) },
  objavatar: { ecdhPub: await key(), ratchetPub: await key(), avatar: { toString: 1 }, bio: { x: 1 } },
  objkeys:   { ecdhPub: { a: 1 }, ratchetPub: ['x'], avatar: { toString: 1 }, bio: { x: 1 } },
};
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/identity' || req.url === '/api/profile') return res.end(JSON.stringify(profiles[mode]));
    res.end('{"ok":true}');
  });
}).listen(port, '127.0.0.1');
