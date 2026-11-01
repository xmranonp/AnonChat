// F-7: how the desktop app checks that the server on the UI port is the backend it started, before the launch token goes anywhere.
// Kept apart from main.js so tools/backend-check-test.mjs can run it against a real backend and against a program that took the port.
//
// Each check opens ONE connection, asks /api/hello with a fresh challenge (answered with an HMAC keyed by the token, which only the backend
// we started knows) and only then, on that same connection, sends a request carrying the token. A program that holds the port at any
// moment (the backend stopped, say) never receives the token: it can't answer the challenge, and the token is never sent on a connection
// that hasn't answered it.
'use strict';
const net = require('net');
const crypto = require('crypto');

// One HTTP/1.1 response from the start of buf: null while incomplete, { bad } if it isn't one we accept (our backend always sends a
// Content-Length: res.json), else { status, body, used }.
function parseHttp(buf) {
  const end = buf.indexOf('\r\n\r\n'); if (end < 0) return null;
  const head = buf.subarray(0, end).toString('latin1');
  const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(head) || [])[1] || 0);
  const len = /\r\ncontent-length:\s*(\d+)/i.exec(head);
  if (!status || !len) return { bad: true };
  const total = end + 4 + Number(len[1]);
  if (buf.length < total) return null;
  return { status, body: buf.subarray(end + 4, total).toString('utf8'), used: total };
}

function makeChecker({ port, token, header, address = '127.0.0.1', timeoutMs = 3000 }) {
  const hostHeader = '127.0.0.1:' + port;
  return function checkBackend(cb) {                                   // cb({ proven, ready, foreign })
    const nonce = crypto.randomBytes(16).toString('hex');
    const want = crypto.createHmac('sha256', token).update('anonchat-hello|' + nonce).digest('hex');
    const sock = net.connect({ host: address, port });
    let buf = Buffer.alloc(0), proven = false, done = false;
    const finish = (r) => { if (done) return; done = true; try { sock.destroy(); } catch {} cb(r); };
    sock.setTimeout(timeoutMs, () => finish({ proven: false }));
    sock.on('error', () => finish({ proven: false }));
    sock.on('close', () => finish({ proven: false }));
    sock.on('connect', () => sock.write(`GET /api/hello?n=${nonce} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: keep-alive\r\n\r\n`));
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length > 65536) return finish({ proven: false });
      const r = parseHttp(buf); if (!r) return;
      if (r.bad) return finish({ proven: false });
      buf = buf.subarray(r.used);
      if (!proven) {
        let mac = null; try { mac = JSON.parse(r.body).mac; } catch {}
        const good = typeof mac === 'string' && mac.length === want.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want));
        if (!good) return finish({ proven: false, foreign: r.status === 200 });
        proven = true;
        sock.write(`GET /api/whoami HTTP/1.1\r\nHost: ${hostHeader}\r\n${header}: ${token}\r\nConnection: close\r\n\r\n`);
        return;
      }
      finish({ proven: true, ready: r.status === 200 && r.body.includes('"address"') && r.body.includes('.anyone') });
    });
  };
}

module.exports = { makeChecker, parseHttp };
