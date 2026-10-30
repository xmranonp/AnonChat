"""Fourth pass (October 2026 audits). Adding someone already in your contacts is refused with a plain message, and their saved name and
keys stay. A picture whose name ends in .exe is saved as a picture (the ending of what it really is), not as a program."""
import sys, os, base64
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
net = H.Net(['ana', 'bob'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000'}, apps={'ana': H.hostile_app()})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
# A 1x1 PNG.
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ana = H.prep(b.new_context(viewport={'width': 1180, 'height': 780}, accept_downloads=True), net, 'ana')
        bob = H.prep(b.new_context(viewport={'width': 1180, 'height': 780}, accept_downloads=True), net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', A['bob'], 3000); H.add_contact(bob, 'Ana', A['ana'], 3000)
        H.open_contact(ana, 'Bob'); H.open_contact(bob, 'Ana')
        H.send(ana, 'hello'); H.sees(bob, 'hello', 60000)
        H.send(bob, 'hi'); H.sees(ana, 'hi', 60000)

        # Bob adds Ana again, under another name.
        before = H.api(bob, '/api/contacts')['body']
        bob.click('#add-contact-btn'); bob.fill('#in-petname', 'Ana again'); bob.fill('#in-address', A['ana']); bob.click('#add-confirm')
        bob.wait_for_timeout(1500)
        status = bob.inner_text('#add-status')
        H.check('adding a contact again is refused with a plain message', 'already in your contacts' in status and 'Ana' in status, status)
        after = H.api(bob, '/api/contacts')['body']
        H.check('…their saved name and keys stay', len(after) == 1 and after[0]['petname'] == 'Ana' and after[0]['ecdhPub'] == before[0]['ecdhPub'], after)
        bob.keyboard.press('Escape'); bob.wait_for_timeout(300)
        r = H.api(bob, '/api/contacts', 'POST', {'petname': 'X', 'address': A['ana']})
        H.check('…the background program refuses it too, whatever the window does', r['status'] == 409 and r['body'].get('error') == 'already_contact', r)

        # Ana sends a picture named like a program.
        # AnonChat itself now renames photos before sending, so the hostile name is put on the wire by a modified client (window.__evil).
        ana.evaluate("""async (b64) => { const E = window.__evil; const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const c = E.contactByAddress(%s);
          await E.deliver(c, E.encodeFrame('image', { name: 'holiday.jpg.exe', type: 'image/png', size: bytes.length, thumb: null, mid: crypto.randomUUID() }, bytes)); }""" % __import__('json').dumps(A['bob']), base64.b64encode(PNG).decode())
        H.wait(bob, "!!document.querySelector('#conv-body .bubble-image')", 60000)
        bob.wait_for_timeout(800)
        with bob.expect_download(timeout=15000) as dl:
            bob.evaluate("[...document.querySelectorAll('#conv-body .msg-save')].pop().click()")
        name = dl.value.suggested_filename
        H.check('a picture named “holiday.jpg.exe” is saved as holiday.jpg.png (Save in the message’s toolbar)', name == 'holiday.jpg.png', name)
        bob.evaluate("[...document.querySelectorAll('#conv-body .bubble-image')].pop().click()"); bob.wait_for_timeout(400)
        with bob.expect_download(timeout=15000) as dl2:
            bob.click('#avatar-zoom .zoom-dl-btn')
        H.check('…and from the enlarged picture', dl2.value.suggested_filename == 'holiday.jpg.png', dl2.value.suggested_filename)
        b.close()
    print('\n'.join(H.errs[:5]))
finally:
    net.close()
H.summary()
