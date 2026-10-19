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
        ctx.add_init_script(STUB)
        pg = ctx.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(f'http://127.0.0.1:6401/?t={TOKEN}')
        pg.wait_for_selector('.welcome-cta'); pg.wait_for_timeout(300); pg.click('.welcome-cta'); pg.wait_for_timeout(400)
        link = pg.locator('#pin-screen .pin-alt').first
        check('first launch: the link is under the keypad', link.is_visible() and 'passphrase' in link.inner_text().lower(), link.inner_text() if link.count() else '')
        pg.screenshot(path=OUT + '/1-link.png')
        link.click(); pg.wait_for_timeout(300)
        check('it opens the passphrase form in place of the keypad', pg.is_visible('.pin-pass') and not pg.is_visible('.pin-pad') and pg.inner_text('#pin-sub') == 'Choose a passphrase')
        pg.keyboard.type('12'); pg.wait_for_timeout(100)
        check('typing digits fills the field, not the PIN', pg.input_value('.pin-pass .pass-field input >> nth=0') == '12' and pg.locator('.pin-dots span.filled').count() == 0)
        pg.click('.pin-pass .pin-alt'); pg.wait_for_timeout(200)
        check('“Use a PIN instead” goes back to the keypad, form cleared', pg.is_visible('.pin-pad') and not pg.is_visible('.pin-pass') and pg.inner_text('#pin-sub') == 'Set a PIN to protect this device')
        link.click(); pg.wait_for_timeout(200)
        check('…and the field starts empty again', pg.input_value('.pin-pass .pass-field input >> nth=0') == '')
        go = pg.locator('.pin-go')
        pg.fill('.pin-pass .pass-field input >> nth=0', 'short')
        check('too short: can’t continue', go.is_disabled())
        P = 'river lantern copper autumn'
        pg.fill('.pin-pass .pass-field input >> nth=0', P); pg.fill('.pin-pass .pass-field input >> nth=1', P)
        check('strong and repeated, but not acknowledged: can’t continue', go.is_disabled())
        pg.check('.pin-pass .pass-ack input')
        check('acknowledged: can continue', not go.is_disabled())
        pg.screenshot(path=OUT + '/2-filled.png')
        pg.press('.pin-pass .pass-field input >> nth=1', 'Enter')
        pg.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000)
        st = pg.evaluate("JSON.parse(sessionStorage.getItem('__sec') || '{}')")
        check('the desktop app was asked to switch to the passphrase', st.get('mode') == 'passphrase' and st.get('pass') == P, st)
        check('storage is keyed without a PIN', pg.evaluate("localStorage.getItem('anyonechat.pin.kdf')") == 'device' and not pg.evaluate("localStorage.getItem('anyonechat.pin.salt')"))
        pg.wait_for_timeout(1500)
        addr = pg.evaluate("fetch('/api/whoami').then(r => r.json()).then(j => j.address)")
        pg.click('#settings-btn'); pg.wait_for_timeout(400)
        card = pg.inner_text('.sec-card')
        check('Settings shows the passphrase', 'passphrase' in card.lower() and 'PIN' not in card, card)
        pg.screenshot(path=OUT + '/3-settings.png')
        # Next start (the start screen already took the passphrase): straight in, no PIN screen, identity readable
        ik = pg.evaluate("localStorage.getItem('anyonechat.ik.ct')"); pub1 = published_ik()
        pg.reload(); pg.wait_for_timeout(2500)
        check('next start: the published identity key is unchanged', published_ik() == pub1)
        check('next start: no PIN screen, same identity, nothing unreadable', pg.evaluate("document.getElementById('pin-screen').classList.contains('gone')")
              and pg.is_visible('#settings-btn') and pg.locator('.store-error').count() == 0 and pg.evaluate("localStorage.getItem('anyonechat.ik.ct')") == ik)
        pg.screenshot(path=OUT + '/4-next-start.png')
        check('no page errors', not errs, errs)
        pg.reload(); pg.wait_for_timeout(2500)
        check('third start: still the same identity, still no welcome screen', published_ik() == pub1 and pg.locator('.welcome-cta').count() == 0)
        # A PIN-mode first launch elsewhere is unchanged, and the link is absent without the desktop app
        ctx2 = b.new_context(viewport={'width': 1180, 'height': 820}); pg2 = ctx2.new_page()
        pg2.goto(f'http://127.0.0.1:6401/?t={TOKEN}')
        pg2.wait_for_timeout(1500)
        if pg2.locator('.welcome-cta').count(): pg2.click('.welcome-cta'); pg2.wait_for_timeout(300)
        check('browser mode (no desktop app): no passphrase link', pg2.locator('#pin-screen .pin-alt').count() == 0)
        b.close()
finally:
    srv.kill()
print(f"{sum(1 for _, o in results if o)}/{len(results)} passed")
