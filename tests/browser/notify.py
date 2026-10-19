"""Desktop notifications for messages and requests: when they appear, what they show (name only / full / nothing), click to open, switching off.
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
    'carl': {'addr': 'd' * 56 + '.anyone', 'ui': 5901, 'pub': 5902},
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

def rowtxt(pg, name): return pg.inner_text(f'#contacts .contact:has-text("{name}")')
STUB = "window.__notes = []; window.electron = { notify: (n) => window.__notes.push(n), onNoticeClick: (cb) => { window.__click = cb; }, setUnreadCount: () => {}, setLanguage: () => {} };"
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx = {k: b.new_context(viewport={'width': 1180, 'height': 780}) for k in NODES}
        ctx['bob'].add_init_script(STUB)
        P = {k: prep(ctx[k], NODES[k], k) for k in NODES}
        for k in NODES: login(P[k])
        ana, bob, carl = P['ana'], P['bob'], P['carl']
        add_contact(ana, 'Bob', NODES['bob']['addr']); add_contact(bob, 'Ana', NODES['ana']['addr'])
        add_contact(carl, 'Bob', NODES['bob']['addr'])
        notes = lambda: bob.evaluate("window.__notes")
        # window in front: no notice
        ana.click('#contacts .contact:has-text("Bob")'); ana.wait_for_timeout(300); send(ana, 'in front')
        wait(bob, "document.getElementById('contacts').innerText.includes('new message')", 40000); bob.wait_for_timeout(500)
        check('window in front: no system notice (only the sound and the unread marker)', notes() == [], notes())
        bob.evaluate("document.hasFocus = () => false")
        # default: name only
        send(ana, 'secret words'); wait(bob, "window.__notes.length >= 1", 40000)
        n = notes()[-1]
        check('window behind, default: a notice with the name only', n['title'] == 'Ana' and n['body'] == 'New message' and 'secret' not in json.dumps(n), n)
        check('…tagged with the chat to open', n['tag'] == NODES['ana']['addr'], n)
        # name and message
        bob.evaluate("localStorage.setItem('anyonechat.notifyShow', 'full')")
        send(ana, 'hello <b>there</b>'); wait(bob, "window.__notes.length >= 2", 40000)
        check('“Name and message”: the text is shown', notes()[-1]['body'] == 'hello <b>there</b>' and notes()[-1]['title'] == 'Ana', notes()[-1])
        bob.evaluate("localStorage.setItem('anyonechat.notifyShow', 'none')")
        send(ana, 'third'); wait(bob, "window.__notes.length >= 3", 40000)
        check('“Nothing”: no name, no text', notes()[-1]['title'] == 'AnonChat' and notes()[-1]['body'] == 'New message', notes()[-1])
        # a message request from a stranger
        bob.evaluate("localStorage.setItem('anyonechat.notifyShow', 'full')")
        carl.click('#contacts .contact:has-text("Bob")'); carl.wait_for_timeout(300); send(carl, 'stranger text')
        wait(bob, "window.__notes.some(n => n.tag === 'req')", 40000)
        r = [x for x in notes() if x['tag'] == 'req']
        check('a message request: “New message request”, never the stranger’s name or words, whatever the setting', r and r[0]['title'] == 'AnonChat' and 'stranger' not in json.dumps(r) and 'request' in r[0]['body'], r)
        # off
        bob.evaluate("localStorage.setItem('anyonechat.notify', 'off')"); k = len(notes())
        send(ana, 'while off'); bob.wait_for_timeout(8000)
        check('switched off: no notice', len(notes()) == k, notes()[k:])
        # clicking a notice opens that chat
        bob.evaluate(f"window.__click('{NODES['ana']['addr']}')"); bob.wait_for_timeout(600)
        check('clicking the notice opens that chat and clears its unread marker', 'while off' in bob.inner_text('#conv-body') and 'new message' not in rowtxt(bob, 'Ana'), rowtxt(bob, 'Ana'))
        # settings
        bob.evaluate("localStorage.setItem('anyonechat.notify', 'on')")
        bob.click('#settings-btn'); bob.wait_for_timeout(500)
        txt = bob.inner_text('#notif-toggle'); opts = bob.eval_on_selector_all('#notif-show option', 'os => os.map(o => o.textContent)')
        check('Settings → Notifications: the switch and the three choices', txt.upper() == 'ON' and opts == ['Name only', 'Name and message', 'Nothing (“New message”)'], (txt, opts))
        bob.click('#notif-toggle'); bob.wait_for_timeout(200)
        check('switching off greys out the choice and is remembered', bob.evaluate("document.getElementById('notif-show').disabled && localStorage.getItem('anyonechat.notify') === 'off'"))
        bob.screenshot(path=OUT + '/settings.png')
        # a plain browser tab without permission: shown as off
        ana.click('#settings-btn'); ana.wait_for_timeout(500)
        check('plain browser tab without permission: shown as off until allowed', ana.inner_text('#notif-toggle').upper() == 'OFF')
        check('no page errors', not errs, errs)
        b.close()
finally:
    for p in procs: p.terminate()
print(f"{sum(1 for r in results if r[1])}/{len(results)} passed")
