// Removes hidden data from photos, videos and audio before they are sent (location, camera, time stamps, embedded thumbnails, the file name).
//
// The aim is the best picture quality that still leaves nothing behind:
//   1. Where the format allows it the file is cleaned WITHOUT re-encoding: only the pieces that carry no picture are cut out
//      (JPEG segments, PNG/WebP/GIF chunks, MP4/MOV boxes, WebM elements, MP3 tags). The pixels stay byte for byte as they were.
//   2. If the picture has to be changed anyway (it is turned by an orientation tag, it is wider than 4096 px, it is larger than the
//      size limit, or it is in a format we cannot cut safely such as BMP/SVG/AVIF) it is drawn on a canvas and saved again at high
//      quality (JPEG 0.92, or PNG when there is transparency). A canvas keeps no metadata at all.
//   3. If a file cannot be cleaned it is NOT sent. The original is never used as a fallback.
//
// The pure functions below work on Uint8Array and have no browser dependency, so tests/node can run them.

export const MAX_BYTES = 5 * 1024 * 1024;       // the send limit, applied to the CLEANED file
export const MAX_INPUT = 40 * 1024 * 1024;      // what we are willing to open and re-encode
export const MAX_EDGE = 4096;                   // longest side of a picture that is re-encoded
export const MAX_PIXELS = 100e6;
export const ICC_MAX = 64 * 1024;               // a colour profile is kept (colours would shift without it) unless it is unusually large

const ascii = (b, o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i] ?? 0); return s; };
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const concat = (parts) => { let n = 0; for (const p of parts) n += p.length; const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

export function sniff(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (b.length >= 6 && ascii(b, 0, 3) === 'GIF') return 'gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') return 'mp4';
  if (b.length >= 4 && u32be(b, 0) === 0x1a45dfa3) return 'webm';
  if (b.length >= 10 && ascii(b, 0, 3) === 'ID3') return 'mp3';
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

// ---------- orientation from an Exif block (TIFF structure): 1 = upright, 2..8 = needs turning/mirroring ----------
function exifOrientation(t) {          // t = bytes starting at the TIFF header ("II*\0" or "MM\0*")
  try {
    const le = t[0] === 0x49;
    const r16 = (o) => (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]);
    const r32 = (o) => (le ? u32le(t, o) : u32be(t, o));
    if (!(le || t[0] === 0x4d) || r16(2) !== 42) return 1;
    const ifd = r32(4); if (ifd + 2 > t.length) return 1;
    const n = r16(ifd);
    for (let i = 0; i < n && i < 256; i++) {
      const e = ifd + 2 + i * 12; if (e + 12 > t.length) break;
      if (r16(e) === 0x0112) { const v = r16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
    }
  } catch { /* unreadable: treated as upright, the canvas path is not needed */ }
  return 1;
}

// ---------- JPEG: keep only what draws the picture ----------
export function stripJpeg(b) {
  if (sniff(b) !== 'jpeg') return null;
  const out = [b.subarray(0, 2)];
  let i = 2, width = 0, height = 0, orientation = 1, icc = [], iccTotal = 0, sawSOS = false;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff && i < b.length) i++;
    const m = b[i++];
    if (m === 0xd9) { out.push(Uint8Array.of(0xff, 0xd9)); return finish(); }          // EOI. Whatever follows it (trailers, embedded videos) is dropped
    if (m === 0x00 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;
    if (i + 2 > b.length) return null;
    const len = u16be(b, i); if (len < 2 || i + len > b.length) return null;
    const seg = b.subarray(i - 2, i + len);        // marker + length + payload (marker's 0xFF is at i-2)
    const body = b.subarray(i + 2, i + len);
    let keep = false;
    if (m === 0xdb || m === 0xc4 || m === 0xdd || m === 0xda) keep = true;                       // tables, restart interval, scan header
    else if (m >= 0xc0 && m <= 0xcf && m !== 0xc8 && m !== 0xcc) {                                   // frame header
      keep = true; if (body.length >= 5) { height = u16be(body, 1); width = u16be(body, 3); }
    }
    else if (m === 0xe0) keep = body.length === 14 && ascii(body, 0, 5) === 'JFIF\0' && body[12] === 0 && body[13] === 0;   // JFIF header without a thumbnail
    else if (m === 0xee) keep = body.length === 12 && ascii(body, 0, 5) === 'Adobe';                // colour transform flag
    else if (m === 0xe1 && ascii(body, 0, 6) === 'Exif\0\0') orientation = exifOrientation(body.subarray(6));   // read, not kept
    else if (m === 0xe2 && ascii(body, 0, 12) === 'ICC_PROFILE\0') { iccTotal += body.length; if (iccTotal <= ICC_MAX) icc.push(seg); }
    if (keep) out.push(seg);
    i += len;
    if (m === 0xda) {                                                                                  // start of scan: copy the entropy-coded data
      sawSOS = true;
      let j = i;
      while (j < b.length) {
        if (b[j] === 0xff) { const n = b[j + 1]; if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) { j += n === 0xff ? 1 : 2; continue; } break; }
        j++;
      }
      if (j >= b.length) return null;
      out.push(b.subarray(i, j)); i = j;
    }
  }
  return null;                                                                                          // no EOI: damaged
  function finish() {
    if (!sawSOS || !width || !height) return null;
    if (iccTotal > ICC_MAX) icc = [];
    // colour profile goes right after SOI (before the tables)
    const bytes = concat([out[0], ...icc, ...out.slice(1)]);
    return { bytes, width, height, orientation, format: 'jpeg', alpha: false };
  }
}

// ---------- PNG ----------
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'acTL', 'fcTL', 'fdAT', 'gAMA', 'cHRM', 'sRGB', 'cICP', 'sBIT']);
export function stripPng(b) {
  if (sniff(b) !== 'png') return null;
  const out = [b.subarray(0, 8)];
  let i = 8, width = 0, height = 0, orientation = 1, alpha = false, iccKept = 0, sawIDAT = false, ct = 0;
  while (i + 12 <= b.length) {
    const len = u32be(b, i), type = ascii(b, i + 4, 4);
    if (len > 0x7fffffff || i + 12 + len > b.length) return null;
    const chunk = b.subarray(i, i + 12 + len), data = b.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') { if (len !== 13) return null; width = u32be(data, 0); height = u32be(data, 4); ct = data[9]; alpha = ct === 4 || ct === 6; }
    if (type === 'tRNS') alpha = true;
    if (type === 'IDAT') sawIDAT = true;
    if (type === 'eXIf') orientation = exifOrientation(data);
    let keep = PNG_KEEP.has(type);
    if (type === 'gAMA' && len !== 4) keep = false;
    if (type === 'cHRM' && len !== 32) keep = false;
    if (type === 'sRGB' && len !== 1) keep = false;
    if (type === 'cICP' && len !== 4) keep = false;
    if (type === 'sBIT' && len > 4) keep = false;
    if (type === 'iCCP') { iccKept += len; keep = iccKept <= ICC_MAX; }
    if (keep) out.push(chunk);
    i += 12 + len;
    if (type === 'IEND') {                                   // anything after IEND is dropped
      if (!sawIDAT || !width || !height) return null;
      return { bytes: concat(out), width, height, orientation, format: 'png', alpha };
    }
  }
  return null;
}

// ---------- GIF ----------
export function stripGif(b) {
  if (sniff(b) !== 'gif' || b.length < 13) return null;
  const out = [b.subarray(0, 6)];
  const width = b[6] | (b[7] << 8), height = b[8] | (b[9] << 8);
  let i = 13; const flags = b[10];
  if (flags & 0x80) i += 3 * (1 << ((flags & 7) + 1));
  if (i > b.length) return null;
  out.push(b.subarray(6, i));
  const skipSub = (p) => { while (true) { if (p >= b.length) return -1; const n = b[p]; p += 1 + n; if (n === 0) return p; } };
  let frames = 0;
  while (i < b.length) {
    const t = b[i];
    if (t === 0x3b) { out.push(Uint8Array.of(0x3b)); if (!frames) return null; return { bytes: concat(out), width, height, orientation: 1, format: 'gif', alpha: true }; }
    if (t === 0x21) {
      const label = b[i + 1], end = skipSub(i + 2); if (end < 0) return null;
      let keep = false;
      if (label === 0xf9) keep = b[i + 2] === 4;                                      // graphic control (timing, transparency)
      else if (label === 0xff && b[i + 2] === 11) {                                   // application block: only the loop count survives
        const id = ascii(b, i + 3, 11);
        keep = (id === 'NETSCAPE2.0' || id === 'ANIMEXTS1.0') && end - i <= 3 + 11 + 5 + 1;
      }
      if (keep) out.push(b.subarray(i, end));                                          // comments (0xFE), plain text (0x01) and other applications are dropped
      i = end; continue;
    }
    if (t === 0x2c) {
      if (i + 10 > b.length) return null;
      let p = i + 10; const f = b[i + 9];
      if (f & 0x80) p += 3 * (1 << ((f & 7) + 1));
      p += 1;                                                                          // LZW minimum code size
      const end = skipSub(p); if (end < 0) return null;
      out.push(b.subarray(i, end)); frames++; i = end; continue;
    }
    return null;
  }
  return null;
}

// ---------- WebP ----------
const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
export function stripWebp(b) {
  if (sniff(b) !== 'webp') return null;
  const total = Math.min(b.length, 8 + u32le(b, 4));
  let i = 12, orientation = 1, width = 0, height = 0, alpha = false, vp8xAt = -1;
  const parts = []; let iccKept = 0;
  while (i + 8 <= total) {
    const type = ascii(b, i, 4), len = u32le(b, i + 4), padded = len + (len & 1);
    if (i + 8 + len > total) return null;
    const data = b.subarray(i + 8, i + 8 + len);
    let keep = WEBP_KEEP.has(type);
    if (type === 'EXIF') orientation = exifOrientation(data[0] === 0x45 ? data.subarray(6) : data);   // may start with "Exif\0\0"
    if (type === 'ICCP') { iccKept += len; keep = iccKept <= ICC_MAX; }
    if (type === 'VP8X') {
      if (len !== 10) return null;
      width = 1 + (data[4] | (data[5] << 8) | (data[6] << 16)); height = 1 + (data[7] | (data[8] << 8) | (data[9] << 16)); alpha = !!(data[0] & 0x10);
      vp8xAt = parts.length;
    }
    if (type === 'ANMF') {
      if (len < 16) return null;
      let p = 16;
      while (p + 8 <= len) {
        const st = ascii(data, p, 4), sl = u32le(data, p + 4);
        if (!['ALPH', 'VP8 ', 'VP8L'].includes(st) || p + 8 + sl > len) return null;
        p += 8 + sl + (sl & 1);
      }
    }
    if (type === 'VP8 ' && !width && len >= 10) { width = (data[6] | (data[7] << 8)) & 0x3fff; height = (data[8] | (data[9] << 8)) & 0x3fff; }
    if (type === 'VP8L' && !width && len >= 5) { const v = u32le(data, 1); width = (v & 0x3fff) + 1; height = ((v >> 14) & 0x3fff) + 1; alpha = !!((v >> 28) & 1); }
    if (keep) { const c = b.slice(i, i + 8 + padded > b.length ? b.length : i + 8 + padded); parts.push(c); }
    i += 8 + padded;
  }
  if (!parts.length || !width || !height) return null;
  if (vp8xAt >= 0) parts[vp8xAt][8] &= ~0x0c;                                           // no EXIF / XMP any more
  const body = concat(parts);
  const head = new Uint8Array(12); head.set(b.subarray(0, 4), 0); head.set(b.subarray(8, 12), 8);
  const size = 4 + body.length; head[4] = size & 255; head[5] = (size >> 8) & 255; head[6] = (size >> 16) & 255; head[7] = (size >>> 24) & 255;
  return { bytes: concat([head, body]), width, height, orientation, format: 'webp', alpha };
}

// ---------- MP4 / MOV / M4A: boxes that carry metadata are turned into "free" boxes of the same size, so every offset stays valid ----------
const ISO_TOP_KEEP = new Set(['ftyp', 'styp', 'moov', 'mdat', 'moof', 'mfra', 'sidx', 'ssix']);
export function stripMp4(src) {
  if (sniff(src) !== 'mp4') return null;
  const b = src.slice();
  let ok = true;
  const boxAt = (o, end) => {
    if (o + 8 > end) return null;
    let size = u32be(b, o), hdr = 8; const type = ascii(b, o + 4, 4);
    if (size === 1) { if (o + 16 > end) return null; const hi = u32be(b, o + 8), lo = u32be(b, o + 12); if (hi) return null; size = lo; hdr = 16; }
    else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) return null;
    return { o, size, hdr, type, end: o + size };
  };
  const wipe = (bx) => { b.set([0x66, 0x72, 0x65, 0x65], bx.o + 4); b.fill(0, bx.o + bx.hdr, bx.end); };   // "free"
  const zeroTimes = (bx) => {                                                                             // mvhd / tkhd / mdhd: creation and modification time
    const v = b[bx.o + bx.hdr]; const at = bx.o + bx.hdr + 4;
    b.fill(0, at, at + (v === 1 ? 16 : 8));
  };
  const handlerOf = (trak) => {
    for (let o = trak.o + trak.hdr; ;) { const m = boxAt(o, trak.end); if (!m) return null;
      if (m.type === 'mdia') { for (let p = m.o + m.hdr; ;) { const h = boxAt(p, m.end); if (!h) return null; if (h.type === 'hdlr') return ascii(b, h.o + h.hdr + 8, 4); p = h.end; } }
      o = m.end; if (o >= trak.end) return null; }
  };
  const walkTrakParts = (bx) => {
    for (let o = bx.o + bx.hdr; o < bx.end;) {
      const c = boxAt(o, bx.end); if (!c) { ok = false; return; }
      if (c.type === 'tkhd') zeroTimes(c);
      else if (c.type === 'mdia') {
        for (let p = c.o + c.hdr; p < c.end;) {
          const d = boxAt(p, c.end); if (!d) { ok = false; return; }
          if (d.type === 'mdhd') zeroTimes(d);
          else if (d.type === 'hdlr') b.fill(0, d.o + d.hdr + 24, d.end);          // the handler's display name ("Core Media Video", ...)
          else if (d.type === 'udta' || d.type === 'meta') wipe(d);
          p = d.end;
        }
      }
      else if (c.type === 'udta' || c.type === 'meta') wipe(c);
      o = c.end;
    }
  };
  for (let o = 0; o < b.length;) {
    const bx = boxAt(o, b.length); if (!bx) return null;
    if (bx.type === 'moov') {
      for (let p = bx.o + bx.hdr; p < bx.end;) {
        const c = boxAt(p, bx.end); if (!c) return null;
        if (c.type === 'mvhd') zeroTimes(c);
        else if (c.type === 'trak') { const h = handlerOf(c); if (h === 'vide' || h === 'soun') walkTrakParts(c); else wipe(c); }   // location / timed-metadata tracks go
        else if (c.type === 'udta' || c.type === 'meta' || c.type === 'iods') wipe(c);
        p = c.end;
      }
    } else if (!ISO_TOP_KEEP.has(bx.type)) wipe(bx);                                                   // uuid, XMP_, meta, free/skip padding, thumbnails, ...
    o = bx.end;
  }
  if (!ok) return null;
  return { bytes: b, format: 'mp4' };
}

// ---------- WebM / Matroska ----------
export function stripWebm(src) {
  if (sniff(src) !== 'webm') return null;
  const b = src.slice();
  const readId = (o) => { const f = b[o]; if (!f) return null; let n = 1; while (!(f & (0x80 >> (n - 1)))) n++; if (n > 4) return null; let id = 0; for (let k = 0; k < n; k++) id = id * 256 + b[o + k]; return { id, n }; };
  const readSize = (o) => {
    const f = b[o]; if (!f) return null; let n = 1; while (!(f & (0x80 >> (n - 1)))) n++; if (n > 8) return null;
    let v = f & (0xff >> n), unknown = (f & (0xff >> n)) === (0xff >> n);
    for (let k = 1; k < n; k++) { v = v * 256 + b[o + k]; if (b[o + k] !== 0xff) unknown = false; }
    return { n, v, unknown };
  };
  const el = (o, end) => { const a = readId(o); if (!a) return null; const s = readSize(o + a.n); if (!s) return null; const hdr = a.n + s.n; return { o, id: a.id, hdr, unknown: s.unknown, end: s.unknown ? end : o + hdr + s.v }; };
  const voidIt = (e) => {                                                          // replace an element by a Void element (0xEC) of the same total size
    const L = e.end - e.o; if (L < 2) return false;
    let n = 1; while (n < 8 && L - 1 - n >= 2 ** (7 * n) - 1) n++;
    if (L - 1 - n < 0) return false;
    b[e.o] = 0xec; let v = L - 1 - n;
    for (let k = n - 1; k >= 0; k--) { b[e.o + 1 + k] = v % 256; v = Math.floor(v / 256); }
    b[e.o + 1] |= 0x80 >> (n - 1);
    b.fill(0, e.o + 1 + n, e.end);
    return true;
  };
  const DROP_SEG = new Set([0x1254c367, 0x1043a770, 0x1941a469]);                        // Tags, Chapters, Attachments
  const KEEP_INFO = new Set([0x2ad7b1, 0x4489]);                                         // TimecodeScale, Duration
  let sawSegment = false;
  for (let o = 0; o < b.length;) {
    const e = el(o, b.length); if (!e || e.end > b.length) return null;
    if (e.id === 0x18538067) {                                                           // Segment
      sawSegment = true;
      for (let p = e.o + e.hdr; p < e.end;) {
        const c = el(p, e.end); if (!c || c.end > e.end) return null;
        if (c.id === 0x1f43b675 && c.unknown) return null;                              // live streams cannot be walked safely
        if (DROP_SEG.has(c.id)) { if (!voidIt(c)) return null; }
        else if (c.id === 0x1549a966) {                                                  // Info
          for (let q = c.o + c.hdr; q < c.end;) { const d = el(q, c.end); if (!d || d.end > c.end) return null; if (!KEEP_INFO.has(d.id) && !voidIt(d)) return null; q = d.end; }
        } else if (c.id === 0x1654ae6b) {                                                // Tracks -> TrackEntry -> Name
          for (let q = c.o + c.hdr; q < c.end;) { const d = el(q, c.end); if (!d || d.end > c.end) return null;
            if (d.id === 0xae) for (let r = d.o + d.hdr; r < d.end;) { const f = el(r, d.end); if (!f || f.end > d.end) return null; if (f.id === 0x536e && !voidIt(f)) return null; r = f.end; }
            q = d.end; }
        }
        p = c.end;
      }
    }
    o = e.end;
  }
  if (!sawSegment) return null;
  return { bytes: b, format: 'webm' };
}

// ---------- MP3: ID3v2 header and ID3v1 trailer ----------
export function stripMp3(b) {
  let s = 0, e = b.length;
  if (ascii(b, 0, 3) === 'ID3') {
    if (b.length < 10 || (b[6] | b[7] | b[8] | b[9]) & 0x80) return null;
    s = 10 + ((b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9]) + ((b[5] & 0x10) ? 10 : 0);
    if (s >= b.length) return null;
  }
  if (e - s >= 128 && ascii(b, e - 128, 3) === 'TAG') e -= 128;
  if (!(b[s] === 0xff && (b[s + 1] & 0xe0) === 0xe0)) return null;
  return { bytes: b.slice(s, e), format: 'mp3' };
}

// ---------- the decision, as a pure function (testable) ----------
export function cleanBytes(bytes, kind) {
  const f = sniff(bytes);
  if (kind === 'image') {
    const r = f === 'jpeg' ? stripJpeg(bytes) : f === 'png' ? stripPng(bytes) : f === 'gif' ? stripGif(bytes) : f === 'webp' ? stripWebp(bytes) : null;
    return r ? { ...r, mime: MIME[r.format], name: 'photo.' + EXT[r.format] } : null;
  }
  if (kind === 'video' || kind === 'audio') {
    const r = f === 'mp4' ? stripMp4(bytes) : f === 'webm' ? stripWebm(bytes) : f === 'mp3' && kind === 'audio' ? stripMp3(bytes) : null;
    return r ? { ...r, mime: (kind === 'audio' && r.format === 'mp4') ? 'audio/mp4' : MIME[r.format], name: (kind === 'audio' ? 'audio.' : 'video.') + (r.format === 'mp4' ? (kind === 'audio' ? 'm4a' : (isQuickTime(bytes) ? 'mov' : 'mp4')) : EXT[r.format]) } : null;
  }
  return null;
}
const isQuickTime = (b) => ascii(b, 8, 4) === 'qt  ';
const MIME = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg' };
const EXT = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', mp4: 'mp4', webm: 'webm', mp3: 'mp3' };

// Does the cleaned picture need to be drawn again anyway?
export function needsRedraw(r) {
  if (r.orientation > 1) return true;                       // turned by a tag: the pixels themselves must be turned, so no tag is needed
  if (Math.max(r.width, r.height) > MAX_EDGE) return true;
  if (r.bytes.length > MAX_BYTES) return true;
  if (r.width * r.height > MAX_PIXELS) return true;
  return false;
}

// ---------- browser part ----------
async function decode(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch {
    return await new Promise((res, rej) => { const i = new Image(); const u = URL.createObjectURL(blob); i.onload = () => { URL.revokeObjectURL(u); res(i); }; i.onerror = () => { URL.revokeObjectURL(u); rej(new Error('could not read image')); }; i.src = u; });
  }
}
const toBlob = (canvas, type, q) => new Promise((res) => canvas.toBlob(res, type, q));

export async function redraw(blob, mayHaveAlpha) {
  const img = await decode(blob);
  const w0 = img.width || img.naturalWidth, h0 = img.height || img.naturalHeight;
  if (!w0 || !h0 || w0 * h0 > MAX_PIXELS) throw new Error('file too large');
  let scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  const draw = () => { canvas.width = Math.max(1, Math.round(w0 * scale)); canvas.height = Math.max(1, Math.round(h0 * scale)); const c = canvas.getContext('2d', { willReadFrequently: false }); c.clearRect(0, 0, canvas.width, canvas.height); c.drawImage(img, 0, 0, canvas.width, canvas.height); return c; };
  let ctx = draw(), alpha = false;
  if (mayHaveAlpha) {
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) { alpha = true; break; }
  }
  if (img.close) img.close();
  for (;;) {
    if (alpha) { const out = await toBlob(canvas, 'image/png'); if (out && out.size <= MAX_BYTES) return { blob: out, mime: 'image/png', name: 'photo.png' }; }
    else for (const q of [0.95, 0.9, 0.84, 0.76]) {
      const out = await toBlob(canvas, 'image/jpeg', q);
      if (out && out.size <= MAX_BYTES) return { blob: out, mime: 'image/jpeg', name: 'photo.jpg' };
    }
    scale *= 0.85;                                               // still too big: a little smaller, then try the same qualities again
    if (Math.max(w0, h0) * scale < 320) throw new Error('file too large');
    ctx = draw(); if (alpha) { /* alpha was found at the first size; keep PNG */ }
  }
}

// kind: 'image' | 'video' | 'audio' | anything else (returned untouched: the person chose to send that file as it is)
export async function cleanForSending(blob, kind) {
  if (kind !== 'image' && kind !== 'video' && kind !== 'audio') return { blob, name: null, changed: false };
  if (blob.size > MAX_INPUT) throw new Error('file too large');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const fmt = sniff(bytes);
  if (kind === 'image') {
    const r = cleanBytes(bytes, 'image');
    // an animation cannot be drawn on a canvas (only the first frame would survive): it is sent cleaned as it is, or refused when too big
    const animated = r && (r.format === 'gif' || (r.format === 'webp' && r.bytes[12] === 0x56 && (r.bytes[20] & 0x02)));
    if (animated) {
      if (r.bytes.length > MAX_BYTES) throw new Error('file too large (5 MB max)');
      return { blob: new Blob([r.bytes], { type: r.mime }), name: r.name, changed: true, how: 'stripped' };
    }
    if (r && !needsRedraw(r)) return { blob: new Blob([r.bytes], { type: r.mime }), name: r.name, changed: true, how: 'stripped' };
    // not cut-able, or the picture itself must change: draw it again (no metadata survives a canvas)
    try {
      const mayAlpha = fmt !== 'jpeg';
      const o = await redraw(blob, mayAlpha);
      return { blob: o.blob, name: o.name, changed: true, how: 'redrawn' };
    } catch (e) {
      if (/too large/i.test(String(e && e.message))) throw e;
      throw new Error('media cleanup failed');
    }
  }
  const r = cleanBytes(bytes, kind);
  if (!r) throw new Error('media cleanup failed');
  if (r.bytes.length > MAX_BYTES) throw new Error('file too large (5 MB max)');
  return { blob: new Blob([r.bytes], { type: r.mime }), name: r.name, changed: true, how: 'stripped' };
}
