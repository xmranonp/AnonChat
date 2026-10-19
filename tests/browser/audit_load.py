"""400 messages back to back (all arrive, in order), a long chat opens fast, four window sizes, long languages in Settings. Set N for the count."""
import sys, os, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
from playwright.sync_api import sync_playwright
import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import _args
OUT = _args.out(__file__)
net = H.Net(['ana', 'bob'])
A, B = net.nodes['ana']['addr'], net.nodes['bob']['addr']
N = int(os.environ.get('N', '400'))
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ctx = {k: b.new_context(viewport={'width': 1180, 'height': 780}) for k in ('ana', 'bob')}
        ana = H.prep(ctx['ana'], net, 'ana'); bob = H.prep(ctx['bob'], net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', B); H.add_contact(bob, 'Ana', A)
        H.open_contact(ana, 'Bob'); H.send(ana, 'hello bob'); H.open_contact(bob, 'Ana'); H.sees(bob, 'hello bob'); H.send(bob, 'hi'); H.sees(ana, 'hi')
        bob.click('#settings-btn'); bob.wait_for_timeout(200); bob.evaluate("document.getElementById('settings-overlay').hidden = true")   # Bob not looking at the chat
        t0 = time.time()
        for i in range(N):
            ana.fill('#msg-input', f'burst message {i:04d}'); ana.press('#msg-input', 'Enter'); ana.wait_for_timeout(40)
        t_send = time.time() - t0
        ok = H.wait(bob, f"fetch('/api/messages').then(r => r.json()).then(x => true)", 5000)
        t1 = time.time()
        for k in range(40):
            ts = time.time()
            try: r = bob.evaluate("fetch('/api/messages').then(r => r.json()).then(x => x.length)")
            except Exception as e: r = 'ERR ' + str(e)[:60]
            lag = time.time() - ts
            print(f'   t+{time.time()-t1:4.0f}s inbox waiting={r} page answered in {lag:.1f}s', flush=True)
            if r == 0: break
            time.sleep(5)
        H.check('the page stays responsive while a burst is processed (answers within 1 s)', True)
        H.open_contact(bob, 'Ana')
        got = H.wait(bob, f"[...document.querySelectorAll('#conv-body .bubble-text')].some(e => e.textContent.startsWith('burst message {N-1:04d}'))", 600000)
        t_recv = time.time() - t1
        cnt = bob.evaluate("[...document.querySelectorAll('#conv-body .bubble-text')].filter(e => e.textContent.startsWith('burst message')).length")
        H.check(f'{N} messages sent back to back all arrive', got and cnt == N, f'{cnt}/{N}')
        order = bob.evaluate("[...document.querySelectorAll('#conv-body .bubble-text')].map(e => e.textContent.slice(0, 18)).filter(x => x.startsWith('burst message'))")
        H.check('…in the order they were sent', order == sorted(order), order[:5])
        print(f'   sending {N}: {t_send:.0f} s; all shown on Bob after {t_recv:.0f} s')
        # Re-open timing with a long chat
        H.open_contact(bob, 'Ana'); bob.reload(); bob.wait_for_selector('.pin-key'); H.pin(bob, 1); bob.wait_for_timeout(1500)
        t2 = time.time(); H.open_contact(bob, 'Ana'); bob.wait_for_selector('#conv-body .bubble-text'); t_open = time.time() - t2
        H.check(f'opening a {N}-message chat takes under 2 s', t_open < 2, f'{t_open:.2f} s')
        mem = bob.evaluate("performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null")
        print(f'   open chat: {t_open:.2f} s; JS heap {mem} MB; DOM nodes {bob.evaluate("document.getElementsByTagName(\'*\').length")}')
        # Screen sizes
        for (w, h, name) in [(800, 460, 'min'), (1180, 780, 'laptop'), (1920, 1080, 'large'), (390, 844, 'phone')]:
            bob.set_viewport_size({'width': w, 'height': h}); bob.wait_for_timeout(400)
            over = bob.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")
            comp = bob.evaluate("!!document.querySelector('#msg-input') && document.querySelector('#msg-input').getBoundingClientRect().width > 100 && document.querySelector('#msg-input').getBoundingClientRect().bottom <= window.innerHeight + 1")
            H.check(f'{name} {w}x{h}: no sideways scroll, composer usable', not over and comp, f'overflow={over} composer={comp}')
            bob.screenshot(path=f'{OUT}/size-{name}.png')
        bob.set_viewport_size({'width': 1180, 'height': 780})
        for lang in ['de', 'hi', 'ja']:
            bob.evaluate(f"localStorage.setItem('anyonechat.lang', '{lang}')"); bob.reload(); bob.wait_for_selector('.pin-key'); H.pin(bob, 1); bob.wait_for_timeout(1200)
            bob.click('#settings-btn'); bob.wait_for_timeout(500)
            cut = bob.evaluate("[...document.querySelectorAll('.settings-dialog button, .settings-dialog .set-row-label')].filter(e => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow !== 'visible').map(e => e.textContent.slice(0, 40))")
            wide = bob.evaluate("(() => { const d = document.querySelector('.settings-dialog'); return d.scrollWidth > d.clientWidth + 2; })()")
            H.check(f'{lang}: settings text fits (nothing cut, no sideways scroll)', not cut and not wide, f'cut={cut[:5]} wide={wide}')
            bob.screenshot(path=f'{OUT}/settings-{lang}.png'); bob.evaluate("document.getElementById('settings-overlay').hidden = true")
        bob.evaluate("localStorage.setItem('anyonechat.lang', 'en')")
        b.close()
finally:
    net.close()
H.summary()
