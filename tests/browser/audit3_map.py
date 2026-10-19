"""Third pass: the Circuit map button in a conversation, the first time the panel opens, shows that contact's circuit at once (it used to
show nothing until the panel was closed and opened again: the globe loaded before the panel counted as open). During a call Ana makes,
the route carrying it is marked "Voice call" in the Circuits tab and "in a call" on the map. Needs WebGL for the map; skipped without."""
import sys, os, json, time, subprocess, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
APP = H.APP
net = H.Net(['ana', 'bob'])
A = {n: net.nodes[n]['addr'] for n in net.nodes}
CTL, HTTP = H.free_port(), H.free_port()
net.stop('ana'); fk = subprocess.Popen(['node', APP + '/tools/fake-control-port.mjs', str(CTL), str(HTTP), net.nodes['ana']['dir'] + '/anon']); time.sleep(0.6)
def fake(path, body=None):
    req = urllib.request.Request(f'http://127.0.0.1:{HTTP}' + path, data=json.dumps(body or {}).encode(), method='POST' if body is not None else 'GET')
    return json.loads(urllib.request.urlopen(req).read())
net.env = dict(net.env, ANON_CTRL_PORT=str(CTL)); net.start('ana'); time.sleep(2)
hs = f"5 BUILT ${'A'*40}~g5,${'Q'*40}~m5,${'0'*40}~x5,${'7'*40}~r5 BUILD_FLAGS=IS_INTERNAL,NEED_CAPACITY PURPOSE=HS_CLIENT_REND HS_STATE=HSCR_JOINED REND_QUERY={A['bob'][:56]} TIME_CREATED=2026-01-01T00:00:00"
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        ana = H.prep(b.new_context(viewport={'width': 1180, 'height': 820}, permissions=['microphone']), net, 'ana'); bob = H.prep(b.new_context(permissions=['microphone']), net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', A['bob']); H.add_contact(bob, 'Ana', A['ana'])
        H.open_contact(ana, 'Bob')
        fake('/state', {'circuits': [hs], 'streams': []})
        H.send(ana, 'hello')
        fake('/emit', {'line': f"650 STREAM 9 SENTCONNECT 5 {A['bob']}:80"}); fake('/emit', {'line': f"650 STREAM 9 SUCCEEDED 5 {A['bob']}:80"})
        time.sleep(1)
        webgl = ana.evaluate("!!document.createElement('canvas').getContext('webgl')")
        if webgl:
            ana.click('.conv-circuit-map')
            H.check('first open from a conversation: the map shows that contact’s circuit', H.wait(ana, "document.getElementById('globe-caption').textContent.includes('5')", 8000), ana.inner_text('#globe-caption'))
            H.check('…and the rows above the map are hidden on the Map tab', ana.evaluate("getComputedStyle(document.getElementById('log-stats')).display === 'none'"))
        else: print('no WebGL here: the map checks are skipped')
        # A call from Ana: the route to Bob carries it
        ana.click('#log-close') if ana.query_selector('#log-close') else ana.click('#logs-btn')
        H.open_contact(bob, 'Ana'); ana.click('.conv-call')
        H.wait(bob, "!!document.querySelector('#call-dock .call-btn.accept')", 40000); bob.click('#call-dock .call-btn.accept')
        H.wait(ana, "document.querySelector('#call-dock .call-status')?.className.includes('active')", 30000)
        fake('/state', {'circuits': [hs], 'streams': [f"9 SUCCEEDED 5 {A['bob']}:80"]})
        fake('/emit', {'line': f"650 STREAM 10 SENTCONNECT 5 {A['bob']}:80"}); fake('/emit', {'line': f"650 STREAM 10 SUCCEEDED 5 {A['bob']}:80"})
        ana.click('#logs-btn'); ana.wait_for_timeout(400); ana.click('.log-tab[data-tab=circuits]')
        H.check('during the call, the Circuits tab marks the route carrying it', H.wait(ana, "!!document.querySelector('#circuits-body .circuit-card .circuit-call')", 10000))
        H.check('…and says where it goes: Bob, voice call', H.wait(ana, "[...document.querySelectorAll('#circuits-body .stream-target')].some(e => /Bob · voice call/.test(e.textContent))", 5000))
        if webgl:
            ana.click('.log-tab[data-tab=map]'); ana.click('#logs-btn'); ana.wait_for_timeout(400); ana.click('.conv-circuit-map')
            H.check('…and the map from the conversation says “in a call”', H.wait(ana, "document.getElementById('globe-focus-title').textContent.includes('in a call') && document.getElementById('globe-caption').textContent.includes('voice call')", 8000), [ana.inner_text('#globe-focus-title'), ana.inner_text('#globe-caption')])
        ana.click('#log-close') if ana.query_selector('#log-close') else ana.click('#logs-btn')
        ana.wait_for_timeout(400); ana.click('#call-dock .call-btn.decline'); ana.wait_for_timeout(1500)
        ana.click('#logs-btn'); ana.wait_for_timeout(400); ana.click('.log-tab[data-tab=circuits]')
        H.check('after the call, the mark is gone', H.wait(ana, "!document.querySelector('#circuits-body .circuit-call')", 10000))
        b.close()
finally:
    net.close(); fk.terminate()
bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
H.check('no page errors', not bad, bad[:5])
H.summary()
