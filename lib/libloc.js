'use strict';

// Pure-JavaScript reader for IPFire libloc databases: longest-prefix IP to country lookups.

const fs = require('fs');

const MAGIC        = 'LOCDBXX';
const NODE_SIZE    = 12;
const NETWORK_SIZE = 12;
const NO_NETWORK   = 0xffffffff;

function ipv4ToBytes(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  const b = Buffer.alloc(16);
  b[10] = 0xff; b[11] = 0xff;
  for (let i = 0; i < 4; i++) {
    const n = Number(p[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    b[12 + i] = n;
  }
  return b;
}

function ipv6ToBytes(ip) {
  ip = ip.split('%')[0];
  const m = ip.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const o = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
    if (o.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return null;
    ip = m[1] + (((o[0] << 8) | o[1]).toString(16)) + ':' + (((o[2] << 8) | o[3]).toString(16));
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  let groups;
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const b = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const g = parseInt(groups[i] || '0', 16);
    if (Number.isNaN(g) || g < 0 || g > 0xffff) return null;
    b[i * 2] = g >> 8; b[i * 2 + 1] = g & 0xff;
  }
  return b;
}

function ipToBytes(ip) {
  if (typeof ip !== 'string') return null;
  return ip.includes(':') ? ipv6ToBytes(ip) : ipv4ToBytes(ip);
}

class Libloc {
  constructor(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4200) throw new Error('libloc: file too small');
    if (buf.toString('ascii', 0, 7) !== MAGIC) throw new Error('libloc: bad magic');
    const version = buf.readUInt8(7);
    if (version !== 1) throw new Error('libloc: unsupported version ' + version);

    this.buf = buf;
    this.networksOffset = buf.readUInt32BE(36);
    this.networksLength  = buf.readUInt32BE(40);
    this.nodesOffset    = buf.readUInt32BE(44);
    this.nodesLength     = buf.readUInt32BE(48);
    this.networkCount = Math.floor(this.networksLength / NETWORK_SIZE);
    this.nodeCount    = Math.floor(this.nodesLength / NODE_SIZE);
    if (this.nodeCount < 1) throw new Error('libloc: empty network tree');
    if (this.nodesOffset + this.nodesLength > buf.length ||
        this.networksOffset + this.networksLength > buf.length) {
      throw new Error('libloc: sections out of bounds');
    }
  }

  _countryOf(networkIndex) {
    const off = this.networksOffset + networkIndex * NETWORK_SIZE;
    const cc = this.buf.toString('ascii', off, off + 2).replace(/\0/g, '').trim().toUpperCase();
    return /^[A-Z]{2}$/.test(cc) ? cc : null;
  }

  lookup(ip) {
    const a = ipToBytes(ip);
    if (!a) return null;
    let idx = 0;
    let best = NO_NETWORK;
    for (let depth = 0; depth <= 128; depth++) {
      if (idx >= this.nodeCount) break;
      const off = this.nodesOffset + idx * NODE_SIZE;
      const network = this.buf.readUInt32BE(off + 8);
      if (network < this.networkCount) best = network;
      if (depth === 128) break;
      const bit = (a[depth >> 3] >> (7 - (depth & 7))) & 1;
      const child = this.buf.readUInt32BE(off + (bit === 0 ? 0 : 4));
      if (child === 0) break;                            // 0 = no child (root can't be a child)
      idx = child;
    }
    return best === NO_NETWORK ? null : this._countryOf(best);
  }

  static open(path) {
    return new Libloc(fs.readFileSync(path));
  }
}

module.exports = { Libloc };
