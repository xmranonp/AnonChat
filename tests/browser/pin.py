import subprocess, os, sys, time, json, tempfile, shutil
from playwright.sync_api import sync_playwright
import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import _args
APP, SHIM, OUT = _args.paths(__file__); TOKEN = 'f' * 64
N = {'a': ('c' * 56 + '.anyone', 6101, 6102), 'b': ('b' * 56 + '.anyone', 6201, 6202)}
PEERS = json.dumps({v[0]: v[2] for v in N.values()}); procs = []; dirs = []
import base64
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization
def p256():   # a real P-256 public key, raw and base64 (keys that aren't points on the curve are refused)
    return base64.b64encode(ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)).decode()
import sys as _s, os as _o; _s.path.insert(0, _o.path.dirname(_o.path.abspath(__file__))); import fsocks; fsocks.start(PEERS)
for k, (addr, ui, pub) in N.items():
    d = tempfile.mkdtemp(); dirs.append(d); os.makedirs(d + '/anon/anon_service'); os.makedirs(d + '/data')
    open(d + '/anon/anon_service/hostname', 'w').write(addr + '\n')
    if k == 'b': open(d + '/data/identity.json', 'w').write(json.dumps({'ecdhPub': p256(), 'ratchetPub': p256()}))   # no window runs for b: real keys, no chat
    procs.append(subprocess.Popen(['node', APP + '/server.js'], cwd=APP, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=dict(os.environ, NODE_PATH=SHIM, PUBLIC_PORT=str(pub), UI_PORT=str(ui), DATA_DIR=d + '/data', ANON_DIR=d + '/anon', ANONCHAT_UI_TOKEN=TOKEN, ANON_CTRL_PORT='1', PEERS=PEERS)))
time.sleep(2); R = []
def check(n, ok, d=''): R.append(ok); print(('PASS ' if ok else 'FAIL ') + n + ('' if ok else f'  [{d}]'))
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME); pg = b.new_context(viewport={'width': 1180, 'height': 760}).new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(f'http://127.0.0.1:6101/?t={TOKEN}'); pg.wait_for_selector('.welcome-cta'); pg.click('.welcome-cta')
        for _ in range(2):
            for dg in '123456': pg.click(f'.pin-key:text-is("{dg}")')
            pg.wait_for_timeout(300)
            if pg.is_visible('#pin-ok'):
                try: pg.click('#pin-ok', timeout=500)
                except Exception: pass
            pg.wait_for_timeout(500)
        pg.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000)
        pg.click('#add-contact-btn'); pg.fill('#in-petname', 'Bob'); pg.fill('#in-address', N['b'][0]); pg.click('#add-confirm'); pg.wait_for_timeout(1500)
        row = pg.locator('#contacts .contact').first
        row.hover(); pg.wait_for_timeout(300)
        check('no pin button on a contact row, even on hover', pg.locator('#contacts .contact-pin, #contacts .contact button').count() == 0)
        check('unpinned row shows no pin mark', pg.locator('#contacts .pin-mark').count() == 0)
        row.click(button='right'); pg.wait_for_timeout(200)
        check('right-click offers Pin to top', 'Pin to top' in pg.inner_text('#ctx-menu'))
        pg.click('#ctx-menu >> text=Pin to top'); pg.wait_for_timeout(300)
        check('pinned row shows the pin mark', pg.locator('#contacts .pin-mark').count() == 1)
        pg.screenshot(path=OUT + '/pin-mark.png')
        pg.locator('#contacts .contact').first.click(button='right'); pg.wait_for_timeout(200)
        check('right-click then offers Unpin', 'Unpin' in pg.inner_text('#ctx-menu'))
        pg.click('#ctx-menu >> text=Unpin'); pg.wait_for_timeout(300)
        check('unpinning removes the mark', pg.locator('#contacts .pin-mark').count() == 0)
        check('no page errors', not errs, errs[:3])
finally:
    for p in procs: p.kill()
    for d in dirs: shutil.rmtree(d, ignore_errors=True)
print(f'{sum(R)}/{len(R)}')
