"""Safety numbers, read receipts, "allow calls" off, removing a contact (their next message arrives as a request) and accepting them back."""
import sys, os, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
net = H.Net(['ana', 'bob'])
A, B = net.nodes['ana']['addr'], net.nodes['bob']['addr']
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME, args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        ctx = {k: b.new_context(viewport={'width': 1180, 'height': 780}, permissions=['microphone']) for k in ('ana', 'bob')}
        ana = H.prep(ctx['ana'], net, 'ana'); bob = H.prep(ctx['bob'], net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', B); H.add_contact(bob, 'Ana', A)
        H.open_contact(ana, 'Bob'); H.send(ana, 'hello bob'); H.open_contact(bob, 'Ana'); H.sees(bob, 'hello bob'); H.send(bob, 'hi'); H.sees(ana, 'hi')
        # Safety numbers
        ana.click('.conv-safe-btn'); bob.click('.conv-safe-btn'); ana.wait_for_timeout(500)
        sa, sb = ana.inner_text('.safety-num'), bob.inner_text('.safety-num')
        H.check('both sides see the same safety number', sa == sb and len(sa.replace(' ', '')) >= 32, f'{sa} / {sb}')
        ana.click('.safety-dialog .confirm-ok'); ana.wait_for_timeout(300); bob.click('.safety-dialog .confirm-cancel')
        ana.reload(); ana.wait_for_selector('.pin-key'); H.pin(ana, 1); ana.wait_for_timeout(1500); H.open_contact(ana, 'Bob')
        H.check('"verified" survives a restart', ana.locator('.conv-safe-btn.verified').count() == 1)
        # Read receipts: off by default
        H.send(ana, 'receipt test 1'); H.sees(bob, 'receipt test 1'); time.sleep(4)
        last = ana.evaluate("[...document.querySelectorAll('#conv-body .bubble.out')].pop().innerText")
        H.check('read receipts off by default: Ana sees no "read" mark', '✓✓' not in last, last)
        bob.click('#settings-btn'); bob.wait_for_timeout(400)
        row = bob.locator('.settings-dialog .set-opt-row:has-text("read receipts") .set-toggle, .settings-dialog .set-opt-row:has-text("Send read receipts") .set-toggle')
        n = row.count(); row.first.click() if n else None; bob.wait_for_timeout(300)
        bob.evaluate("document.getElementById('settings-overlay').hidden = true")
        st = H.api(bob, '/api/settings')
        H.check('turning read receipts on is saved', st['body'].get('readReceipts') is True, st)
        H.send(ana, 'receipt test 2'); H.sees(bob, 'receipt test 2')
        ok = H.wait(ana, "(() => { const b = [...document.querySelectorAll('#conv-body .bubble.out')].pop(); return b && (b.innerText.includes('✓✓') || !!b.querySelector('.read, .ticks.read, [data-read]')); })()", 20000)
        H.check('with receipts on, Ana sees her message was read', ok, ana.evaluate("[...document.querySelectorAll('#conv-body .bubble.out')].pop().innerHTML.slice(-300)"))
        # Calls off
        bob.click('#settings-btn'); bob.wait_for_timeout(400)
        t = bob.locator('.settings-dialog .set-opt-row:has-text("voice calls") .set-toggle'); t.first.click() if t.count() else None
        bob.evaluate("document.getElementById('settings-overlay').hidden = true")
        H.check('"allow calls" off is remembered', bob.evaluate("localStorage.getItem('anyonechat.calls.off')") == '1')
        ana.click('.conv-call')
        ok = H.wait(ana, "document.body.innerText.includes('declined') || document.body.innerText.includes('Declined')", 40000)
        H.check('calling someone who turned calls off ends as declined', ok)
        H.check('…and Bob’s app never rang', bob.locator('#contacts .contact.ringing').count() == 0)
        ana.wait_for_timeout(3000)
        # Remove contact and re-add
        bob.click('#contacts .contact:has-text("Ana")', button='right'); bob.click('#ctx-menu .ctx-item:has-text("Remove contact")'); bob.click('#confirm-overlay .confirm-ok'); bob.wait_for_timeout(800)
        H.check('removed contact is gone', bob.locator('#contacts .contact:has-text("Ana")').count() == 0)
        H.send(ana, 'after removal')
        ok = H.wait(bob, "document.getElementById('requests-btn').classList.contains('has')", 30000)
        H.check('a message from a removed contact arrives as a request', ok)
        bob.click('#requests-btn'); bob.wait_for_timeout(300); bob.click('#req-panel .req-entry-head'); bob.wait_for_timeout(300)
        H.check('…and the request holds the first message written after the removal', 'after removal' in bob.inner_text('#req-panel'), bob.inner_text('#req-panel')[:200])
        bob.click('#req-panel .req-actions .btn.primary'); bob.wait_for_timeout(300); bob.fill('#in-nickname', 'Ana'); bob.click('#name-ok')
        H.check('accepting it makes Ana a contact again (her key checked at her address)', H.wait(bob, "[...document.querySelectorAll('#contacts .contact-name')].some(e => e.textContent === 'Ana')", 30000))
        bob.keyboard.press('Escape'); H.open_contact(bob, 'Ana')
        H.send(bob, 'readded'); H.check('after re-adding, messages flow again', H.sees(ana, 'readded', 40000))
        H.send(ana, 'and back'); H.check('…both ways', H.sees(bob, 'and back', 40000))
        bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e]
        H.check('no page errors', not bad, bad[:5])
        b.close()
finally: net.close()
H.summary()
