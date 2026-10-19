'use strict';

// Keeps the backend's outbound traffic inside the Anyone network: the SOCKS proxy must be loopback with remote DNS (socks5h).

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function normalizeSocks(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error(`invalid SOCKS proxy URL: ${raw}`); }
  const scheme = u.protocol.replace(/:$/, '');
  if (scheme !== 'socks5' && scheme !== 'socks5h') {
    throw new Error(`SOCKS proxy must be socks5/socks5h, got "${scheme}"`);
  }
  if (!LOOPBACK.has(u.hostname)) {
    throw new Error(`SOCKS proxy must be on loopback, got "${u.hostname}"`);
  }
  const port = u.port || '9050';
  return `socks5h://${u.hostname}:${port}`;
}

// The app's own requests that leave the Anyone network (the country database, the update check) go out with a SOCKS user name of their
// own. The network keeps requests with different names on different routes (IsolateSOCKSAuth, on by default), so they never share an exit
// relay's route with a browser someone points at the same proxy: that relay can't see both and link the browsing to an AnonChat user.
// The password changes at every start, so each run gets fresh routes too.
const RUN_TAG = require('crypto').randomBytes(8).toString('hex');
function isolatedSocks(raw, purpose) {
  const base = new URL(normalizeSocks(raw));
  const name = 'anonchat-' + String(purpose || 'app').replace(/[^a-z0-9-]/gi, '').slice(0, 24);
  return `socks5h://${name}:${RUN_TAG}@${base.hostname}:${base.port}`;
}

module.exports = { normalizeSocks, isolatedSocks };
