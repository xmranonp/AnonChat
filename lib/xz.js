'use strict';

// Pure-JavaScript .xz (LZMA2) decompressor for single-stream, single-block files: enough for the libloc database.

const KTOP = 0x01000000;
const NUM_STATES = 12;
const kNumPosBitsMax = 4;
const kMatchMinLen = 2;

function bitTreeDecode(rc, probs, off, numBits) {
  let m = 1;
  for (let i = 0; i < numBits; i++) m = (m << 1) + rc.decodeBit(probs, off + m);
  return m - (1 << numBits);
}
function bitTreeReverseDecode(rc, probs, off, numBits) {
  let m = 1, sym = 0;
  for (let i = 0; i < numBits; i++) {
    const b = rc.decodeBit(probs, off + m);
    m = (m << 1) + b;
    sym |= b << i;
  }
  return sym;
}

class RangeDecoder {
  constructor(buf, pos) {
    this.buf = buf;
    this.pos = pos + 1;                 // first byte must be 0
    this.range = 0xFFFFFFFF;
    let code = 0;
    for (let i = 0; i < 4; i++) code = ((code << 8) | this.buf[this.pos++]) >>> 0;
    this.code = code >>> 0;
  }
  decodeBit(probs, index) {
    const prob = probs[index];
    const bound = ((this.range >>> 11) * prob) >>> 0;
    let bit;
    if ((this.code >>> 0) < (bound >>> 0)) {
      this.range = bound;
      probs[index] = prob + ((2048 - prob) >>> 5);
      bit = 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      probs[index] = prob - (prob >>> 5);
      bit = 1;
    }
    if (this.range >>> 0 < KTOP) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.buf[this.pos++]) >>> 0;
    }
    return bit;
  }
  decodeDirectBits(numBits) {
    let result = 0;
    do {
      this.range = this.range >>> 1;
      this.code = (this.code - this.range) >>> 0;
      const t = (0 - (this.code >>> 31)) >>> 0;
      this.code = (this.code + (this.range & t)) >>> 0;
      if (this.range >>> 0 < KTOP) {
        this.range = (this.range << 8) >>> 0;
        this.code = ((this.code << 8) | this.buf[this.pos++]) >>> 0;
      }
      result = ((result << 1) + (t + 1)) >>> 0;
    } while (--numBits);
    return result >>> 0;
  }
}

function newLenProbs() {
  return new Uint16Array(2 + (16 * 8) + (16 * 8) + 256).fill(1024);
}
const LEN_LOW = 2, LEN_MID = 2 + 16 * 8, LEN_HIGH = 2 + 16 * 8 + 16 * 8;
function decodeLen(rc, p, posState) {
  if (rc.decodeBit(p, 0) === 0) return kMatchMinLen + bitTreeDecode(rc, p, LEN_LOW + (posState << 3), 3);
  if (rc.decodeBit(p, 1) === 0) return kMatchMinLen + 8 + bitTreeDecode(rc, p, LEN_MID + (posState << 3), 3);
  return kMatchMinLen + 16 + bitTreeDecode(rc, p, LEN_HIGH, 8);
}

class LzmaDec {
  constructor() {
    this.lc = 0; this.lp = 0; this.pb = 0;
    this.state = 0;
    this.rep0 = 0; this.rep1 = 0; this.rep2 = 0; this.rep3 = 0;
    this.probsAllocated = false;
  }
  setProps(propByte) {
    if (propByte >= 9 * 5 * 5) throw new Error('xz: bad LZMA props');
    this.lc = propByte % 9; propByte = (propByte / 9) | 0;
    this.lp = propByte % 5; this.pb = (propByte / 5) | 0;
    this._allocProbs();
  }
  _allocProbs() {
    this.IsMatch    = new Uint16Array(NUM_STATES << kNumPosBitsMax).fill(1024);
    this.IsRep      = new Uint16Array(NUM_STATES).fill(1024);
    this.IsRepG0    = new Uint16Array(NUM_STATES).fill(1024);
    this.IsRepG1    = new Uint16Array(NUM_STATES).fill(1024);
    this.IsRepG2    = new Uint16Array(NUM_STATES).fill(1024);
    this.IsRep0Long = new Uint16Array(NUM_STATES << kNumPosBitsMax).fill(1024);
    this.PosSlot    = new Uint16Array(4 * (1 << 6)).fill(1024);       // 4 len-to-pos states, 6-bit tree
    this.SpecPos    = new Uint16Array(115).fill(1024);
    this.Align      = new Uint16Array(1 << 4).fill(1024);
    this.LenCoder   = newLenProbs();
    this.RepLenCoder= newLenProbs();
    this.Literal    = new Uint16Array(0x300 << (this.lc + this.lp)).fill(1024);
    this.probsAllocated = true;
  }
  resetState() {
    this.state = 0; this.rep0 = 0; this.rep1 = 0; this.rep2 = 0; this.rep3 = 0;
    if (this.probsAllocated) this._allocProbs();
  }
  decode(rc, out, limit, dictStart) {
    const pbMask = (1 << this.pb) - 1;
    const lpMask = (1 << this.lp) - 1;
    const lc = this.lc;
    while (out.pos < limit) {
      const posState = out.pos & pbMask;
      const state2 = (this.state << kNumPosBitsMax) + posState;
      if (rc.decodeBit(this.IsMatch, state2) === 0) {
        const prevByte = out.pos > dictStart ? out.buf[out.pos - 1] : 0;
        const litState = (((out.pos & lpMask) << lc) + (prevByte >>> (8 - lc))) >>> 0;
        const probsOff = 0x300 * litState;
        let symbol = 1;
        if (this.state >= 7) {
          let matchByte = out.buf[out.pos - this.rep0 - 1];
          do {
            const matchBit = (matchByte >> 7) & 1; matchByte = (matchByte << 1) & 0xff;
            const bit = rc.decodeBit(this.Literal, probsOff + (((1 + matchBit) << 8) + symbol));
            symbol = (symbol << 1) | bit;
            if (matchBit !== bit) break;
          } while (symbol < 0x100);
        }
        while (symbol < 0x100) symbol = (symbol << 1) | rc.decodeBit(this.Literal, probsOff + symbol);
        out.buf[out.pos++] = symbol & 0xff;
        this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6;
        continue;
      }
      let len;
      if (rc.decodeBit(this.IsRep, this.state) !== 0) {
        if (rc.decodeBit(this.IsRepG0, this.state) === 0) {
          if (rc.decodeBit(this.IsRep0Long, state2) === 0) {
            this.state = this.state < 7 ? 9 : 11;
            out.buf[out.pos] = out.buf[out.pos - this.rep0 - 1]; out.pos++;
            continue;
          }
        } else {
          let dist;
          if (rc.decodeBit(this.IsRepG1, this.state) === 0) dist = this.rep1;
          else {
            if (rc.decodeBit(this.IsRepG2, this.state) === 0) dist = this.rep2;
            else { dist = this.rep3; this.rep3 = this.rep2; }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0; this.rep0 = dist;
        }
        len = decodeLen(rc, this.RepLenCoder, posState);
        this.state = this.state < 7 ? 8 : 11;
      } else {
        this.rep3 = this.rep2; this.rep2 = this.rep1; this.rep1 = this.rep0;
        len = decodeLen(rc, this.LenCoder, posState);
        this.state = this.state < 7 ? 7 : 10;
        const lenToPos = (len - kMatchMinLen) < 4 ? (len - kMatchMinLen) : 3;
        const posSlot = bitTreeDecode(rc, this.PosSlot, lenToPos << 6, 6);
        if (posSlot < 4) this.rep0 = posSlot;
        else {
          const numDirect = (posSlot >> 1) - 1;
          this.rep0 = (2 | (posSlot & 1)) << numDirect;
          if (posSlot < 14) {
            this.rep0 = (this.rep0 + bitTreeReverseDecode(rc, this.SpecPos, this.rep0 - posSlot - 1, numDirect)) >>> 0;
          } else {
            this.rep0 = (this.rep0 + (rc.decodeDirectBits(numDirect - 4) << 4)) >>> 0;
            this.rep0 = (this.rep0 + bitTreeReverseDecode(rc, this.Align, 0, 4)) >>> 0;
          }
        }
        if (this.rep0 === 0xFFFFFFFF) { return true; }
      }
      let src = out.pos - this.rep0 - 1;
      if (src < dictStart) throw new Error('xz: match distance out of range');
      for (let i = 0; i < len && out.pos < limit; i++) out.buf[out.pos++] = out.buf[src++];
    }
    return false;
  }
}

function lzma2(data, dictSizeHint, maxBytes = Infinity) {
  // Output can't exceed the sum of chunk uncompressed sizes; grow as needed, never past maxBytes (the header's dictionary size is only a
  // hint from the file: up to 4 GB, which must not be allocated just because a file says so).
  let cap = Math.min(Math.max(dictSizeHint >>> 0, 1 << 20), 64 << 20, maxBytes);
  let out = { buf: new Uint8Array(cap), pos: 0 };
  let dictStart = 0;
  const dec = new LzmaDec();
  let i = 0;
  const ensure = (extra) => {
    if (out.pos + extra <= out.buf.length) return;
    if (out.pos + extra > maxBytes) throw new Error('xz: unpacked data larger than allowed');
    let n = out.buf.length;
    while (out.pos + extra > n) n *= 2;
    n = Math.min(n, maxBytes);
    const nb = new Uint8Array(n); nb.set(out.buf.subarray(0, out.pos)); out.buf = nb;
  };
  while (i < data.length) {
    const control = data[i++];
    if (control === 0) break;
    if (control < 3) {
      if (control === 1) dictStart = out.pos;
      const size = ((data[i] << 8) | data[i + 1]) + 1; i += 2;
      ensure(size);
      out.buf.set(data.subarray(i, i + size), out.pos); out.pos += size; i += size;
      continue;
    }
    if (control < 0x80) throw new Error('xz: bad LZMA2 control ' + control);
    const unpackSize = (((control & 0x1f) << 16) | (data[i] << 8) | data[i + 1]) + 1; i += 2;
    const packSize   = ((data[i] << 8) | data[i + 1]) + 1; i += 2;
    const resetBits  = (control >> 5) & 3;
    if (resetBits >= 2) { dec.setProps(data[i++]); }
    if (resetBits >= 1) { dec.resetState(); }
    if (resetBits === 3) { dictStart = out.pos; }
    ensure(unpackSize);
    const rc = new RangeDecoder(data, i);
    const limit = out.pos + unpackSize;
    dec.decode(rc, out, limit, dictStart);
    if (out.pos !== limit) throw new Error('xz: LZMA2 chunk short output');
    i += packSize;
  }
  return out.buf.subarray(0, out.pos);
}

function decompressXz(input, { maxBytes = Infinity } = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const MAGIC = [0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00];
  for (let k = 0; k < 6; k++) if (buf[k] !== MAGIC[k]) throw new Error('xz: bad stream magic');
  // stream header: magic(6) flags(2) crc32(4) = 12 bytes. Block starts at 12.
  let p = 12;
  const blockHeaderSizeByte = buf[p];
  if (blockHeaderSizeByte === 0) return Buffer.alloc(0);
  const blockHeaderSize = (blockHeaderSizeByte + 1) * 4;
  const blockHeaderStart = p;
  p += 1;
  const blockFlags = buf[p++];
  const numFilters = (blockFlags & 0x03) + 1;
  if (blockFlags & 0x3C) throw new Error('xz: reserved block flags set');
  if (blockFlags & 0x40) { p += readMultibyte(buf, p).len; }
  if (blockFlags & 0x80) { p += readMultibyte(buf, p).len; }
  let dictSize = 1 << 20;
  for (let f = 0; f < numFilters; f++) {
    const id = readMultibyte(buf, p); p += id.len;
    const propsSize = readMultibyte(buf, p); p += propsSize.len;
    if (id.value === 0x21) {
      // LZMA2 props: 1 byte encoding the dictionary size
      const b = buf[p] & 0x3F;
      dictSize = b === 40 ? 0xFFFFFFFF : (((2 | (b & 1)) << (b >> 1 >> 0)) >>> 0);
    } else if (id.value !== 0x21) {
      throw new Error('xz: unsupported filter id 0x' + id.value.toString(16));
    }
    p += propsSize.value;
  }
  // block header CRC32 (4 bytes) then compressed data begins at header end.
  const dataStart = blockHeaderStart + blockHeaderSize;
  return Buffer.from(lzma2(buf.subarray(dataStart), dictSize, maxBytes));
}

// xz multibyte integer (LEB128-ish, 7 bits/byte, high bit = continue)
function readMultibyte(buf, p) {
  let value = 0, len = 0, shift = 0;
  for (;;) {
    const b = buf[p + len]; len++;
    value = (value + ((b & 0x7f) * Math.pow(2, shift)));
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value, len };
}

module.exports = { decompressXz };
