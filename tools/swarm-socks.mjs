// A SOCKS5 server for the swarm tests: a .anyone name is connected to whatever the test maps it to (a local socket or port), or refused,
// or left hanging. User/password authentication is accepted and every connection's user name is recorded (route isolation).
import net from 'node:net';

export function startSocks(map) {
  const seen = [];          // {user, pass, host}
  const conns = new Set();
  const server = net.createServer((c) => {
    conns.add(c); c.on('close', () => conns.delete(c)); c.on('error', () => {});
    let stage = 'greet', buf = Buffer.alloc(0), user = null, pass = null;
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (stage === 'greet') {
          if (buf.length < 2 || buf.length < 2 + buf[1]) return;
          const methods = [...buf.subarray(2, 2 + buf[1])]; buf = buf.subarray(2 + buf[1]);
          if (methods.includes(2)) { c.write(Buffer.from([5, 2])); stage = 'auth'; } else { c.write(Buffer.from([5, 0])); stage = 'req'; }
        } else if (stage === 'auth') {
          if (buf.length < 2) return; const ul = buf[1]; if (buf.length < 3 + ul) return; const pl = buf[2 + ul]; if (buf.length < 3 + ul + pl) return;
          user = buf.subarray(2, 2 + ul).toString(); pass = buf.subarray(3 + ul, 3 + ul + pl).toString(); buf = buf.subarray(3 + ul + pl); c.write(Buffer.from([1, 0])); stage = 'req';
        } else if (stage === 'req') {
          if (buf.length < 5 || buf[3] !== 3 || buf.length < 7 + buf[4]) return;
          const host = buf.subarray(5, 5 + buf[4]).toString(); buf = buf.subarray(7 + buf[4]);
          c.removeListener('data', onData); stage = 'done';
          seen.push({ user, pass, host });
          const to = typeof map === 'function' ? map(host, user) : map[host];
          if (!to || to === 'refuse') { c.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
          if (to === 'hang') return;
          const up = net.connect(to);
          up.on('connect', () => { c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); if (buf.length) up.write(buf); c.pipe(up); up.pipe(c); });
          up.on('error', () => c.destroy()); c.on('close', () => up.destroy()); up.on('close', () => c.destroy());
          return;
        } else return;
      }
    };
    c.on('data', onData);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ port: server.address().port, seen, url: `socks5h://127.0.0.1:${server.address().port}`,
    close: () => { for (const c of conns) c.destroy(); server.close(); }, dropAll: () => { for (const c of conns) c.destroy(); } })));
}
