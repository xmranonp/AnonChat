// Fake loopback SOCKS5 (socks5h) for the browser suites: maps test .anyone names to local public ports (PEERS json, argv[2]); listens on argv[3].
import net from 'node:net'; import fs from 'node:fs';
const PORTS = JSON.parse(process.argv[2]); const LISTEN = +process.argv[3];
const DELAY = +(process.env.FSOCKS_DELAY_MS || 0);   // each connection takes this long to open (setting up a route on the real network)
const JITTER = +(process.env.FSOCKS_JITTER_MS || 0); // plus up to this much more, different each time (so a later message can arrive first)
net.createServer((c) => { c.on('error', () => {}); c.once('data', () => { c.write(Buffer.from([5, 0])); c.once('data', (req) => {
  if (req[3] !== 3) { c.write(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return c.end(); }
  const n = req[4], host = req.slice(5, 5 + n).toString(), port = req.readUInt16BE(5 + n);
  // FSOCKS_HIDE_FILE: a JSON list of addresses the network can't find right now (answered like the real one: reply 0xF0, "descriptor not found").
  let hidden = []; try { if (process.env.FSOCKS_HIDE_FILE) hidden = JSON.parse(fs.readFileSync(process.env.FSOCKS_HIDE_FILE, 'utf8')); } catch {}
  if (hidden.includes(host)) { c.write(Buffer.from([5, 0xF0, 0, 1, 0, 0, 0, 0, 0, 0])); return c.end(); }
  const dst = PORTS[host]; if (!dst || port !== 80) { c.write(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); return c.end(); }
  setTimeout(() => {
  const up = net.connect(dst, '127.0.0.1', () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); c.pipe(up); up.pipe(c); });
  up.on('error', () => { try { c.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); } catch {} }); c.on('close', () => up.destroy()); }, DELAY + Math.random() * JITTER); }); }); }).listen(LISTEN, '127.0.0.1', () => console.log('socks up'));
