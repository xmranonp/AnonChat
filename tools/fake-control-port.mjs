// Fake anon control port for UI tests. Control: HTTP on CONTROL_HTTP_PORT: POST /state {circuits, streams, published}, POST /emit {line},
// POST /delays {list:[ms,...]} (next circuit-status answers), POST /fail {n} (next n circuit-status queries fail), GET /log,
// POST /bootstrap {pct, silent} (the progress reported; silent: bootstrap queries get no answer).
import net from 'node:net'; import http from 'node:http'; import fs from 'node:fs';
const [ctlPort, httpPort, dir] = process.argv.slice(2).map((x, i) => i < 2 ? Number(x) : x);
fs.writeFileSync(dir + '/control_auth_cookie', Buffer.alloc(32, 7));
let circuits = [], streams = [], published = false, delays = [], fails = 0, bootPct = 100, bootSilent = false; const watchers = new Set(); const log = [];
const block = (name, lines) => lines.length ? `250+${name}=\r\n` + lines.join('\r\n') + '\r\n.\r\n250 OK\r\n' : `250-${name}=\r\n250 OK\r\n`;
net.createServer((sock) => {
  let buf = '';
  sock.on('data', async (d) => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const cmd = buf.slice(0, i).trim(); buf = buf.slice(i + 1); log.push(cmd.slice(0, 60));
      if (cmd.startsWith('AUTHENTICATE')) sock.write('250 OK\r\n');
      else if (cmd.startsWith('SETEVENTS')) { if (/STREAM/.test(cmd)) watchers.add(sock); sock.write('250 OK\r\n'); }
      else if (cmd === 'GETINFO circuit-status') {
        if (fails > 0) { fails--; sock.destroy(); return; }
        const snap = circuits.slice(); const wait = delays.length ? delays.shift() : 0;
        if (wait) await new Promise((r) => setTimeout(r, wait));
        sock.write(block('circuit-status', snap));
      }
      else if (cmd.startsWith('GETINFO hs/service/desc/id/')) sock.write(published ? block(cmd.slice(8), ['hs-descriptor 3', 'superencrypted', '-----BEGIN MESSAGE-----', 'AAAA', '-----END MESSAGE-----']) : '552 Unrecognized key\r\n');
      else if (cmd === 'GETINFO stream-status') sock.write(block('stream-status', streams));
      else if (cmd.startsWith('GETINFO ns/id/')) { const fp = cmd.slice(14); sock.write(`250+ns/id/${fp}=\r\nr relay${fp.slice(0, 4)} AAAA BBBB 2026-01-01 00:00:00 10.0.0.${fp.charCodeAt(0) % 200} 9001 0\r\ns Fast Running Stable\r\nw Bandwidth=2048\r\n.\r\n250 OK\r\n`); }
      else if (cmd.startsWith('GETINFO traffic/read')) sock.write('250-traffic/read=1000\r\n250 OK\r\n');
      else if (cmd.startsWith('GETINFO traffic/written')) sock.write('250-traffic/written=500\r\n250 OK\r\n');
      else if (cmd.startsWith('GETINFO status/bootstrap-phase')) { if (bootSilent) return; sock.write(`250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=${bootPct} TAG=x SUMMARY="x"\r\n250 OK\r\n`); }
      else if (cmd.startsWith('CLOSECIRCUIT')) { const id = cmd.split(/\s+/)[1]; circuits = circuits.filter((l) => !l.startsWith(id + ' ')); sock.write('250 OK\r\n'); }
      else if (cmd.startsWith('EXTENDCIRCUIT')) { const id = 100 + circuits.length; circuits.push(`${id} BUILT $${'D'.repeat(40)}~gd,$${'E'.repeat(40)}~me,$${'F'.repeat(40)}~ex BUILD_FLAGS=NEED_CAPACITY PURPOSE=GENERAL TIME_CREATED=2026-01-01T00:00:00`); sock.write(`250 EXTENDED ${id}\r\n`); }
      else if (cmd === 'QUIT') sock.end('250 closing connection\r\n');
      else if (cmd) sock.write('250 OK\r\n');
    }
  });
  sock.on('close', () => watchers.delete(sock)); sock.on('error', () => {});
}).listen(ctlPort, '127.0.0.1');
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    const j = b ? JSON.parse(b) : {};
    if (req.url === '/state') { if (j.circuits) circuits = j.circuits; if (j.streams) streams = j.streams; if ('published' in j) published = !!j.published; }
    if (req.url === '/emit') for (const w of watchers) w.write(j.line + '\r\n');
    if (req.url === '/delays') delays = j.list || [];
    if (req.url === '/fail') fails = j.n || 0;
    if (req.url === '/bootstrap') { if ('pct' in j) bootPct = j.pct; if ('silent' in j) bootSilent = !!j.silent; }
    res.end(JSON.stringify(req.url === '/log' ? log.slice(-200) : { ok: true }));
  });
}).listen(httpPort, '127.0.0.1');
