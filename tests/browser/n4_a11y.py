"""N-4: live regions for toasts and the conversation, a name on the sound button from the first screen on (not only after unlock), no unnamed
images in the accessibility tree on any screen (drawn icons and avatars are decorative), and Escape closing the safety dialog."""
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
        # Chromium's accessibility tree: every button named, no image without a name. Taken on each screen before and after unlock.
        def tree(pg):
            cdp = pg.context.new_cdp_session(pg); cdp.send('Accessibility.enable')
            out = {'unnamedButtons': [], 'unnamedImages': 0}
            for n in cdp.send('Accessibility.getFullAXTree')['nodes']:
                if n.get('ignored'): continue
                role = (n.get('role') or {}).get('value'); name = str((n.get('name') or {}).get('value', '')).strip()
                if role == 'button' and not name: out['unnamedButtons'].append(n.get('backendDOMNodeId'))
                if role in ('image', 'img', 'graphics-symbol', 'graphics-document') and not name: out['unnamedImages'] += 1
            cdp.detach(); return out
        ana.wait_for_selector('.welcome-cta'); ana.wait_for_timeout(500)
        H.check('welcome screen: #sound-btn already has its name', bool(attr('#sound-btn', 'aria-label')) and bool(attr('#sound-btn', 'title')), attr('#sound-btn', 'aria-label'))
        t = tree(ana); H.check('welcome screen: no unnamed button, no unnamed image', not t['unnamedButtons'] and t['unnamedImages'] == 0, t)
        ana.click('.welcome-cta'); ana.wait_for_selector('.pin-key'); ana.wait_for_timeout(400)
        t = tree(ana); H.check('PIN screen: no unnamed button, no unnamed image', not t['unnamedButtons'] and t['unnamedImages'] == 0, t)
        H.pin(ana, 2); ana.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000); ana.wait_for_timeout(600)
        H.check('#sound-btn has an accessible name', bool(attr('#sound-btn', 'aria-label')))
        t = tree(ana); H.check('main screen: no unnamed button, no unnamed image', not t['unnamedButtons'] and t['unnamedImages'] == 0, t)
        bob = H.prep(b.new_context(), net, 'bob'); H.login(bob)
        H.add_contact(ana, 'Bob', A['bob']); H.open_contact(ana, 'Bob')
        t = tree(ana); H.check('a chat: no unnamed button, no unnamed image (avatars and icons are decorative)', not t['unnamedButtons'] and t['unnamedImages'] == 0, t)
        # dialogs: hiding drawn icons must never leave a button without a name
        ana.click('#settings-btn'); ana.wait_for_selector('#upd-auto-sw'); ana.wait_for_timeout(500)
        t = tree(ana); H.check('Settings: no unnamed button, no unnamed image', not t['unnamedButtons'] and t['unnamedImages'] == 0, t)
        H.check('Settings: the update switch is reachable and works from the keyboard', ana.evaluate("() => { const b = document.getElementById('upd-auto-sw'); b.focus(); return document.activeElement === b; }"))
        ana.keyboard.press('Space'); ana.wait_for_timeout(150)
        H.check('Space turns the switch on, Enter turns it off again', ana.get_attribute('#upd-auto-sw', 'aria-checked') == 'true')
        ana.keyboard.press('Enter'); ana.wait_for_timeout(150)
        H.check('...and back', ana.get_attribute('#upd-auto-sw', 'aria-checked') == 'false')
        ana.keyboard.press('Escape'); ana.wait_for_timeout(300)
        # The bell's name follows its state through a language change (a muted bell is never called "Mute").
        on_en = ana.get_attribute('#sound-btn', 'aria-label'); ana.click('#sound-btn'); ana.wait_for_timeout(150)
        off_en = ana.get_attribute('#sound-btn', 'aria-label')
        ana.click('#settings-btn'); ana.wait_for_selector('#upd-auto-sw')
        ana.evaluate("() => { const s = [...document.querySelectorAll('#settings-overlay select')].find((x) => [...x.options].some((o) => o.value === 'es')); s.value = 'es'; s.dispatchEvent(new Event('change')); }")
        ana.wait_for_timeout(500); ana.keyboard.press('Escape'); ana.wait_for_timeout(300)
        off_es = ana.get_attribute('#sound-btn', 'aria-label'); ana.click('#sound-btn'); ana.wait_for_timeout(150)
        on_es = ana.get_attribute('#sound-btn', 'aria-label')
        H.check('muted bell after a language change: named "unmute" in the new language, not "mute"', off_es and off_es != on_es and off_es != off_en and on_es != on_en, (on_en, off_en, off_es, on_es))
        H.check('...and its tooltip says the same', ana.get_attribute('#sound-btn', 'title') == on_es)
        ana.click('#settings-btn'); ana.wait_for_selector('#upd-auto-sw')
        ana.evaluate("() => { const s = [...document.querySelectorAll('#settings-overlay select')].find((x) => [...x.options].some((o) => o.value === 'en')); s.value = 'en'; s.dispatchEvent(new Event('change')); }")
        ana.wait_for_timeout(500); ana.keyboard.press('Escape'); ana.wait_for_timeout(300)
        ana.click('#add-contact-btn'); ana.wait_for_selector('#in-address'); ana.wait_for_timeout(300)
        t = tree(ana); H.check('Add contact: no unnamed button, no unnamed image', not t['unnamedButtons'] and t['unnamedImages'] == 0, t)
        ana.keyboard.press('Escape'); ana.wait_for_timeout(300)
        ana.click('#new-group-btn'); ana.wait_for_timeout(500)
        t = tree(ana); H.check('New group: no unnamed button, no unnamed image', not t['unnamedButtons'] and t['unnamedImages'] == 0, t)
        ana.keyboard.press('Escape'); ana.wait_for_timeout(300)
        ana.click('.conv-safe-btn'); ana.wait_for_timeout(500)
        H.check('the safety dialog is a labelled dialog', attr('#safety-overlay .safety-dialog', 'role') == 'dialog' and attr('#safety-overlay .safety-dialog', 'aria-labelledby') == 'safety-title')
        H.check('focus moves into the safety dialog', ana.evaluate("() => !!document.activeElement.closest('#safety-overlay')"))
        ring = "() => getComputedStyle(document.activeElement).outlineStyle"
        H.check('opened with the mouse: no focus ring on Close', ana.evaluate(ring) == 'none', ana.evaluate(ring))
        if os.environ.get('SHOT'): ana.screenshot(path=os.environ['SHOT'] + '/safety-mouse.png')
        ana.keyboard.press('Tab'); ana.keyboard.press('Shift+Tab'); ana.wait_for_timeout(150)
        H.check('reached with the keyboard: the focus ring shows', ana.evaluate(ring) != 'none', ana.evaluate(ring))
        ana.keyboard.press('Escape'); ana.wait_for_timeout(300)
        H.check('Escape closes the safety dialog', ana.evaluate("() => document.getElementById('safety-overlay').hidden"))
        H.summary()
        b.close()
finally:
    net.close()
