#!/usr/bin/env python3
"""Shrinks the emoji and flag images to 256-colour PNGs (about a quarter of the size, no visible difference at 28-56 px).
Usage: python3 -I tools/compress-pngs.py <emoji folder> <flags folder>
Flags are first cropped to the flag itself (the pack draws them on a square canvas). An image that would lose visible quality stays full colour."""
import io, os, sys
import numpy as np
from PIL import Image

MAX_ERROR = 4.5      # mean colour error per pixel (0-255) above which an image keeps full colour


def squeeze(im):
    q = im.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    buf = io.BytesIO(); q.save(buf, 'PNG', optimize=True)
    back = np.array(Image.open(io.BytesIO(buf.getvalue())).convert('RGBA'), dtype=int)
    a = np.array(im, dtype=int)
    seen = np.maximum(a[..., 3], back[..., 3]) > 0
    err = float(np.abs(a - back)[seen][:, :3].mean()) if seen.any() else 0.0
    return buf.getvalue(), err


def run(folder, crop):
    kept_full = total = 0
    before = after = 0
    worst = 0.0
    for name in sorted(os.listdir(folder)):
        if not name.endswith('.png'): continue
        path = os.path.join(folder, name)
        im = Image.open(path).convert('RGBA')
        before += os.path.getsize(path)
        if crop:
            box = im.getchannel('A').getbbox()
            if not box: raise SystemExit(f'{name} is empty')
            im = im.crop(box)
        data, err = squeeze(im)
        if err > MAX_ERROR:
            buf = io.BytesIO(); im.save(buf, 'PNG', optimize=True); data = buf.getvalue(); kept_full += 1
        else:
            worst = max(worst, err)
        with open(path, 'wb') as f: f.write(data)
        after += len(data); total += 1
    return total, kept_full, before, after, worst


if len(sys.argv) != 3: raise SystemExit(__doc__)
for label, folder, crop in (('emoji', sys.argv[1], False), ('flags', sys.argv[2], True)):
    n, full, b, a, w = run(folder, crop)
    print(f'{label}: {n} images, {b / 1048576:.1f} MB -> {a / 1048576:.1f} MB ({100 * a // max(b, 1)}%), worst colour error {w:.1f}/255, {full} kept in full colour')
