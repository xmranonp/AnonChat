#!/usr/bin/env node
// A stand-in for the anon binary, for tools/restart-test.mjs: run by start.js as `fake-anon.mjs -f <anonrc>`.
// Reads the control and SOCKS ports and the service folder from the anonrc, writes the hostname, runs tools/fake-control-port.mjs (in-process) on the
// control port (its HTTP side on FAKE_ANON_HTTP) with the address published, and a SOCKS port where every connection fails ("host
// unreachable"), as when our own address can't be reached. Says "Bootstrapped 100%" and, while FAKE_ANON_GIVEUP is set, the line the
// real anon logs when it gives up on connections people make to its service. Each launch is appended to FAKE_ANON_RECORD.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const rc = fs.readFileSync(process.argv[process.argv.indexOf('-f') + 1], 'utf8');
const get = (k) => (rc.match(new RegExp('^' + k + ' (.+)$', 'm')) || [])[1];
const ctl = Number(get('ControlPort')), socksPort = Number(get('SocksPort').split(' ')[0].split(':')[1]);
const dataDir = path.resolve(get('DataDirectory')), svc = path.resolve(get('HiddenServiceDir'));
fs.mkdirSync(svc, { recursive: true });
fs.writeFileSync(path.join(svc, 'hostname'), 'w'.repeat(56) + '.anyone\n');
if (process.env.FAKE_ANON_RECORD) fs.appendFileSync(process.env.FAKE_ANON_RECORD, `${Date.now()} ${process.pid}\n`);
const http = process.env.FAKE_ANON_HTTP || String(ctl + 1000);
// in this same process, so that whatever stops it (a SIGKILL too) stops the control port with it
process.argv = [process.argv[0], 'fake-control-port.mjs', String(ctl), http, dataDir];
await import(new URL('./fake-control-port.mjs', import.meta.url));
const socks = net.createServer((c) => {
  let stage = 0; c.on('error', () => {});
  c.on('data', (x) => {
    if (stage === 0) { stage = 1; c.write(Buffer.from([5, x.subarray(2).includes(2) ? 2 : 0])); if (!x.subarray(2).includes(2)) stage = 2; return; }
    if (stage === 1) { stage = 2; c.write(Buffer.from([1, 0])); return; }
    if (stage === 2) { stage = 3; c.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0])); }
  });
}).listen(socksPort, '127.0.0.1');
setTimeout(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${http}/state`, { method: 'POST', body: JSON.stringify({ published: true }) }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  console.log('[notice] Bootstrapped 100% (done): Done');
}, 300);
const giveUp = setInterval(() => { if (process.env.FAKE_ANON_GIVEUP === '1') console.log('[notice] Giving up on launching a rendezvous circuit to name the client.'); }, 1000);
const stop = () => { clearInterval(giveUp); socks.close(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
