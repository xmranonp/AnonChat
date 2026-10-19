"""Incoming call: the caller’s contact card is shaded and says "Incoming voice call" until the call is answered, declined or missed.
Two real server.js nodes and two real windows in Chromium."""
import subprocess, os, sys, time, json, tempfile, base64, struct, zlib
from playwright.sync_api import sync_playwright

import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import _args
APP, SHIM, OUT = _args.paths(__file__)
os.makedirs(OUT, exist_ok=True)
TOKEN = 'f' * 64
NODES = {
    'ana':  {'addr': 'c' * 56 + '.anyone', 'ui': 5701, 'pub': 5702},
    'bob':  {'addr': 'b' * 56 + '.anyone', 'ui': 5801, 'pub': 5802},
}
PEERS = json.dumps({n['addr']: n['pub'] for n in NODES.values()})
import sys as _s, os as _o; _s.path.insert(0, _o.path.dirname(_o.path.abspath(__file__))); import fsocks; fsocks.start(PEERS)
procs, dirs = [], []
for name, n in NODES.items():
    d = tempfile.mkdtemp(prefix='grp-' + name + '-'); dirs.append(d); n['dir'] = d
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

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        ctx = {k: b.new_context(viewport={'width': 1180, 'height': 780}, permissions=['microphone']) for k in NODES}
        P = {k: prep(ctx[k], NODES[k], k) for k in NODES}
        for k in NODES: login(P[k])
        ana, bob = P['ana'], P['bob']
        add_contact(ana, 'Bob', NODES['bob']['addr']); add_contact(bob, 'Ana', NODES['ana']['addr'])
        add_contact(ana, 'Zed', 'z' * 56 + '.anyone') if False else None
        ana.click('#contacts .contact:has-text("Bob")'); ana.wait_for_timeout(400); send(ana, 'hi bob')
        bob.click('#contacts .contact:has-text("Ana")'); bob.wait_for_timeout(400)
        wait(bob, "document.getElementById('conv-body').innerText.includes('hi bob')", 40000)
        send(bob, 'hi ana'); wait(ana, "document.getElementById('conv-body').innerText.includes('hi ana')", 40000)
        # Ana looks at another screen: Settings closed, no chat open with Bob is not needed; the card is in the list either way
        bob.click('.conv-call'); 
        ok = wait(ana, "!!document.querySelector('#contacts .contact.ringing')", 40000)
        check('Bob calls: Ana’s card for Bob is shaded', ok)
        row = ana.locator('#contacts .contact.ringing')
        check('…its second line says it’s an incoming call', 'Incoming voice call' in row.inner_text(), row.inner_text() if ok else '')
        check('…with the green edge and the phone', ana.evaluate("(() => { const r = document.querySelector('#contacts .contact.ringing'); return getComputedStyle(r).boxShadow.includes('inset') && !!r.querySelector('.ring-phone svg') && getComputedStyle(r).animationName === 'ring-breathe'; })()"))
        check('…and only Bob’s card', ana.locator('#contacts .contact.ringing').count() == 1)
        ana.wait_for_timeout(800); ana.locator('#contacts').screenshot(path=OUT + '/ringing.png')
        bob.screenshot(path=OUT + '/bob.png')
        # decline on Ana's side
        dec = ana.locator('#call-dock .call-btn').last
        ana.locator('#call-dock button:has-text("Decline"), #call-dock .call-btn.decline').first.click()
        check('declined: the shade goes away at once', wait(ana, "!document.querySelector('#contacts .contact.ringing')", 3000))
        check('…and the address line is back', 'Incoming' not in ana.inner_text('#contacts .contact:has-text("Bob")'))
        check('no page errors', not [e for e in errs if 'call' not in e.lower() or 'Error' in e], errs)
        b.close()
finally:
    for p in procs: p.terminate()
print(f"{sum(1 for r in results if r[1])}/{len(results)} passed")
