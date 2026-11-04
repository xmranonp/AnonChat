"""N-1: a long chat costs what a short one does. History is stored in chunks (one message rewrites only the newest chunk), survives a reload,
a chat saved the old way (one array) still loads and moves to chunks, deleting and clearing leave no stale chunks, and the window shows
only the newest messages, adds older ones on request, and adds a new message without drawing the whole list again."""
import os, sys, time, json, shutil, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
from playwright.sync_api import sync_playwright
APP = H.APP
d = tempfile.mkdtemp(prefix='n1-app-')
for x in ('server.js', 'start.js', 'package.json', 'lib', 'public'):
    s = os.path.join(APP, x); (shutil.copytree if os.path.isdir(s) else shutil.copy)(s, os.path.join(d, x))
if os.path.exists(os.path.join(APP, 'node_modules')): os.symlink(os.path.realpath(os.path.join(APP, 'node_modules')), os.path.join(d, 'node_modules'))
with open(os.path.join(d, 'public', 'app.js'), 'a') as f:
    f.write("\nwindow.__p = { loadThread, persistField, appendThread, deleteMessage, clearThread, renderConversation, LS, threadCache, fields, pinEncrypt, persistQueues, dropThread, get pinKey() { return pinKey; }, get selected() { return selected; } };\n")
net = H.Net(['ana', 'bob'], apps={'ana': d})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
FILL = """async (n) => { const P = window.__p, addr = P.selected, t = P.loadThread(addr);
  while (t.length < n) t.push({ id: 'm' + t.length, dir: t.length % 2 ? 'in' : 'out', kind: 'text', text: 'message number ' + t.length, ts: Date.now() - (n - t.length) * 60000, verified: true });
  P.threadCache.set(addr, t); await P.persistField(P.LS.thread(addr), t); return t.length; }"""
STATE = """() => { const P = window.__p, k = P.LS.thread(P.selected), t = P.loadThread(P.selected);
  return { len: t.length, last: t.length ? t[t.length - 1].text : null, keys: P.fields.keys().filter((x) => x === k || x.startsWith(k + '#')).map((x) => x.slice(k.length)).sort() }; }"""
def settle(pg): pg.evaluate("async () => { await Promise.all([...window.__p.persistQueues.values()]); }")
def reopen(pg):
    pg.wait_for_timeout(1500); pg.reload(); H.pin(pg, 1); pg.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000); pg.wait_for_timeout(1500)
    pg.click('#contacts .contact:has-text("Bob")'); pg.wait_for_timeout(800)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(); ana = H.prep(b.new_context(), net, 'ana'); bob = H.prep(b.new_context(), net, 'bob')
        H.login(ana); H.login(bob); H.add_contact(ana, 'Bob', A['bob']); H.open_contact(ana, 'Bob')
        ana.evaluate(FILL, 1300)
        ana.evaluate("() => { const P = window.__p; for (let i = 0; i < 3; i++) P.appendThread(P.selected, { id: 'x' + i, dir: 'out', kind: 'text', text: 'appended ' + i, ts: Date.now() + i, verified: true }); }")
        settle(ana); s = ana.evaluate(STATE)
        H.check('1,303 messages are stored as 3 chunks and a list', s['len'] == 1303 and s['keys'] == ['', '#0', '#1', '#2'], s)
        reopen(ana); s = ana.evaluate(STATE)
        H.check('after a reload all 1,303 messages are back, the newest last', s['len'] == 1303 and s['last'] == 'appended 2', s)
        # one more message writes only the newest chunk
        ana.evaluate("() => { const P = window.__p; window.__w = []; const set = P.fields.putMany.bind(P.fields); P.fields.putMany = (e, dl) => { window.__w.push(e.map((x) => x[0].split('#')[1] ?? 'list')); return set(e, dl); }; P.appendThread(P.selected, { id: 'y1', dir: 'out', kind: 'text', text: 'one more', ts: Date.now() + 9, verified: true }); }")
        settle(ana); w = ana.evaluate("() => window.__w")
        H.check('one more message rewrites only the newest chunk', w == [['2']], w)
        # delete from the middle: the chat shrinks and no stale chunk stays
        ana.evaluate("() => { const P = window.__p; for (let i = 0; i < 400; i++) P.deleteMessage(P.selected, 'm' + (10 + i)); }")
        settle(ana); s = ana.evaluate(STATE)
        H.check('after deleting 400 messages: 904 left in 2 chunks, no stale chunk', s['len'] == 904 and s['keys'] == ['', '#0', '#1'], s)
        reopen(ana); s = ana.evaluate(STATE)
        H.check('the shortened chat reloads whole', s['len'] == 904 and s['last'] == 'one more', s)
        # a chat saved the old way: one array under the field itself
        ana.evaluate("""async () => { const P = window.__p, k = P.LS.thread(P.selected);
          const old = Array.from({ length: 700 }, (_, i) => ({ id: 'o' + i, dir: 'in', kind: 'text', text: 'old ' + i, ts: Date.now() - (700 - i) * 60000, verified: true }));
          const { ct, iv } = await P.pinEncrypt(P.pinKey, JSON.stringify(old));
          await P.fields.deleteThread(k); await P.fields.set(k, JSON.stringify({ __enc: 1, ct, iv })); }""")
        reopen(ana); s = ana.evaluate(STATE)
        H.check('a chat saved the old way still loads (700 messages)', s['len'] == 700 and s['last'] == 'old 699' and s['keys'] == [''], s)
        ana.evaluate("() => { const P = window.__p; P.appendThread(P.selected, { id: 'z1', dir: 'out', kind: 'text', text: 'first in chunks', ts: Date.now(), verified: true }); }")
        settle(ana); s = ana.evaluate(STATE)
        H.check('its first write moves it to chunks', s['keys'] == ['', '#0', '#1'] and s['len'] == 701, s)
        reopen(ana); s = ana.evaluate(STATE)
        H.check('and it reloads from chunks', s['len'] == 701 and s['last'] == 'first in chunks', s)
        # what is on screen
        nb = ana.evaluate("() => document.querySelectorAll('#conv-body .bubble').length")
        H.check('a long chat shows only the newest 200 messages', 190 <= nb <= 210, nb)
        H.check('with a button for the earlier ones', ana.is_visible('#conv-body .earlier-btn'))
        ana.evaluate("() => { document.querySelector('#conv-body').scrollTop = 0; }"); ana.wait_for_timeout(1200)
        nb2 = ana.evaluate("() => document.querySelectorAll('#conv-body .bubble').length")
        H.check('scrolling to the top adds 200 earlier messages', nb2 >= nb + 190, (nb, nb2))
        ana.evaluate("() => { const b = document.querySelector('#conv-body'); b.scrollTop = b.scrollHeight; }"); ana.wait_for_timeout(300)
        ana.evaluate("() => { window.__mark = document.querySelector('#conv-body .bubble'); const P = window.__p; P.appendThread(P.selected, { id: 'z2', dir: 'out', kind: 'text', text: 'shown at the end', ts: Date.now() + 5, verified: true }); P.renderConversation(); }")
        ana.wait_for_timeout(300)
        same = ana.evaluate("() => document.querySelector('#conv-body .bubble') === window.__mark")
        txt = ana.evaluate("() => [...document.querySelectorAll('#conv-body .bubble-text')].pop().textContent")
        H.check('a new message is added at the end, the rest is not drawn again', same and 'shown at the end' in txt, (same, txt))
        ana.evaluate("() => { const P = window.__p; P.clearThread(P.selected); }"); settle(ana); s = ana.evaluate(STATE)
        H.check('clearing the chat leaves the list and no chunks', s['len'] == 0 and s['keys'] == [''], s)
        reopen(ana); s = ana.evaluate(STATE)
        H.check('and it stays empty after a reload', s['len'] == 0, s)
        # R-3 (the chat was cleared just before, so it starts empty): a flood of saves of one chat becomes a few writes, not one per message, and nothing is lost.
        ana.evaluate("() => { const P = window.__p; P.__writes = 0; const orig = P.fields.putMany.bind(P.fields); P.fields.putMany = (...a) => { P.__writes++; return orig(...a); }; }")
        t0 = time.time()
        ana.evaluate("() => { const P = window.__p; for (let i = 0; i < 400; i++) P.appendThread(P.selected, { id: 'f' + i, dir: 'in', kind: 'text', text: 'flood ' + i, ts: Date.now() + i, verified: true }); }")
        settle(ana); s = ana.evaluate(STATE); w = ana.evaluate("() => window.__p.__writes")
        H.check('400 messages arriving at once cost a handful of writes, not 400', 1 <= w <= 4, w)
        H.check('...and every one is stored, in order, with the right chunks', s['len'] == 400 and s['last'] == 'flood 399' and s['keys'] == ['', '#0'], s)
        r = ana.evaluate("""async () => { const P = window.__p, k = P.LS.thread(P.selected); const calls = [];
          const a = P.persistField(k, P.loadThread(P.selected), 0); const b = P.persistField(k, P.loadThread(P.selected), 0); const c = P.persistField(k, P.loadThread(P.selected), 0);
          return [await a, await b, await c]; }""")
        H.check('every caller gets its answer (true) when its saves are merged', r == [True, True, True], r)
        reopen(ana); s = ana.evaluate(STATE)
        H.check('after a reload the flood is all there', s['len'] == 400 and s['last'] == 'flood 399', s)
        # Deleting a chat (contact removed, group deleted) while saves of it are queued: nothing of it comes back to the disk.
        r = ana.evaluate("""async () => { const P = window.__p, k = P.LS.thread(P.selected);
          for (let i = 0; i < 300; i++) P.appendThread(P.selected, { id: 'd' + i, dir: 'in', kind: 'text', text: 'doomed ' + i, ts: Date.now() + 1000 + i, verified: true });
          P.dropThread(k);
          await Promise.allSettled([...P.persistQueues.values()]); await new Promise((r) => setTimeout(r, 300));
          return P.fields.keys().filter((x) => x === k || x.startsWith(k + '#')); }""")
        H.check('a chat deleted while its saves are queued stays deleted on disk', r == [], r)
        r = ana.evaluate("""async () => { const P = window.__p, k = P.LS.thread(P.selected);
          for (let i = 0; i < 50; i++) P.appendThread(P.selected, { id: 'e' + i, dir: 'in', kind: 'text', text: 'again ' + i, ts: Date.now() + 5000 + i, verified: true });
          P.dropThread(k);
          const t = [{ id: 'n1', dir: 'in', kind: 'text', text: 'after re-adding', ts: Date.now() + 9000, verified: true }];
          P.threadCache.set(P.selected, t); const ok = await P.persistField(k, t, 0);
          await Promise.allSettled([...P.persistQueues.values()]); await new Promise((r) => setTimeout(r, 300));
          return [ok, P.fields.keys().filter((x) => x === k || x.startsWith(k + '#')).length]; }""")
        H.check('a save made after the deletion (contact added again) is kept', r[0] is True and r[1] == 2, r)
        H.check('no page errors', not [e for e in H.errs if 'map' not in e.lower()], H.errs[:3])
        H.summary()
        b.close()
finally:
    net.close()
