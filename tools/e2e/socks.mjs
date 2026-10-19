// Fake loopback SOCKS5 for tools/e2e: maps the two test .anyone names to the stub nodes and can add delay, jitter, stalls or cut circuits
// (commands on stdin: impair <base_ms> <jitter_ms> | stall <ms> | kill | log).
import net from 'node:net'; import { createRequire } from 'node:module';
const PORTS = { ['a'.repeat(56) + '.anyone']: 5102, ['b'.repeat(56) + '.anyone']: 5202 };
const impair = { base: 0, jitter: 0, stallUntil: 0 }; const live = new Set(); const log = [];
function dpipe(src, dst) { let last = 0; src.on('data', (d) => { const now = Date.now(); let at = now + impair.base + Math.random() * impair.jitter; if (impair.stallUntil > now) at = Math.max(at, impair.stallUntil); at = Math.max(at, last); last = at; setTimeout(() => { if (!dst.destroyed) dst.write(d); }, Math.max(0, at - now)); }); src.on('end', () => setTimeout(() => dst.end(), 50)); }
net.createServer((c) => { c.once('data', () => { c.write(Buffer.from([5, 0])); c.once('data', (req) => {
  const n = req[4], host = req.slice(5, 5 + n).toString(), port = req.readUInt16BE(5 + n); log.push({ atyp: req[3], host, port });
  const dst = PORTS[host]; if (req[3] !== 3 || !dst || port !== 80) { c.write(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return c.end(); }
  const up = net.connect(dst, '127.0.0.1', () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); live.add(c); live.add(up); dpipe(c, up); dpipe(up, c); });
  up.on('error', () => c.destroy()); c.on('error', () => up.destroy()); }); }); c.on('error', () => {}); }).listen(5300, '127.0.0.1', () => console.log('socks up'));
process.stdin.on('data', (d) => { for (const l of d.toString().split('\n')) { const [c, x, y] = l.trim().split(' '); if (c === 'impair') { impair.base = +x; impair.jitter = +y; } else if (c === 'stall') impair.stallUntil = Date.now() + +x; else if (c === 'kill') [...live].forEach((s) => s.destroy()); else if (c === 'log') console.log('LOG ' + JSON.stringify(log)); } });
