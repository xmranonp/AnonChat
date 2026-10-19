"""Language pill on the welcome screen + identity backup and restore, end to end.
Ana (admin) has a group with Bob and Carl; Bob and Carl aren't contacts. Bob makes a backup in Settings, his computer is replaced by a
fresh install, he restores from the welcome screen, the app 'restarts', and everybody can write to Bob again on his same address."""
import subprocess, os, sys, time, json, tempfile, base64, shutil
from playwright.sync_api import sync_playwright

import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import _args
APP, SHIM, OUT = _args.paths(__file__)
os.makedirs(OUT, exist_ok=True)
TOKEN = 'f' * 64
NODES = {
    'ana':  {'addr': 'c' * 56 + '.anyone', 'ui': 5901, 'pub': 5902},
    'bob':  {'addr': 'b' * 56 + '.anyone', 'ui': 5911, 'pub': 5912},
    'carl': {'addr': 'd' * 56 + '.anyone', 'ui': 5921, 'pub': 5922},
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
    p = procs.pop(name); p.terminate(); p.wait(10)

for name, n in NODES.items():
    d = tempfile.mkdtemp(prefix='bk-' + name + '-'); n['dir'] = d
    os.makedirs(d + '/data'); hs_files(d, n['addr']); start(name, d)
time.sleep(2)

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
    pg.fill('#msg-input', text); pg.press('#msg-input', 'Enter'); pg.wait_for_timeout(600)
def open_contact(pg, name):
    pg.click(f'#contacts .contact:has-text("{name}")'); pg.wait_for_timeout(400)
def open_group(pg):
    pg.click('#groups .contact'); pg.wait_for_timeout(400)
def sees(pg, text, ms=40000):
    return wait(pg, f"[...document.querySelectorAll('#conv-body .bubble-text')].some(e => e.textContent.includes({json.dumps(text)}))", ms)

# Bob's window is the desktop app: the preload's API is stubbed (saving captures the file; relaunch only records that it was asked).
ELECTRON = """window.electron = { setUnreadCount(){}, notify(){},
  saveFile: async (name, data) => { window.__saved = { name, b64: btoa(String.fromCharCode(...data)) }; return '/home/bob/Downloads/' + name; },
  relaunch: async () => { window.__relaunched = (window.__relaunched || 0) + 1; },
  pendingRestore: async () => null, filePath: () => '', eraseForRestore: async () => ({ error: 'cancelled' }), eraseEverything: async () => true };"""

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ctx = {k: b.new_context(viewport={'width': 1180, 'height': 780}) for k in NODES}
        ctx['bob'].add_init_script(ELECTRON)
        P = {k: prep(ctx[k], NODES[k], k) for k in NODES}
        ana, bob, carl = P['ana'], P['bob'], P['carl']

        # ---- Language pill (Ana's welcome screen) ----
        ana.wait_for_selector('.welcome-cta'); ana.wait_for_timeout(300)
        check('welcome: a language pill sits at the top right', ana.evaluate("(() => { const p = document.querySelector('.lang-pill'); if (!p) return false; const r = p.getBoundingClientRect(); return r.right > innerWidth - 80 && r.top < 80; })()"))
        check('…naming the current language', 'English' in ana.inner_text('.lang-pill'))
        check('no restore link in a plain browser tab', ana.locator('.welcome-restore').count() == 0)
        ana.screenshot(path=OUT + '/1-welcome.png')
        ana.click('.lang-pill'); ana.wait_for_timeout(200)
        check('it opens a list of all 10 languages', ana.locator('.lang-menu .lang-opt').count() == 10)
        ana.screenshot(path=OUT + '/2-lang-menu.png')
        ana.keyboard.press('Escape'); ana.wait_for_timeout(150)
        check('Escape closes it', ana.evaluate("document.querySelector('.lang-menu').hidden"))
        cta_en = ana.inner_text('.welcome-cta')
        ana.click('.lang-pill'); ana.click('.lang-opt:has-text("Português")'); ana.wait_for_timeout(300)
        check('choosing Português redraws the welcome in Portuguese', ana.inner_text('.welcome-cta') != cta_en and 'Português' in ana.inner_text('.lang-pill'), ana.inner_text('.welcome-cta'))
        check('…and the PIN screen behind follows', ana.evaluate("document.documentElement.lang").startswith('pt'), ana.evaluate("document.documentElement.lang"))
        ana.screenshot(path=OUT + '/3-welcome-pt.png')
        ana.click('.lang-pill'); ana.click('.lang-opt:has-text("English")'); ana.wait_for_timeout(300)
        check('…and back to English', ana.inner_text('.welcome-cta') == cta_en)
        check('only one pill after redraws', ana.locator('.lang-pill').count() == 1)
        check('Bob (desktop app) sees "Restore from a backup"', bob.locator('.welcome-restore').count() == 1 and 'Restore' in bob.inner_text('.welcome-restore'))
        bob.screenshot(path=OUT + '/4-welcome-desktop.png')

        for k in NODES: login(P[k])
        time.sleep(1)

        # ---- Before: Ana and Bob are contacts; Ana and Carl are contacts; group of three ----
        add_contact(ana, 'Bob', NODES['bob']['addr']); add_contact(ana, 'Carl', NODES['carl']['addr'])
        add_contact(bob, 'Ana', NODES['ana']['addr']); add_contact(carl, 'Ana', NODES['ana']['addr'])
        open_contact(ana, 'Bob'); send(ana, 'hello bob')
        open_contact(bob, 'Ana'); check('before: Bob gets Ana’s message', sees(bob, 'hello bob'))
        send(bob, 'hello ana'); check('before: Ana gets Bob’s reply', sees(ana, 'hello ana'))
        ana.click('#new-group-btn'); ana.wait_for_timeout(300); ana.fill('#grp-name', 'Trio')
        for cb in ana.locator('#grp-member-list input[type=checkbox]').all(): cb.check()
        ana.click('#grp-create'); ana.wait_for_timeout(1500)
        for k in ('bob', 'carl'): check(f'before: {k} has the group', wait(P[k], "fetch('/api/groups').then(r=>r.json()).then(g => g.length === 1)", 40000))
        open_group(carl); send(carl, 'carl before')
        open_group(bob); check('before: Bob sees Carl in the group', sees(bob, 'carl before'))
        send(bob, 'bob before'); open_group(ana); check('before: Ana sees Bob in the group', sees(ana, 'bob before'))
        check('before: Carl sees Bob in the group', sees(carl, 'bob before'))
        bob_ik = bob.evaluate("fetch('/api/whoami').then(r=>r.json())")

        # ---- Bob: Settings → Create backup ----
        bob.click('#settings-btn'); bob.wait_for_timeout(400)
        check('Settings has a Backup section with Create and Restore', bob.locator('.settings-dialog button:has-text("Create backup")').count() == 1 and bob.locator('.settings-dialog button:has-text("Restore")').count() == 1)
        bob.locator('.settings-dialog .set-title:has-text("Backup")').scroll_into_view_if_needed(); bob.wait_for_timeout(200)
        bob.screenshot(path=OUT + '/5-settings-backup.png')
        bob.click('.settings-dialog button:has-text("Create backup")'); bob.wait_for_timeout(300)
        check('step 1 asks for the PIN', bob.is_visible('.backup-pin'))
        bob.fill('.backup-pin', '654321'); bob.click('.backup-dialog .confirm-ok'); bob.wait_for_timeout(1200)
        check('a wrong PIN is refused', bob.is_visible('.backup-pin') and bob.inner_text('.backup-dialog .changepin-err') != '')
        bob.fill('.backup-pin', '123456'); bob.click('.backup-dialog .confirm-ok')
        bob.wait_for_selector('.backup-includes', timeout=15000)
        check('step 2 lists what goes in (with the address) and what doesn’t', 'bbbbbb' in bob.inner_text('.backup-includes') and bob.locator('.backup-includes li.n').count() == 1)
        PASS = 'violet otter climbs nine ladders'
        f = bob.locator('.backup-dialog .pass-field input')
        f.nth(0).fill('short'); f.nth(1).fill('short'); bob.check('.backup-dialog .pass-ack input')
        check('a short passphrase can’t be used', bob.is_disabled('.backup-dialog .confirm-ok'))
        f.nth(0).fill(PASS); f.nth(1).fill(PASS)
        check('a good one, typed twice and acknowledged, can', bob.is_enabled('.backup-dialog .confirm-ok'))
        bob.screenshot(path=OUT + '/6-create-backup.png')
        bob.click('.backup-dialog .confirm-ok')
        saved = wait(bob, "window.__saved", 30000)
        check('the backup file is saved', saved and saved['name'].endswith('.anonchat'), saved and saved['name'])
        check('…and a toast says where', wait(bob, "document.body.innerText.includes('Downloads')", 5000))
        raw = base64.b64decode(saved['b64'])
        outer = json.loads(raw)
        check('the file names nothing about whose it is', b'bbbbbbbb' not in raw and outer['format'] == 'anonchat-backup' and outer['kdf']['iterations'] == 600000)

        # ---- Bob's computer is replaced: a fresh install on the same ports ----
        ctx['bob'].close(); stop('bob')
        nd = tempfile.mkdtemp(prefix='bk-bob2-'); os.makedirs(nd + '/data'); hs_files(nd, 'e' * 56 + '.anyone')
        NODES['bob']['dir2'] = nd; start('bob', nd); time.sleep(2)
        ctx['bob'] = b.new_context(viewport={'width': 1180, 'height': 780}); ctx['bob'].add_init_script(ELECTRON)
        bob = P['bob'] = prep(ctx['bob'], NODES['bob'], 'bob2')
        bob.wait_for_selector('.welcome-restore'); bob.wait_for_timeout(300)
        bob.click('.welcome-restore'); bob.wait_for_timeout(300)
        check('restore (fresh install) has one step, no erase warning', bob.locator('.restore-overlay .backup-steps i').count() == 1 and bob.locator('.backup-danger').count() == 0)
        bkfile = OUT + '/' + saved['name']; open(bkfile, 'wb').write(raw)
        bob.set_input_files('.restore-overlay input[type=file]', bkfile); bob.wait_for_timeout(300)
        check('the chosen file is shown', saved['name'] in bob.inner_text('.backup-file'))
        bob.fill('.restore-overlay .pass-field input', PASS + 'x'); bob.click('.restore-overlay .confirm-ok')
        check('a wrong passphrase says so', wait(bob, "document.querySelector('.restore-overlay .changepin-err').textContent.length > 0", 30000))
        bob.fill('.restore-overlay .pass-field input', PASS); bob.click('.restore-overlay .confirm-ok')
        check('the right one opens it and shows the address and counts', wait(bob, "(() => { const o = document.querySelector('.backup-opened'); return o && !o.hidden && o.textContent.includes('bbbb') && /2/.test(o.textContent); })()", 30000), bob.inner_text('.restore-overlay'))
        bob.screenshot(path=OUT + '/7-restore-opened.png')
        bob.click('.restore-overlay .confirm-ok'); bob.wait_for_timeout(500)
        check('then the PIN is chosen as on any first launch', bob.is_visible('.pin-key'))
        pin(bob, 2)
        check('the app asks to restart once the restore is in', wait(bob, "window.__relaunched === 1", 30000))
        check('the restored address is in place on disk', open(nd + '/anon/anon_service/hostname').read().strip() == NODES['bob']['addr'])
        check('…with the same key files', open(nd + '/anon/anon_service/hs_ed25519_public_key', 'rb').read() == open(NODES['bob']['dir'] + '/anon/anon_service/hs_ed25519_public_key', 'rb').read())
        st = bob.evaluate("Promise.all(['/api/contacts','/api/peers','/api/groups'].map(u => fetch(u).then(r=>r.json())))")
        check('contacts, group members and the group are back', len(st[0]) == 1 and st[0][0]['petname'] == 'Ana' and any(p['address'] == NODES['carl']['addr'] for p in st[1]) and len(st[2]) == 1, json.dumps(st)[:300])
        bob.screenshot(path=OUT + '/8-restarting.png')

        # ---- The 'restart' ----
        stop('bob'); start('bob', nd); time.sleep(2)
        bob.reload(); bob.wait_for_selector('.pin-key', timeout=15000); pin(bob, 1)
        bob.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000)
        who = wait(bob, "fetch('/api/whoami').then(r=>r.json()).then(w => w.address)", 15000)
        check('after restart Bob is on his old address', who == NODES['bob']['addr'], who)
        check('…with his old message key', bob.evaluate("fetch('/api/whoami').then(r=>r.json())").get('ecdhPub') == bob_ik.get('ecdhPub') if bob_ik.get('ecdhPub') else True)
        check('a toast says the restore is done', wait(bob, "document.body.innerText.includes('estored')", 8000))
        check('Ana is in the contact list again', bob.locator('#contacts .contact:has-text("Ana")').count() == 1)

        open_contact(ana, 'Bob'); open_contact(bob, 'Ana')
        send(ana, 'are you back bob')
        check('after: Bob gets Ana’s message', sees(bob, 'are you back bob', 60000))
        send(bob, 'yes, same address')
        check('after: Ana gets Bob’s', sees(ana, 'yes, same address', 60000))
        check('…with no “text only” limit on Bob’s side', bob.evaluate("!document.body.innerText.toLowerCase().includes('text only')"))
        open_group(carl); open_group(bob)
        send(carl, 'carl after')
        check('after: Bob sees Carl in the group', sees(bob, 'carl after', 60000))
        send(bob, 'bob after')
        check('after: Carl sees Bob in the group', sees(carl, 'bob after', 60000))
        check('…and it isn’t a message request for Carl', carl.evaluate("!document.getElementById('requests-btn').classList.contains('has')"))
        bob.screenshot(path=OUT + '/9-bob-after.png'); ana.screenshot(path=OUT + '/10-ana-after.png')

        # ---- Settings → Restore on a computer already in use: the erase confirmation step ----
        bob.evaluate("window.electron.eraseForRestore = async (p, l) => { window.__erase = { p, l }; return { error: 'cancelled' }; }")
        bob.click('#settings-btn'); bob.wait_for_timeout(400)
        bob.click('.settings-dialog button.req-block'); bob.wait_for_timeout(300)
        check('Settings restore has two steps', bob.locator('.restore-overlay .backup-steps i').count() == 2)
        bob.set_input_files('.restore-overlay input[type=file]', bkfile)
        bob.fill('.restore-overlay .pass-field input', PASS); bob.click('.restore-overlay .confirm-ok')
        wait(bob, "(() => { const o = document.querySelector('.backup-opened'); return o && !o.hidden; })()", 30000)
        bob.click('.restore-overlay .confirm-ok'); bob.wait_for_timeout(300)
        check('step 2 warns that everything here is erased', bob.is_visible('.backup-danger') and bob.is_visible('.backup-warn'))
        go = '.restore-overlay .confirm-ok.danger'
        check('…and can’t go ahead before the box and the word', bob.is_disabled(go))
        bob.check('.restore-overlay .pass-ack input'); bob.fill('.restore-overlay .erase-input', 'restor')
        check('…a half-typed word still can’t', bob.is_disabled(go))
        bob.fill('.restore-overlay .erase-input', 'restore')
        check('…the word in any case can', bob.is_enabled(go))
        bob.screenshot(path=OUT + '/11-settings-restore-confirm.png')
        bob.click(go); bob.wait_for_timeout(500)
        er = bob.evaluate("window.__erase")
        check('it hands the desktop app the translated labels for its own confirmation', er and er['l']['title'] and er['l']['ok'] and er['l']['cancel'], er)
        check('cancelled in the native box: the dialog stays, no error', bob.is_visible('.backup-danger') and bob.inner_text('.restore-overlay .changepin-err') == '' and bob.is_enabled(go))
        bob.keyboard.press('Escape')

        bad = [e for e in errs if 'favicon' not in e and 'net::ERR' not in e and '[restore]' not in e]
        check('no page errors', not bad, bad[:6])
        b.close()
finally:
    for p in list(procs.values()): p.terminate()
print(f"{sum(1 for r in results if r[1])}/{len(results)} passed")
