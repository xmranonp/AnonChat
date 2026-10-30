"""F-2 in a real browser: photos are cleaned for real, and how much quality is kept."""
import http.server, threading, socket, os, io, sys, json, base64, math
from PIL import Image, ImageDraw, ImageFilter
from playwright.sync_api import sync_playwright
ROOT = os.path.join(os.path.dirname(__file__), '..', '..', 'public')
def port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
P = port()
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(s, *a): pass
    def guess_type(s, path): return 'text/javascript' if path.endswith('.js') else super().guess_type(path)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', P), H); threading.Thread(target=srv.serve_forever, daemon=True).start()

def scene(w, h):                       # a detailed picture, so quality loss would show
    im = Image.new('RGB', (w, h)); d = ImageDraw.Draw(im)
    for y in range(0, h, 4): d.line([(0, y), (w, (y * 7) % w)], fill=((y * 3) % 255, (y * 5) % 255, (y * 11) % 255), width=2)
    for x in range(0, w, 37): d.ellipse([x, h // 3, x + 60, h // 3 + 60], outline=(255, 255, 255), width=3)
    d.text((40, 40), 'AnonChat test picture 0123456789', fill=(255, 255, 0))
    return im.filter(ImageFilter.GaussianBlur(0.6))
def exif_bytes(orient):
    e = Image.Exif(); e[0x010F] = 'Canon'; e[0x0110] = 'EOS R5'; e[0x0112] = orient; e[0x0132] = '2026:10:01 14:30:00'
    gps = e.get_ifd(0x8825); gps[1] = 'N'; gps[2] = (48.0, 51.0, 24.0); gps[3] = 'E'; gps[4] = (2.0, 21.0, 8.0)
    return e.tobytes()
def jpeg(im, orient=1, q=95):
    b = io.BytesIO(); im.save(b, 'JPEG', quality=q, exif=exif_bytes(orient)); return b.getvalue()
def psnr(a, b):
    a = a.convert('RGB'); b = b.convert('RGB')
    if a.size != b.size: b = b.resize(a.size)
    pa, pb = a.tobytes(), b.tobytes(); mse = sum((x - y) ** 2 for x, y in zip(pa[::7], pb[::7])) / len(pa[::7])
    return 99 if mse == 0 else 10 * math.log10(255 * 255 / mse)
ok = True; N = [0, 0]
def R(name, c, extra=''):
    global ok; ok &= bool(c); N[0] += bool(c); N[1] += 1; print(('PASS ' if c else 'FAIL ') + name, '' if c else extra)
JS = """async ([b64, kind, type]) => {
  const m = await import('/mediaclean.js');
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const o = await m.cleanForSending(new Blob([bin], {type}), kind);
  const out = new Uint8Array(await o.blob.arrayBuffer());
  let s = ''; for (let i = 0; i < out.length; i += 8192) s += String.fromCharCode(...out.subarray(i, i + 8192));
  return { b64: btoa(s), name: o.name, how: o.how, type: o.blob.type };
}"""
def clean(pg, data, kind='image', type='image/jpeg'):
    r = pg.evaluate(JS, [base64.b64encode(data).decode(), kind, type]); return base64.b64decode(r['b64']), r
def tags(data):
    try: e = Image.open(io.BytesIO(data)).getexif(); return dict(e), bool(e.get_ifd(0x8825))
    except Exception: return {}, False
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(); pg.goto(f'http://127.0.0.1:{P}/index.html'); pg.wait_for_timeout(300)
    base = scene(1600, 1200)
    # 1. upright JPEG: cut, not re-encoded; the pixels are identical
    src = jpeg(base, 1); out, r = clean(pg, src)
    t, gps = tags(out)
    R('upright jpeg: no Exif / GPS left', not t and not gps, (t, gps))
    R('upright jpeg: neutral name and type', r['name'] == 'photo.jpg' and r['type'] == 'image/jpeg' and r['how'] == 'stripped', r)
    R('upright jpeg: pixels identical to the original', list(Image.open(io.BytesIO(out)).convert('RGB').getdata()) == list(Image.open(io.BytesIO(src)).convert('RGB').getdata()))
    R('upright jpeg: smaller than the original (only metadata cut)', len(out) < len(src))
    R('upright jpeg: none of the metadata strings remain', all(s not in out for s in (b'Canon', b'EOS R5', b'2026:10')))
    # 2. photo turned by its tag: drawn again, upright, at high quality
    import random; random.seed(3)
    def natural(w, h):                  # smooth colour areas, soft edges and light grain, like a camera picture
        small = Image.effect_noise((w // 40, h // 40), 90).convert('RGB') if False else Image.new('RGB', (w // 40, h // 40))
        px = small.load()
        for x in range(small.width):
            for y in range(small.height): px[x, y] = (random.randrange(256), random.randrange(256), random.randrange(256))
        im = small.resize((w, h), Image.BICUBIC).filter(ImageFilter.GaussianBlur(2))
        grain = Image.effect_noise((w, h), 6).convert('RGB')
        return Image.blend(im, grain, 0.04)
    for label, scn in (('photo-like', natural(1600, 1200)), ('worst case (fine lines)', base)):
        turned = scn.rotate(90, expand=True)
        src = jpeg(turned, 6, 95); out, r = clean(pg, src)
        im = Image.open(io.BytesIO(out)); t, gps = tags(out)
        seen = Image.open(io.BytesIO(src)).transpose(Image.ROTATE_270)          # what a viewer shows for the original file
        R(f'turned jpeg ({label}): no Exif left, drawn again, upright', not t and not gps and r['how'] == 'redrawn' and im.size == seen.size, (r, im.size, seen.size))
        q = psnr(seen, im); print(f'   {label}: output vs what the original shows: {q:.1f} dB; file {len(src)//1024} KB -> {len(out)//1024} KB')
        R(f'turned jpeg ({label}): quality kept', q > (40 if label == 'photo-like' else 33), q)
    # 3. huge photo: shrunk to 4096 on the long edge
    big = scene(6000, 4000); src = jpeg(big, 1, 92); out, r = clean(pg, src)
    im = Image.open(io.BytesIO(out))
    R('6000x4000 photo: long edge 4096 and under 5 MB', max(im.size) == 4096 and len(out) <= 5 * 1024 * 1024, (im.size, len(out)))
    R('6000x4000 photo: no Exif', not tags(out)[0])
    # 4. PNG with text chunks and transparency
    a = Image.new('RGBA', (300, 200), (0, 0, 0, 0)); ImageDraw.Draw(a).ellipse([20, 20, 200, 160], fill=(255, 0, 0, 255)); a.putpixel((5, 5), (0, 255, 0, 128))
    from PIL.PngImagePlugin import PngInfo
    meta = PngInfo(); meta.add_text('Author', 'Jane Roe'); meta.add_text('GPS', '48.85,2.35')
    bb = io.BytesIO(); a.save(bb, 'PNG', pnginfo=meta); src = bb.getvalue()
    out, r = clean(pg, src, 'image', 'image/png')
    R('png: text gone, still PNG, pixels and transparency identical', b'Jane Roe' not in out and b'tEXt' not in out and list(Image.open(io.BytesIO(out)).convert('RGBA').getdata()) == list(a.getdata()) and r['name'] == 'photo.png', r)
    # 5. formats that are drawn again: BMP, and a PNG with transparency made smaller
    bb = io.BytesIO(); base.resize((400, 300)).save(bb, 'BMP'); out, r = clean(pg, bb.getvalue(), 'image', 'image/bmp')
    R('bmp: becomes a clean JPEG', Image.open(io.BytesIO(out)).format == 'JPEG' and r['how'] == 'redrawn', r)
    # 6. not an image at all, sent as image: refused
    try: clean(pg, b'hello this is not a picture', 'image', 'image/jpeg'); R('garbage sent as image is refused', False)
    except Exception as e: R('garbage sent as image is refused', 'media cleanup failed' in str(e), str(e)[:200])
    try: clean(pg, b'hello this is not a video', 'video', 'video/mp4'); R('garbage sent as video is refused', False)
    except Exception as e: R('garbage sent as video is refused', 'media cleanup failed' in str(e), str(e)[:200])
    # 7. ordinary files are not touched
    out, r = clean(pg, b'%PDF-1.4 anything', 'file', 'application/pdf'); R('other files are sent as they are', out == b'%PDF-1.4 anything' and r['name'] is None)
    b.close()
srv.shutdown()
print(f'{N[0]}/{N[1]}'); sys.exit(0 if ok else 1)
