// The libloc reader (lib/libloc.js: IP address to country for the exit/circuit map) against a small database built here in the same
// layout, so it runs everywhere without downloading the real one (tools/verify-libloc.js compares it with the official tool when a real
// database is at hand). Run: node tools/libloc-test.mjs
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { Libloc } = require(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'lib', 'libloc.js'));
let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n); } };

// 16-byte form of an address, as the reader sees it (IPv4 as ::ffff:a.b.c.d).
const v4 = (s) => { const b = Buffer.alloc(16); b[10] = b[11] = 0xff; s.split('.').forEach((x, i) => { b[12 + i] = Number(x); }); return b; };
const v6 = (groups) => { const b = Buffer.alloc(16); groups.forEach((g, i) => b.writeUInt16BE(g, i * 2)); return b; };

function build(entries, { pad = 4200 } = {}) {
  const nodes = [{ l: 0, r: 0, net: 0xffffffff }];
  const nets = [];
  for (const [addr, len, cc] of entries) {
    let i = 0;
    for (let d = 0; d < len; d++) {
      const bit = (addr[d >> 3] >> (7 - (d & 7))) & 1;
      const k = bit ? 'r' : 'l';
      if (!nodes[i][k]) { nodes.push({ l: 0, r: 0, net: 0xffffffff }); nodes[i][k] = nodes.length - 1; }
      i = nodes[i][k];
    }
    nets.push(cc); nodes[i].net = nets.length - 1;
  }
  const head = Buffer.alloc(pad);
  head.write('LOCDBXX', 0, 'ascii'); head.writeUInt8(1, 7);
  const nodeBuf = Buffer.alloc(nodes.length * 12), netBuf = Buffer.alloc(nets.length * 12);
  nodes.forEach((n, k) => { nodeBuf.writeUInt32BE(n.l, k * 12); nodeBuf.writeUInt32BE(n.r, k * 12 + 4); nodeBuf.writeUInt32BE(n.net, k * 12 + 8); });
  nets.forEach((cc, k) => { netBuf.write(cc, k * 12, 'ascii'); });
  head.writeUInt32BE(pad, 36); head.writeUInt32BE(netBuf.length, 40);
  head.writeUInt32BE(pad + netBuf.length, 44); head.writeUInt32BE(nodeBuf.length, 48);
  return Buffer.concat([head, netBuf, nodeBuf]);
}

console.log('1. Lookups');
const db = new Libloc(build([
  [v4('10.0.0.0'), 96 + 8, 'AA'],                  // 10.0.0.0/8
  [v4('10.1.0.0'), 96 + 16, 'BB'],                 // 10.1.0.0/16, inside the /8: the longer prefix wins
  [v4('192.168.7.0'), 96 + 24, 'CC'],
  [v6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]), 32, 'DD'],
  [v6([0x2001, 0xdb8, 0xabcd, 0, 0, 0, 0, 0]), 48, 'EE'],
]));
ok('an address in a prefix gets its country', db.lookup('10.9.9.9') === 'AA');
ok('the longest matching prefix wins', db.lookup('10.1.2.3') === 'BB');
ok('a /24 matches only its own range', db.lookup('192.168.7.200') === 'CC' && db.lookup('192.168.8.1') === null);
ok('an address no prefix covers gives null', db.lookup('8.8.8.8') === null);
ok('IPv6 prefixes work, longest wins', db.lookup('2001:db8:1::1') === 'DD' && db.lookup('2001:db8:abcd::5') === 'EE');
ok('IPv6 with an embedded IPv4 tail', db.lookup('::ffff:10.1.2.3') === 'BB');
ok('"::" and zone ids are handled', db.lookup('::') === null && db.lookup('2001:db8::1%eth0') === 'DD');

console.log('2. Bad input never throws');
for (const bad of ['', 'abc', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.-4', '1:2:3', '1::2::3', 'g::1', null, undefined, 42, {}]) {
  let r, threw = false; try { r = db.lookup(bad); } catch { threw = true; }
  ok(`${JSON.stringify(bad)} gives null`, !threw && r === null);
}

console.log('3. Damaged database files are refused');
const good = build([[v4('10.0.0.0'), 104, 'AA']]);
const refuses = (b) => { try { new Libloc(b); return false; } catch { return true; } };
ok('too small', refuses(Buffer.alloc(100)));
ok('wrong magic', refuses(Buffer.concat([Buffer.from('NOTLOCD'), good.subarray(7)])));
ok('unsupported version', refuses(Buffer.concat([good.subarray(0, 7), Buffer.from([2]), good.subarray(8)])));
{ const b = Buffer.from(good); b.writeUInt32BE(good.length + 1000, 44); ok('a section running past the end', refuses(b)); }
{ const b = Buffer.from(good); b.writeUInt32BE(0, 48); ok('no nodes', refuses(b)); }
{ const b = Buffer.from(good); b.writeUInt32BE(0xfffffff0, 40); ok('absurd section length', refuses(b)); }
ok('not a buffer', refuses('LOCDBXX'));

console.log('4. A tree that loops or points outside cannot hang or crash a lookup');
{
  const b = Buffer.from(build([[v4('10.0.0.0'), 104, 'AA']]));
  const nodesAt = b.readUInt32BE(44);
  b.writeUInt32BE(1, nodesAt + 0); b.writeUInt32BE(1, nodesAt + 4);   // the node every lookup starts at (index 0) points at index 1 on both sides, and index 1 at itself
  b.writeUInt32BE(1, nodesAt + 12 + 0); b.writeUInt32BE(1, nodesAt + 12 + 4);
  let threw = false; const t = Date.now(); try { new Libloc(b).lookup('1.2.3.4'); } catch { threw = true; }
  ok('a looping tree ends within 128 steps', !threw && Date.now() - t < 1000);
  const c = Buffer.from(build([[v4('10.0.0.0'), 104, 'AA']]));
  c.writeUInt32BE(0x7fffffff, c.readUInt32BE(44)); c.writeUInt32BE(0x7fffffff, c.readUInt32BE(44) + 4);
  let threw2 = false; try { new Libloc(c).lookup('10.0.0.1'); } catch { threw2 = true; }
  ok('a child pointing outside the file is ignored', !threw2);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
