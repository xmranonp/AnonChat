"""Third pass: both write first. Ana and Bob add each other and write at the same moment, before either has received anything, on a
network where every connection takes a few seconds to open. The tie-break keeps one side's session; what the other side wrote on its
own is sent again on the kept one. Every message arrives, once, both ways, and later ones too (a late copy of the dropped session must
never replace the kept one). Then, with connections taking a different time each, six quick messages arrive in any order and are shown
in the order written."""
import sys, os, json, time
os.environ.setdefault('FSOCKS_DELAY_MS', '1500'); os.environ.setdefault('FSOCKS_JITTER_MS', '3000')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
net = H.Net(['ana', 'bob'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
def got(pg, pre):
    return [t.strip()[:3] for t in pg.evaluate("[...document.querySelectorAll('#conv-body .bubble-text')].map(e => e.textContent)") if t.strip().startswith(pre)]
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ana = H.prep(b.new_context(viewport={'width': 1180, 'height': 780}), net, 'ana'); bob = H.prep(b.new_context(viewport={'width': 1180, 'height': 780}), net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', A['bob'], 4000); H.add_contact(bob, 'Ana', A['ana'], 4000)
        H.open_contact(ana, 'Bob'); H.open_contact(bob, 'Ana')
        for i in range(5): H.send(ana, f'a{i}:x'); H.send(bob, f'b{i}:x'); time.sleep(1.5)
        H.wait(bob, "[...document.querySelectorAll('#conv-body .bubble-text')].filter(e => e.textContent.startsWith('a')).length >= 5", 90000)
        H.wait(ana, "[...document.querySelectorAll('#conv-body .bubble-text')].filter(e => e.textContent.startsWith('b')).length >= 5", 90000)
        H.check('both wrote first: Bob gets all 5 of Ana’s first messages', sorted(set(got(bob, 'a'))) == [f'a{i}:' for i in range(5)], got(bob, 'a'))
        H.check('…and Ana all 5 of Bob’s', sorted(set(got(ana, 'b'))) == [f'b{i}:' for i in range(5)], got(ana, 'b'))
        H.check('…each once', len(got(bob, 'a')) == 5 and len(got(ana, 'b')) == 5, [got(bob, 'a'), got(ana, 'b')])
        time.sleep(20)   # late copies and retries of the dropped session have their chance to arrive
        for i in range(5, 8): H.send(ana, f'a{i}:x'); H.send(bob, f'b{i}:x'); time.sleep(1)
        H.check('later messages still get through both ways', H.wait(bob, "[...document.querySelectorAll('#conv-body .bubble-text')].filter(e => e.textContent.startsWith('a')).length >= 8", 60000)
                and H.wait(ana, "[...document.querySelectorAll('#conv-body .bubble-text')].filter(e => e.textContent.startsWith('b')).length >= 8", 60000), [got(bob, 'a'), got(ana, 'b')])
        H.check('…all of them, once', sorted(got(bob, 'a')) == [f'a{i}:' for i in range(8)] and sorted(got(ana, 'b')) == [f'b{i}:' for i in range(8)], [got(bob, 'a'), got(ana, 'b')])
        # A burst on a network where each connection takes a different time: arrival order varies, the order shown doesn't
        t0 = time.time()
        for i in range(6): ana.fill('#msg-input', f'q{i}:x'); ana.press('#msg-input', 'Enter'); time.sleep(0.2)
        H.wait(bob, "[...document.querySelectorAll('#conv-body .bubble-text')].filter(e => e.textContent.startsWith('q')).length >= 6", 90000)
        shown = [t.strip()[:2] for t in bob.evaluate("[...document.querySelectorAll('#conv-body .bubble-text')].map(e => e.textContent)") if t.strip().startswith('q')]
        H.check('a quick burst is shown in the order it was written, whatever order it arrived in', shown == [f'q{i}' for i in range(6)], shown)
        bob.reload(); H.unlock(bob); H.open_contact(bob, 'Ana')
        shown = [t.strip()[:2] for t in bob.evaluate("[...document.querySelectorAll('#conv-body .bubble-text')].map(e => e.textContent)") if t.strip().startswith('q')]
        H.check('…and still after reopening', shown == [f'q{i}' for i in range(6)], shown)
        H.check('no message shows as waiting', H.wait(ana, "!document.querySelector('#conv-body .receipt-tick.pending, #conv-body .receipt-tick.failed')", 30000) is not None)
        b.close()
finally:
    net.close()
bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
H.check('no page errors', not bad, bad[:5])
H.summary()
