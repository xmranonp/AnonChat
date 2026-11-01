"""N-3: the backend never replaces an existing identity key. A window that holds a different key (here: the other host name, an empty
origin) is refused with 409 and the published key stays the same; the same key, and profile updates, still work."""
import os, sys, json, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
from playwright.sync_api import sync_playwright
net = H.Net(['ana', 'bob'])
A = {n: net.nodes[n]['addr'] for n in net.nodes}
def pub_identity():
    r = urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{net.nodes['ana']['pub']}/api/identity", headers={'Host': A['ana']}), timeout=5)
    return json.loads(r.read())
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(); ctx = b.new_context()
        ana = H.prep(ctx, net, 'ana'); bob = H.prep(b.new_context(), net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(bob, 'Ana', A['ana']); H.add_contact(ana, 'Bob', A['bob'])
        H.open_contact(bob, 'Ana'); H.send(bob, 'hello ana'); H.open_contact(ana, 'Bob'); H.sees(ana, 'hello ana')
        before = pub_identity()
        r = H.api(ana, '/api/identity', 'POST', {'ecdhPub': before['ecdhPub'], 'ratchetPub': before['ratchetPub'], 'bio': 'same key'})
        H.check('same identity key: profile update accepted', r['status'] == 200, r)
        r = H.api(ana, '/api/identity', 'POST', {'ecdhPub': 'AAAA' + before['ecdhPub'][4:], 'ratchetPub': before['ratchetPub']})
        H.check('a different identity key is refused with 409', r['status'] == 409, r)
        H.check('the published identity key is unchanged after the refusal', pub_identity()['ecdhPub'] == before['ecdhPub'])
        # The other host name is a second, empty origin: its first-start setup must not replace the key.
        second = ctx.new_page()
        second.goto(f"http://localhost:{net.nodes['ana']['ui']}/#t={H.TOKEN}")
        second.wait_for_timeout(3000)
        if second.is_visible('.welcome-cta'):
            H.login(second); second.wait_for_timeout(3000)
        H.check("the second host name's setup does not change the published key", pub_identity()['ecdhPub'] == before['ecdhPub'])
        H.send(bob, 'second message'); time.sleep(4)
        H.check('Ana (first tab) still receives Bob', bool(H.sees(ana, 'second message', 25000)))
        H.summary()
        b.close()
finally:
    net.close()
