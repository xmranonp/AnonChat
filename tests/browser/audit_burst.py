"""Twelve quick messages to a contact (like sending twelve photos) all arrive within seconds and in order."""
import sys, os, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
net = H.Net(['ana', 'bob'])
A, B = net.nodes['ana']['addr'], net.nodes['bob']['addr']
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ctx = {k: b.new_context(viewport={'width': 1180, 'height': 780}) for k in ('ana', 'bob')}
        ana = H.prep(ctx['ana'], net, 'ana'); bob = H.prep(ctx['bob'], net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', B); H.add_contact(bob, 'Ana', A)
        H.open_contact(ana, 'Bob'); H.send(ana, 'hello bob'); H.open_contact(bob, 'Ana'); H.sees(bob, 'hello bob'); H.send(bob, 'hi'); H.sees(ana, 'hi')
        time.sleep(2)
        t0 = time.time()
        for i in range(12):
            ana.fill('#msg-input', f'quick {i:02d}'); ana.press('#msg-input', 'Enter'); ana.wait_for_timeout(60)
        arrived = {}
        while time.time() - t0 < 120 and len(arrived) < 12:
            seen = bob.evaluate("[...document.querySelectorAll('#conv-body .bubble-text')].map(e => e.textContent.slice(0, 8)).filter(x => x.startsWith('quick '))")
            for s in seen: arrived.setdefault(s, round(time.time() - t0, 1))
            time.sleep(0.5)
        order = bob.evaluate("[...document.querySelectorAll('#conv-body .bubble-text')].map(e => e.textContent.slice(0, 8)).filter(x => x.startsWith('quick '))")
        print('   arrival times (s):', arrived)
        H.check('12 quick messages (like sending 12 photos) all arrive within 10 s', len(arrived) == 12 and max(arrived.values()) <= 10, f'{len(arrived)}/12, last at {max(arrived.values()) if arrived else None}s')
        H.check('…in the order they were sent', order == sorted(order), order)
        q = H.api(ana, '/api/outbox'); print('   queued at Ana after the burst:', len(q['body']['items']))
        b.close()
finally:
    net.close()
H.summary()
