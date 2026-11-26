"""Both halves of the mailbox in real windows (1.1.0 test builds; needs MAILBOX_PEER_DIR, a mailbox-peer source folder): Bob joins a real
mailbox peer from Settings → Mailbox swarm with an invite; his window sends Ana his details by itself (her frames showed she can read
them); then Bob's app can't be reached directly, and Ana's message goes to his mailbox (📮), Bob's app collects it and shows it once,
and Ana's 📮 turns into ✓. A call while Bob can't be reached rings nowhere and leaves one "Missed call" in his chat. Bob removes the peer
(Switch and Turn off are offered next to it) and Ana's app writes to him directly again."""
import sys, os, time, json, subprocess, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
OUT = _args.out(__file__)
PEER = os.environ.get('MAILBOX_PEER_DIR')
if not PEER or not os.path.exists(os.path.join(PEER, 'test/helpers.mjs')):
    print('(set MAILBOX_PEER_DIR to a mailbox-peer source folder to run this suite)'); H.summary(); sys.exit(0)
APP = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
PA = 'p' * 56 + '.anyone'
bridge, ctl = H.free_port(), H.free_port()
mp = subprocess.Popen(['node', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mbxpeer.mjs'), APP, str(bridge), str(ctl)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
mp.stdout.readline()
net = H.Net(['ana', 'bob'], extra_peers={PA: bridge}, env={'RL_BURST': '1000', 'RL_PER_MIN': '10000', 'ANONCHAT_SWARM_TEST': '1'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
def ui(n, path, body=None):
    v = net.nodes[n]
    r = urllib.request.Request(f"http://127.0.0.1:{v['ui']}{path}", data=json.dumps(body).encode() if body is not None else None,
                               headers={'X-AnonChat-Token': H.TOKEN, 'Content-Type': 'application/json'}, method='POST' if body is not None else 'GET')
    return json.loads(urllib.request.urlopen(r, timeout=10).read())
def peer(path):
    return json.loads(urllib.request.urlopen(f"http://127.0.0.1:{ctl}{path}", timeout=20).read())
def tick(pg, text):
    return pg.evaluate(f"""(() => {{ const b = [...document.querySelectorAll('#conv-body .bubble')].find(x => x.textContent.includes({json.dumps(text)}));
        if (!b) return null; const t = b.querySelector('.receipt-tick'); return t ? t.className + '|' + t.textContent.trim() : '(none)'; }})()""")
def wait_for(f, s=60):
    t0 = time.time(); v = None
    while time.time() - t0 < s:
        try:
            v = f()
            if v: return v
        except Exception: pass
        time.sleep(0.5)
    return v
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME, args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        cA, cB = (b.new_context(viewport={'width': 1180, 'height': 820}, permissions=['microphone']) for _ in range(2))
        ana, bob = H.prep(cA, net, 'ana'), H.prep(cB, net, 'bob')
        for pg in (ana, bob): H.login(pg)
        H.add_contact(ana, 'Bob', A['bob']); H.add_contact(bob, 'Ana', A['ana'])
        H.open_contact(ana, 'Bob'); H.send(ana, 'hi bob'); H.open_contact(bob, 'Ana')
        H.check('the first message goes directly (no mailbox yet)', H.sees(bob, 'hi bob'))

        # Bob joins the peer from his settings
        inv = peer('/invite')
        bob.click('#settings-btn'); bob.wait_for_selector('#swarm-join-addr', timeout=10000)
        H.check('Settings shows "Mailbox swarm" in a test build', bob.is_visible('#swarm-settings h4'))
        bob.fill('#swarm-join-addr', inv['address']); bob.fill('#swarm-join-invite', '0' * 32); bob.click('#swarm-join-btn')
        H.check('a wrong invite: the reason is shown', wait_for(lambda: 'invite' in (bob.text_content('#swarm-join-msg') or '').lower(), 20), bob.text_content('#swarm-join-msg'))
        bob.fill('#swarm-join-invite', inv['invite']); bob.click('#swarm-join-btn')
        H.check('Bob joins: the peer is listed', wait_for(lambda: bob.query_selector('#swarm-settings .swarm-peer'), 20))
        bob.screenshot(path=OUT + '/collect-1-joined.png')
        bob.keyboard.press('Escape'); bob.wait_for_timeout(300)
        bob.evaluate("document.getElementById('settings-overlay') && (document.getElementById('settings-overlay').hidden = true)")
        # Bob's window sends Ana his details by itself: Ana's frames carried sw: 1
        H.send(bob, 'hello ana')
        H.check('Ana gets Bob\'s details from his window (a swarm frame, nothing shown)', wait_for(lambda: A['bob'] in ui('ana', '/api/swarm/contacts')['contacts'], 40))
        n = ana.evaluate("""[...document.querySelectorAll('#conv-body .bubble')].length""")

        # Bob's app can't be reached directly any more, but it can reach his peer
        net.hide('bob')
        H.open_contact(ana, 'Bob'); H.send(ana, 'into the mailbox')
        H.check('Bob\'s window shows it once, collected from his mailbox', H.sees(bob, 'into the mailbox'))
        t = wait_for(lambda: (lambda x: x if x and x.endswith('✓') else None)(tick(ana, 'into the mailbox')), 60)
        H.check('Ana\'s message turns ✓', t and t.endswith('✓'), tick(ana, 'into the mailbox'))
        c = bob.evaluate("""[...document.querySelectorAll('#conv-body .bubble')].filter(x => x.textContent.includes('into the mailbox')).length""")
        H.check('…shown once', c == 1, c)
        bob.screenshot(path=OUT + '/collect-2-received.png')

        # a call while Bob can't be reached: nothing rings at Bob's, one "Missed call"
        ana.click('.conv-call'); ana.wait_for_timeout(5000)
        dec = ana.locator('#call-dock .call-btn.decline')
        if dec.count(): dec.first.click()
        ana.wait_for_timeout(1500)
        H.check('a call while Bob is unreachable: one "Missed call" line in his chat, from the mailbox copies',
                wait_for(lambda: bob.evaluate("""[...document.querySelectorAll('#conv-body .sys, #conv-body .system, #conv-body .msg-system, #conv-body *')].filter(x => x.children.length === 0 && /Missed voice call/i.test(x.textContent)).length""") == 1, 40),
                bob.evaluate("""[...document.querySelectorAll('#conv-body *')].filter(x => x.children.length === 0 && /Missed voice call/i.test(x.textContent)).length"""))
        H.check('…and Bob\'s app never rang', not bob.query_selector('#call-dock .call-btn.accept'))

        # Bob leaves: Ana's app writes directly again
        net.hide()
        bob.click('#settings-btn'); bob.wait_for_selector('#swarm-settings .swarm-remove', timeout=10000)
        H.check('each peer has Switch and Remove, and the section has Turn off', bob.query_selector('#swarm-settings .swarm-switch-open') and bob.query_selector('#swarm-turn-off'))
        bob.click('#swarm-settings .swarm-switch-open')
        H.check('Switch opens a form for the new peer\'s address and invite, under that peer', bob.is_visible('#swarm-switch-addr') and bob.is_visible('#swarm-switch-invite'))
        bob.click('#swarm-settings .swarm-remove')
        H.check('Remove asks first', wait_for(lambda: bob.is_visible('#confirm-overlay .confirm-ok'), 5))
        bob.click('#confirm-overlay .confirm-ok')
        H.check('Bob removes the peer', wait_for(lambda: not bob.query_selector('#swarm-settings .swarm-peer'), 30))
        bob.evaluate("document.getElementById('settings-overlay').hidden = true")
        H.check('…and Ana gets his new details (write directly)', wait_for(lambda: A['bob'] not in ui('ana', '/api/swarm/contacts')['contacts'], 40))
        H.send(ana, 'directly again')
        H.check('Ana\'s next message goes directly', H.sees(bob, 'directly again'))
        H.check('…without ever being 📮', not any(s.get('shown') == 'mailbox' for s in ui('ana', '/api/swarm/states')['states']))
        b.close()
finally:
    net.close(); mp.terminate()
bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
H.check('no page errors', not bad, bad[:5])
H.summary()
