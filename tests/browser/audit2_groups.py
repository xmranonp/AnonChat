"""Second audit pass, groups: a member the admin removes is told, sees a read-only chat, and can't come back on their own (not with a code
built from what members know, not with the code they had, not with the new one) until the admin adds them again; a malformed reaction
from a member (a modified client) can't blank the group chat. Bob is the admin; Ana and Carl are his contacts; Carl runs the modified app."""
import sys, os, time, json, base64
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
OUT = _args.out(__file__)
def groups_of(pg): return pg.evaluate("fetch('/api/groups').then(r => r.json())")
net = H.Net(['bob', 'ana', 'carl'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000'}, apps={'carl': H.hostile_app()})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ctx = {n: b.new_context(viewport={'width': 1180, 'height': 780}) for n in net.nodes}
        P = {n: H.prep(ctx[n], net, n) for n in net.nodes}
        for n in P: H.login(P[n])
        bob, ana, carl = P['bob'], P['ana'], P['carl']
        for n in ('ana', 'carl'): H.add_contact(P[n], 'Bob', A['bob'])
        H.add_contact(bob, 'Ana', A['ana']); H.add_contact(bob, 'Carl', A['carl'])
        bob.click('#new-group-btn'); bob.wait_for_timeout(300)
        bob.fill('#grp-name', 'Book club')
        for cb in bob.locator('#grp-member-list input[type=checkbox]').all(): cb.check()
        bob.click('#grp-create'); bob.wait_for_timeout(1500)
        for n in ('ana', 'carl'):
            H.check(f'{n} gets the invite', H.wait(P[n], "fetch('/api/groups').then(r=>r.json()).then(g => g.length === 1 && g[0].members.length === 3)", 40000))
        gid = groups_of(bob)[0]['id']
        H.open_group(ana); H.send(ana, 'ana before removal')
        H.open_group(carl)
        H.check('Carl sees Ana before removal', H.sees(carl, 'ana before removal'))

        # Bob shares the invite code with Ana before anything happens (she keeps it)
        H.open_group(bob); bob.click('.conv-manage-btn'); bob.wait_for_timeout(400)
        old_code = bob.input_value('#grp-manage-overlay .grp-invite-code'); bob.click('#grp-manage-overlay .confirm-cancel')
        H.check('the code carries a secret', 'k' in json.loads(base64.b64decode(old_code + '=' * (-len(old_code) % 4))))
        forged = ana.evaluate(f"btoa(JSON.stringify({{ id: {json.dumps(gid)}, name: 'Book club', by: {json.dumps(A['bob'])} }})).replace(/=+$/, '')")

        # ---- 1. Bob removes Ana ----
        bob.click('.conv-manage-btn'); bob.wait_for_timeout(400)
        bob.click('#grp-manage-overlay .grp-member-row:has-text("Ana") .grp-rm-btn'); bob.wait_for_timeout(300)
        bob.click('#confirm-overlay .confirm-ok')
        H.check('Bob: Ana removed', H.wait(bob, f"fetch('/api/groups').then(r=>r.json()).then(g => g[0].members.length === 2 && !g[0].members.some(m => m.address === {json.dumps(A['ana'])}))", 20000))
        H.check('Carl: Ana removed', H.wait(carl, f"fetch('/api/groups').then(r=>r.json()).then(g => g[0].members.length === 2)", 40000))
        H.check('Ana’s app is told she was removed', H.wait(ana, f"fetch('/api/groups').then(r=>r.json()).then(g => g[0] && !!g[0].removedMe && !g[0].members.some(m => m.address === {json.dumps(A['ana'])}))", 40000))
        H.open_group(ana); ana.wait_for_timeout(600)
        H.check('…the chat says so', 'removed you from the group' in ana.inner_text('#conv-body'))
        H.check('…the message box gives way to a note', not ana.is_visible('#msg-input') and 'no longer in this group' in ana.inner_text('#compose-note'))
        ana.screenshot(path=OUT + '/t1-ana-removed.png')
        H.check('…her history is still there', H.sees(ana, 'ana before removal', 3000))
        ana.click('.head-more'); ana.wait_for_timeout(300)
        items = ana.evaluate("[...document.querySelectorAll('.ctx-item')].map(e => e.textContent)")
        H.check('…the menu offers Delete group instead of Leave group', any('Delete group' in x for x in items) and not any('Leave group' in x for x in items), items)
        ana.click('.ctx-item:has-text("Delete group")'); ana.wait_for_timeout(300); ana.click('#confirm-overlay .confirm-ok')
        H.check('Delete group removes it from Ana’s app', H.wait(ana, "fetch('/api/groups').then(r=>r.json()).then(g => g.length === 0)", 10000))

        def try_join(code, label):
            ana.click('#join-group-btn'); ana.fill('#join-group-overlay textarea', code); ana.click('#join-group-overlay .confirm-ok'); ana.wait_for_timeout(1500)
            err = ana.evaluate("(() => { const o = document.getElementById('join-group-overlay'); return o && !o.hidden ? o.innerText : '' })()")
            if err: ana.click('#join-group-overlay .confirm-cancel')
            back = H.wait(bob, f"fetch('/api/groups').then(r=>r.json()).then(g => g[0] && g[0].members.some(m => m.address === {json.dumps(A['ana'])}))", 25000)
            H.check(f'{label}: Bob’s list stays without Ana', not back, 'Ana is back')
            if groups_of(ana):                         # her app made the group locally: tidy up for the next try
                H.open_group(ana); ana.click('.head-more'); ana.wait_for_timeout(200)
                ana.click('.ctx-item:has-text("Leave group")'); ana.wait_for_timeout(200); ana.click('#confirm-overlay .confirm-ok'); ana.wait_for_timeout(1000)
            return err
        e1 = try_join(forged, 'a code built without the secret')
        H.check('…and her app says the code is not valid', 'not valid' in e1.lower() or 'invalid' in e1.lower(), e1[:120])
        try_join(old_code, 'the code she was given before removal')
        bob.click('.conv-manage-btn'); bob.wait_for_timeout(400)
        new_code = bob.input_value('#grp-manage-overlay .grp-invite-code'); bob.click('#grp-manage-overlay .confirm-cancel')
        H.check('removing someone changed the code', new_code != old_code)
        try_join(new_code, 'even the new code')
        H.check('Carl doesn’t see anything from Ana', not H.sees(carl, 'ana is back', 2000))

        # The admin can add her again: then she is a member as before
        bob.click('.conv-manage-btn'); bob.wait_for_timeout(400)
        bob.select_option('#grp-manage-overlay .grp-add-select', A['ana']); bob.click('#grp-manage-overlay .grp-add-row .confirm-ok')
        H.check('Bob adds Ana again', H.wait(ana, "fetch('/api/groups').then(r=>r.json()).then(g => g[0] && !g[0].removedMe && g[0].members.length === 3)", 40000))
        H.open_group(ana); ana.wait_for_timeout(500)
        H.check('…her message box is back', ana.is_visible('#msg-input'))
        H.send(ana, 'ana is back, added by bob')
        H.check('…and Carl reads her', H.sees(carl, 'ana is back, added by bob'))

        # ---- 2. Carl (hostile client) reacts to Bob's message with a malformed emoji ----
        H.open_group(bob); H.send(bob, 'bob says hi')
        H.check('Carl has Bob’s message', H.sees(carl, 'bob says hi'))
        mid = carl.evaluate(f"window.__evil.loadThread('grp:' + {json.dumps(gid)}).find(m => m.text === 'bob says hi').id")
        n0 = len(H.errs)
        carl.evaluate(f"""(() => {{ const E = window.__evil; const g = E.groupById({json.dumps(gid)});
            return E.deliverToGroup(g, E.encodeFrame('reaction', {{ grp: g.id, reactTo: {json.dumps(mid)}, emoji: [1] }}, new Uint8Array(0))); }})()""")
        time.sleep(6)
        for n in ('bob', 'ana'):
            pg = P[n]; H.open_group(pg); pg.wait_for_timeout(800)
            cnt = pg.evaluate("document.querySelectorAll('#conv-body .bubble-text').length")
            H.check(f'{n}’s group chat still shows its messages after the bad reaction', cnt > 0, f'{cnt} messages shown; errors: {[e for e in H.errs[n0:] if n in e][:2]}')
        bob.screenshot(path=OUT + '/t1-bob-group-after-reaction.png')
        # survives a restart of the window
        bob.reload(); H.unlock(bob); bob.wait_for_timeout(1000); H.open_group(bob); bob.wait_for_timeout(800)
        cnt = bob.evaluate("document.querySelectorAll('#conv-body .bubble-text').length")
        H.check('…and after reopening the app', cnt > 0, f'{cnt} messages shown after reload')
        b.close()
finally:
    net.close()
bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
H.check('no page errors', not bad, bad[:5])
H.summary()
