// Photos, videos and audio lose their hidden data before sending (public/mediaclean.js): what is cut, what stays, and that damaged input is refused, never passed on.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); const f = path.join(tmp, 'mediaclean.mjs');
fs.copyFileSync(fileURLToPath(new URL('../public/mediaclean.js', import.meta.url)), f);
const M = await import(pathToFileURL(f).href);   // a plain C:\ path is not a valid module address on Windows
let pass = 0, fail = 0;
const ok = (c, name, extra) => { if (c) pass++; else { fail++; console.log('FAIL', name, extra ?? ''); } };
const enc = (s) => new TextEncoder().encode(s);
const cat = (...a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const has = (b, s) => hasB(b, typeof s === 'string' ? enc(s) : s);
const hasB = (b, n) => { outer: for (let i = 0; i + n.length <= b.length; i++) { for (let k = 0; k < n.length; k++) if (b[i + k] !== n[k]) continue outer; return true; } return false; };
const be32 = (n) => Uint8Array.of(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255);
const le32 = (n) => Uint8Array.of(n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255);
const be16 = (n) => Uint8Array.of(n >> 8, n & 255);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---------- JPEG ----------
const exifTiff = (orient) => cat(enc('Exif\0\0'), enc('II'), Uint8Array.of(42, 0), le32(8), Uint8Array.of(2, 0),
  Uint8Array.of(0x12, 0x01, 3, 0, 1, 0, 0, 0, orient, 0, 0, 0), Uint8Array.of(0x25, 0x88, 4, 0, 1, 0, 0, 0, 0, 0, 0, 0), le32(0), enc('GPSLAT-48.8566 GPSLON-2.3522 Canon EOS R5'));
const seg = (m, body) => cat(Uint8Array.of(0xff, m), be16(body.length + 2), body);
const scan = Uint8Array.of(0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a);
const jpeg = (orient = 1, extra = {}) => cat(Uint8Array.of(0xff, 0xd8),
  seg(0xe0, cat(enc('JFIF\0'), Uint8Array.of(1, 1, 0, 0, 1, 0, 1, 2, 2, 1, 2, 3, 4, 5, 6))),         // JFIF with a 2x2 thumbnail
  seg(0xe1, exifTiff(orient)), seg(0xe1, enc('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>LocationSecret</x:xmpmeta>')),
  seg(0xfe, enc('comment: owner John Smith')), seg(0xed, enc('Photoshop 3.0\0IPTCSecret')),
  extra.icc ? seg(0xe2, cat(enc('ICC_PROFILE\0'), Uint8Array.of(1, 1), enc('PROFILEBYTES'))) : new Uint8Array(0),
  seg(0xdb, new Uint8Array(65).fill(7)), seg(0xc0, cat(Uint8Array.of(8), be16(extra.h ?? 300), be16(extra.w ?? 400), Uint8Array.of(1, 1, 0x11, 0))),
  seg(0xc4, new Uint8Array(20).fill(3)), seg(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)), scan, Uint8Array.of(0xff, 0xd9),
  enc('TRAILER-motion-photo-video-bytes'));
let r = M.stripJpeg(jpeg());
ok(r && r.width === 400 && r.height === 300 && r.orientation === 1, 'jpeg: size and orientation read', r && [r.width, r.height, r.orientation]);
ok(r && !['GPSLAT', 'Canon', 'LocationSecret', 'John Smith', 'IPTCSecret', 'TRAILER', 'Exif'].some((s) => has(r.bytes, s)), 'jpeg: no location, camera, owner, XMP, IPTC, trailer');
const markers = (x) => { const o = []; let i = 2; while (i + 2 <= x.length) { if (x[i] !== 0xff) { o.push('BAD'); break; } const m = x[i + 1]; if (m === 0xd9) { o.push(0xd9); break; } o.push(m); i += 2 + ((x[i + 2] << 8) | x[i + 3]); if (m === 0xda) while (i < x.length && !(x[i] === 0xff && x[i + 1] !== 0 && !(x[i + 1] >= 0xd0 && x[i + 1] <= 0xd7))) i++; } return o; };
ok(r && markers(r.bytes).join() === [0xdb, 0xc0, 0xc4, 0xda, 0xd9].join(), 'jpeg: the remaining segments are well formed: tables, frame, scan, end', r && markers(r.bytes));
ok(r && r.bytes[r.bytes.length - 2] === 0xff && r.bytes[r.bytes.length - 1] === 0xd9, 'jpeg: ends at EOI');
ok(r && has(r.bytes, scan), 'jpeg: picture data untouched');
ok(r && !has(r.bytes, 'JFIF'), 'jpeg: JFIF with thumbnail dropped');
ok(M.stripJpeg(jpeg(6)).orientation === 6 && M.needsRedraw(M.stripJpeg(jpeg(6))), 'jpeg: a turned picture is drawn again');
ok(!M.needsRedraw(M.stripJpeg(jpeg(1))), 'jpeg: an upright picture is not re-encoded');
ok(M.needsRedraw(M.stripJpeg(jpeg(1, { w: 5000, h: 3000 }))), 'jpeg: over 4096 px is drawn again');
ok(has(M.stripJpeg(jpeg(1, { icc: true })).bytes, 'PROFILEBYTES'), 'jpeg: small colour profile kept');
const thumbJfif = cat(Uint8Array.of(0xff, 0xd8), seg(0xe0, cat(enc('JFIF\0'), Uint8Array.of(1, 1, 0, 0, 1, 0, 1, 0, 0))), seg(0xdb, new Uint8Array(65)), seg(0xc0, cat(Uint8Array.of(8), be16(10), be16(10), Uint8Array.of(1, 1, 0x11, 0))), seg(0xda, Uint8Array.of(1, 1, 0, 0, 63, 0)), scan, Uint8Array.of(0xff, 0xd9));
ok(has(M.stripJpeg(thumbJfif).bytes, 'JFIF'), 'jpeg: plain JFIF header kept');
ok(M.stripJpeg(jpeg().subarray(0, 60)) === null, 'jpeg: truncated is refused');

// ---------- PNG ----------
const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const td = cat(enc(type), data); return cat(be32(data.length), td, be32(crc(td))); };
const png = (orient) => cat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10), chunk('IHDR', cat(be32(64), be32(48), Uint8Array.of(8, 6, 0, 0, 0))),
  chunk('tEXt', enc('Author\0Jane Roe')), chunk('tIME', new Uint8Array(7).fill(9)), chunk('pHYs', new Uint8Array(9)),
  chunk('eXIf', cat(enc('II'), Uint8Array.of(42, 0), le32(8), Uint8Array.of(1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, orient, 0, 0, 0), le32(0))),
  chunk('iTXt', enc('XML:com.adobe.xmp\0\0\0\0\0<x>GPSsecret</x>')), chunk('gAMA', be32(45455)), chunk('IDAT', Uint8Array.of(1, 2, 3, 4, 5)), chunk('IEND', new Uint8Array(0)), enc('TRAILING-DATA'));
r = M.stripPng(png(1));
ok(r && r.width === 64 && r.height === 48 && r.orientation === 1 && r.alpha, 'png: size, orientation, alpha read');
ok(r && !['Jane Roe', 'GPSsecret', 'TRAILING', 'tIME', 'eXIf', 'tEXt', 'iTXt', 'pHYs'].some((s) => has(r.bytes, s)), 'png: text, time, Exif, XMP, trailer gone');
ok(r && has(r.bytes, 'IDAT') && has(r.bytes, 'gAMA') && has(r.bytes, 'IEND'), 'png: picture chunks kept');
ok(M.needsRedraw(M.stripPng(png(3))), 'png: turned picture is drawn again');
ok(M.stripPng(png(1).subarray(0, 50)) === null, 'png: truncated is refused');

// ---------- GIF ----------
const sub = (b) => cat(Uint8Array.of(b.length), b, Uint8Array.of(0));
const gif = cat(enc('GIF89a'), Uint8Array.of(8, 0, 8, 0, 0x80, 0, 0), new Uint8Array(6).fill(5),
  Uint8Array.of(0x21, 0xff, 11), enc('NETSCAPE2.0'), Uint8Array.of(3, 1, 0, 0, 0),
  Uint8Array.of(0x21, 0xfe), sub(enc('camera: Pixel 9, Berlin')), Uint8Array.of(0x21, 0xff, 11), enc('XMP DataXMP'), sub(enc('<x>GPSsecret</x>')),
  Uint8Array.of(0x21, 0xf9, 4, 0, 10, 0, 0, 0), Uint8Array.of(0x2c, 0, 0, 0, 0, 8, 0, 8, 0, 0), Uint8Array.of(2), sub(Uint8Array.of(1, 2, 3)),
  Uint8Array.of(0x21, 0xf9, 4, 0, 10, 0, 0, 0), Uint8Array.of(0x2c, 0, 0, 0, 0, 8, 0, 8, 0, 0), Uint8Array.of(2), sub(Uint8Array.of(4, 5, 6)),
  Uint8Array.of(0x3b), enc('AFTER'));
r = M.stripGif(gif);
ok(r && r.width === 8 && !['camera', 'Pixel', 'GPSsecret', 'XMP Data', 'AFTER'].some((s) => has(r.bytes, s)), 'gif: comment, XMP block, trailer gone');
ok(r && has(r.bytes, 'NETSCAPE2.0') && r.bytes.filter((v, i, a) => v === 0x2c && a[i + 5] === 8).length === 2, 'gif: loop count and both frames kept');
ok(M.stripGif(gif.subarray(0, 40)) === null, 'gif: truncated is refused');

// ---------- WebP ----------
const rc = (t, d) => cat(enc(t), le32(d.length), d, d.length & 1 ? Uint8Array.of(0) : new Uint8Array(0));
const vp8x = Uint8Array.of(0x08 | 0x04 | 0x10, 0, 0, 0, 0x3f, 0, 0, 0x2f, 0, 0);
const vp8 = cat(Uint8Array.of(0, 0, 0, 0x9d, 0x01, 0x2a, 64, 0, 48, 0), new Uint8Array(6));
const webpBody = cat(enc('WEBP'), rc('VP8X', vp8x), rc('EXIF', cat(enc('Exif\0\0'), exifTiff(1).subarray(6), enc('webpGPS'))), rc('XMP ', enc('<x>xmpsecret</x>')), rc('VP8 ', vp8));
const webp = cat(enc('RIFF'), le32(webpBody.length), webpBody);
r = M.stripWebp(webp);
ok(r && !has(r.bytes, 'webpGPS') && !has(r.bytes, 'xmpsecret') && !has(r.bytes, 'EXIF') && has(r.bytes, 'VP8 '), 'webp: Exif and XMP gone, picture kept');
ok(r && (r.bytes[20] & 0x0c) === 0 && (r.bytes[20] & 0x10), 'webp: header flags cleared');
ok(r && r.bytes[4] + (r.bytes[5] << 8) + (r.bytes[6] << 16) === r.bytes.length - 8, 'webp: size field matches');

// ---------- MP4 / MOV ----------
const box = (t, ...p) => { const d = cat(...p); return cat(be32(8 + d.length), enc(t), d); };
const full = (v, n) => cat(Uint8Array.of(v, 0, 0, 0), n);
const times = Uint8Array.of(0xd2, 0xd2, 0xd2, 0xd2, 0xd2, 0xd2, 0xd2, 0xd3);
const trak = (h, name) => box('trak', box('tkhd', full(0, cat(times, new Uint8Array(70)))), box('mdia', box('mdhd', full(0, cat(times, new Uint8Array(12)))), box('hdlr', full(0, cat(new Uint8Array(4), enc(h), new Uint8Array(12), enc(name)))), box('minf')), box('udta', box('\xa9xyz', enc('+48.8566+002.3522/'))));
const mdatBytes = enc('PICTURE-AND-SOUND-DATA');
const mp4 = cat(box('ftyp', enc('qt  '), new Uint8Array(4), enc('qt  ')),
  box('moov', box('mvhd', full(0, cat(times, new Uint8Array(80)))), trak('vide', 'Core Media Video'), trak('soun', 'Sound'), trak('meta', 'GPS track'),
    box('udta', box('\xa9mak', enc('Apple')), box('\xa9mod', enc('iPhone 16 Pro')), box('meta', enc('keys com.apple.quicktime.location'))), box('iods', new Uint8Array(8))),
  box('uuid', enc('XMP-UUID-GPSsecret')), box('free', enc('leftover-text')), box('mdat', mdatBytes));
r = M.stripMp4(mp4);
ok(r && r.bytes.length === mp4.length, 'mp4: same length (offsets stay valid)');
ok(r && !['Apple', 'iPhone', 'GPS track', 'Core Media', 'GPSsecret', 'leftover', 'location', '+48.85'].some((s) => has(r.bytes, s)), 'mp4: make, model, location, handler names, uuid, free text gone');
ok(r && has(r.bytes, 'PICTURE-AND-SOUND-DATA') && has(r.bytes, 'mdat') && has(r.bytes, 'vide') && has(r.bytes, 'soun'), 'mp4: media data and tracks kept');
ok(r && !has(r.bytes, Uint8Array.of(0xd2, 0xd2, 0xd2, 0xd2)), 'mp4: creation / modification times zeroed');
ok(r && (() => { const a = mp4.length - mdatBytes.length - 8; return same(r.bytes.subarray(a), mp4.subarray(a)); })(), 'mp4: mdat byte for byte equal');
ok(M.stripMp4(mp4.subarray(0, mp4.length - 5)) === null, 'mp4: a cut-off box is refused');

// ---------- WebM ----------
const vint = (n) => cat(Uint8Array.of(0x10 | (n >>> 24), (n >> 16) & 255, (n >> 8) & 255, n & 255));
const el = (idBytes, ...p) => { const d = cat(...p); return cat(Uint8Array.from(idBytes), vint(d.length), d); };
const webm = cat(el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], enc('webm'))),
  el([0x18, 0x53, 0x80, 0x67],
    el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], Uint8Array.of(0x0f, 0x42, 0x40)), el([0x4d, 0x80], enc('libwebm-secret')), el([0x57, 0x41], enc('Chrome-writer')), el([0x7b, 0xa9], enc('My private title')), el([0x44, 0x61], new Uint8Array(8).fill(4))),
    el([0x16, 0x54, 0xae, 0x6b], el([0xae], el([0xd7], Uint8Array.of(1)), el([0x53, 0x6e], enc('Front camera track')))),
    el([0x12, 0x54, 0xc3, 0x67], el([0x73, 0x73], el([0x45, 0xa3], enc('LOCATION')))),
    el([0x1f, 0x43, 0xb6, 0x75], el([0xe7], Uint8Array.of(0)), el([0xa3], enc('FRAMEDATA')))));
r = M.stripWebm(webm);
ok(r && r.bytes.length === webm.length, 'webm: same length');
ok(r && !['libwebm-secret', 'Chrome-writer', 'My private title', 'Front camera', 'LOCATION'].some((s) => has(r.bytes, s)), 'webm: writer, title, track name, tags gone');
ok(r && has(r.bytes, 'FRAMEDATA') && has(r.bytes, 'webm'), 'webm: frames and doc type kept');
ok(M.stripWebm(webm.subarray(0, webm.length - 6)) === null, 'webm: a cut-off element is refused');

// ---------- MP3 ----------
const mp3 = cat(enc('ID3'), Uint8Array.of(3, 0, 0, 0, 0, 0, 20), enc('TIT2Secret title.....'.slice(0, 20)), Uint8Array.of(0xff, 0xfb, 0x90, 0x00), new Uint8Array(40).fill(1), enc('TAG'), new Uint8Array(125).fill(0x41));
r = M.stripMp3(mp3);
ok(r && r.bytes[0] === 0xff && r.bytes.length === 44 && !has(r.bytes, 'Secret'), 'mp3: ID3v2 and ID3v1 tags gone, audio kept');

// ---------- decisions and names ----------
let c = M.cleanBytes(jpeg(), 'image'); ok(c && c.name === 'photo.jpg' && c.mime === 'image/jpeg', 'name: neutral photo name');
c = M.cleanBytes(mp4, 'video'); ok(c && c.name === 'video.mov' && c.mime === 'video/mp4', 'name: neutral video name', c && c.name);
ok(M.cleanBytes(enc('not media at all'), 'image') === null && M.cleanBytes(enc('not media at all'), 'video') === null, 'unknown formats are never passed on');
ok(M.cleanBytes(jpeg(), 'video') === null, 'a photo sent as video is refused');

// ---------- hostile input: never throws, never hangs, never returns something larger than the input ----------
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let bad = 0;
for (const [name, src, fn] of [['jpeg', jpeg(), M.stripJpeg], ['png', png(1), M.stripPng], ['gif', gif, M.stripGif], ['webp', webp, M.stripWebp], ['mp4', mp4, M.stripMp4], ['webm', webm, M.stripWebm], ['mp3', mp3, M.stripMp3]]) {
  for (let n = 0; n < 400; n++) {
    const b = src.slice(); const k = 1 + Math.floor(rnd() * 4);
    for (let j = 0; j < k; j++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    const cut = rnd() < 0.3 ? b.subarray(0, Math.floor(rnd() * b.length)) : b;
    try { const o = fn(cut); if (o && o.bytes.length > cut.length + 16) bad++; } catch (e) { bad++; console.log(name, 'threw', e.message); }
  }
}
ok(bad === 0, 'fuzz: 2800 damaged files, no exception, no growth', bad);

console.log(`${pass} passed, ${fail} failed`); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
