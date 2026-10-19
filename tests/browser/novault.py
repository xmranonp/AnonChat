"""Encryption on this device, end to end: a real server.js given a data key over stdin, and the real page in Chromium with the desktop
app's preload API stubbed (vault mode / passphrase mode)."""
import subprocess, os, sys, time, json, tempfile, base64, shutil, urllib.request
from playwright.sync_api import sync_playwright

import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import _args
APP, SHIM, OUT = _args.paths(__file__)
TOKEN = 'f' * 64; ADDR = 'c' * 56 + '.anyone'
KEY = os.urandom(32).hex()
WKEY = base64.b64encode(os.urandom(32)).decode()
d = tempfile.mkdtemp(prefix='sec-'); os.makedirs(d + '/anon/anon_service'); os.makedirs(d + '/data')
open(d + '/anon/anon_service/hostname', 'w').write(ADDR + '\n')

def start(key=KEY):
    env = dict(os.environ, NODE_PATH=SHIM, PUBLIC_PORT='6402', UI_PORT='6401', DATA_DIR=d + '/data', ANON_DIR=d + '/anon',
               ANONCHAT_UI_TOKEN=TOKEN, ANON_CTRL_PORT='1', PEERS='{}', ANONCHAT_KEY_STDIN='1')
    p = subprocess.Popen(['node', APP + '/server.js'], env=env, cwd=APP, stdin=subprocess.PIPE, stdout=open(d + '/log', 'a'), stderr=subprocess.STDOUT)
    p.stdin.write((key + '\n').encode()); p.stdin.close()
    time.sleep(1.8)
    return p

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok))); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  [' + str(detail) + ']'), flush=True)

STUB = """
(() => {
  const st = () => { try { return JSON.parse(sessionStorage.getItem('__sec') || '{}'); } catch { return {}; } };
  const put = (v) => sessionStorage.setItem('__sec', JSON.stringify({ ...st(), ...v }));
  window.electron = {
    setUnreadCount() {}, saveFile() {}, eraseEverything: async () => true,
    securityInfo: async () => ({ mode: st().mode || 'os', vault: 'windows', windowKey: '%s', minPassphrase: 12 }),
    setPassphrase: async (p) => { put({ mode: 'passphrase', pass: p }); return { ok: true }; },
    useOsVault: async () => { put({ mode: 'os' }); return { ok: true }; },
  };
})();""" % WKEY

def pin(pg, digits='123456', confirm=True):
    for dg in digits: pg.click(f'.pin-key:text-is("{dg}")')
    pg.wait_for_timeout(400)
    if confirm:
        for dg in digits: pg.click(f'.pin-key:text-is("{dg}")')
        pg.wait_for_timeout(400)


def published_ik():
    r = urllib.request.Request('http://127.0.0.1:6402/api/identity', headers={'Host': ADDR})
    return json.loads(urllib.request.urlopen(r, timeout=10).read())['ecdhPub']

srv = start()
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx = b.new_context(viewport={'width': 1180, 'height': 820})
        ctx.add_init_script("if (!sessionStorage.getItem('__sec')) sessionStorage.setItem('__sec', JSON.stringify({ mode: 'passphrase' }));")
        ctx.add_init_script(STUB)
        pg = ctx.new_page()
        pg.goto(f'http://127.0.0.1:6401/?t={TOKEN}')
        pg.wait_for_selector('.welcome-cta'); pg.wait_for_timeout(300); pg.click('.welcome-cta'); pg.wait_for_timeout(2500)
        pub1 = published_ik()
        for i in (2, 3):
            pg.reload(); pg.wait_for_timeout(2500)
            check(f'no keychain, start {i}: no welcome screen again', pg.locator('.welcome-cta').count() == 0)
            if pg.locator('.welcome-cta').count(): pg.click('.welcome-cta'); pg.wait_for_timeout(2500)
            check(f'no keychain, start {i}: same published identity key', published_ik() == pub1)
        b.close()
finally:
    srv.kill()
print(f"{sum(1 for _, o in results if o)}/{len(results)} passed")
