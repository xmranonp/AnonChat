"""Waiting for the network, and looking for our own address. With the supervisor's switch on (ANONCHAT_WAIT_NETWORK) and a fake network
program: nothing is sent while progress is below 100% or the relay list is a day old, and what waits goes out (after one clear-out of
the lookup memory) when the network is ready. Our own address is looked up through the network: findable, then not (the network can't find
it: the lookup memory is cleared, then our address details are sent again), then findable again; the Status line and Test connection say so."""
import sys, os, json, time, subprocess, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
APP = H.APP
net = H.Net(['ana', 'bob'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000', 'ANONCHAT_WAIT_NETWORK': '1', 'SELFTEST_FAST': '1', 'PRESENCE_FIRST_MS': '1000'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
CTL, HTTP = H.free_port(), H.free_port()
net.stop('ana'); fk = subprocess.Popen(['node', APP + '/tools/fake-control-port.mjs', str(CTL), str(HTTP), net.nodes['ana']['dir'] + '/anon']); time.sleep(0.6)
def fake(path, body=None):
    req = urllib.request.Request(f'http://127.0.0.1:{HTTP}' + path, data=json.dumps(body or {}).encode(), method='POST' if body is not None else 'GET')
    return json.loads(urllib.request.urlopen(req).read())
intro = [f"{40 + i} BUILT ${'A'*40}~g,${'B'*40}~m,${'C'*40}~x BUILD_FLAGS=IS_INTERNAL PURPOSE=HS_SERVICE_INTRO HS_STATE=HSSI_ESTABLISHED TIME_CREATED=2026-01-01T00:00:00" for i in range(3)]
fake('/state', {'circuits': intro, 'streams': [], 'published': True}); fake('/bootstrap', {'pct': 60}); fake('/consensus', {'ageMs': 600000})
net.env = dict(net.env, ANON_CTRL_PORT=str(CTL)); net.start('ana'); time.sleep(2)
def health(pg): return H.api(pg, '/api/hs/health')['body']
def log_has(pg, pat): return pg.evaluate("(p) => fetch('/api/logs').then(r => r.json()).then(j => (j.lines || []).some(l => new RegExp(p).test(l)))", pat)
def dot(pg): return pg.evaluate("(() => { const d = document.querySelector('#ws-dot'); return { on: d.classList.contains('online'), amber: d.classList.contains('connecting'), off: d.classList.contains('offline'), tip: d._tipText || '' }; })()")
def dot_is(pg, kind, tip, ms=30000):
    ok = H.wait(pg, "(() => { const d = document.querySelector('#ws-dot'); if (!d) return false; const k = d.classList.contains('online') ? 'on' : d.classList.contains('connecting') ? 'amber' : d.classList.contains('offline') ? 'off' : ''; return k === '%s' && (d._tipText || '').includes(%s); })()" % (kind, json.dumps(tip)), ms)
    return bool(ok)
def bob_has(pg, text): return pg.evaluate("(t) => [...document.querySelectorAll('#conv-body .bubble-text')].some(e => e.textContent.includes(t))", text)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ana = H.prep(b.new_context(viewport={'width': 1180, 'height': 780}), net, 'ana'); bob = H.prep(b.new_context(), net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', A['bob']); H.add_contact(bob, 'Ana', A['ana'])
        H.open_contact(ana, 'Bob'); H.open_contact(bob, 'Ana')

        print('-- progress 60%: nothing is sent')
        H.send(ana, 'first'); ana.wait_for_timeout(7000)
        items = H.api(ana, '/api/outbox')['body']['items']
        H.check('the message is queued', len(items) == 1, items)
        H.check('…and not tried at all (0 attempts)', items and items[0]['attempts'] == 0, items)
        H.check('Bob has not received it', not bob_has(bob, 'first'))
        H.check('the status says the network is not ready', health(ana)['network']['ready'] is False, health(ana)['network'])
        H.check('no look at our own address yet', health(ana)['selfTest']['state'] == 'idle', health(ana)['selfTest'])
        H.check('the dot beside the name is amber: still connecting', dot_is(ana, 'amber', 'Connecting to the Anyone network', 12000), dot(ana))

        print('-- progress 100%, relay list a day old: still waiting')
        fake('/consensus', {'ageMs': 30 * 3600 * 1000}); fake('/bootstrap', {'pct': 100}); ana.wait_for_timeout(7000)
        H.check('still not ready (reason: the relay list)', health(ana)['network']['ready'] is False and health(ana)['network']['reason'] == 'relay-list', health(ana)['network'])
        H.check('Bob has still not received it', not bob_has(bob, 'first'))

        print('-- a current relay list: ready, one clear-out, then it goes')
        n0 = sum(1 for l in fake('/log') if l == 'SIGNAL NEWNYM')
        fake('/consensus', {'ageMs': 300000})
        got = H.sees(bob, 'first', 30000)
        H.check('Bob receives it once the network is ready', got)
        H.check('the network is reported ready', health(ana)['network']['ready'] is True, health(ana)['network'])
        n1 = sum(1 for l in fake('/log') if l == 'SIGNAL NEWNYM')
        H.check('the lookup memory was cleared (one NEWNYM)', n1 - n0 >= 1, (n0, n1))
        H.check('the Status log says the network is ready', log_has(ana, 'network is ready'))
        H.send(ana, 'second'); H.check('a message sent now goes at once', H.sees(bob, 'second', 15000))

        print('-- our own address')
        ok = H.wait(ana, "fetch('/api/hs/health').then(r => r.json()).then(j => j.selfTest.state === 'findable')", 20000)
        H.check('our own address is found through the network', ok, health(ana)['selfTest'])
        H.check('the dot is cyan: ready, reachable and findable', dot_is(ana, 'on', 'Your address is reachable', 30000), dot(ana))
        net.hide('ana')
        bad = H.wait(ana, "fetch('/api/hs/health').then(r => r.json()).then(j => j.selfTest.state === 'not-findable')", 20000)
        H.check('when the network can\'t find it: not findable', bad, health(ana)['selfTest'])
        H.check('…the reason is the network\'s own', health(ana)['selfTest']['term'] == 'descriptor not found', health(ana)['selfTest'])
        H.check('the dot turns amber and says the address cannot be found', dot_is(ana, 'amber', 'cannot be found yet', 30000), dot(ana))
        pub = H.wait(ana, "fetch('/api/hs/health').then(r => r.json()).then(j => j.selfTest.republished >= 1)", 30000)
        H.check('our address details were sent to the network again', pub, health(ana)['selfTest'])
        H.check('…the network program received them (HSPOST)', fake('/hspost')['n'] >= 1, fake('/hspost'))
        H.check('the Status log says so', log_has(ana, 'could not be found through the network') and log_has(ana, 'sent to the network again'))
        ana.click('#net-btn') if ana.locator('#net-btn').count() else None
        H.open_contact(ana, 'Bob')
        ana.click('.head-btn.head-more'); ana.click('#ctx-menu .ctx-item:has-text("Test connection")'); ana.wait_for_selector('#ctest-overlay')
        v = H.wait(ana, "(() => { const e = document.querySelector('#ctest-overlay .ctest-verdict'); return e && /ok|warn/.test(e.className) ? e.className : null; })()", 60000)
        rows = ana.evaluate("[...document.querySelectorAll('#ctest-overlay .ctest-row')].map(r => r.className + ' | ' + r.textContent)")
        print(rows)
        H.check('Test connection: Bob is reachable, but our own address is marked as not found', rows and rows[0].startswith('ctest-row warn') and 'not find it' in rows[0], rows[:1])
        verdict = ana.evaluate("document.querySelector('#ctest-overlay .ctest-verdict').textContent")
        H.check('…and the verdict says so', 'own address cannot be found' in verdict, verdict)
        ana.keyboard.press('Escape')
        net.hide('ana', 'bob')
        ana.click('.head-btn.head-more'); ana.click('#ctx-menu .ctx-item:has-text("Test connection")'); ana.wait_for_selector('#ctest-overlay')
        H.wait(ana, "(() => { const e = document.querySelector('#ctest-overlay .ctest-verdict'); return e && /ok|warn/.test(e.className); })()", 60000)
        verdict = ana.evaluate("document.querySelector('#ctest-overlay .ctest-verdict').textContent")
        H.check('neither found: the verdict blames this computer', 'probably on this computer' in verdict, verdict)
        ana.keyboard.press('Escape')
        net.hide()
        back = H.wait(ana, "fetch('/api/hs/health').then(r => r.json()).then(j => j.selfTest.state === 'findable')", 30000)
        H.check('found again once the network finds it', back, health(ana)['selfTest'])
        H.check('the dot is cyan again', dot_is(ana, 'on', 'Your address is reachable', 30000), dot(ana))
        print('-- the dot: address not published, then published; and the link to the app lost')
        fake('/state', {'published': False})
        H.check('not published: amber, "not reachable yet"', dot_is(ana, 'amber', 'not reachable yet', 40000), dot(ana))
        fake('/state', {'published': True})
        H.check('published again: cyan', dot_is(ana, 'on', 'Your address is reachable', 40000), dot(ana))
        ana.route('**/api/whoami', lambda r: r.abort())
        H.check('the link to the app lost: red, "No connection"', dot_is(ana, 'off', 'No connection', 30000), dot(ana))
        ana.unroute('**/api/whoami')
        H.check('the link back: cyan', dot_is(ana, 'on', 'Your address is reachable', 30000), dot(ana))
        ana.click('#status-btn') if ana.locator('#status-btn').count() else None
        H.check('no page errors', not [e for e in H.errs if 'ERR_CONNECTION_REFUSED' not in e and 'ERR_FAILED' not in e], H.errs[:3])
        b.close()
finally:
    fk.terminate(); net.close()
H.summary()
