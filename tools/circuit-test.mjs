// Checks which circuit is reported for a contact against a fake anon control port: only a circuit that is still open, built and a
// hidden-service client circuit may be shown, and a newer circuit replaces an older one.
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-ctl-'));
fs.writeFileSync(path.join(dir, 'control_auth_cookie'), Buffer.alloc(32, 7));
const watchers = new Set();
let circuitLines = [], streamLines = [];

const server = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const cmd = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (cmd.startsWith('AUTHENTICATE')) sock.write('250 OK\r\n');
      else if (cmd === 'SETEVENTS STREAM') { watchers.add(sock); sock.write('250 OK\r\n'); }
      else if (cmd === 'GETINFO circuit-status') sock.write('250+circuit-status=\r\n' + circuitLines.join('\r\n') + (circuitLines.length ? '\r\n' : '') + '.\r\n250 OK\r\n');
      else if (cmd === 'GETINFO stream-status') sock.write('250+stream-status=\r\n' + streamLines.join('\r\n') + (streamLines.length ? '\r\n' : '') + '.\r\n250 OK\r\n');
      else if (cmd.startsWith('GETINFO ns/id/')) { const fp = cmd.slice(14); sock.write(`250+ns/id/${fp}=\r\nr relay${fp.slice(0, 2)} AAAA BBBB 2026-01-01 00:00:00 10.0.0.1 9001 0\r\ns Fast Running\r\nw Bandwidth=100\r\n.\r\n250 OK\r\n`); }
      else if (cmd === 'QUIT') { sock.end('250 closing connection\r\n'); }
    }
  });
  sock.on('close', () => watchers.delete(sock));
  sock.on('error', () => {});
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.ANON_CTRL_PORT = String(server.address().port);
process.env.ANON_DIR = dir;

const circuits = createRequire(import.meta.url)('../lib/circuits.js');
circuits.startStreamWatcher();

let passed = 0, failed = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? passed++ : (failed++, console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fp = (c) => c.repeat(40);
const A = 'a'.repeat(56) + '.anyone', B = 'b'.repeat(56) + '.anyone';
const circ = (id, purpose, state = 'BUILT') => `${id} ${state} $${fp('A')}~g,$${fp('B')}~m,$${fp('C')}~r BUILD_FLAGS=NEED_CAPACITY PURPOSE=${purpose} HS_STATE=HSCR_JOINED TIME_CREATED=2026-01-01T00:00:00`;
const stream = (sid, state, cid, target) => `650 STREAM ${sid} ${state} ${cid} ${target}\r\n`;
const emit = async (line) => { for (const w of watchers) w.write(line); await sleep(80); };
const lookup = async (addr) => circuits.resolveContactCircuit(circuits.getActiveCircuitForAddress(addr), await circuits.getCircuitsDetailed());

await sleep(400);                                                  // watcher connected
eq('no stream seen yet', (await lookup(A)).status, 'none');

circuitLines = [circ(12, 'HS_CLIENT_REND'), circ(40, 'HS_SERVICE_REND')];
streamLines = ['99 SUCCEEDED 12 ' + A + ':80'];
await emit(stream(99, 'SUCCEEDED', 12, A + ':80'));
let r = await lookup(A);
eq('contact circuit found', [r.status, r.circuit?.id], ['active', '12']);
eq('other contact has none', (await lookup(B)).status, 'none');
eq('the service-side circuit is never picked', r.circuit?.id === '40', false);

streamLines = [];                                                  // stream closed, circuit still open: idle after the 30 s window, active inside it
r = await lookup(A);
eq('still open after the stream closes', r.status !== 'none', true);

circuitLines = [circ(40, 'HS_SERVICE_REND')];                       // circuit 12 was closed
r = await lookup(A);
eq('closed circuit is not shown', [r.status, r.reason], ['none', 'closed']);

circuitLines = [circ(12, 'GENERAL')];
eq('wrong purpose is not shown', (await lookup(A)).reason, 'not-hs');

circuitLines = [circ(12, 'HS_CLIENT_REND', 'EXTENDED')];
eq('unfinished circuit is not shown', (await lookup(A)).reason, 'not-built');

circuitLines = [circ(12, 'HS_CLIENT_REND'), circ(15, 'HS_CLIENT_REND')];
await emit(stream(100, 'SENTCONNECT', 15, A + ':80'));
r = await lookup(A);
eq('a newer circuit replaces the old one', r.circuit?.id, '15');

await circuits.rebuildCircuitForContact(A);
eq('after a rebuild the old record is dropped', (await lookup(A)).status, 'none');

// SOCKS circuit: only ordinary-traffic circuits, live streams first, newest wins, just-built one when nothing is in use.
const g = (id, o = {}) => ({ id: String(id), state: 'BUILT', purpose: 'GENERAL', hsState: null, buildFlags: [], inUse: false, streams: [], relays: [{}], ...o });
const live = [{ state: 'SUCCEEDED' }], recent = [{ state: 'RECENT' }];
eq('no circuits', circuits.pickSocksCircuit([]), null);
eq('idle circuit is not shown', circuits.pickSocksCircuit([g(1)]), null);
eq('live circuit is shown', circuits.pickSocksCircuit([g(1), g(2, { inUse: true, streams: live })]).id, '2');
eq('live streams beat recent use', circuits.pickSocksCircuit([g(9, { inUse: true, streams: recent }), g(3, { inUse: true, streams: live })]).id, '3');
eq('newest of equals', circuits.pickSocksCircuit([g(3, { inUse: true, streams: live }), g(7, { inUse: true, streams: live })]).id, '7');
eq('hidden-service circuit is never SOCKS', circuits.pickSocksCircuit([g(5, { purpose: 'HS_CLIENT_REND', inUse: true, streams: live })]), null);
eq('unfinished circuit is not shown', circuits.pickSocksCircuit([g(5, { state: 'EXTENDED', inUse: true, streams: live })]), null);
eq('conflux leg counts', circuits.pickSocksCircuit([g(5, { purpose: 'CONFLUX_LINKED', inUse: true, streams: live })]).id, '5');
eq('just-built circuit when nothing is in use', circuits.pickSocksCircuit([g(1), g(4)], ['4']).id, '4');
eq('live traffic beats a just-built circuit', circuits.pickSocksCircuit([g(4), g(6, { inUse: true, streams: live })], ['4']).id, '6');

console.log(`${passed} passed, ${failed} failed`);
server.close(); fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
