"""The signed prekey is replaced every week (public/app.js rotateSpkIfDue). A contact whose app still holds the old one can still start a
chat: the first message is read with the retired key. Contacts learn the new one from the profile (server.js maybeRefreshProfile), told
to look by the notice sent after a rotation. Retired keys are deleted after 60 days. Rotation is driven by a test hook that moves the
clock forward (window.__anonchatSpk)."""
import sys, os, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
net = H.Net(['ana', 'bob'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
def bob_key_at(pg):
    c = [x for x in H.api(pg, '/api/contacts')['body'] if x['address'] == A['bob']]
    return c[0]['ratchetPub'] if c else None
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ana = H.prep(b.new_context(), net, 'ana'); bob = H.prep(b.new_context(), net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', A['bob']); H.add_contact(bob, 'Ana', A['ana'])
        k1 = bob.evaluate('window.__anonchatSpk.pub()')
        H.check('Ana holds Bob\'s signed prekey from when she added him', bob_key_at(ana) == k1, (bob_key_at(ana), k1))
        H.check('Bob has one signed prekey', bob.evaluate('window.__anonchatSpk.count()') == 1)

        print('-- Bob\'s prekey is replaced while Ana can\'t be reached (she keeps the old one)')
        net.hide('ana'); bob.wait_for_timeout(500)
        rotated = bob.evaluate('window.__anonchatSpk.rotate(8)')
        k2 = bob.evaluate('window.__anonchatSpk.pub()')
        H.check('a week later it is replaced', rotated is True and k2 and k2 != k1, (rotated, k1, k2))
        H.check('…and the old one is kept for a while', bob.evaluate('window.__anonchatSpk.count()') == 2)
        bob.wait_for_timeout(3000)
        net.hide(); ana.wait_for_timeout(500)
        H.check('Ana still holds the old one', bob_key_at(ana) == k1)

        print('-- Ana writes first, with the old prekey')
        H.open_contact(ana, 'Bob'); H.send(ana, 'hello on the old key')
        H.open_contact(bob, 'Ana')
        H.check('Bob reads it (with the retired key)', H.sees(bob, 'hello on the old key'))
        H.send(bob, 'reply on the new session')
        H.check('…and the chat goes on both ways', H.sees(ana, 'reply on the new session'))

        print('-- another replacement while Ana can be reached: she learns the new one')
        bob.evaluate('window.__anonchatSpk.rotate(16)')
        k3 = bob.evaluate('window.__anonchatSpk.pub()')
        got = H.wait(ana, "fetch('/api/contacts').then(r => r.json()).then(l => (l.find(c => c.address === %s) || {}).ratchetPub === %s)" % (json.dumps(A['bob']), json.dumps(k3)), 40000)
        H.check('Ana\'s app takes Bob\'s new prekey from his profile (signature checked)', got, (bob_key_at(ana), k3))

        print('-- retired keys are deleted after 60 days')
        bob.evaluate('window.__anonchatSpk.rotate(80)')
        H.check('only the current one and the one just retired are left', bob.evaluate('window.__anonchatSpk.count()') == 2, bob.evaluate('window.__anonchatSpk.count()'))
        H.send(ana, 'still talking')
        H.check('the chat in progress is not affected', H.sees(bob, 'still talking'))
        bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
        H.check('no page errors', not bad, bad[:3])
        b.close()
finally:
    net.close()
H.summary()
