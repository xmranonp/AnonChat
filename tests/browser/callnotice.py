"""Incoming-call system notices: shown while the window is in the background, taken away when the call ends, a missed-call notice, the Show setting.
Two real server.js nodes and two real windows in Chromium."""
import subprocess, os, sys, time, json, tempfile, base64, struct, zlib
from playwright.sync_api import sync_playwright

import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import _args
APP, SHIM, OUT = _args.paths(__file__)
os.makedirs(OUT, exist_ok=True)
TOKEN = 'f' * 64
NODES = {
    'ana':  {'addr': 'c' * 56 + '.anyone', 'ui': 6701, 'pub': 6702},
    'bob':  {'addr': 'b' * 56 + '.anyone', 'ui': 6801, 'pub': 6802},
}
PEERS = json.dumps({n['addr']: n['pub'] for n in NODES.values()})
import sys as _s, os as _o; _s.path.insert(0, _o.path.dirname(_o.path.abspath(__file__))); import fsocks; fsocks.start(PEERS)
procs, dirs = [], []
for name, n in NODES.items():
    d = tempfile.mkdtemp(prefix='cn-' + name + '-'); dirs.append(d); n['dir'] = d
    os.makedirs(d + '/anon/anon_service'); os.makedirs(d + '/data')
    open(d + '/anon/anon_service/hostname', 'w').write(n['addr'] + '\n')
    env = dict(os.environ, NODE_PATH=SHIM, PUBLIC_PORT=str(n['pub']), UI_PORT=str(n['ui']), DATA_DIR=d + '/data', ANON_DIR=d + '/anon',
               ANONCHAT_UI_TOKEN=TOKEN, ANON_CTRL_PORT='1', PEERS=PEERS, RL_BURST='1000', RL_PER_MIN='10000')
    procs.append(subprocess.Popen(['node', APP + '/server.js'], env=env, cwd=APP, stdout=open(d + '/log', 'w'), stderr=subprocess.STDOUT))
time.sleep(2)

def png(color):
    w = h = 64
    raw = b''.join(b'\x00' + bytes(color) * w for _ in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  [' + str(detail) + ']'), flush=True)
def wait(pg, js, ms=20000):
    end = time.time() + ms / 1000
    while time.time() < end:
        try:
            v = pg.evaluate(js)
            if v: return v
        except Exception: pass
        time.sleep(0.25)
    return None

errs = []
def prep(ctx, n, tag):
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append(tag + ': ' + str(e)))
    pg.on('console', lambda m: errs.append(tag + ' console: ' + m.text) if m.type == 'error' else None)
    pg.goto(f"http://127.0.0.1:{n['ui']}/?t={TOKEN}")
    return pg
def login(pg):
    pg.wait_for_selector('.welcome-cta'); pg.wait_for_timeout(300)
    pg.click('.welcome-cta')
    for _ in range(2):
        for dg in '123456': pg.click(f'.pin-key:text-is("{dg}")')
        pg.wait_for_timeout(300)
        if pg.is_visible('#pin-ok'):
            try: pg.click('#pin-ok', timeout=500)
            except Exception: pass
        pg.wait_for_timeout(500)
    pg.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000)
def add_contact(pg, name, addr):
    pg.click('#add-contact-btn'); pg.fill('#in-petname', name); pg.fill('#in-address', addr); pg.click('#add-confirm'); pg.wait_for_timeout(1200)
def send(pg, text):
    pg.fill('#msg-input', text); pg.press('#msg-input', 'Enter'); pg.wait_for_timeout(600)
def open_group(pg):
    pg.click('#groups .contact'); pg.wait_for_timeout(400)
def bubbles(pg):
    return pg.evaluate("[...document.querySelectorAll('#conv-body .bubble-text')].map(e => e.textContent)")


STUB = """window.__notes = []; window.__closed = []; window.electron = { notify: (n) => window.__notes.push(n), closeNotice: (t) => window.__closed.push(t),
  onNoticeClick: (cb) => { window.__click = cb; }, setUnreadCount: () => {}, setLanguage: () => {} };"""
ANA = NODES['ana']['addr']
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME,
                               args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        ctx = {k: b.new_context(viewport={'width': 1180, 'height': 780}, permissions=['microphone']) for k in NODES}
        ctx['bob'].add_init_script(STUB)
        P = {k: prep(ctx[k], NODES[k], k) for k in NODES}
        for k in NODES: login(P[k])
        ana, bob = P['ana'], P['bob']
        add_contact(ana, 'Bob', NODES['bob']['addr']); add_contact(bob, 'Ana', ANA)
        ana.click('#contacts .contact:has-text("Bob")'); ana.wait_for_timeout(400); send(ana, 'hi bob')
        bob.click('#contacts .contact:has-text("Ana")'); bob.wait_for_timeout(400)
        wait(bob, "document.getElementById('conv-body').innerText.includes('hi bob')", 40000)
        send(bob, 'hi ana'); wait(ana, "document.getElementById('conv-body').innerText.includes('hi ana')", 40000)
        bob.evaluate("document.hasFocus = () => false; window.__notes.length = 0")   # Bob's window is minimized

        # 1. Ana calls, then hangs up before Bob answers
        ana.click('.conv-call')
        n = wait(bob, "window.__notes.find(n => n.tag && n.tag.startsWith('call:'))", 40000)
        check('minimized: an incoming call shows a system notice', n, bob.evaluate("window.__notes"))
        check('…naming the caller and saying it is a voice call', n and n['title'] == 'Ana' and n['body'] == 'Incoming voice call', n)
        check('…tagged with the caller, so it can be taken away', n and n['tag'] == 'call:' + ANA)
        ana.locator('#call-dock .call-btn.decline').first.click()
        check('caller hangs up: the notice is taken away', wait(bob, f"window.__closed.includes('call:{ANA}')", 30000), bob.evaluate("window.__closed"))
        bob.wait_for_timeout(3000)

        # 2. Clicking the notice opens Ana's chat
        bob.click('#settings-btn') if False else None
        ana.click('.conv-call')
        wait(bob, "window.__notes.filter(n => n.tag === 'call:" + ANA + "').length === 2", 40000)
        bob.evaluate("selected = null") if False else None
        bob.click('#contacts .contact:has-text("Ana")') if False else None
        bob.evaluate("document.getElementById('conv-head').innerHTML = ''")
        bob.evaluate(f"window.__click('call:{ANA}')"); bob.wait_for_timeout(400)
        check('clicking it opens the caller’s chat', 'Ana' in bob.inner_text('#conv-head'))
        bob.locator('#call-dock .call-btn.decline').first.click()
        check('declined: the notice is taken away', wait(bob, f"window.__closed.filter(t => t === 'call:{ANA}').length === 2", 10000))
        bob.wait_for_timeout(3000)

        # 3. "Show: nothing" hides who is calling; notifications off shows none
        bob.evaluate("localStorage.setItem('anyonechat.notifyShow', 'none'); window.__notes.length = 0")
        ana.click('.conv-call')
        n = wait(bob, "window.__notes.find(n => n.tag && n.tag.startsWith('call:'))", 40000)
        check('with "show nothing" the notice doesn’t name the caller', n and n['title'] == 'AnonChat' and 'Ana' not in n['body'], n)
        ana.locator('#call-dock .call-btn.decline').first.click(); bob.wait_for_timeout(3500)
        bob.evaluate("localStorage.setItem('anyonechat.notifyShow', 'name'); localStorage.setItem('anyonechat.notify', 'off'); window.__notes.length = 0")
        ana.click('.conv-call'); bob.wait_for_timeout(4000)
        check('with notifications off there is no notice (the ringtone still plays)', bob.evaluate("window.__notes.length === 0") and bob.locator('#contacts .contact.ringing').count() == 1)
        ana.locator('#call-dock .call-btn.decline').first.click(); bob.wait_for_timeout(3500)
        bob.evaluate("localStorage.setItem('anyonechat.notify', 'on'); window.__notes.length = 0")

        # 4. Window in front: no notice
        bob.evaluate("document.hasFocus = () => true")
        ana.click('.conv-call'); bob.wait_for_timeout(4000)
        check('window in front: no notice, the call card is enough', bob.evaluate("window.__notes.length === 0"))
        ana.locator('#call-dock .call-btn.decline').first.click(); bob.wait_for_timeout(3500)

        # 5. Unanswered: the ringing notice gives way to a missed-call notice
        bob.wait_for_timeout(60000)                     # more than 4 rings a minute from one contact are ignored (anti-spam)
        bob.evaluate("document.hasFocus = () => false; window.__notes.length = 0")
        ana.click('.conv-call')
        wait(bob, "window.__notes.length === 1", 40000)
        m = wait(bob, "window.__notes.find(n => n.body === 'Missed voice call')", 70000)
        check('unanswered: a "Missed voice call" notice from Ana', m and m['title'] == 'Ana' and m['tag'] == ANA, bob.evaluate("window.__notes"))
        check('…and the ringing notice is gone', wait(bob, f"window.__closed.filter(t => t === 'call:{ANA}').length >= 5", 10000), bob.evaluate("window.__closed"))
        bad = [e for e in errs if 'net::ERR' not in e]
        check('no page errors', not bad, bad[:5])
        b.close()
finally:
    for p in procs: p.terminate()
print(f"{sum(1 for r in results if r[1])}/{len(results)} passed")
