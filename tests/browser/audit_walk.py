"""Long messages, disappearing messages removed from storage unopened, delivery to a contact who was offline."""
import sys, os, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
from playwright.sync_api import sync_playwright
import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import _args
OUT = _args.out(__file__)
net = H.Net(['ana', 'bob'], env={'PRESENCE_INTERVAL_MS': '5000', 'PRESENCE_FIRST_MS': '3000', 'PRESENCE_RECHECK_MS': '3000', 'PRESENCE_FRESH_MS': '4000'})
A, B = net.nodes['ana']['addr'], net.nodes['bob']['addr']
def thread_texts(pg): return pg.evaluate("[...document.querySelectorAll('#conv-body .bubble-text')].map(e => e.textContent)")
def idb_len(pg, key):
    return pg.evaluate("""(k) => new Promise((res) => { const r = indexedDB.open('anonchat'); r.onsuccess = () => { const db = r.result; const names = [...db.objectStoreNames];
      let found = null; let left = names.length; if (!left) res(null);
      for (const n of names) { const tx = db.transaction(n); const g = tx.objectStore(n).get(k); g.onsuccess = () => { if (g.result != null) found = JSON.stringify(g.result).length; if (--left === 0) res(found); }; g.onerror = () => { if (--left === 0) res(found); }; } }; r.onerror = () => res('noidb'); })""", key)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ctx = {k: b.new_context(viewport={'width': 1180, 'height': 780}) for k in ('ana', 'bob')}
        ana = H.prep(ctx['ana'], net, 'ana'); bob = H.prep(ctx['bob'], net, 'bob')
        bob.on('framenavigated', lambda f: print('NAV', f.url) if f == bob.main_frame else None)
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', B); H.add_contact(bob, 'Ana', A)
        H.open_contact(ana, 'Bob'); H.send(ana, 'hello bob')
        H.open_contact(bob, 'Ana'); H.sees(bob, 'hello bob'); H.send(bob, 'hello ana'); H.sees(ana, 'hello ana')
        long = ('long message ' * 1000).strip()
        ana.fill('#msg-input', long); ana.press('#msg-input', 'Enter')
        H.check('a 13 000-character message arrives intact', H.wait(bob, "[...document.querySelectorAll('#conv-body .bubble-text')].some(e => e.textContent.startsWith(" + json.dumps(long) + "))", 40000))
        ana.click('.head-btn.head-more'); ana.wait_for_timeout(200)
        ana.locator('#ctx-menu .ctx-item').first.click(); ana.wait_for_timeout(200)
        ana.click('#ctx-menu .ctx-item:has-text("30 seconds")'); ana.wait_for_timeout(300)
        bob.reload(); bob.wait_for_selector('.pin-key'); H.pin(bob, 1); bob.wait_for_timeout(1500)
        key = 'anyonechat.thread.' + A
        bob.wait_for_timeout(3000)
        keys = H.wait(bob, "new Promise(res => { const r = indexedDB.open('anonchat'); r.onsuccess = () => { const g = r.result.transaction('fields').objectStore('fields').getAllKeys(); g.onsuccess = () => res(g.result); }; })", 15000) or []
        key = [k for k in keys if k.startswith('anyonechat.t.')]; key = key[0] if key else None
        print('keys:', [k for k in keys][:10], 'key:', key, 'url:', bob.url)
        before = idb_len(bob, key)
        H.send(ana, 'self destruct 30s'); time.sleep(8)
        mid = idb_len(bob, key)
        H.check('the timed message reached Bob (stored)', mid and before and mid > before, f'{key}: {before} -> {mid}')
        time.sleep(35)
        after = idb_len(bob, key)
        H.check('expired with the chat never opened: removed from storage on its own', after is not None and mid and after < mid, f'{mid} -> {after}')
        ana.click('.head-btn.head-more'); ana.locator('#ctx-menu .ctx-item').first.click(); ana.click('#ctx-menu .ctx-item:has-text("Off")'); ana.wait_for_timeout(300)
        net.stop('bob'); time.sleep(1)
        H.send(ana, 'while you were away')
        H.wait(ana, "fetch('/api/outbox').then(r => r.json()).then(q => q.items.length > 0)", 30000)
        q = H.api(ana, '/api/outbox')
        H.check('message to an offline contact is queued, not lost', q['body'] and len(q['body']['items']) >= 1, q)
        ana.screenshot(path=OUT + '/queued.png')
        net.start('bob'); time.sleep(3)
        bob.reload(); bob.wait_for_selector('.pin-key', timeout=20000); H.pin(bob, 1); bob.wait_for_timeout(1000)
        H.open_contact(bob, 'Ana')
        t0 = time.time(); ok = H.sees(bob, 'while you were away', 300000)
        H.check('queued message arrives once the contact is back', ok, f'{time.time()-t0:.0f}s')
        print(f'   (queued delivery took {time.time()-t0:.0f} s after Bob came back)')
        b.close()
finally:
    net.close()
H.summary()
