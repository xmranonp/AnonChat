"""1.0.7: "Undelivered messages" (conversation menu) offers 3 days and 7 days besides 1 h, 12 h and 24 h; the choice is kept per contact,
and a message to that contact while they are offline waits that long. 24 h stays the default."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
OUT = _args.out(__file__)
net = H.Net(['bob', 'ana'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
HOUR = 3600 * 1000
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ctx = {n: b.new_context(viewport={'width': 1180, 'height': 780}) for n in net.nodes}
        P = {n: H.prep(ctx[n], net, n) for n in net.nodes}
        for n in P: H.login(P[n])
        bob = P['bob']
        H.add_contact(bob, 'Ana', A['ana']); H.add_contact(P['ana'], 'Bob', A['bob'])
        H.open_contact(bob, 'Ana'); H.send(bob, 'hello'); bob.wait_for_timeout(2500)
        bob.click('.head-more'); bob.wait_for_timeout(300)
        item = bob.locator('#ctx-menu .ctx-item', has_text='Undelivered')
        H.check('the menu shows 24h by default', item.locator('.ctx-value').inner_text().strip() == '24h', item.inner_text())
        item.click(); bob.wait_for_timeout(300)
        labels = [x.strip() for x in bob.locator('#ctx-menu .ctx-item:not(.ctx-back) .ctx-label').all_inner_texts()]
        print(labels)
        H.check('five choices: 1h, 12h, 24h, 3d, 7d', labels == ['1h', '12h', '24h', '3d', '7d'], str(labels))
        bob.screenshot(path=os.path.join(OUT, 'undelivered-menu.png'))
        bob.locator('#ctx-menu .ctx-item', has_text='7d').click(); bob.wait_for_timeout(500)
        H.check('a toast says so', bob.locator('text=Undelivered messages now expire after 7d').count() >= 1)
        net.stop('ana')
        H.send(bob, 'while ana is away'); bob.wait_for_timeout(3000)
        mine = [i for i in H.api(bob, '/api/outbox')['body']['items'] if i['toAddress'] == A['ana']]
        print([round((i['expiresAt'] - i['queuedAt']) / HOUR, 1) for i in mine])
        H.check('the message waits 7 days', any(abs((i['expiresAt'] - i['queuedAt']) - 168 * HOUR) < 60000 for i in mine))
        bob.reload(); H.unlock(bob); H.open_contact(bob, 'Ana')
        bob.click('.head-more'); bob.wait_for_timeout(300)
        H.check('the choice is kept after a reload', bob.locator('#ctx-menu .ctx-item', has_text='Undelivered').locator('.ctx-value').inner_text().strip() == '7d')
        b.close()
finally:
    net.close()
H.summary()
