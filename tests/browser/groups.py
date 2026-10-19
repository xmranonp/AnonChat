"""Groups between people who aren't each other's contacts, the Requests button, the group picture, Erase everything.
Four real server.js nodes and four real UIs in Chromium. Bob is the admin; Ana and Carl only know Bob; Dan joins with a code."""
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
    'dan':  {'addr': 'f' * 56 + '.anyone', 'ui': 6001, 'pub': 6002},
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
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ctx = {k: b.new_context(viewport={'width': 1180, 'height': 780}) for k in NODES}
        # Ana's window is the desktop app for the Erase test: the preload's API is stubbed.
        ctx['ana'].add_init_script("window.electron = { setUnreadCount(){}, saveFile(){}, eraseEverything: async () => { window.__erased = (window.__erased || 0) + 1; return true; } };")
        P = {k: prep(ctx[k], NODES[k], k) for k in NODES}
        for k in NODES: login(P[k])
        time.sleep(1)

        # ---- Requests button ----
        btn = P['ana'].locator('#requests-btn')
        check('Requests icon sits next to Add contact', btn.is_visible() and P['ana'].evaluate("document.getElementById('requests-btn').nextElementSibling.id") == 'add-contact-btn')
        check('…muted, no dot, when there are none', P['ana'].evaluate("!document.getElementById('requests-btn').classList.contains('has')"))
        check('the old Requests section is gone', P['ana'].evaluate("!document.getElementById('requests') && !document.getElementById('requests-head')"))
        btn.click(); P['ana'].wait_for_timeout(300)
        check('empty panel says so', 'No message requests' in P['ana'].inner_text('#req-panel'))
        P['ana'].screenshot(path=OUT + '/1-requests-empty.png', clip={'x': 0, 'y': 0, 'width': 760, 'height': 520})
        P['ana'].keyboard.press('Escape'); P['ana'].wait_for_timeout(200)
        check('Escape closes it', P['ana'].evaluate("!document.getElementById('req-panel')"))

        # Dan writes to Ana out of the blue
        add_contact(P['dan'], 'Ana', NODES['ana']['addr'])
        P['dan'].click('#contacts .contact'); send(P['dan'], 'Hello Ana, this is Dan')
        check('dot appears when a request arrives', wait(P['ana'], "document.getElementById('requests-btn').classList.contains('has')", 40000))
        check('requests do not count as unread in the title', P['ana'].evaluate("document.title") == 'AnonChat', P['ana'].evaluate("document.title"))
        P['ana'].screenshot(path=OUT + '/2-requests-dot.png', clip={'x': 0, 'y': 0, 'width': 420, 'height': 520})
        btn.click(); P['ana'].wait_for_timeout(300)
        panel = P['ana'].inner_text('#req-panel')
        check('panel lists the request, marked "Not verified yet"', 'ffffff' in panel and 'Not verified yet' in panel, panel)
        check('text hidden until opened', 'Hello Ana' not in panel)
        P['ana'].click('#req-panel .req-entry-head'); P['ana'].wait_for_timeout(300)
        check('opening the row shows the text and Accept/Delete/Block', 'Hello Ana, this is Dan' in P['ana'].inner_text('#req-panel') and P['ana'].locator('#req-panel .req-actions .btn').count() == 3)
        P['ana'].screenshot(path=OUT + '/3-requests-open.png', clip={'x': 0, 'y': 0, 'width': 760, 'height': 560})
        P['ana'].click('#req-panel .req-actions .btn.primary'); P['ana'].wait_for_timeout(300)
        check('Accept asks for a nickname and the panel stays open behind it', P['ana'].is_visible('#name-dialog') and P['ana'].evaluate("!!document.getElementById('req-panel')"))
        P['ana'].fill('#in-nickname', 'Dan'); P['ana'].click('#name-ok')
        check('accepted: Dan is a contact, dot gone', wait(P['ana'], "[...document.querySelectorAll('#contacts .contact-name')].some(e => e.textContent === 'Dan') && !document.getElementById('requests-btn').classList.contains('has')", 30000))
        P['ana'].keyboard.press('Escape')

        # ---- Group where Ana and Carl aren't contacts ----
        for k in ('ana', 'carl', 'dan'): add_contact(P[k], 'Bob', NODES['bob']['addr'])
        add_contact(P['bob'], 'Ana', NODES['ana']['addr']); add_contact(P['bob'], 'Carl', NODES['carl']['addr'])
        bob = P['bob']
        bob.click('#new-group-btn'); bob.wait_for_timeout(300)
        check('New group form has the empty picture circle', bob.locator('#grp-pic-new .pic-edit.empty').count() == 1)
        bob.screenshot(path=OUT + '/4-new-group-empty.png')
        bob.set_input_files('#grp-pic-new input[type=file]', files=[{'name': 'p.png', 'mimeType': 'image/png', 'buffer': png((27, 193, 239))}])
        check('picking a picture shows it in the circle', wait(bob, "!!document.querySelector('#grp-pic-new .pic-edit img')"))
        bob.fill('#grp-name', 'Weekend trip')
        for cb in bob.locator('#grp-member-list input[type=checkbox]').all(): cb.check()
        bob.screenshot(path=OUT + '/5-new-group-filled.png')
        bob.click('#grp-create'); bob.wait_for_timeout(1500)
        check('group created with the picture', bob.evaluate("groups => true") and wait(bob, "fetch('/api/groups').then(r=>r.json()).then(g => g.length === 1 && /^data:image\\/jpeg/.test(g[0].avatar || ''))"))

        for k in ('ana', 'carl'):
            check(f'{k} gets the invite with the picture', wait(P[k], "fetch('/api/groups').then(r=>r.json()).then(g => g.length === 1 && !!g[0].avatar)", 40000))
        open_group(P['ana']); send(P['ana'], 'Hi everyone, Ana here')
        open_group(P['carl'])
        check('Carl (not Ana’s contact) sees Ana’s group message', wait(P['carl'], "[...document.querySelectorAll('#conv-body .bubble-text')].some(e => e.textContent.includes('Ana here'))", 40000))
        check('…and it is not a message request', P['carl'].evaluate("!document.getElementById('requests-btn').classList.contains('has')"))
        send(P['carl'], 'Hey Ana, Carl here')
        check('Ana sees Carl’s reply', wait(P['ana'], "[...document.querySelectorAll('#conv-body .bubble-text')].some(e => e.textContent.includes('Carl here'))", 40000))
        check('Bob sees both', wait(bob, "fetch('/api/groups').then(()=>true)") and (open_group(bob) or True) and wait(bob, "(() => { const t = [...document.querySelectorAll('#conv-body .bubble-text')].map(e => e.textContent).join('|'); return t.includes('Ana here') && t.includes('Carl here'); })()", 30000))
        check('Ana’s backend keeps Carl’s keys as a group member, not a contact', wait(P['ana'], "Promise.all([fetch('/api/peers').then(r=>r.json()), fetch('/api/contacts').then(r=>r.json())]).then(([p, c]) => p.some(x => x.address.startsWith('dddd')) && !c.some(x => x.address.startsWith('dddd')))"))
        P['carl'].screenshot(path=OUT + '/6-carl-group-chat.png')

        # ---- Dan joins with an invite code (Bob doesn't have Dan as a contact) ----
        bob.click('.conv-manage-btn'); bob.wait_for_timeout(400)
        code = bob.input_value('#grp-manage-overlay .grp-invite-code')
        check('admin view: picture is the button with the pencil, hint shown', bob.locator('#grp-manage-overlay .pic-edit').count() == 1 and 'Click the picture' in bob.inner_text('#grp-manage-overlay'))
        bob.screenshot(path=OUT + '/7-group-settings-admin.png')
        bob.click('#grp-manage-overlay .confirm-cancel')
        P['dan'].click('#join-group-btn'); P['dan'].fill('#join-group-overlay textarea', code); P['dan'].click('#join-group-overlay .confirm-ok')
        check('Dan gets the full member list (4) after joining', wait(P['dan'], "fetch('/api/groups').then(r=>r.json()).then(g => g[0] && g[0].members.length === 4)", 60000),
              P['dan'].evaluate("fetch('/api/groups').then(r=>r.json())"))
        check('…and the group picture', wait(P['dan'], "fetch('/api/groups').then(r=>r.json()).then(g => g[0] && !!g[0].avatar)", 20000))
        check('Ana’s list now has Dan too', wait(P['ana'], "fetch('/api/groups').then(r=>r.json()).then(g => g[0].members.length === 4)", 40000))
        open_group(P['dan']); send(P['dan'], 'Dan joined, hello')
        check('Ana sees Dan’s group message', wait(P['ana'], "[...document.querySelectorAll('#conv-body .bubble-text')].some(e => e.textContent.includes('Dan joined, hello'))", 40000))
        check('Carl sees Dan’s group message', wait(P['carl'], "[...document.querySelectorAll('#conv-body .bubble-text')].some(e => e.textContent.includes('Dan joined, hello'))", 40000))
        send(P['ana'], 'Welcome Dan')
        check('Dan sees Ana’s message', wait(P['dan'], "[...document.querySelectorAll('#conv-body .bubble-text')].some(e => e.textContent.includes('Welcome Dan'))", 40000))

        # ---- Member view: + Add contact for members who aren't contacts ----
        carl = P['carl']
        carl.click('.conv-manage-btn'); carl.wait_for_timeout(400)
        rows = carl.evaluate("[...document.querySelectorAll('#grp-manage-overlay .grp-member-row')].map(r => ({ t: r.textContent, add: !!r.querySelector('.grp-add-contact') }))")
        check('member view: no pencil', carl.locator('#grp-manage-overlay .pic-edit').count() == 0)
        check('Add contact on members who aren’t contacts (Ana, Dan), not on Bob or You', [r['add'] for r in rows].count(True) == 2 and all(not r['add'] for r in rows if 'Bob' in r['t'] or r['t'].startswith('You')), rows)
        carl.screenshot(path=OUT + '/8-group-settings-member.png')
        carl.click('#grp-manage-overlay .grp-member-row:has-text("Ana") .grp-add-contact'); carl.wait_for_timeout(300)
        check('opens Add contact with the address and the group name filled in', carl.input_value('#in-address') == NODES['ana']['addr'] and carl.input_value('#in-petname') == 'Ana')
        carl.screenshot(path=OUT + '/9-add-member-as-contact.png')
        carl.click('#add-confirm')
        check('Ana becomes Carl’s contact; her group-member keys are dropped', wait(carl, "Promise.all([fetch('/api/peers').then(r=>r.json()), fetch('/api/contacts').then(r=>r.json())]).then(([p, c]) => c.some(x => x.address.startsWith('cccc')) && !p.some(x => x.address.startsWith('cccc')))", 30000))
        open_group(carl); send(carl, 'still works after adding')
        check('group messages still flow after that', wait(P['ana'], "[...document.querySelectorAll('#conv-body .bubble-text')].some(e => e.textContent.includes('still works after adding'))", 40000))

        # ---- Admin changes the picture from settings ----
        bob.click('.conv-manage-btn'); bob.wait_for_timeout(300)
        bob.set_input_files('#grp-manage-overlay .pic-edit + input[type=file]', files=[{'name': 'q.png', 'mimeType': 'image/png', 'buffer': png((242, 166, 90))}])
        check('new picture reaches members', wait(P['ana'], "fetch('/api/groups').then(r=>r.json()).then(g => g[0].avatar && g[0].avatar.length > 0 && window.__lastPic !== g[0].avatar)", 30000))
        bob.click('#grp-manage-overlay .confirm-cancel')

        # ---- Carl leaves the group while Dan is offline ----
        procs[3].terminate(); time.sleep(0.5)            # Dan's node: unreachable from now on
        open_group(carl); carl.wait_for_timeout(300)
        carl.click('#conv-head .head-more') if carl.query_selector('#conv-head .head-more') else carl.click('.head-more')
        carl.wait_for_timeout(300)
        carl.click('.ctx-item:has-text("Leave group")'); carl.wait_for_timeout(300)
        okl = carl.inner_text('#confirm-overlay .confirm-ok')
        carl.click('#confirm-overlay .confirm-ok'); t0 = time.time()
        gone = wait(carl, "fetch('/api/groups').then(r=>r.json()).then(g => g.length === 0) && !document.querySelector('#groups .contact')", 20000)
        dt = time.time() - t0
        check('leaving: the group is gone from Carl at once, even with a member offline', gone and dt < 2.5, f'{dt:.1f}s')
        check('…the confirm button says Leave, not Delete', 'Leave' in okl, okl)
        check('Bob sees that Carl left, and his list drops Carl', wait(bob, "fetch('/api/groups').then(r=>r.json()).then(g => g[0] && g[0].members.length === 3 && !g[0].members.some(m => m.address.startsWith('dddd')))", 40000)
              and wait(bob, "document.getElementById('conv-body').innerText.includes('left the group')", 10000))
        check('Ana’s list drops Carl too', wait(P['ana'], "fetch('/api/groups').then(r=>r.json()).then(g => g[0] && !g[0].members.some(m => m.address.startsWith('dddd')))", 40000))
        send(bob, 'after Carl left'); carl.wait_for_timeout(4000)
        check('Carl is not put back by a later group message', carl.evaluate("fetch('/api/groups').then(r=>r.json()).then(g => g.length === 0)"))

        # ---- Bob (the admin) leaves: the group is dissolved for everyone ----
        bob.click('.head-more'); bob.wait_for_timeout(300)
        bob.click('.ctx-item:has-text("Leave group")'); bob.wait_for_timeout(300)
        bob.click('#confirm-overlay .confirm-ok'); t0 = time.time()
        gone = wait(bob, "fetch('/api/groups').then(r=>r.json()).then(g => g.length === 0)", 20000)
        check('the admin leaving: gone from Bob at once', gone and time.time() - t0 < 2.5, f'{time.time() - t0:.1f}s')
        check('…and dissolved for Ana', wait(P['ana'], "fetch('/api/groups').then(r=>r.json()).then(g => g.length === 0)", 40000))

        # ---- Erase everything (Ana's window is the desktop app) ----
        ana = P['ana']
        ana.click('#settings-btn'); ana.wait_for_timeout(400)
        check('Erase everything shows in the desktop app', ana.locator('.erase-box').count() == 1)
        ana.locator('.erase-box').scroll_into_view_if_needed(); ana.wait_for_timeout(200)
        ana.screenshot(path=OUT + '/10-settings-erase.png')
        ana.click('.erase-btn'); ana.wait_for_timeout(300)
        okb = ana.locator('#erase-overlay .confirm-ok')
        check('Erase button starts disabled', okb.is_disabled())
        ana.fill('#erase-overlay .erase-input', 'erase')
        check('typing the word (any case) enables it', not okb.is_disabled())
        ana.screenshot(path=OUT + '/11-erase-confirm.png')
        okb.click(); ana.wait_for_timeout(300)
        check('confirming calls the desktop app’s erase once', ana.evaluate("window.__erased") == 1)
        check('not offered in a plain browser tab', P['bob'].evaluate("(document.getElementById('settings-btn').click(), new Promise(r => setTimeout(() => r(!document.querySelector('.erase-box')), 400)))"))

        b.close()
finally:
    for p in procs: p.terminate()
    real_errs = [e for e in errs if 'favicon' not in e and 'Failed to load resource' not in e]
    print('page errors:', real_errs[:10])
    print(f"\n{sum(1 for r in results if r[1])}/{len(results)} passed")
