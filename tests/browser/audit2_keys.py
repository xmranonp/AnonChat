"""Second audit pass, the first message long after adding a contact. Two pairs, with window clocks moved forward (window.__skew):
- Cid adds Dan and writes 8 days later: Cid's app leaves the old one-time key out, and Dan reads the first message.
- Ana adds Bob, and Bob's app forgets the one-time key Ana holds (his clock is 15 days ahead): Bob's app tells Ana's, which switches to
  a new session; after that both sides write. (Ana's very first message is lost in that case.)"""
import sys, os, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
net = H.Net(['ana', 'bob', 'cid', 'dan'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ctx = {n: b.new_context(viewport={'width': 1180, 'height': 780}) for n in net.nodes}
        for n in ('bob', 'cid'): ctx[n].add_init_script(H.SKEW_JS)
        P = {n: H.prep(ctx[n], net, n) for n in net.nodes}
        for n in P: H.login(P[n])
        time.sleep(3)
        ana, bob, cid, dan = P['ana'], P['bob'], P['cid'], P['dan']
        H.add_contact(bob, 'Ana', A['ana']); H.add_contact(ana, 'Bob', A['bob'])
        H.add_contact(dan, 'Cid', A['cid']); H.add_contact(cid, 'Dan', A['dan'])
        opk = lambda pg, who: pg.evaluate(f"fetch('/api/contacts').then(r => r.json()).then(l => l.find(x => x.address === {json.dumps(A[who])}).opkId || null)")
        H.check('adding a contact hands out one of their one-time keys', bool(opk(ana, 'bob')) and bool(opk(cid, 'dan')))

        # Cid writes 8 days later
        cid.evaluate("window.__skew = 8 * 24 * 3600 * 1000")
        H.open_contact(cid, 'Dan'); H.send(cid, 'cid, eight days later'); H.open_contact(dan, 'Cid')
        H.check('8 days later: the first message is read', H.sees(dan, 'cid, eight days later', 60000))
        H.check('…sent without the old one-time key, which is cleared', not opk(cid, 'dan'))

        # Bob's app forgets the key Ana holds
        time.sleep(70)                                   # Bob's app notices the key was handed out (checked every minute)
        bob.evaluate("window.__skew = 15 * 24 * 3600 * 1000")
        time.sleep(70)                                   # …and forgets it at the next check
        H.open_contact(ana, 'Bob'); H.send(ana, 'ana, first try'); time.sleep(8); H.send(ana, 'ana, second try')
        H.open_contact(bob, 'Ana')
        H.check('after Bob’s app tells Ana’s, her next message is read', H.sees(bob, 'ana, second try', 60000))
        H.send(bob, 'bob answers'); H.check('…Bob’s answer reaches Ana', H.sees(ana, 'bob answers', 60000))
        H.send(ana, 'ana again'); H.check('…and they keep writing both ways', H.sees(bob, 'ana again', 60000))
        b.close()
finally:
    net.close()
bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
H.check('no page errors', not bad, bad[:5])
H.summary()
