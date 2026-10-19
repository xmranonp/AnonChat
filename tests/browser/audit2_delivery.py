"""Second audit pass, sending to someone offline: a message is saved in the queue before its first try, so quitting AnonChat a moment
after sending can't lose it; two messages a moment apart both arrive when the contact comes back between their tries (each goes out on
its own, so either may arrive first: the receiving app shows them in the order written, see audit3_cross)."""
import sys, os, time, json, base64, threading, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
net = H.Net(['ana', 'bob'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
def call(n, path, body=None):
    v = net.nodes[n]; data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(f"http://127.0.0.1:{v['ui']}{path}", data=data, method='POST' if data else 'GET',
                               headers={'X-AnonChat-Token': H.TOKEN, 'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(r, timeout=120).read())
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        cA = b.new_context(viewport={'width': 1180, 'height': 780}); cB = b.new_context(viewport={'width': 1180, 'height': 780})
        ana, bob = H.prep(cA, net, 'ana'), H.prep(cB, net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', A['bob']); H.add_contact(bob, 'Ana', A['ana'])
        H.open_contact(ana, 'Bob'); H.send(ana, 'hi bob'); H.open_contact(bob, 'Ana')
        H.check('first message arrives', H.sees(bob, 'hi bob')); H.send(bob, 'hi ana'); H.check('…and the reply', H.sees(ana, 'hi ana'))

        # Bob is offline; Ana sends and quits while it still shows ⏳
        net.stop('bob')
        H.send(ana, 'sent just before quitting')
        H.check('it shows ⏳', H.wait(ana, "!!document.querySelector('#conv-body .receipt-tick.pending')", 10000))
        H.check('…and is in the queue file at once', H.wait(ana, "fetch('/api/outbox').then(r => r.json()).then(j => j.items.length === 1)", 3000))
        ana.close(); net.stop('ana')
        net.start('ana'); net.start('bob')
        H.check('after both are back, Bob gets it', H.sees(bob, 'sent just before quitting', 60000))
        b.close()

    # Two sends a second apart; Bob comes back between their tries (backend only)
    def send(tag, n, out):
        env = {'dh': 'B' + 'K' * 86 + '=', 'n': n, 'pn': 0, 'ct': base64.b64encode(f'order {tag}'.encode()).decode()}
        out[tag] = call('ana', '/api/send', {'toAddress': A['bob'], 'envelope': env, 'offlineTtl': 86400})
    for delay in (1.6, 2.0):
        net.stop('bob')
        out = {}
        ta = threading.Thread(target=send, args=('A%.1f' % delay, 0, out)); ta.start(); time.sleep(1.0)
        tb = threading.Thread(target=send, args=('B%.1f' % delay, 1, out)); tb.start(); time.sleep(delay)
        net.start('bob'); ta.join(); tb.join(); time.sleep(5)
        got = [base64.b64decode(e['ct']).decode() for e in sorted(call('bob', '/api/messages'), key=lambda e: e['receivedAt'])]
        got = [g for g in got if g.endswith('%.1f' % delay)]
        H.check(f'two sends a moment apart both arrive, once each (Bob back {delay} s after the second)', sorted(got) == ['order A%.1f' % delay, 'order B%.1f' % delay], got)
finally:
    net.close()
H.summary()
