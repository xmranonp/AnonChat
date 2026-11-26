"""Mailbox sending (1.1.0, phase 2): Bob has a mailbox at a real mailbox peer (MAILBOX_PEER_DIR). Ana's app has his details; Bob is
offline. Ana's message goes to his mailbox and shows 📮, nothing is tried directly; Bob comes back, his app takes in what waited (here,
by hand: the owner's side comes in a later release), the message appears in his window once, and Ana's 📮 turns into ✓. A photo goes the
same way. A call to Bob while he is offline leaves a copy at his peer. A contact without a mailbox still gets everything directly."""
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
net = H.Net(['ana', 'bob', 'cleo'], extra_peers={PA: bridge}, env={'RL_BURST': '1000', 'RL_PER_MIN': '10000'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
def ui(n, path, body=None):
    v = net.nodes[n]
    r = urllib.request.Request(f"http://127.0.0.1:{v['ui']}{path}", data=json.dumps(body).encode() if body is not None else None,
                               headers={'X-AnonChat-Token': H.TOKEN, 'Content-Type': 'application/json'}, method='POST' if body is not None else 'GET')
    return json.loads(urllib.request.urlopen(r, timeout=10).read())
def peer(path, post=False):
    r = urllib.request.Request(f"http://127.0.0.1:{ctl}{path}", data=b'' if post else None, method='POST' if post else 'GET')
    return json.loads(urllib.request.urlopen(r, timeout=20).read())
def to_inbox(n, env):
    v = net.nodes[n]; data = json.dumps(env).encode()
    r = urllib.request.Request(f"http://127.0.0.1:{v['pub']}/api/inbox", data=data, headers={'Host': v['addr'], 'Content-Type': 'application/json'}, method='POST')
    try: return urllib.request.urlopen(r, timeout=10).status
    except urllib.error.HTTPError as e: return e.code
def tick(pg, text):
    return pg.evaluate(f"""(() => {{ const b = [...document.querySelectorAll('#conv-body .bubble')].find(x => x.textContent.includes({json.dumps(text)}));
        if (!b) return null; const t = b.querySelector('.receipt-tick'); return t ? t.className + '|' + t.textContent.trim() : '(none)'; }})()""")
def wait_tick(pg, text, want, ms=60000):
    t0 = time.time()
    while time.time() - t0 < ms / 1000:
        t = tick(pg, text)
        if t and want in t: return t
        time.sleep(0.5)
    return tick(pg, text)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME, args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        cA, cB, cC = (b.new_context(viewport={'width': 1180, 'height': 780}, permissions=['microphone']) for _ in range(3))
        ana, bob, cleo = H.prep(cA, net, 'ana'), H.prep(cB, net, 'bob'), H.prep(cC, net, 'cleo')
        for pg in (ana, bob, cleo): H.login(pg)
        H.add_contact(ana, 'Bob', A['bob']); H.add_contact(bob, 'Ana', A['ana'])
        H.add_contact(ana, 'Cleo', A['cleo']); H.add_contact(cleo, 'Ana', A['ana'])
        H.open_contact(ana, 'Bob'); H.send(ana, 'hi bob'); H.open_contact(bob, 'Ana')
        H.check('Bob gets the first message (directly: no mailbox yet)', H.sees(bob, 'hi bob')); H.send(bob, 'hi ana'); H.check('Ana gets the reply', H.sees(ana, 'hi ana'))
        H.open_contact(ana, 'Cleo'); H.send(ana, 'hi cleo'); H.open_contact(cleo, 'Ana'); H.check('Cleo gets hers', H.sees(cleo, 'hi cleo'))

        # Bob's details reach Ana's app (as her window does when it decrypts his swarm frame)
        d = peer('/details')
        H.check('Ana\'s app takes Bob\'s mailbox details', ui('ana', '/api/swarm/details', {'address': A['bob'], 'details': d['details']})['result'] == 'updated')
        bob.close(); net.stop('bob')
        H.open_contact(ana, 'Bob'); H.send(ana, 'via the mailbox')
        t = wait_tick(ana, 'via the mailbox', 'mailbox', 30000)
        H.check('Bob offline: Ana\'s message shows 📮 (in his mailbox)', t and 'mailbox' in t and '\U0001F4EE' in t, t)
        items = ui('ana', '/api/outbox')['items']
        H.check('…held in Ana\'s queue, not tried directly', items and all(i.get('held') for i in items if i['toAddress'] == A['bob']), items)
        ana.screenshot(path=OUT + '/mailbox-1-held.png')

        # Bob comes back; his app takes in what waited at his peer
        net.start('bob'); time.sleep(3)
        bob = H.prep(cB, net, 'bob'); H.unlock(bob); bob.wait_for_timeout(1500); H.open_contact(bob, 'Ana')
        got = peer('/collect', True)['envelopes']
        H.check('the message is at his peer, sealed for him, from Ana', len(got) == 1 and got[0]['from'] == A['ana'], [e.get('from') for e in got])
        H.check('…his app takes it in', all(to_inbox('bob', e) == 200 for e in got))
        H.check('Bob sees it', H.sees(bob, 'via the mailbox'))
        t = wait_tick(ana, 'via the mailbox', '✓', 60000)
        H.check('Ana\'s 📮 turns into ✓ once it is collected', t and t.endswith('✓'), t)
        H.check('…without a "delivered" notice (only what goes wrong is said)', not ana.evaluate("[...document.querySelectorAll('#toast.show')].some(x => /delivered/i.test(x.textContent))"))
        ana.screenshot(path=OUT + '/mailbox-2-delivered.png')
        n = bob.evaluate("""[...document.querySelectorAll('#conv-body .bubble')].filter(x => x.textContent.includes('via the mailbox')).length""")
        H.check('…and Bob sees it once', n == 1, n)

        # a photo the same way, while Bob is offline
        bob.close(); net.stop('bob')
        ana.set_input_files('#file-input', files=[{'name': 'dot.png', 'mimeType': 'image/png', 'buffer': bytes.fromhex(
            '89504e470d0a1a0a0000000d4948445200000001000000010806000000'
            '1f15c4890000000d49444154789c6360f8cfc0f01f0005000201e2269d5b0000000049454e44ae426082')}])
        t0 = time.time(); st = []
        while time.time() - t0 < 40:
            st = ui('ana', '/api/swarm/states')['states']
            if any(s['shown'] == 'mailbox' for s in st): break
            time.sleep(0.5)
        H.check('a photo to Bob offline: into his mailbox too', any(s['shown'] == 'mailbox' for s in st), st)
        net.start('bob'); time.sleep(3)
        bob = H.prep(cB, net, 'bob'); H.unlock(bob); bob.wait_for_timeout(1500); H.open_contact(bob, 'Ana')
        got = peer('/collect', True)['envelopes']
        H.check('…collected and taken in', len(got) == 1 and to_inbox('bob', got[0]) == 200, len(got))
        H.check('…Bob has the photo', H.wait(bob, "document.querySelector('#conv-body img.media, #conv-body .bubble img')", 30000))

        # a call to Bob while he is offline: a copy at his peer for the missed-call record
        bob.close(); net.stop('bob')
        ana.click('.conv-call'); ana.wait_for_timeout(6000)
        dec = ana.locator('#call-dock .call-btn.decline')
        if dec.count(): dec.first.click()
        ana.wait_for_timeout(3000)
        got = peer('/collect', True)['envelopes']
        H.check('a call invite while Bob is offline leaves a copy at his peer', len(got) >= 1, len(got))

        # Cleo has no mailbox: directly, as always
        H.open_contact(ana, 'Cleo'); H.send(ana, 'direct to cleo')
        H.check('a contact without a mailbox gets it directly', H.sees(cleo, 'direct to cleo'))
        t = wait_tick(ana, 'direct to cleo', '✓', 30000)
        H.check('…and Ana sees ✓', t and t.endswith('✓'), t)
        b.close()
finally:
    net.close(); mp.terminate()
bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
H.check('no page errors', not bad, bad[:5])
H.summary()
