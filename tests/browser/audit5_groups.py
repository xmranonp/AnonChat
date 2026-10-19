"""Fifth pass (October 2026): group messages and group member lists.
1. Your own group message shows at once (⏳ while it is handed to every member), in the group it was written in, even when one member
   can't be reached and even if you open another chat straight away.
2. A member who misses someone's leave notice is put right by the admin, who sends the new list (saying who left).
3. After a restore from a backup, the app asks each group's admin for the current list: someone who left while the restore was going
   on no longer shows as a member.
Ana is the admin; Bob, Carl, Dave and Eve are members; Bob's window is the desktop app (for the backup and restore)."""
import subprocess, os, sys, time, json, tempfile, base64, socket, threading
from playwright.sync_api import sync_playwright

import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import _args
APP, SHIM, OUT = _args.paths(__file__)
os.makedirs(OUT, exist_ok=True)
TOKEN = 'f' * 64
NODES = {
    'ana':  {'addr': 'c' * 56 + '.anyone', 'ui': 6501, 'pub': 6502},
    'bob':  {'addr': 'b' * 56 + '.anyone', 'ui': 6511, 'pub': 6512},
    'carl': {'addr': 'd' * 56 + '.anyone', 'ui': 6521, 'pub': 6522},
    'dave': {'addr': 'g' * 56 + '.anyone', 'ui': 6531, 'pub': 6532},
    'eve':  {'addr': 'h' * 56 + '.anyone', 'ui': 6541, 'pub': 6542},
}
PEERS = json.dumps({n['addr']: n['pub'] for n in NODES.values()})
import sys as _s, os as _o; _s.path.insert(0, _o.path.dirname(_o.path.abspath(__file__))); import fsocks; fsocks.start(PEERS)

def hdr(s): return s.encode().ljust(32, b'\0')
def hs_files(d, addr):
    os.makedirs(d + '/anon/anon_service', exist_ok=True)
    pub = base64.b32decode(addr[:56].upper())[:32]
    open(d + '/anon/anon_service/hostname', 'w').write(addr + '\n')
    open(d + '/anon/anon_service/hs_ed25519_secret_key', 'wb').write(hdr('== ed25519v1-secret: type0 ==') + os.urandom(64))
    open(d + '/anon/anon_service/hs_ed25519_public_key', 'wb').write(hdr('== ed25519v1-public: type0 ==') + pub)

procs = {}
def start(name, d):
    n = NODES[name]
    env = dict(os.environ, NODE_PATH=SHIM, PUBLIC_PORT=str(n['pub']), UI_PORT=str(n['ui']), DATA_DIR=d + '/data', ANON_DIR=d + '/anon',
               ANONCHAT_UI_TOKEN=TOKEN, ANON_CTRL_PORT='1', PEERS=PEERS, RL_BURST='1000', RL_PER_MIN='10000')
    procs[name] = subprocess.Popen(['node', APP + '/server.js'], env=env, cwd=APP, stdout=open(d + '/log', 'a'), stderr=subprocess.STDOUT)
def stop(name):
    p = procs.pop(name, None)
    if p: p.terminate(); p.wait(10)
def up(n):
    for _ in range(100):
        try:
            with socket.create_connection(('127.0.0.1', NODES[n]['ui']), 0.3): return
        except OSError: time.sleep(0.15)

for name, n in NODES.items():
    d = tempfile.mkdtemp(prefix='g5-' + name + '-'); n['dir'] = d
    os.makedirs(d + '/data'); hs_files(d, n['addr']); start(name, d)
for n in NODES: up(n)

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  [' + str(detail)[:300] + ']'), flush=True)
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
    pg.goto(f"http://127.0.0.1:{n['ui']}/?t={TOKEN}")
    return pg
def pin(pg, times):
    for _ in range(times):
        for dg in '123456': pg.click(f'.pin-key:text-is("{dg}")')
        pg.wait_for_timeout(300)
        if pg.is_visible('#pin-ok'):
            try: pg.click('#pin-ok', timeout=500)
            except Exception: pass
        pg.wait_for_timeout(500)
def login(pg):
    pg.wait_for_selector('.welcome-cta'); pg.wait_for_timeout(300)
    pg.click('.welcome-cta'); pin(pg, 2)
    pg.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000)
def add_contact(pg, name, addr):
    pg.click('#add-contact-btn'); pg.fill('#in-petname', name); pg.fill('#in-address', addr); pg.click('#add-confirm'); pg.wait_for_timeout(1200)
def send(pg, text):
    pg.fill('#msg-input', text); pg.press('#msg-input', 'Enter')
def open_contact(pg, name):
    pg.click(f'#contacts .contact:has-text("{name}")'); pg.wait_for_timeout(400)
def open_group(pg):
    pg.click('#groups .contact'); pg.wait_for_timeout(400)
def sees(pg, text, ms=40000):
    return wait(pg, f"[...document.querySelectorAll('#conv-body .bubble-text')].some(e => e.textContent.includes({json.dumps(text)}))", ms)
def own(pg, text):
    return pg.evaluate(f"(() => {{ const b = [...document.querySelectorAll('#conv-body .bubble.out')].find(e => e.textContent.includes({json.dumps(text)})); return b ? (b.querySelector('.receipt-tick.pending') ? 'pending' : 'shown') : null; }})()")
def members(pg):
    return pg.evaluate("fetch('/api/groups').then(r=>r.json()).then(g => g[0] ? g[0].members.map(m => m.address) : null)")
def leave(pg):
    pg.click('#groups .contact', button='right'); pg.wait_for_timeout(300)
    pg.click('#ctx-menu .ctx-item:has-text("Leave group")'); pg.wait_for_timeout(300); pg.click('#confirm-overlay .confirm-ok')
    wait(pg, "fetch('/api/groups').then(r=>r.json()).then(g => g.length === 0)", 10000)

ELECTRON = """window.electron = { setUnreadCount(){}, notify(){},
  saveFile: async (name, data) => { window.__saved = { name, b64: btoa(String.fromCharCode(...data)) }; return '/home/bob/Downloads/' + name; },
  relaunch: async () => { window.__relaunched = (window.__relaunched || 0) + 1; },
  pendingRestore: async () => null, eraseForRestore: async () => ({ error: 'cancelled' }), eraseEverything: async () => true };"""

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ctx = {k: b.new_context(viewport={'width': 1180, 'height': 780}) for k in NODES}
        ctx['bob'].add_init_script(ELECTRON)
        P = {k: prep(ctx[k], NODES[k], k) for k in NODES}
        for k in NODES: login(P[k])
        ana, bob, carl, dave, eve = (P[k] for k in ('ana', 'bob', 'carl', 'dave', 'eve'))
        A = {k: NODES[k]['addr'] for k in NODES}
        for k in ('bob', 'carl', 'dave', 'eve'): add_contact(ana, k.capitalize(), A[k]); add_contact(P[k], 'Ana', A['ana'])
        ana.click('#new-group-btn'); ana.wait_for_timeout(300); ana.fill('#grp-name', 'Five')
        for cb in ana.locator('#grp-member-list input[type=checkbox]').all(): cb.check()
        ana.click('#grp-create'); ana.wait_for_timeout(1500)
        for k in ('bob', 'carl', 'dave', 'eve'): wait(P[k], "fetch('/api/groups').then(r=>r.json()).then(g => g.length === 1)", 40000)
        for k in NODES: open_group(P[k])
        send(bob, 'warm up');
        for k in ('ana', 'carl', 'dave', 'eve'): sees(P[k], 'warm up', 60000)
        check('setup: a group of five, everyone reachable', all(sees(P[k], 'warm up', 1000) for k in ('ana', 'carl', 'dave', 'eve')))

        # ---- 1. Eve's computer stops answering (accepts connections, never replies) ----
        ctx['eve'].close(); stop('eve')
        hole = socket.socket(); hole.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); hole.bind(('127.0.0.1', NODES['eve']['pub'])); hole.listen(100)
        held = []; threading.Thread(target=lambda: [held.append(hole.accept()) for _ in range(500)], daemon=True).start()
        t0 = time.time(); send(bob, 'fast one')
        st = wait(bob, "true", 1) and None
        for _ in range(12):
            st = own(bob, 'fast one')
            if st: break
            time.sleep(0.25)
        check('your own group message shows at once although a member can’t be reached', st is not None and time.time() - t0 < 4, (st, round(time.time() - t0, 1)))
        check('…marked ⏳ while it is still being handed over', st == 'pending', st)
        check('…and the others get it meanwhile', sees(ana, 'fast one', 30000) and sees(carl, 'fast one', 30000))
        send(bob, 'written then switched'); bob.wait_for_timeout(300); open_contact(bob, 'Ana')
        sees(carl, 'written then switched', 30000)
        bob.wait_for_timeout(2000)
        check('opening another chat straight after sending: it isn’t put there', own(bob, 'written then switched') is None)
        open_group(bob)
        check('…it is in the group it was written in', own(bob, 'written then switched') is not None)
        order = bob.evaluate("[...document.querySelectorAll('#conv-body .bubble.out .bubble-text')].map(e => e.textContent)")
        ia = next((i for i, o in enumerate(order) if 'fast one' in o), None); ib = next((i for i, o in enumerate(order) if 'written then' in o), None)
        check('…in the order written', ia is not None and ib is not None and ia < ib, order)

        # ---- 2. Bob is away while Carl leaves; Carl is gone before Bob is back, so only Ana can tell him ----
        stop('bob')
        leave(carl)
        check('Ana sees that Carl left', wait(ana, f"fetch('/api/groups').then(r=>r.json()).then(g => !g[0].members.some(m => m.address === {json.dumps(A['carl'])}))", 40000))
        ctx['carl'].close(); stop('carl')
        start('bob', NODES['bob']['dir']); up('bob')
        bob.reload(); bob.wait_for_selector('.pin-key', timeout=15000); pin(bob, 1); bob.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000)
        ok = wait(bob, f"fetch('/api/groups').then(r=>r.json()).then(g => g[0] && !g[0].members.some(m => m.address === {json.dumps(A['carl'])}))", 90000)
        check('a member who missed the leave notice gets the new list from the admin', ok, members(bob))
        open_group(bob)
        check('…and it says Carl left (not that he was removed)', wait(bob, "[...document.querySelectorAll('#conv-body .system-msg')].some(e => /left the group/.test(e.textContent))", 10000),
              bob.evaluate("[...document.querySelectorAll('#conv-body .system-msg')].map(e => e.textContent)"))

        # ---- 3. Bob makes a backup; while his computer is replaced, Dave leaves ----
        bob.click('#settings-btn'); bob.wait_for_timeout(400)
        bob.click('.settings-dialog button:has-text("Create backup")'); bob.wait_for_timeout(300)
        bob.fill('.backup-pin', '123456'); bob.click('.backup-dialog .confirm-ok'); bob.wait_for_selector('.backup-includes', timeout=15000)
        PASS = 'violet otter climbs nine ladders'
        f = bob.locator('.backup-dialog .pass-field input'); f.nth(0).fill(PASS); f.nth(1).fill(PASS); bob.check('.backup-dialog .pass-ack input')
        bob.click('.backup-dialog .confirm-ok')
        saved = wait(bob, "window.__saved", 30000)
        check('backup made, with Dave still in the group', saved and A['dave'] in (members(bob) or []))
        raw = base64.b64decode(saved['b64'])
        ctx['bob'].close(); stop('bob')
        nd = tempfile.mkdtemp(prefix='g5-bob2-'); os.makedirs(nd + '/data'); hs_files(nd, 'e' * 56 + '.anyone'); start('bob', nd); up('bob')
        leave(dave)
        check('Ana sees that Dave left', wait(ana, f"fetch('/api/groups').then(r=>r.json()).then(g => !g[0].members.some(m => m.address === {json.dumps(A['dave'])}))", 40000))
        time.sleep(20)                       # Dave's and Ana's notices reach Bob's new, empty install and can't be read there
        ctx['dave'].close(); stop('dave')
        ctx['bob'] = b.new_context(viewport={'width': 1180, 'height': 780}); ctx['bob'].add_init_script(ELECTRON)
        bob = P['bob'] = prep(ctx['bob'], NODES['bob'], 'bob2')
        bob.wait_for_selector('.welcome-restore'); bob.click('.welcome-restore'); bob.wait_for_timeout(300)
        bkfile = OUT + '/' + saved['name']; open(bkfile, 'wb').write(raw)
        bob.set_input_files('.restore-overlay input[type=file]', bkfile)
        bob.fill('.restore-overlay .pass-field input', PASS); bob.click('.restore-overlay .confirm-ok')
        wait(bob, "(() => { const o = document.querySelector('.backup-opened'); return o && !o.hidden; })()", 30000)
        bob.click('.restore-overlay .confirm-ok'); bob.wait_for_timeout(500); pin(bob, 2)
        wait(bob, "window.__relaunched === 1", 30000)
        check('right after the restore, the list is the backup’s (Dave still in it)', A['dave'] in (members(bob) or []))
        stop('bob'); start('bob', nd); up('bob')
        bob.reload(); bob.wait_for_selector('.pin-key', timeout=15000); pin(bob, 1); bob.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000)
        ok = wait(bob, f"fetch('/api/groups').then(r=>r.json()).then(g => g[0] && !g[0].members.some(m => m.address === {json.dumps(A['dave'])}))", 90000)
        check('after the restart, the admin’s current list replaces it: Dave is gone', ok, members(bob))
        open_group(bob)
        check('…and it says Dave left', wait(bob, "[...document.querySelectorAll('#conv-body .system-msg')].filter(e => /left the group/.test(e.textContent)).length >= 1", 10000),
              bob.evaluate("[...document.querySelectorAll('#conv-body .system-msg')].map(e => e.textContent)"))
        check('…and it isn’t a message request', not bob.evaluate("document.getElementById('requests-btn').classList.contains('has')"))
        send(bob, 'still here'); check('Bob and Ana can still write in the group', sees(ana, 'still here', 60000))

        bad = [e for e in errs if 'favicon' not in e and 'net::ERR' not in e]
        check('no page errors', not bad, bad[:5])
        b.close()
finally:
    for p in list(procs.values()): p.terminate()
print(f"{sum(1 for r in results if r[1])}/{len(results)} passed")
