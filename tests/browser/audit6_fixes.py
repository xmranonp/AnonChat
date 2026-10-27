"""Audit fixes 2 and 4: a group message for a member who is offline waits 24 h at most (the default for one-to-one chats), not the queue's
7 days; the three selects in Settings have a name for a screen reader; an uncaught error or unhandled rejection in the page is noted (not shown)."""
import sys, os, time
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
        bob = P['bob']
        H.add_contact(bob, 'Ana', A['ana']); H.add_contact(bob, 'Carl', A['carl'])
        for n in ('ana', 'carl'): H.add_contact(P[n], 'Bob', A['bob'])
        H.open_contact(bob, 'Carl'); H.send(bob, 'hello'); bob.wait_for_timeout(2500)   # Bob and Carl have exchanged keys
        net.stop('carl')
        bob.click('#new-group-btn'); bob.wait_for_timeout(300); bob.fill('#grp-name', 'Trip')
        for cb in bob.locator('#grp-member-list input[type=checkbox]').all(): cb.check()
        bob.click('#grp-create'); bob.wait_for_timeout(1500)
        H.open_group(bob); H.send(bob, 'while carl is away'); bob.wait_for_timeout(2500)
        items = H.api(bob, '/api/outbox')['body']['items']
        mine = [i for i in items if i['toAddress'] == A['carl']]
        print([(round((i['expiresAt'] - i['queuedAt']) / 3600000, 1)) for i in mine])
        H.check('something waits for Carl', len(mine) >= 1)
        H.check('every group item for Carl waits at most 24 h', all(i['expiresAt'] - i['queuedAt'] <= 24 * 3600 * 1000 + 5000 for i in mine))
        bob.click('#settings-btn'); bob.wait_for_timeout(900)
        names = bob.evaluate("[...document.querySelectorAll('select.set-select')].map(s => s.getAttribute('aria-label'))")
        print(names)
        H.check('three selects, all named', len(names) == 3 and all(names))
        before = bob.evaluate("window.__anonchatErrors().length")
        bob.evaluate("setTimeout(() => { throw new Error('boom-sync'); }, 0); void Promise.reject(new Error('boom-async'))"); bob.wait_for_timeout(500)
        errs = bob.evaluate("window.__anonchatErrors().map(e => e.kind + ': ' + e.message)")
        print(errs)
        H.check('an uncaught error and an unhandled rejection are both noted', len(errs) == before + 2 and any('boom-sync' in e for e in errs) and any('boom-async' in e for e in errs))
        H.check('…and the page keeps working', bob.evaluate("!!document.getElementById('msg-input') || !!document.querySelector('#settings-btn')"))
        b.close()
finally:
    net.close()
H.summary()
