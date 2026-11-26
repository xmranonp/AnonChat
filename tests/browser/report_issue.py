"""Report an issue (1.1.0): the link at the bottom of Settings, next to About, opens its own window like About: the address to write to and
the app's details, each with Copy; the details name nothing personal (not your address); Escape and a click outside close it and leave
Settings open; the texts follow the app's language."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
OUT = _args.out(__file__)
net = H.Net(['ana'])
A = net.nodes['ana']['addr']
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        c = b.new_context(viewport={'width': 1180, 'height': 820}, permissions=['clipboard-read', 'clipboard-write'])
        pg = H.prep(c, net, 'ana'); H.login(pg)
        pg.click('#settings-btn'); pg.wait_for_selector('#report-link', timeout=10000)
        H.check('Settings has "Report an issue" next to "About"', pg.evaluate("""(() => { const a = [...document.querySelectorAll('.about-link')].map(x => x.textContent); return a.includes('About') && a.includes('Report an issue'); })()"""))
        pg.click('#report-link'); pg.wait_for_selector('#report-overlay .about-dialog', timeout=5000)
        H.check('it opens its own window, titled "Report an issue"', pg.text_content('#report-title') == 'Report an issue')
        H.check('…with the address to write to', 'xmranonp@tuta.io' in pg.text_content('#report-overlay'))
        det = H.wait(pg, "(() => { const d = document.querySelector('.report-details'); return d && /AnonChat \\d+\\.\\d+\\.\\d+/.test(d.textContent) ? d.textContent : null; })()", 10000)
        H.check('…and the app details: version, system, network, language', det and 'network:' in det and 'language: en' in det, det)
        H.check('…which name nothing personal (not your address)', det and A.split('.')[0][:12] not in det and '.anyone' not in det, det)
        pg.click('#report-copy-email'); pg.wait_for_timeout(200)
        H.check('Copy puts the address on the clipboard', pg.evaluate('navigator.clipboard.readText()') == 'xmranonp@tuta.io')
        pg.click('#report-copy-details'); pg.wait_for_timeout(200)
        H.check('Copy puts the details on the clipboard', pg.evaluate('navigator.clipboard.readText()') == det)
        H.check('the email is not a link that opens a mail program', not pg.query_selector('#report-overlay a[href^="mailto:"]'))
        pg.screenshot(path=OUT + '/report-1.png')
        pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
        H.check('Escape closes it, and Settings stays open', pg.evaluate("document.getElementById('report-overlay').hidden") and pg.is_visible('#report-link'))
        pg.click('#report-link'); pg.wait_for_timeout(300)
        pg.mouse.click(10, 10); pg.wait_for_timeout(200)
        H.check('a click outside closes it', pg.evaluate("document.getElementById('report-overlay').hidden"))
        pg.evaluate("localStorage.setItem('anyonechat.lang', 'es')"); pg.reload(); H.unlock(pg)
        pg.click('#settings-btn'); pg.wait_for_selector('#report-link', timeout=10000); pg.click('#report-link'); pg.wait_for_timeout(300)
        H.check('in Spanish: "Informar de un problema"', pg.text_content('#report-title') == 'Informar de un problema')
        b.close()
finally:
    net.close()
bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
H.check('no page errors', not bad, bad[:5])
H.summary()
