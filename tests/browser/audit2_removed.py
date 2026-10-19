"""Second audit pass, removing contacts and writing again. 1: both removed each other, Ana adds Bob again: she writes text only, Bob gets a
message request, accepting restores everything. 3: only Ana removed Bob and adds him back: he reads her at once and she is unlocked again.
2: only Bob removed Ana: her next message arrives as a request, Bob's app tells hers so she is limited to text, and Bob accepting
unlocks her again."""
import sys, os, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
net = H.Net(['ana', 'bob'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
def remove(pg, name):
    pg.click(f'#contacts .contact:has-text("{name}")', button='right'); pg.click('#ctx-menu .ctx-item:has-text("Remove contact")')
    pg.click('#confirm-overlay .confirm-ok'); pg.wait_for_timeout(800)
def text_only(pg): return pg.evaluate("document.getElementById('composer').classList.contains('text-only')")
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ana = H.prep(b.new_context(viewport={'width': 1180, 'height': 780}), net, 'ana'); bob = H.prep(b.new_context(viewport={'width': 1180, 'height': 780}), net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', A['bob']); H.add_contact(bob, 'Ana', A['ana'])
        H.open_contact(ana, 'Bob'); H.send(ana, 'hello'); H.open_contact(bob, 'Ana'); H.sees(bob, 'hello'); H.send(bob, 'hi'); H.sees(ana, 'hi')
        # 1. Both remove each other; Ana adds Bob again and writes
        remove(ana, 'Bob'); remove(bob, 'Ana')
        H.add_contact(ana, 'Bob', A['bob']); H.open_contact(ana, 'Bob')
        H.check('1. after both removed and Ana re-added Bob: Ana is limited to text', text_only(ana))
        H.send(ana, 'case one: back again')
        H.check('1. …Bob gets it as a message request', H.wait(bob, "document.getElementById('requests-btn').classList.contains('has')", 40000))
        bob.click('#requests-btn'); bob.wait_for_timeout(300); bob.click('#req-panel .req-entry-head'); bob.wait_for_timeout(300)
        H.check('1. …with the text', 'case one: back again' in bob.inner_text('#req-panel'), bob.inner_text('#req-panel')[:200])
        bob.click('#req-panel .req-actions .btn.primary'); bob.wait_for_timeout(300); bob.fill('#in-nickname', 'Ana'); bob.click('#name-ok')
        H.check('1. Bob accepts: Ana is a contact again', H.wait(bob, "[...document.querySelectorAll('#contacts .contact-name')].some(e => e.textContent === 'Ana')", 30000))
        H.check('1. …and Ana can send everything again', H.wait(ana, "(document.querySelector('#contacts .contact') && !document.getElementById('composer').classList.contains('text-only'))", 30000))
        H.send(bob, 'case one: welcome back'); H.check('1. …both ways', H.sees(ana, 'case one: welcome back', 40000))
        bob.keyboard.press('Escape')
        # 3. Only Ana removes Bob (Bob keeps her), then adds him again and writes
        remove(ana, 'Bob'); H.add_contact(ana, 'Bob', A['bob']); H.open_contact(ana, 'Bob')
        H.send(ana, 'case three: re-added')
        H.check('3. Bob (who kept Ana) reads it in their chat', H.sees(bob, 'case three: re-added', 40000))
        H.check('3. …and Ana can send everything again soon after', H.wait(ana, "!document.getElementById('composer').classList.contains('text-only')", 30000))
        H.send(bob, 'case three: reply'); H.check('3. …both ways', H.sees(ana, 'case three: reply', 40000))
        # 2. Only Bob removes Ana; Ana writes
        remove(bob, 'Ana')
        H.send(ana, 'case two: still there?')
        H.check('2. Bob removed Ana: her message arrives as a request', H.wait(bob, "document.getElementById('requests-btn').classList.contains('has')", 40000))
        H.check('2. …and Ana’s app is told: she is limited to text', H.wait(ana, "document.getElementById('composer').classList.contains('text-only')", 30000))
        ana.screenshot(path=_args.out(__file__) + '/2-told-text-only.png')
        bob.click('#requests-btn'); bob.wait_for_timeout(300); bob.click('#req-panel .req-entry-head'); bob.wait_for_timeout(300)
        bob.click('#req-panel .req-actions .btn.primary'); bob.wait_for_timeout(300); bob.fill('#in-nickname', 'Ana'); bob.click('#name-ok')
        H.check('2. Bob accepts: Ana can send everything again', H.wait(ana, "!document.getElementById('composer').classList.contains('text-only')", 30000))
        H.send(bob, 'case two: back'); H.check('2. …both ways', H.sees(ana, 'case two: back', 40000))
        b.close()
finally:
    net.close()
bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
H.check('no page errors', not bad, bad[:5])
H.summary()
