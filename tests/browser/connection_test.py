"""Test connection (conversation menu): the item opens a panel that checks, step by step, the way to a contact. With Bob up: every step
passes and the verdict says all is well; with Bob down: the lookup/route step fails and the verdict says what to do; a message waiting for
Bob goes out when the test finds him again. Escape closes the panel; the buttons are real buttons; the page has no error."""
import sys, os, json, time, subprocess, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
APP = H.APP
net = H.Net(['ana', 'bob'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
CTL, HTTP = H.free_port(), H.free_port()
net.stop('ana'); fk = subprocess.Popen(['node', APP + '/tools/fake-control-port.mjs', str(CTL), str(HTTP), net.nodes['ana']['dir'] + '/anon']); time.sleep(0.6)
def fake(path, body=None):
    req = urllib.request.Request(f'http://127.0.0.1:{HTTP}' + path, data=json.dumps(body or {}).encode(), method='POST' if body is not None else 'GET')
    return json.loads(urllib.request.urlopen(req).read())
net.env = dict(net.env, ANON_CTRL_PORT=str(CTL)); net.start('ana'); time.sleep(2)
intro = [f"{40 + i} BUILT ${'A'*40}~g,${'B'*40}~m,${'C'*40}~x BUILD_FLAGS=IS_INTERNAL PURPOSE=HS_SERVICE_INTRO HS_STATE=HSSI_ESTABLISHED TIME_CREATED=2026-01-01T00:00:00" for i in range(3)]
fake('/state', {'circuits': intro, 'streams': [], 'published': True})
def open_test(pg):
    pg.click('.head-btn.head-more'); pg.wait_for_selector('#ctx-menu')
    pg.click('#ctx-menu .ctx-item:has-text("Test connection")')
    pg.wait_for_selector('#ctest-overlay')
def finished(pg, ms=60000):
    return H.wait(pg, "(() => { const v = document.querySelector('#ctest-overlay .ctest-verdict'); return v && /ok|warn/.test(v.className) ? v.className : null; })()", ms)
def rows(pg):
    return pg.evaluate("[...document.querySelectorAll('#ctest-overlay .ctest-row')].map(r => ({ cls: r.className, label: r.querySelector('.ctest-label').textContent, value: r.querySelector('.ctest-value').textContent }))")
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ana = H.prep(b.new_context(viewport={'width': 1180, 'height': 780}), net, 'ana'); bob = H.prep(b.new_context(), net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', A['bob']); H.add_contact(bob, 'Ana', A['ana'])
        H.open_contact(ana, 'Bob'); H.send(ana, 'hello'); H.sees(bob, 'hello')

        print('-- Bob is up')
        open_test(ana)
        H.check('the panel is a dialog with a title naming Bob', ana.evaluate("(() => { const d = document.querySelector('#ctest-overlay [role=dialog]'); return !!d && d.getAttribute('aria-modal') === 'true' && document.getElementById(d.getAttribute('aria-labelledby')).textContent.includes('Bob'); })()"))
        cls = finished(ana)
        r = rows(ana); print(r, cls)
        H.check('five steps are shown', len(r) == 5, r)
        H.check('your own address: published, with its introduction points', r and r[0]['cls'].endswith('ok') and '3' in r[0]['value'], r[:1])
        H.check('their address: found', r and r[1]['cls'].endswith('ok'), r[1:2])
        H.check('their app: answered', r and r[2]['cls'].endswith('ok'), r[2:3])
        H.check('clocks agree (same computer)', r and r[3]['cls'].endswith('ok'), r[3:4])
        H.check('the verdict says all is well', cls and 'ok' in cls.split(), cls)
        v0 = ana.evaluate("document.querySelector('#ctest-overlay .ctest-verdict').textContent")
        H.check('…without mentioning waiting messages when none wait', 'Everything works' in v0 and 'Waiting messages' not in v0, v0)
        H.check('Close looks like the other dialogs\' Close buttons (the plain button, not the filled one)', ana.evaluate("(() => { const b = document.querySelector('#ctest-overlay .ctest-close'); return b.classList.contains('confirm-cancel') && !b.classList.contains('confirm-ok') && b.textContent.trim() === 'Close'; })()"))
        ana.keyboard.press('Escape'); ana.wait_for_timeout(300)
        H.check('Escape closes the panel', ana.evaluate("!document.getElementById('ctest-overlay')"))

        print('-- Bob is down, a message waits')
        net.stop('bob'); ana.wait_for_timeout(500)
        H.send(ana, 'are you there'); ana.wait_for_timeout(1500)
        open_test(ana)
        cls = finished(ana, 90000)
        r = rows(ana); v = ana.evaluate("document.querySelector('#ctest-overlay .ctest-verdict').textContent"); print(r, cls, v)
        H.check('the step that failed is marked', r and any(x['cls'].endswith(('fail', 'warn')) for x in r[1:3]), r)
        H.check('the verdict is a warning with a sentence to act on', cls and 'warn' in cls.split() and len(v) > 30, (cls, v))
        H.check('one message is counted as waiting', r and r[4]['value'] == '1', r[4:5])
        # No label may run into its value, at the normal width and a narrow one (the clock row's value is a long sentence here).
        overlap = "(() => [...document.querySelectorAll('#ctest-overlay .ctest-row')].filter(r => { const l = r.querySelector('.ctest-label').getBoundingClientRect(), v = r.querySelector('.ctest-value').getBoundingClientRect(); const sameLine = v.top < l.bottom && v.bottom > l.top; return (sameLine && l.right > v.left + 0.5) || r.querySelector('.ctest-label').scrollWidth > r.querySelector('.ctest-label').clientWidth + 1; }).map(r => r.querySelector('.ctest-label').textContent))()"
        H.check('no label runs into its value (normal width)', ana.evaluate(overlap) == [], ana.evaluate(overlap))
        for w in (560, 380):
            ana.set_viewport_size({'width': w, 'height': 780}); ana.wait_for_timeout(300)
            H.check(f'no label runs into its value ({w}px wide)', ana.evaluate(overlap) == [], ana.evaluate(overlap))
        ana.set_viewport_size({'width': 1180, 'height': 780}); ana.wait_for_timeout(300)
        ana.click('#ctest-overlay .ctest-close'); ana.wait_for_timeout(300)
        H.check('Close closes the panel', ana.evaluate("!document.getElementById('ctest-overlay')"))

        print('-- Bob comes back, the test finds him and the message goes')
        net.start('bob'); time.sleep(3)
        open_test(ana)
        cls = finished(ana, 90000)
        H.check('the test passes again', cls and 'ok' in cls.split(), cls)
        gone = H.wait(ana, "fetch('/api/outbox').then(r => r.json()).then(j => j.items.length === 0)", 30000)
        H.check('the waiting message was sent without waiting for the next round', gone)
        ana.click('#ctest-overlay .ctest-close')

        print('-- the API')
        st = H.api(ana, '/api/contact-test/' + A['bob'], 'POST')
        H.check('answers codes only (no sentences)', st['status'] == 200 and set(st['body']) == {'own', 'find', 'reach', 'clock', 'queue', 'verdict'}, st)
        H.check('a stranger is refused', H.api(ana, '/api/contact-test/' + 'z' * 56 + '.anyone', 'POST')['status'] == 404)
        H.check('a malformed address is refused', H.api(ana, '/api/contact-test/nonsense', 'POST')['status'] == 400)
        real = [e for e in H.errs if 'ERR_CONNECTION_REFUSED' not in e and 'status of 404' not in e and 'status of 400' not in e]   # Bob was stopped on purpose; the refused addresses answer 404 / 400
        H.check('no page errors', not real, real[:3])
        b.close()
finally:
    fk.terminate(); net.close()
H.summary()
