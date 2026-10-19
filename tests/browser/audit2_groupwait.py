"""Second audit pass, groups with someone offline: Ana and Carl aren't each other's contacts and Carl is offline when the group starts, so
Ana's app has no keys for him. Her group message waits and reaches him once he is back. Carl's window stays open while his app restarts:
it must still know its own address when the invite arrives a moment later."""
import sys, os, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
OUT = _args.out(__file__)
net = H.Net(['bob', 'ana', 'carl'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ctx = {n: b.new_context(viewport={'width': 1180, 'height': 780}) for n in net.nodes}
        P = {n: H.prep(ctx[n], net, n) for n in net.nodes}
        for n in P: H.login(P[n])
        bob, ana, carl = P['bob'], P['ana'], P['carl']
        for n in ('ana', 'carl'): H.add_contact(P[n], 'Bob', A['bob'])
        H.add_contact(bob, 'Ana', A['ana']); H.add_contact(bob, 'Carl', A['carl'])
        net.stop('carl')                                   # Carl's computer is off (asleep, say)
        bob.click('#new-group-btn'); bob.wait_for_timeout(300); bob.fill('#grp-name', 'Trip')
        for cb in bob.locator('#grp-member-list input[type=checkbox]').all(): cb.check()
        bob.click('#grp-create'); bob.wait_for_timeout(1500)
        H.check('Ana gets the invite', H.wait(ana, "fetch('/api/groups').then(r=>r.json()).then(g => g.length === 1)", 40000))
        time.sleep(3)
        H.open_group(ana); H.send(ana, 'ana wrote while carl was away'); ana.wait_for_timeout(4000)
        toast = ana.evaluate("document.getElementById('toast')?.textContent || ''")
        print('Ana sees:', repr(toast))
        H.open_group(bob); H.send(bob, 'bob wrote while carl was away')
        net.start('carl'); time.sleep(3)
        carl.reload(); H.unlock(carl)
        H.check('Carl gets the invite once back', H.wait(carl, "fetch('/api/groups').then(r=>r.json()).then(g => g.length === 1)", 90000))
        H.open_group(carl)
        H.check('Carl gets Bob’s message (Bob has his keys: queued)', H.sees(carl, 'bob wrote while carl was away', 60000))
        H.check('Carl gets Ana’s message too', H.sees(carl, 'ana wrote while carl was away', 60000), 'never arrives')
        print('Ana’s queue:', ana.evaluate("fetch('/api/outbox').then(r => r.json()).then(j => j.items.length)"))
        carl.screenshot(path=OUT + '/t7-carl.png')
        b.close()
finally:
    net.close()
bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
H.check('no page errors', not bad, bad[:5])
H.summary()
