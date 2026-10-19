"""Escape closes Settings, but closes a dialog opened on top of it first."""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
net = H.Net(['ana'])
hidden = lambda pg, i: pg.evaluate(f"(() => {{ const o = document.getElementById('{i}'); return !o || o.hidden; }})()")
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        pg = H.prep(b.new_context(viewport={'width': 1180, 'height': 780}), net, 'ana'); H.login(pg)
        ok = True
        for delay in (100, 500, 1500):
            pg.click('#settings-btn'); pg.wait_for_timeout(delay); pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
            ok = ok and hidden(pg, 'settings-overlay')
        H.check('Escape closes Settings (100 ms, 0.5 s and 1.5 s after opening)', ok)
        pg.click('#settings-btn'); pg.wait_for_timeout(300); pg.click('.settings-dialog .about-link'); pg.wait_for_timeout(300)
        pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
        H.check('with About open on top, Escape closes About only', hidden(pg, 'about-overlay') and not hidden(pg, 'settings-overlay'))
        pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
        H.check('…and a second Escape closes Settings', hidden(pg, 'settings-overlay'))
        pg.click('#settings-btn'); pg.wait_for_timeout(300); pg.click('.settings-dialog .erase-box button, .settings-dialog button:has-text("Erase")') if pg.locator('.settings-dialog button:has-text("Erase")').count() else None
        H.check('the Close button still works', (pg.click('.settings-dialog .confirm-cancel') or True) and hidden(pg, 'settings-overlay'))
        H.check('no page errors', not [e for e in H.errs if 'net::ERR' not in e], H.errs[:3])
        b.close()
finally: net.close()
H.summary()
