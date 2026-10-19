"""Chat history and media in IndexedDB: media survives a reload, nothing big in localStorage, Settings → Storage with clearing, and a
"not saved" warning instead of silent loss when the quota runs out. Two real server.js nodes, two pages in Chromium (desktop stub)."""
import subprocess, os, sys, time, json, tempfile, base64, struct, zlib
from playwright.sync_api import sync_playwright

import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import _args
APP, SHIM, OUT = _args.paths(__file__)
TOKEN = 'f' * 64
NODES = {'ana': {'addr': 'c' * 56 + '.anyone', 'ui': 5711, 'pub': 5712}, 'bob': {'addr': 'b' * 56 + '.anyone', 'ui': 5811, 'pub': 5812}}
PEERS = json.dumps({n['addr']: n['pub'] for n in NODES.values()})
import sys as _s, os as _o; _s.path.insert(0, _o.path.dirname(_o.path.abspath(__file__))); import fsocks; fsocks.start(PEERS)
procs = []
for name, n in NODES.items():
    d = tempfile.mkdtemp(prefix='st-' + name + '-'); os.makedirs(d + '/anon/anon_service'); os.makedirs(d + '/data')
    open(d + '/anon/anon_service/hostname', 'w').write(n['addr'] + '\n')
    env = dict(os.environ, NODE_PATH=SHIM, PUBLIC_PORT=str(n['pub']), UI_PORT=str(n['ui']), DATA_DIR=d + '/data', ANON_DIR=d + '/anon',
               ANONCHAT_UI_TOKEN=TOKEN, ANON_CTRL_PORT='1', PEERS=PEERS)
    procs.append(subprocess.Popen(['node', APP + '/server.js'], env=env, cwd=APP, stdout=open(d + '/log', 'w'), stderr=subprocess.STDOUT))
time.sleep(2)

def png(w, h, color):
    raw = b''.join(b'\x00' + bytes(color) * w for _ in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')

WKEY = base64.b64encode(os.urandom(32)).decode()
STUB = "window.electron = { setUnreadCount(){}, saveFile(){}, eraseEverything: async () => true, securityInfo: async () => ({ mode: 'os', vault: 'gnome', windowKey: '%s', minPassphrase: 12 }), setPassphrase: async () => ({ ok: true }), useOsVault: async () => ({ ok: true }) };" % WKEY
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok))); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  [' + str(detail) + ']'), flush=True)
def wait(pg, js, ms=30000):
    end = time.time() + ms / 1000
    while time.time() < end:
        try:
            v = pg.evaluate(js)
            if v: return v
        except Exception: pass
        time.sleep(0.25)
    return None
errs = []
def login(pg, first=True):
    if first:
        pg.wait_for_selector('.welcome-cta'); pg.wait_for_timeout(300); pg.click('.welcome-cta')
    else:
        pg.wait_for_selector('.pin-key')
    pg.wait_for_timeout(300)
    for _ in range(2 if first else 1):
        for dg in '123456': pg.click(f'.pin-key:text-is("{dg}")')
        pg.wait_for_timeout(400)
    pg.wait_for_selector('#pin-screen.gone', state='attached', timeout=20000)
def add_contact(pg, name, addr):
    pg.click('#add-contact-btn'); pg.fill('#in-petname', name); pg.fill('#in-address', addr); pg.click('#add-confirm'); pg.wait_for_timeout(1200)
def send(pg, text):
    pg.fill('#msg-input', text); pg.press('#msg-input', 'Enter'); pg.wait_for_timeout(600)

try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx = {k: b.new_context(viewport={'width': 1180, 'height': 780}) for k in NODES}
        for c in ctx.values(): c.add_init_script(STUB)
        P = {}
        for k, n in NODES.items():
            P[k] = ctx[k].new_page(); P[k].on('pageerror', lambda e, k=k: errs.append(k + ': ' + str(e)))
            P[k].goto(f"http://127.0.0.1:{n['ui']}/?t={TOKEN}"); login(P[k])
        add_contact(P['ana'], 'Bob', NODES['bob']['addr']); add_contact(P['bob'], 'Ana', NODES['ana']['addr'])
        P['bob'].click('#contacts .contact'); send(P['bob'], 'hi Ana')
        P['ana'].click('#contacts .contact')
        wait(P['ana'], "[...document.querySelectorAll('.bubble-text')].some(e => e.textContent.includes('hi Ana'))")
        send(P['ana'], 'hi Bob')
        wait(P['bob'], "[...document.querySelectorAll('.bubble-text')].some(e => e.textContent.includes('hi Bob'))")
        time.sleep(1)
        P['bob'].set_input_files('#file-input', files=[{'name': 'beach.png', 'mimeType': 'image/png', 'buffer': png(320, 200, (40, 160, 230))}])
        P['bob'].set_input_files('#file-input', files=[{'name': 'notes.txt', 'mimeType': 'text/plain', 'buffer': b'trip notes ' * 200}])
        check('Ana receives the photo', wait(P['ana'], "!!document.querySelector('#conv-body img.bubble-image[src^=\"blob:\"]')", 40000))
        check('…and the file', wait(P['ana'], "[...document.querySelectorAll('.file-name')].some(e => e.textContent.includes('notes.txt'))", 40000))
        time.sleep(1.5)
        ls = P['ana'].evaluate("Object.keys(localStorage).join('|') + '|' + Object.values(localStorage).join('|')")
        check('localStorage holds no contact address (keys or values)', 'bbbbbbbbbb' not in ls, ls[:200])
        idb = P['ana'].evaluate("""new Promise(r => { const q = indexedDB.open('anonchat'); q.onsuccess = () => { const db = q.result; const t = db.transaction(['fields', 'mediaMeta', 'media']);
            const out = {}; t.objectStore('fields').getAllKeys().onsuccess = (e) => out.fields = e.target.result;
            t.objectStore('mediaMeta').getAll().onsuccess = (e) => out.meta = e.target.result;
            t.objectStore('media').getAll().onsuccess = (e) => out.media = e.target.result.map(x => ({ hasIv: !!x.iv, bytes: x.ct.byteLength }));
            t.oncomplete = () => r(out); }; })""")
        check('history is in the database under opaque names (no addresses in field names)', any(k.startswith('anyonechat.t.') for k in idb['fields']) and not any('bbbbbbbbbb' in k for k in idb['fields']), idb['fields'])
        check('the media index holds no address and no file type', all('bbbbbbbbbb' not in json.dumps(m) and 'type' not in m for m in idb['meta']), idb['meta'])
        check('both attachments stored, encrypted (ciphertext only)', len(idb['meta']) == 2 and all(m['hasIv'] and m['bytes'] > 0 for m in idb['media']), idb['meta'])
        # Reload: media comes back
        P['ana'].reload(); login(P['ana'], first=False)
        P['ana'].click('#contacts .contact')
        check('after a restart, the photo is still shown', wait(P['ana'], "!!document.querySelector('#conv-body img.bubble-image[src^=\"blob:\"]')", 15000))
        P['ana'].screenshot(path=OUT + '/1-after-restart.png')
        # A lot of history: far past localStorage's ~5 M characters
        big = P['ana'].evaluate("""new Promise(r => { const q = indexedDB.open('anonchat'); q.onsuccess = () => { const t = q.result.transaction('fields', 'readwrite');
            t.objectStore('fields').put('x'.repeat(12 * 1024 * 1024), 'probe.big'); t.oncomplete = () => r('ok'); t.onerror = () => r('fail:' + t.error); }; })""")
        check('the database takes 12 MB in one value (localStorage stops near 5 M characters)', big == 'ok', big)
        P['ana'].evaluate("""new Promise(r => { const q = indexedDB.open('anonchat'); q.onsuccess = () => { const t = q.result.transaction('fields', 'readwrite'); t.objectStore('fields').delete('probe.big'); t.oncomplete = () => r(1); }; })""")
        # Settings → Storage
        P['ana'].click('#settings-btn'); P['ana'].wait_for_timeout(800)
        txt = P['ana'].inner_text('#storage-section')
        check('Settings shows Storage with the chat and its size', 'Bob' in txt and 'Clear media' in txt and 'Photos, voice' in txt, txt[:300])
        P['ana'].locator('#storage-section').scroll_into_view_if_needed(); P['ana'].wait_for_timeout(300)
        P['ana'].screenshot(path=OUT + '/2-settings-storage.png')
        # Older than 30 days: nothing yet
        P['ana'].click('#storage-section .set-pill:text-is("Clear…")'); P['ana'].wait_for_timeout(300)
        check('“older than 30 days” with nothing that old: just says so', 'Nothing older than 30 days' in P['ana'].inner_text('#toast'))
        # Clear media for Bob's chat
        P['ana'].click('#storage-section .storage-row .set-pill'); P['ana'].wait_for_timeout(300)
        P['ana'].click('#confirm-overlay .confirm-ok'); P['ana'].wait_for_timeout(1200)
        P['ana'].click('#settings-overlay .confirm-cancel') if P['ana'].is_visible('#settings-overlay .confirm-cancel') else None
        P['ana'].wait_for_timeout(300)
        check('cleared: the chat shows “Removed to save space”, text kept', wait(P['ana'], "document.querySelectorAll('.media-cleared').length === 2 && [...document.querySelectorAll('.bubble-text')].some(e => e.textContent.includes('hi Ana'))", 8000))
        n_meta = P['ana'].evaluate("""new Promise(r => { const q = indexedDB.open('anonchat'); q.onsuccess = () => { q.result.transaction('mediaMeta').objectStore('mediaMeta').count().onsuccess = (e) => r(e.target.result); }; })""")
        check('…and the stored media is gone', n_meta == 0, n_meta)
        P['ana'].screenshot(path=OUT + '/3-cleared.png')
        P['ana'].reload(); login(P['ana'], first=False); P['ana'].click('#contacts .contact')
        check('still shown as removed after a restart', wait(P['ana'], "document.querySelectorAll('.media-cleared').length === 2", 10000))
        # Older-than-30-days path: age one new photo, then clear old media from all chats
        P['bob'].set_input_files('#file-input', files=[{'name': 'old.png', 'mimeType': 'image/png', 'buffer': png(200, 120, (230, 120, 40))}])
        P['bob'].set_input_files('#file-input', files=[{'name': 'new.png', 'mimeType': 'image/png', 'buffer': png(200, 120, (60, 200, 90))}])
        wait(P['ana'], "document.querySelectorAll('#conv-body img.bubble-image[src^=\"blob:\"]').length === 2", 40000)
        time.sleep(1)
        P['ana'].evaluate("""new Promise(r => { const q = indexedDB.open('anonchat'); q.onsuccess = () => { const t = q.result.transaction('mediaMeta', 'readwrite'); const st = t.objectStore('mediaMeta');
            st.getAll().onsuccess = (e) => { const all = e.target.result.sort((a, b) => a.ts - b.ts); const o = all[0]; o.ts = Date.now() - 40 * 86400000; st.put(o); }; t.oncomplete = () => r(1); }; })""")
        P['ana'].click('#settings-btn'); P['ana'].wait_for_timeout(800)
        P['ana'].click('#storage-section .set-pill:text-is("Clear…")'); P['ana'].wait_for_timeout(300)
        msg = P['ana'].inner_text('#confirm-overlay .confirm-msg')
        check('asks first, with the count and size', 'Remove 1 ' in msg and '30 days' in msg, msg)
        P['ana'].click('#confirm-overlay .confirm-ok'); P['ana'].wait_for_timeout(1200)
        left = P['ana'].evaluate("""new Promise(r => { const q = indexedDB.open('anonchat'); q.onsuccess = () => { q.result.transaction('mediaMeta').objectStore('mediaMeta').count().onsuccess = (e) => r(e.target.result); }; })""")
        check('only the media older than 30 days was removed', left == 1, left)
        P['ana'].click('#settings-overlay .confirm-cancel'); P['ana'].wait_for_timeout(300)
        # Little space left: the banner warns before anything fails
        cdp = ctx['ana'].new_cdp_session(P['ana'])
        usage = P['ana'].evaluate("navigator.storage.estimate().then(e => e.usage)")
        cdp.send('Storage.overrideQuotaForOrigin', {'origin': f"http://127.0.0.1:{NODES['ana']['ui']}", 'quotaSize': usage + 50 * 1024 * 1024})
        P['ana'].reload(); login(P['ana'], first=False)
        check('less than 200 MB left: “Storage is almost full” banner', wait(P['ana'], "document.getElementById('storage-banner')?.textContent.includes('almost full')", 10000))
        P['ana'].screenshot(path=OUT + '/4-low-space.png')
        cdp.send('Storage.overrideQuotaForOrigin', {'origin': f"http://127.0.0.1:{NODES['ana']['ui']}"})
        P['ana'].click('#contacts .contact'); P['ana'].wait_for_timeout(500)
        # A write that fails (disk full): the message stays on screen marked "Not saved", never silently lost
        P['ana'].evaluate("(() => { window.__put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException('disk full', 'QuotaExceededError'); }; return 1; })()")
        send(P['bob'], 'this one cannot be saved')
        check('a message that couldn’t be stored carries a “Not saved” mark', wait(P['ana'], "!!document.querySelector('.stamp .not-saved')", 30000))
        check('…and the banner says some messages couldn’t be saved', wait(P['ana'], "document.getElementById('storage-banner')?.textContent.includes('couldn’t be saved')", 5000))
        P['ana'].screenshot(path=OUT + '/5-not-saved.png')
        P['ana'].evaluate("(() => { IDBObjectStore.prototype.put = window.__put; return 1; })()")
        send(P['bob'], 'space is back')
        check('once space is back, the next save clears the mark and the banner', wait(P['ana'], "!document.querySelector('.stamp .not-saved') && !document.getElementById('storage-banner')", 30000))
        check('no page errors', not errs, errs[:3])
        b.close()
finally:
    for p in procs: p.terminate()
print(f"\n{sum(1 for r in results if r[1])}/{len(results)} passed")
