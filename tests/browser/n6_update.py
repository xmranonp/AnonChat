"""Update check at start (off by default). The switch in Settings → Updates; with it on, once the network is ready the window asks the
backend for the latest release (the answer is faked here, the backend's own route is covered by the update-check tests) and shows a window
for a version it has not shown yet. Closing the window records the version; the next start still checks, and a newer version is shown.
Up to date, offline and failed checks show nothing. The 20-second wait after "network ready" runs on a fake clock."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
from playwright.sync_api import sync_playwright
net = H.Net(['ana'])
calls = []
answer = {'status': 200, 'body': {'current': '1.0.4', 'latest': '9.9.9', 'updateAvailable': True, 'url': 'https://github.com/xmranonp/AnonChat/releases/tag/v9.9.9', 'publishedAt': '2026-11-09T10:00:00Z'}}
def handler(route):
    calls.append(1)
    route.fulfill(status=answer['status'], content_type='application/json', body=json.dumps(answer['body']))
def ready(route):
    # The test network never reports 100 %: say it is ready, as a real one does once it has joined.
    r = route.fetch(); j = r.json(); j['network'] = 'ready'; route.fulfill(response=r, json=j)
def start(pg):
    """A start: reload, unlock, let the network settle, then run the 20 s wait."""
    pg.reload(); H.pin(pg, 1); pg.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000)
    pg.wait_for_timeout(2500)
    pg.clock.fast_forward(25000); pg.wait_for_timeout(1200)
def shown(pg): return pg.is_visible('#update-overlay .upd-dialog')
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(); ctx = b.new_context(); ctx.grant_permissions(['clipboard-read', 'clipboard-write'])
        ctx.clock.install()
        ana = H.prep(ctx, net, 'ana'); ana.route('**/api/update/check', handler); ana.route('**/api/whoami', ready)
        H.login(ana); ana.wait_for_timeout(2500)
        # 1. default: off, nothing is sent
        ana.click('#settings-btn')
        ana.wait_for_selector('#upd-auto-sw')
        H.check('the switch exists and is OFF by default', ana.get_attribute('#upd-auto-sw', 'aria-checked') == 'false')
        H.check('the switch has a name and the role switch', ana.get_attribute('#upd-auto-sw', 'role') == 'switch' and 'Check for updates when AnonChat starts' in ana.eval_on_selector('#upd-auto-label', 'e => e.textContent'))
        H.check('the settings say what leaves the computer', 'GitHub' in ana.inner_text('.upd-note') and 'not who' not in ana.inner_text('.upd-note'), ana.inner_text('.upd-note'))
        if os.environ.get('SHOT'): ana.screenshot(path=os.environ['SHOT'] + '/settings-off.png')
        ana.keyboard.press('Escape'); ana.wait_for_timeout(300)
        ana.clock.fast_forward(60000); ana.wait_for_timeout(800)
        H.check('with the switch off nothing is asked, whatever the time', len(calls) == 0, len(calls))
        ana.wait_for_timeout(200)
        start(ana)
        H.check('a start with the switch off asks nothing and shows nothing', len(calls) == 0 and not shown(ana), len(calls))
        # 2. switch on: no check now, a check at the next start
        ana.click('#settings-btn')
        ana.click('#upd-auto-sw'); ana.wait_for_timeout(200)
        if os.environ.get('SHOT'): ana.screenshot(path=os.environ['SHOT'] + '/settings-on.png')
        H.check('the switch turns on and is remembered', ana.get_attribute('#upd-auto-sw', 'aria-checked') == 'true' and ana.evaluate("localStorage.getItem('anonchat.autoUpdate')") == 'on')
        ana.keyboard.press('Escape'); ana.wait_for_timeout(300)
        H.check('turning it on does not check at once', len(calls) == 0 and not shown(ana))
        # Let the 10-second network poll run and answer "ready", then the 20-second wait run: the old code checked here.
        for _ in range(3): ana.clock.fast_forward(11000); ana.wait_for_timeout(1500)
        ana.clock.fast_forward(25000); ana.wait_for_timeout(1500)
        H.check('...nor later in the same session (the check is at the next start)', len(calls) == 0 and not shown(ana), len(calls))
        start(ana)
        H.check('next start: one check, and the window opens', len(calls) == 1 and shown(ana), len(calls))
        txt = ana.inner_text('#update-overlay .upd-dialog')
        if os.environ.get('SHOT'): ana.screenshot(path=os.environ['SHOT'] + '/update-window.png')
        H.check('it names the new version and the one in use', 'v9.9.9' in txt and 'v1.0.4' in txt, txt[:120])
        H.check('it shows the download link', 'releases/tag/v9.9.9' in ana.inner_text('#update-overlay .upd-win-url'))
        H.check('it says to use a SOCKS5 compatible browser, and why', 'SOCKS5 compatible browser' in txt and 'real IP address' in txt and '127.0.0.1:' in txt, txt)
        H.check('it points to SHA256SUMS.txt', 'SHA256SUMS.txt' in txt)
        H.check('it has no "remind me later" and no "skip" button', 'later' not in txt.lower() and 'skip' not in txt.lower())
        H.check('it is a labelled modal dialog and focus is inside it', ana.evaluate("() => { const d = document.querySelector('#update-overlay .upd-dialog'); return d.getAttribute('role') === 'dialog' && d.getAttribute('aria-modal') === 'true' && !!document.getElementById(d.getAttribute('aria-labelledby')) && d.contains(document.activeElement); }"))
        ana.click('#update-overlay .confirm-ok'); ana.wait_for_timeout(300)
        H.check('Copy link puts the link on the clipboard', ana.evaluate('navigator.clipboard.readText()') == answer['body']['url'])
        H.check('then it says copied and the Copy link button is gone', 'Link copied' in ana.inner_text('#update-overlay .upd-win-link') and not ana.is_visible('#update-overlay .confirm-ok'))
        ana.click('#update-overlay .confirm-cancel'); ana.wait_for_timeout(300)
        H.check('Close closes it and records the version', not shown(ana) and ana.evaluate("localStorage.getItem('anonchat.updateSeen')") == '9.9.9')
        # 3. same version at the next start: checked, not shown again
        n = len(calls); start(ana)
        H.check('next start checks again but does not show the same version twice', len(calls) == n + 1 and not shown(ana), (n, len(calls)))
        ana.clock.fast_forward(60000); ana.wait_for_timeout(500)
        H.check('only one check per start', len(calls) == n + 1)
        # 4. a newer version is shown, Escape closes it and focus goes back
        answer['body'] = {**answer['body'], 'latest': '9.9.10', 'url': 'https://github.com/xmranonp/AnonChat/releases/tag/v9.9.10'}
        start(ana)
        H.check('a newer version than the one closed is shown', shown(ana) and 'v9.9.10' in ana.inner_text('#update-overlay .upd-dialog'))
        ana.keyboard.press('Tab'); ana.keyboard.press('Tab'); ana.keyboard.press('Tab')
        H.check('Tab stays inside the window', ana.evaluate("() => document.querySelector('#update-overlay .upd-dialog').contains(document.activeElement)"))
        ana.keyboard.press('Escape'); ana.wait_for_timeout(300)
        H.check('Escape closes it and records that version', not shown(ana) and ana.evaluate("localStorage.getItem('anonchat.updateSeen')") == '9.9.10')
        # 5. up to date, no releases, unreachable, bad answers: silent
        for label, st, body in (('up to date', 200, {'current': '1.0.4', 'latest': '1.0.4', 'updateAvailable': False, 'url': 'https://github.com/xmranonp/AnonChat/releases'}),
                                ('no releases', 200, {'current': '1.0.4', 'latest': None, 'updateAvailable': False, 'url': 'https://github.com/xmranonp/AnonChat/releases'}),
                                ('unreachable (502)', 502, {'error': 'unreachable'}),
                                ('rate limited (429)', 429, {'error': 'too_many_requests'}),
                                ('an answer without a link', 200, {'latest': '9.9.99', 'updateAvailable': True})):
            answer['status'], answer['body'] = st, body; n = len(calls); start(ana)
            H.check(f'{label}: asked, and nothing shown', len(calls) == n + 1 and not shown(ana), (n, len(calls)))
        # 5b. hostile answers (a compromised release feed or a bad proxy in between): nothing is shown, nothing runs
        for label, body in (('markup in the version', {'current': '1.0.4', 'latest': '9.9.9<img src=x onerror=window.__xss=1>', 'updateAvailable': True, 'url': 'https://github.com/xmranonp/AnonChat/releases/tag/v9.9.9'}),
                            ('a javascript: link', {'current': '1.0.4', 'latest': '9.9.11', 'updateAvailable': True, 'url': 'javascript:window.__xss=2'}),
                            ('a link to another site', {'current': '1.0.4', 'latest': '9.9.12', 'updateAvailable': True, 'url': 'https://evil.example/AnonChat/releases/tag/v9.9.12'}),
                            ('a look-alike host', {'current': '1.0.4', 'latest': '9.9.13', 'updateAvailable': True, 'url': 'https://github.com.evil.example/x/y/releases'}),
                            ('an enormous version', {'current': '1.0.4', 'latest': '9' * 5000, 'updateAvailable': True, 'url': 'https://github.com/xmranonp/AnonChat/releases'})):
            answer['status'], answer['body'] = 200, body; n = len(calls); start(ana)
            H.check(f'hostile answer ({label}): nothing shown, nothing run', len(calls) == n + 1 and not shown(ana) and ana.evaluate('window.__xss === undefined'), (n, len(calls)))
        answer['body'] = {'current': '1.0.4', 'latest': '9.9.20', 'updateAvailable': True, 'url': 'https://github.com/xmranonp/AnonChat/releases/tag/v9.9.20', 'publishedAt': '<b>x</b>'}
        start(ana)
        H.check('a hostile date is shown as nothing, never as markup', shown(ana) and not ana.evaluate("() => !!document.querySelector('#update-overlay .upd-dialog b')") and 'released' not in ana.inner_text('#update-overlay .upd-win-sub'))
        ana.keyboard.press('Escape'); ana.wait_for_timeout(300)
        # 6. switched off again
        answer['status'] = 200
        ana.click('#settings-btn')
        ana.click('#upd-auto-sw'); ana.wait_for_timeout(200)
        H.check('the switch turns off again', ana.get_attribute('#upd-auto-sw', 'aria-checked') == 'false')
        ana.keyboard.press('Escape'); n = len(calls); start(ana)
        H.check('off again: nothing is asked', len(calls) == n and not shown(ana))
        H.check('no page errors', not [e for e in H.errs if 'status of 502' not in e and 'status of 429' not in e], H.errs[:3])
        H.summary()
        b.close()
finally:
    net.close()
