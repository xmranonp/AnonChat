// Static clearnet-leak checks for voice calls. Voice must never use WebRTC / UDP / a direct socket: the page only talks to the local
// backend, and the backend reaches the other node only through the loopback SOCKS proxy (socks5h). Exits non-zero on any finding.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));   // fileURLToPath: correct drive-letter paths on Windows
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');   // comments may mention what is forbidden
const problems = [];
const bad = (m) => problems.push(m);

const pub = fs.readdirSync(path.join(root, 'public')).filter((f) => /\.(js|html)$/.test(f) && f !== 'emoji-data.js' && f !== 'i18n.js');
for (const f of pub) {
  const code = f.endsWith('.js') ? strip(read('public/' + f)) : read('public/' + f);
  if (f !== 'no-rtc.js' && /RTCPeerConnection|RTCDataChannel|createOffer|createAnswer|iceServers|\bstun:|\bturn:|getDisplayMedia|RTCIceCandidate/.test(code)) bad(`public/${f}: WebRTC / ICE / STUN / TURN reference`);
  if (/sendBeacon|new\s+EventSource|importScripts\s*\(\s*['"]https?:/.test(code)) bad(`public/${f}: beacon / EventSource / remote script`);
  for (const m of code.matchAll(/new\s+WebSocket\(([^)]*)\)/g)) {
    if (!/location\.host|wsUrl\(\)|\$\{proto\}:\/\/\$\{location\.host\}/.test(m[0])) bad(`public/${f}: WebSocket to something other than the local backend: ${m[0].slice(0, 80)}`);
  }
  if (f.endsWith('.html')) for (const m of code.matchAll(/<(?:script|img|link|iframe|audio|video|source)\b[^>]*\b(?:src|href)=["']https?:\/\/[^"']+/gi)) bad(`public/${f}: remote resource ${m[0].slice(0, 90)}`);
}
// the WebRTC API is removed before anything else runs
const html = read('public/index.html');
const scripts = [...html.matchAll(/<script\b[^>]*src=["']([^"']+)["']/g)].map((m) => m[1]);
if (scripts[0] !== 'no-rtc.js') bad('index.html: no-rtc.js must be the first script (found ' + scripts[0] + ')');

// backend: the call bridge may only leave through the SOCKS agent
const cb = strip(read('lib/callbridge.js'));
if (/require\(['"](?:dgram|https?|tls|dns|child_process)['"]\)/.test(cb)) bad('lib/callbridge.js: requires a module that could open a direct connection');
if (/\bnet\.(?:connect|createConnection|Socket)\b|\bhttp\.request\b/.test(cb)) bad('lib/callbridge.js: opens a socket by itself');
const socketCalls = [...cb.matchAll(/new\s+WebSocket\(([\s\S]*?)\);/g)];
if (socketCalls.length !== 1) bad('lib/callbridge.js: expected exactly one outbound WebSocket, found ' + socketCalls.length);
for (const m of socketCalls) if (!/agent/.test(m[1])) bad('lib/callbridge.js: an outbound WebSocket without the SOCKS agent');
if (!/normalizeSocks/.test(cb)) bad('lib/callbridge.js: the proxy is not validated with netlock.normalizeSocks');
if (!/ADDR_RE\.test\(m\.peer\)/.test(cb)) bad('lib/callbridge.js: the peer address is not validated');

// backend: CSP and desktop shell
const server = read('server.js');
const csp = (server.match(/connect-src[^\n]*/) || [''])[0];
if (!csp || /\bws:\s|wss:\s|\*/.test(csp.replace(/ws:\/\/[^\s`'"]+/g, ''))) bad('server.js: connect-src allows more than the local backend: ' + csp.slice(0, 100));
const main = read('desktop/main.js');
if (!/disable_non_proxied_udp/.test(main) || !/setWebRTCIPHandlingPolicy/.test(main)) bad('desktop/main.js: WebRTC IP handling policy is not forced to disable_non_proxied_udp');
if (!/onBeforeRequest/.test(main) || !/isLocalUrl/.test(main)) bad('desktop/main.js: the renderer request filter is missing');
if (!/host-resolver-rules/.test(main)) bad('desktop/main.js: the renderer DNS block is missing');

if (problems.length) { for (const p of problems) console.log('FAIL ' + p); console.log(`${problems.length} problem(s)`); process.exit(1); }
console.log('clean: ' + pub.length + ' page files, call bridge, CSP and desktop shell checked');
