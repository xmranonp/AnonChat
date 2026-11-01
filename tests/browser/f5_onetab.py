"""F-5 re-check: two tabs can no longer encrypt with the same ratchet step. A second tab waits on a notice and sends nothing; it carries on
by itself once the first is closed. A send's chain step is saved before the message leaves, so a reload right after sending can't reuse it."""
import os, sys, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
from playwright.sync_api import sync_playwright
net = H.Net(['ana', 'bob'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
sent = []                                      # every envelope any of Ana's tabs hands to her backend, across reloads
def log_send(route, request):
    try:
        b = json.loads(request.post_data or '{}')
        if b.get('envelope'): sent.append((b['envelope']['dh'], b['envelope'].get('pn', 0), b['envelope']['n']))
    except Exception: pass
    route.continue_()
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ctx_ana = b.new_context(); ctx_ana.route('**/api/send', log_send)
        ana = H.prep(ctx_ana, net, 'ana')
        ctx_bob = b.new_context(); bob = H.prep(ctx_bob, net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', A['bob']); H.add_contact(bob, 'Ana', A['ana'])
        H.open_contact(ana, 'Bob'); H.send(ana, 'first'); H.open_contact(bob, 'Ana'); H.sees(bob, 'first')
        H.send(bob, 'ack'); H.sees(ana, 'ack'); time.sleep(1)

        # A second tab of the same browser profile.
        ana2 = ctx_ana.new_page(); ana2.goto(net.url('ana'))
        shown = H.wait(ana2, "!!document.querySelector('#pin-screen .other-tab') && getComputedStyle(document.querySelector('#pin-screen')).display !== 'none'", 10000)
        H.check('a second tab shows the "open in another tab" notice', shown)
        H.check('…with the notice text, and no PIN pad or chat behind it', ana2.evaluate(
            "document.querySelector('#pin-screen .store-error-title')?.textContent.length > 5 && !document.querySelector('#pin-screen .pin-key') && !document.querySelector('#contacts .contact')"))
        n0 = len(sent)
        try: ana2.evaluate("() => { const i = document.querySelector('#msg-input'); if (i) { i.value = 'from-tab-2'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); } }")
        except Exception: pass
        H.send(ana, 'from-tab-1'); time.sleep(2)
        H.check('the second tab sends nothing; the first still works', len(sent) == n0 + 1 and H.sees(bob, 'from-tab-1'), (n0, len(sent)))

        # The first tab is closed: the second continues by itself.
        ana.close()
        H.check('once the first tab is closed, the second continues (PIN screen)', H.wait(ana2, "!!document.querySelector('.pin-key')", 15000))
        H.unlock(ana2); H.open_contact(ana2, 'Bob'); H.send(ana2, 'from-tab-2-now'); 
        H.check('…and can send', H.sees(bob, 'from-tab-2-now'))

        # Persist before send: reload at once after each send, several times; no chain position is ever used twice.
        for i in range(4):
            H.send(ana2, f'reload-{i}'); ana2.reload(); H.unlock(ana2); H.open_contact(ana2, 'Bob')
        H.send(ana2, 'after-reloads')
        ok_all = all(H.sees(bob, f'reload-{i}', 20000) for i in range(4)) and H.sees(bob, 'after-reloads')
        H.check('after reloads right after sending, every message still arrives', ok_all)
        H.check('no ratchet position (dh, pn, n) was ever used twice', len(sent) == len(set(sent)), [x for x in sent if sent.count(x) > 1][:2])
        H.check('no page errors', not [e for e in H.errs if 'favicon' not in e and 'Failed to load resource' not in e], H.errs[:3])
        b.close()
finally:
    net.close()
H.summary()
