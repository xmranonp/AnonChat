"""Third pass: a call's audio. Ana calls Bob, he answers, both send the browser's test tone. The other side's voice is played through an
ordinary audio player in the page (Chromium's echo cancellation knows what its audio players play), it is actually heard (the speaking
audio is decoded), the card counts a 2–3 s delay as good, and the player stops when the call ends."""
import sys, os, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
net = H.Net(['ana', 'bob'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
# Every audio player the page starts, and what it plays
TRACK = """(() => { window.__players = []; window.__decoded = 0; const play = HTMLMediaElement.prototype.play;
  if (window.AudioDecoder) { const AD = window.AudioDecoder; window.AudioDecoder = class extends AD { constructor(init) { super({ ...init, output: (d) => { window.__decoded++; init.output(d); } }); } }; }
  HTMLMediaElement.prototype.play = function () { if (!window.__players.includes(this)) window.__players.push(this); return play.call(this); }; })();"""
STATE = "window.__players.map(p => ({ stream: !!(p.srcObject && p.srcObject.getAudioTracks && p.srcObject.getAudioTracks().length), paused: p.paused }))"
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
        ctx = {n: b.new_context(viewport={'width': 1180, 'height': 780}, permissions=['microphone']) for n in ('ana', 'bob')}
        for c in ctx.values(): c.add_init_script(TRACK)
        ana = H.prep(ctx['ana'], net, 'ana'); bob = H.prep(ctx['bob'], net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', A['bob']); H.add_contact(bob, 'Ana', A['ana'])
        H.open_contact(ana, 'Bob'); H.send(ana, 'hi'); H.open_contact(bob, 'Ana'); H.sees(bob, 'hi'); H.send(bob, 'hi back'); H.sees(ana, 'hi back')
        ana.click('.conv-call')
        H.check('Bob’s app rings', H.wait(bob, "!!document.querySelector('#call-dock .call-btn.accept')", 40000))
        bob.click('#call-dock .call-btn.accept')
        live = H.wait(bob, "window.__players.some(p => p.srcObject && !p.paused)", 30000) and H.wait(ana, "window.__players.some(p => p.srcObject && !p.paused)", 30000)
        H.check('both sides play the other’s voice through an audio player in the page', live, [ana.evaluate(STATE), bob.evaluate(STATE)])
        H.check('…and the other’s audio arrives and is decoded on both sides', H.wait(bob, "window.__decoded > 50", 30000) and H.wait(ana, "window.__decoded > 50", 30000), [ana.evaluate('window.__decoded'), bob.evaluate('window.__decoded')])
        H.check('…the call card shows a delay in the 2–3 s range as good', H.wait(ana, "(() => { const q = document.querySelector('#call-dock .call-q'); return q && /\\d/.test(q.textContent) && q.classList.contains('good'); })()", 20000), ana.evaluate("document.querySelector('#call-dock .call-q')?.outerHTML"))
        ana.click('#call-dock .call-btn.decline')
        H.check('hanging up stops the players', H.wait(ana, "window.__players.every(p => p.paused)", 10000) and H.wait(bob, "window.__players.every(p => p.paused)", 20000), [ana.evaluate(STATE), bob.evaluate(STATE)])
        b.close()
finally:
    net.close()
bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
H.check('no page errors', not bad, bad[:5])
H.summary()
