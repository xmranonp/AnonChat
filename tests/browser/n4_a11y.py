"""N-4 (quick part): live regions for toasts and the conversation, a name on the sound button, and Escape closing the safety dialog."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
from playwright.sync_api import sync_playwright
net = H.Net(['ana', 'bob'])
A = {n: net.nodes[n]['addr'] for n in net.nodes}
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        ana = H.prep(b.new_context(), net, 'ana')
        attr = lambda sel, a: ana.evaluate("([s, a]) => document.querySelector(s)?.getAttribute(a)", [sel, a])
        H.check('#toast is a polite status region', attr('#toast', 'role') == 'status' and attr('#toast', 'aria-live') == 'polite')
        H.check('#conv-body is a polite log', attr('#conv-body', 'role') == 'log' and attr('#conv-body', 'aria-live') == 'polite')
        H.check('the logos are decorative (alt="")', ana.evaluate("() => [...document.querySelectorAll('img.brand-logo, img.pin-logo')].every(i => i.getAttribute('alt') === '')"))
        H.login(ana)
        H.check('#sound-btn has an accessible name', bool(attr('#sound-btn', 'aria-label')))
        bob = H.prep(b.new_context(), net, 'bob'); H.login(bob)
        H.add_contact(ana, 'Bob', A['bob']); H.open_contact(ana, 'Bob')
        ana.click('.conv-safe-btn'); ana.wait_for_timeout(500)
        H.check('the safety dialog is a labelled dialog', attr('#safety-overlay .safety-dialog', 'role') == 'dialog' and attr('#safety-overlay .safety-dialog', 'aria-labelledby') == 'safety-title')
        H.check('focus moves into the safety dialog', ana.evaluate("() => !!document.activeElement.closest('#safety-overlay')"))
        ana.keyboard.press('Escape'); ana.wait_for_timeout(300)
        H.check('Escape closes the safety dialog', ana.evaluate("() => document.getElementById('safety-overlay').hidden"))
        H.summary()
        b.close()
finally:
    net.close()
