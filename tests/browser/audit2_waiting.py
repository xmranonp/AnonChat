"""Second audit pass, what the sender sees: a message shown as waiting (⏳) gets its outcome even if it came while the window wasn't
connected. A1 delivered while the window was closed; A2 the window closed during the first tries; B1 the waiting time ran out while the
app was closed (shown "not delivered"); B2 the app was quit during the first tries (still delivered, and shown so)."""
import sys, os, time, json, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
OUT = _args.out(__file__)
net = H.Net(['ana', 'bob'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
def ui(n, path):
    v = net.nodes[n]
    r = urllib.request.Request(f"http://127.0.0.1:{v['ui']}{path}", headers={'X-AnonChat-Token': H.TOKEN})
    return json.loads(urllib.request.urlopen(r, timeout=5).read())
def tick(pg, text):
    return pg.evaluate(f"""(() => {{ const b = [...document.querySelectorAll('#conv-body .bubble')].find(x => x.textContent.includes({json.dumps(text)}));
        if (!b) return null; const t = b.querySelector('.receipt-tick'); return t ? t.textContent.trim() : '(none)'; }})()""")
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        cA = b.new_context(viewport={'width': 1180, 'height': 780}); cB = b.new_context(viewport={'width': 1180, 'height': 780})
        ana, bob = H.prep(cA, net, 'ana'), H.prep(cB, net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', A['bob']); H.add_contact(bob, 'Ana', A['ana'])
        H.open_contact(ana, 'Bob'); H.send(ana, 'hi bob'); H.open_contact(bob, 'Ana')
        H.check('Bob gets the first message', H.sees(bob, 'hi bob')); H.send(bob, 'hi ana'); H.check('Ana gets the reply', H.sees(ana, 'hi ana'))

        def pending_bubble(pg, text):
            return H.wait(pg, f"(() => {{ const b = [...document.querySelectorAll('#conv-body .bubble')].find(x => x.textContent.includes({json.dumps(text)})); return b && b.querySelector('.receipt-tick.pending'); }})()", 30000)
        def queued(n, ms=60000):
            t0 = time.time()
            while time.time() - t0 < ms / 1000:
                if ui(n, '/api/outbox')['items']: return round(time.time() - t0, 1)
                time.sleep(0.5)
            return None
        def drained(n, ms=90000):
            t0 = time.time()
            while time.time() - t0 < ms / 1000:
                if not ui(n, '/api/outbox')['items']: return True
                time.sleep(1)
            return False
        def reopen():
            pg = H.prep(cA, net, 'ana'); H.unlock(pg); pg.wait_for_timeout(1500); H.open_contact(pg, 'Bob'); pg.wait_for_timeout(1500); return pg

        # ---- A1: queued, then delivered while Ana's window is closed ----
        net.stop('bob')
        H.send(ana, 'case A1'); pending_bubble(ana, 'case A1')
        q = queued('ana'); H.check('A1 reaches Ana’s queue', q is not None, q); print('A1 queued after', q, 's of trying')
        ana.wait_for_timeout(1500)
        ana.close()
        net.start('bob')
        H.check('the backend delivers A1 while the window is closed', drained('ana'))
        H.check('Bob has A1', H.sees(bob, 'case A1'))
        ana = reopen(); time.sleep(10)
        t = tick(ana, 'case A1')
        H.check('A1 shows ✓ when Ana opens the app again', t == '\u2713', f'shows {t!r}')
        ana.screenshot(path=OUT + '/t2-A1.png')

        # ---- A2: the window closes during the first tries; the backend carries on ----
        net.stop('bob')
        H.send(ana, 'case A2'); pending_bubble(ana, 'case A2')
        ana.close()
        q = queued('ana'); H.check('A2 is queued by the backend after the window closed', q is not None, q)
        net.start('bob')
        H.check('…and delivered', drained('ana')); H.check('Bob has A2', H.sees(bob, 'case A2'))
        ana = reopen(); time.sleep(10)
        t = tick(ana, 'case A2')
        H.check('A2 shows ✓ when Ana opens the app again', t == '\u2713', f'shows {t!r}')

        # ---- B1: queued, and the waiting time runs out while the app is closed ----
        net.stop('bob')
        H.send(ana, 'case B1'); pending_bubble(ana, 'case B1')
        q = queued('ana'); H.check('B1 reaches Ana’s queue', q is not None, q)
        ana.wait_for_timeout(1500)
        ana.close(); net.stop('ana')
        f = net.nodes['ana']['dir'] + '/data/outbox.json'
        qq = json.load(open(f))
        for i in qq['items']: i['expiresAt'] = int(time.time() * 1000) - 60000      # the app stayed closed past the chosen 1/12/24 h
        json.dump(qq, open(f, 'w'))
        net.start('ana'); time.sleep(3)
        H.check('the backend drops B1 as expired at start', not ui('ana', '/api/outbox')['items'])
        ana = reopen(); time.sleep(10)
        t = tick(ana, 'case B1')
        H.check('B1 shows “not delivered”', t is not None and t.startswith('\u26a0'), f'shows {t!r}')

        # ---- B2: the app is quit during the first tries ----
        H.send(ana, 'case B2'); pending_bubble(ana, 'case B2')
        ana.wait_for_timeout(1000)
        ana.close(); net.stop('ana')
        f = net.nodes['ana']['dir'] + '/data/outbox.json'
        print('queue file after quitting:', open(f).read()[:80] if os.path.exists(f) else '(none)')
        net.start('ana'); net.start('bob'); time.sleep(40)
        H.check('B2 reaches Bob once both are back', H.sees(bob, 'case B2', 20000), 'never arrives')
        ana = reopen(); time.sleep(5)
        t = tick(ana, 'case B2')
        H.check('…or Ana is told it wasn’t sent', t is not None and t != '\u23f3', f'shows {t!r}')
        ana.screenshot(path=OUT + '/t2-B2.png')
        b.close()
finally:
    net.close()
bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
H.check('no page errors', not bad, bad[:5])
H.summary()
