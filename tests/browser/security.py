"""Encryption on this device, end to end: a real server.js given a data key over stdin, and the real page in Chromium with the desktop
app's preload API stubbed (vault mode / passphrase mode)."""
import subprocess, os, sys, time, json, tempfile, base64, shutil
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
    // As the desktop app does: in passphrase mode the one in use now must be given, and must be right.
    setPassphrase: async (p, current) => { if (st().mode === 'passphrase' && current !== st().pass) return { error: 'wrong' }; put({ mode: 'passphrase', pass: p }); return { ok: true }; },
    verifyPassphrase: async (p) => (p === st().pass ? { ok: true } : { error: 'wrong' }),
    useOsVault: async (current) => { if (st().mode === 'passphrase' && current !== st().pass) return { error: 'wrong' }; put({ mode: 'os' }); return { ok: true }; },
  };
})();""" % WKEY

def pin(pg, digits='123456', confirm=True):
    for dg in digits: pg.click(f'.pin-key:text-is("{dg}")')
    pg.wait_for_timeout(400)
    if confirm:
        for dg in digits: pg.click(f'.pin-key:text-is("{dg}")')
        pg.wait_for_timeout(400)

srv = start()
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx = b.new_context(viewport={'width': 1180, 'height': 780})
        ctx.add_init_script(STUB)
        pg = ctx.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(f'http://127.0.0.1:6401/?t={TOKEN}')
        w = pg.evaluate("fetch('/api/whoami').then(r => r.json())")
        check('whoami reports the store readable and encrypted', w.get('storeOk') is True and w.get('encryptedAtRest') is True, w)
        pg.wait_for_selector('.welcome-cta'); pg.wait_for_timeout(300); pg.click('.welcome-cta'); pg.wait_for_timeout(300)
        pin(pg)
        pg.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000)
        check('new user: storage keyed by PIN + device share', pg.evaluate("localStorage.getItem('anyonechat.pin.kdf')") == '2')
        raw = open(d + '/data/identity.json', 'rb').read()
        check('backend files are written sealed', raw[:4] == b'ACE1' and b'ecdhPub' not in raw)
        # The PIN alone (old scheme) can no longer open the stored keys
        pinOnly = pg.evaluate("""(async () => {
          const salt = localStorage.getItem('anyonechat.pin.salt'), iter = +localStorage.getItem('anyonechat.pin.iter');
          const km = await crypto.subtle.importKey('raw', new TextEncoder().encode('123456'), 'PBKDF2', false, ['deriveKey']);
          const dec = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
          const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: dec(salt), iterations: iter, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
          try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv: dec(localStorage.getItem('anyonechat.ik.iv')) }, key, dec(localStorage.getItem('anyonechat.ik.ct'))); return 'opened'; }
          catch { return 'refused'; } })()""")
        check('a copy of the storage can’t be opened with the PIN alone', pinOnly == 'refused')
        # Settings: Security card
        pg.click('#settings-btn'); pg.wait_for_timeout(400)
        card = pg.inner_text('.sec-card')
        check('Settings shows “Encrypted on this device”, kept by Windows, unlocked by PIN', 'Encrypted on this device' in card and 'Windows' in card and 'PIN' in card, card)
        pg.screenshot(path=OUT + '/1-settings-security.png')
        # Switch to a passphrase
        pg.click('.set-pill:text-is("Use a passphrase…")'); pg.wait_for_timeout(300)
        pg.fill('.pass-dialog .pass-field >> nth=0 >> input', 'short pass')
        check('short passphrase: button stays disabled', pg.is_disabled('.pass-dialog .confirm-ok'))
        pg.fill('.pass-dialog .pass-field >> nth=0 >> input', 'correct horse battery staple')
        pg.fill('.pass-dialog .pass-field >> nth=1 >> input', 'correct horse battery staple')
        check('…still disabled until the no-recovery box is ticked', pg.is_disabled('.pass-dialog .confirm-ok'))
        pg.check('.pass-ack input')
        check('…and until the current PIN is typed', pg.is_disabled('.pass-dialog .confirm-ok'))
        pg.fill('.pass-dialog .cur-secret', '000000'); pg.click('.pass-dialog .confirm-ok'); pg.wait_for_timeout(1500)
        check('a wrong current PIN is refused, nothing changes', 'Incorrect PIN' in pg.inner_text('.pass-dialog .cur-secret-err') and pg.evaluate("localStorage.getItem('anyonechat.pin.kdf')") == '2')
        pg.fill('.pass-dialog .cur-secret', '123456')
        pg.screenshot(path=OUT + '/2-passphrase-dialog.png')
        pg.click('.pass-dialog .confirm-ok'); pg.wait_for_timeout(1500)
        check('passphrase on: storage moved to the device share alone', pg.evaluate("localStorage.getItem('anyonechat.pin.kdf')") == 'device')
        # Reload: passphrase mode, no PIN screen
        pg.reload(); pg.wait_for_timeout(2500)
        check('passphrase mode: no PIN screen after start', pg.evaluate("document.getElementById('pin-screen').classList.contains('gone')"))
        check('identity intact', pg.evaluate("!!document.querySelector('#me .me-addr')"))
        pg.click('#settings-btn'); pg.wait_for_timeout(400)
        card = pg.inner_text('.sec-card')
        check('Settings now says kept by / unlocked with your passphrase; no Change PIN', 'passphrase' in card.lower() and pg.locator('.set-pill:text-is("Change PIN")').count() == 0, card)
        pg.screenshot(path=OUT + '/3-settings-passphrase.png')
        # Change passphrase: only with the one in use now
        pg.click('.set-pill:text-is("Change passphrase…")'); pg.wait_for_timeout(300)
        pg.fill('.pass-dialog .pass-field >> nth=1 >> input', 'violet otter climbs nine ladders')
        pg.fill('.pass-dialog .pass-field >> nth=2 >> input', 'violet otter climbs nine ladders'); pg.check('.pass-ack input')
        check('Change passphrase asks for the current one first', pg.is_disabled('.pass-dialog .confirm-ok') and 'current passphrase' in pg.inner_text('.pass-dialog').lower(), pg.inner_text('.pass-dialog')[:200])
        pg.screenshot(path=OUT + '/3b-change-passphrase.png')
        pg.fill('.pass-dialog .cur-secret', 'not the passphrase'); pg.click('.pass-dialog .confirm-ok'); pg.wait_for_timeout(800)
        check('…a wrong one is refused and the passphrase stays', 'Wrong passphrase' in pg.inner_text('.pass-dialog .cur-secret-err') and pg.evaluate("JSON.parse(sessionStorage.getItem('__sec')).pass") == 'correct horse battery staple')
        pg.fill('.pass-dialog .cur-secret', 'correct horse battery staple'); pg.click('.pass-dialog .confirm-ok'); pg.wait_for_timeout(1200)
        check('…the right one changes it', pg.evaluate("JSON.parse(sessionStorage.getItem('__sec')).pass") == 'violet otter climbs nine ladders')
        # Back to the PIN: also only with the passphrase in use now
        if not pg.is_visible('.set-pill:text-is("Use the PIN instead")'):
            pg.keyboard.press('Escape'); pg.wait_for_timeout(300); pg.click('#settings-btn'); pg.wait_for_timeout(400)
        pg.click('.set-pill:text-is("Use the PIN instead")'); pg.wait_for_timeout(300)
        inputs = pg.locator('#usepin-overlay input:not(.cur-secret)')
        inputs.nth(0).fill('654321'); inputs.nth(1).fill('654321')
        pg.fill('#usepin-overlay .cur-secret', 'correct horse battery staple')      # the old one: no longer right
        pg.click('#usepin-overlay .confirm-ok'); pg.wait_for_timeout(1500)
        check('Use the PIN instead: a wrong passphrase is refused, storage untouched', 'Wrong passphrase' in pg.inner_text('#usepin-overlay .cur-secret-err') and pg.evaluate("localStorage.getItem('anyonechat.pin.kdf')") == 'device')
        pg.fill('#usepin-overlay .cur-secret', 'violet otter climbs nine ladders')
        pg.click('#usepin-overlay .confirm-ok'); pg.wait_for_timeout(2000)
        check('back to PIN + device share', pg.evaluate("localStorage.getItem('anyonechat.pin.kdf')") == '2')
        pg.reload(); pg.wait_for_selector('.pin-key'); pg.wait_for_timeout(500)
        pin(pg, '654321', confirm=False)
        pg.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000)
        check('the new PIN unlocks', pg.evaluate("document.getElementById('pin-screen').classList.contains('gone')"))
        check('no page errors', not errs, errs[:3])

        # Older install with PIN-only storage moves to PIN + device at the next unlock
        ctx2 = b.new_context(viewport={'width': 1180, 'height': 780})
        p2 = ctx2.new_page()
        p2.goto(f'http://127.0.0.1:6401/?t={TOKEN}')
        p2.wait_for_selector('.welcome-cta'); p2.wait_for_timeout(300); p2.click('.welcome-cta'); p2.wait_for_timeout(300)
        pin(p2, '111111')
        p2.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000)
        check('browser mode: PIN only (no device share)', p2.evaluate("localStorage.getItem('anyonechat.pin.kdf')") is None)
        p2.click('#settings-btn'); p2.wait_for_timeout(300)
        check('browser mode Settings warns: not fully encrypted', 'Not fully encrypted' in p2.inner_text('.sec-card'))
        b.close()
finally:
    srv.terminate(); srv.wait()

# Store error screen: wrong key at the next start
raw = open(d + '/data/identity.json', 'rb').read()
srv = start(os.urandom(32).hex())
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(); pg = b.new_page(viewport={'width': 1180, 'height': 780})
        pg.goto(f'http://127.0.0.1:6401/?t={TOKEN}'); pg.wait_for_timeout(1500)
        txt = pg.inner_text('#pin-screen')
        check('wrong key: “Couldn’t read saved data” instead of an empty app', 'read saved data' in txt and 'Nothing was changed' in txt, txt[:200])
        pg.click('.store-error-actions .btn:not(.primary)'); pg.wait_for_timeout(200)
        check('details name the file', '.json' in pg.inner_text('.store-error-details'))
        pg.screenshot(path=OUT + '/4-store-error.png')
        # The port itself is held (so no other program can take it), but nothing is accepted on it until the data reads.
        code = subprocess.run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', '-H', 'Host: ' + 'a' * 56 + '.anyone', '-H', 'Content-Type: application/json',
                               '-d', '{}', 'http://127.0.0.1:6402/api/inbox'], capture_output=True, text=True).stdout
        check('hidden service accepts nothing while the data can’t be read (its port held, every request turned away)', code == '503', code)
        b.close()
    check('nothing was overwritten', open(d + '/data/identity.json', 'rb').read() == raw)
finally:
    srv.terminate()
print(f"\n{sum(1 for r in results if r[1])}/{len(results)} passed")
