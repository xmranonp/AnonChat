"""Second audit pass, names: your own address can't be added as a contact; in a group, someone who isn't your contact shows the name the
admin gave them with their short address beside it, and a contact shows your own name for them; a right-click on a group offers Leave group. Bob is the admin; Ana and Carl only know Bob."""
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
        # Your own address
        ana.click('#add-contact-btn'); ana.fill('#in-petname', 'Me'); ana.fill('#in-address', A['ana']); ana.click('#add-confirm'); ana.wait_for_timeout(1500)
        H.check('your own address is refused, with a reason', 'your own address' in ana.inner_text('#add-status').lower(), ana.inner_text('#add-status'))
        H.check('…and not saved', not ana.evaluate(f"fetch('/api/contacts').then(r => r.json()).then(l => l.some(c => c.address === {json.dumps(A['ana'])}))"))
        H.check('…the backend refuses it too', H.api(ana, '/api/contacts', 'POST', {'petname': 'Me', 'address': A['ana']})['status'] == 400)
        ana.keyboard.press('Escape')
        # Group names
        for n in ('ana', 'carl'): H.add_contact(P[n], 'Bob', A['bob'])
        H.add_contact(bob, 'Ana', A['ana']); H.add_contact(bob, 'Carl', A['carl'])
        bob.click('#new-group-btn'); bob.wait_for_timeout(300); bob.fill('#grp-name', 'Names')
        for cb in bob.locator('#grp-member-list input[type=checkbox]').all(): cb.check()
        bob.click('#grp-create'); bob.wait_for_timeout(1500)
        for n in ('ana', 'carl'): H.check(f'{n} gets the invite', H.wait(P[n], "fetch('/api/groups').then(r=>r.json()).then(g => g.length === 1)", 40000))
        H.open_group(carl); H.send(carl, 'carl writes'); H.open_group(bob); H.send(bob, 'bob writes')
        H.open_group(ana)
        H.check('Ana sees both', H.sees(ana, 'carl writes') and H.sees(ana, 'bob writes'))
        labels = ana.evaluate("[...document.querySelectorAll('#conv-body .bubble-sender')].map(e => e.textContent)")
        short = ana.evaluate(f"(a => a.slice(0, 10))({json.dumps(A['carl'])})")
        H.check('a member who isn’t your contact: the admin’s name and their short address', any(l.startswith('Carl') and short in l for l in labels), labels)
        H.check('a contact: your own name for them, no address', any(l.strip() == 'Bob' for l in labels), labels)
        # Pictures: beside the first message of each run from the same person, and the name only there
        H.open_group(carl); H.send(carl, 'carl again'); H.send(carl, 'carl third'); H.open_group(ana)
        H.wait(ana, "[...document.querySelectorAll('#conv-body .bubble-text')].some(e => e.textContent.includes('carl third'))", 40000)
        runs = ana.evaluate("[...document.querySelectorAll('#conv-body .bubble-row.grp-in')].map(r => [!!r.querySelector('.grp-av'), !!r.querySelector('.bubble-sender'), r.querySelector('.bubble-text')?.textContent.slice(0, 10)])")
        H.check('group: a picture and the name beside the first message of each run from the same person, not on the ones after it', [x[:2] for x in runs] == [[True, True], [True, True], [True, True], [False, False]], runs)
        # A member who isn't a contact sets a profile picture later: it reaches Ana's app and shows beside his group messages
        import urllib.request
        ident = json.loads(urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{net.nodes['carl']['pub']}/api/identity", headers={'Host': A['carl']})).read())
        PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
        H.api(carl, '/api/identity', 'POST', {'ecdhPub': ident['ecdhPub'], 'ratchetPub': ident['ratchetPub'], 'avatar': PNG})
        H.api(carl, '/api/profile/broadcast', 'POST', {})      # what his app does when he changes his picture
        H.send(carl, 'with a picture now')
        H.wait(ana, "[...document.querySelectorAll('#conv-body .bubble-text')].some(e => e.textContent.includes('with a picture now'))", 40000)
        for _ in range(3):
            if ana.evaluate("[...document.querySelectorAll('#conv-body img.grp-av')].length > 0"): break
            time.sleep(4); H.send(carl, 'and again'); ana.wait_for_timeout(3000)
        H.check('a member who isn’t a contact: the picture he set shows beside his group messages', ana.evaluate("[...document.querySelectorAll('#conv-body img.grp-av')].some(i => i.src.startsWith('data:image/png'))"))
        ana.screenshot(path=OUT + '/1-group-names.png')
        # Right-click on a group in the list: Leave group
        ana.click('#groups .contact', button='right'); ana.wait_for_timeout(300)
        items = ana.evaluate("[...document.querySelectorAll('#ctx-menu .ctx-item')].map(e => e.textContent)")
        H.check('right-click on a group offers Leave group', any('Leave group' in x for x in items), items)
        ana.screenshot(path=OUT + '/2-group-right-click.png')
        ana.click('#ctx-menu .ctx-item:has-text("Leave group")'); ana.wait_for_timeout(300); ana.click('#confirm-overlay .confirm-ok')
        H.check('…leaving from there works', H.wait(ana, "fetch('/api/groups').then(r=>r.json()).then(g => g.length === 0)", 10000))
        H.check('…and Bob sees Ana left', H.wait(bob, f"fetch('/api/groups').then(r=>r.json()).then(g => g[0] && !g[0].members.some(m => m.address === {json.dumps(A['ana'])}))", 40000))
        b.close()
finally:
    net.close()
bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
H.check('no page errors', not bad, bad[:5])
H.summary()
