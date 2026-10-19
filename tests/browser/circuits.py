import subprocess, os, time, tempfile, json, sys, urllib.request
from playwright.sync_api import sync_playwright
import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import _args
APP, SHIM, OUT = _args.paths(__file__); TOKEN='f'*64
FAKE=os.path.join(APP, 'tools', 'fake-control-port.mjs')
d=tempfile.mkdtemp(); os.makedirs(d+'/anon/anon_service'); os.makedirs(d+'/data')
open(d+'/anon/anon_service/hostname','w').write('c'*56+'.anyone\n')
json.dump([{'address':'b'*56+'.anyone','petname':'Ana','ecdhPub':'K','ratchetPub':'R'}], open(d+'/data/contacts.json','w'))
fk=subprocess.Popen(['node',FAKE,'6619','6618',d+'/anon']); time.sleep(0.6)
def fake(path, body=None):
    req=urllib.request.Request('http://127.0.0.1:6618'+path, data=json.dumps(body or {}).encode(), method='POST' if body is not None else 'GET')
    return json.loads(urllib.request.urlopen(req).read())
def circ(i, purpose='GENERAL'):
    fp=lambda c: c*40
    a,b,c='ABCDEFGHIJKLMNOP'[i%16],'QRSTUVWX'[i%8],'0123456789'[i%10]
    return f"{i} BUILT ${fp(a)}~g{i},${fp(b)}~m{i},${fp(c)}~x{i} BUILD_FLAGS=NEED_CAPACITY PURPOSE={purpose} TIME_CREATED=2026-01-01T00:00:00"
def stream(i): return f"{i+500} SUCCEEDED {i} example{i}.com:443"
def setc(ids): fake('/state', {'circuits':[circ(i) for i in ids], 'streams':[stream(i) for i in ids]})
setc([5,6])
env=dict(os.environ, NODE_PATH=SHIM, PUBLIC_PORT='6612', UI_PORT='6611', DATA_DIR=d+'/data', ANON_DIR=d+'/anon', ANONCHAT_UI_TOKEN=TOKEN, ANON_CTRL_PORT='6619', PEERS='{}')
p=subprocess.Popen(['node',APP+'/server.js'],env=env,cwd=APP,stdout=open(OUT+'/server.log','w'),stderr=subprocess.STDOUT); time.sleep(1.8)
results=[]
def check(name, ok, detail=''):
    results.append(ok); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  [' + str(detail) + ']'), flush=True)
try:
  with sync_playwright() as pw:
    b=pw.chromium.launch(args=['--use-gl=swiftshader','--enable-webgl','--ignore-gpu-blocklist']); ctx=b.new_context(viewport={'width':1180,'height':820}); pg=ctx.new_page()
    errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://127.0.0.1:6611/?t={TOKEN}')
    pg.wait_for_selector('.welcome-cta'); pg.click('.welcome-cta'); pg.wait_for_timeout(300)
    for _ in range(2):
      for dg in '123456': pg.click(f'.pin-key:text-is("{dg}")')
      pg.wait_for_timeout(300)
    pg.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000); pg.wait_for_timeout(800)
    ids=lambda: pg.eval_on_selector_all('#circuits-body .circuit-id', 'xs => xs.map(x => x.textContent)')
    pg.click('#logs-btn'); pg.wait_for_timeout(400); pg.click('.log-tab[data-tab=circuits]'); pg.wait_for_timeout(1500)
    check('the Circuits tab lists the live circuits', sorted(ids())==['#5','#6'], ids())
    pg.screenshot(path=OUT+'/1-circuits.png')
    setc([5,6,7]); pg.wait_for_timeout(3600)
    check('a new circuit appears on the next refresh', '#7' in ids(), ids())
    setc([5,7]); pg.wait_for_timeout(3600)
    check('a circuit that went away disappears', '#6' not in ids() and '#7' in ids(), ids())
    # no change: the list is not rebuilt (scroll, tooltips survive)
    setc(list(range(10,26))); pg.wait_for_timeout(3600)
    pg.evaluate("document.querySelector('#circuits-body .circuit-card').dataset.mark='1'; document.getElementById('circuits-body').scrollTop = 300")
    st0=pg.evaluate("document.getElementById('circuits-body').scrollTop")
    pg.wait_for_timeout(3600)
    check('an unchanged list is left alone (not rebuilt)', pg.evaluate("!!document.querySelector('#circuits-body .circuit-card[data-mark]')"))
    check('…and keeps its scroll position', st0 > 0 and pg.evaluate("document.getElementById('circuits-body').scrollTop")==st0, (st0, pg.evaluate("document.getElementById('circuits-body').scrollTop")))
    setc(list(range(10,27))); pg.wait_for_timeout(3600)
    check('a changed list is rebuilt but keeps the scroll position', '#26' in ids() and abs(pg.evaluate("document.getElementById('circuits-body').scrollTop")-st0) < 2, pg.evaluate("document.getElementById('circuits-body').scrollTop"))
    # a failed query keeps the list
    n0=len(ids()); fake('/fail', {'n':3}); pg.wait_for_timeout(4000)
    check('a failed control-port query keeps the list on screen', len(ids())==n0 and 'control' not in pg.inner_text('#circuits-body').lower()[:200], len(ids()))
    # closing: a slow answer that started before the close must not bring it back
    setc([5,7]); pg.wait_for_timeout(3600)
    fake('/delays', {'list':[3500]}); pg.wait_for_timeout(3200)
    pg.click('.circuit-card:has(.circuit-id:text-is("#7")) .circuit-close'); pg.wait_for_timeout(800)
    check('closing a circuit removes it at once', ids()==['#5'], ids())
    pg.wait_for_timeout(4000)
    check('…and a slower, older answer does not bring it back', ids()==['#5'], ids())
    log=fake('/log')
    check('the circuit was closed on the control port', any(l.startswith('CLOSECIRCUIT 7') for l in log))
    # Show/Hide while the network answers slowly (Windows): every answer takes 4 s, longer than the 3 s between polls
    fake('/delays', {'list':[4000]*12}); pg.wait_for_timeout(3500)
    pg.click('.circuits-toggle'); pg.wait_for_timeout(500)
    check('Show takes effect at once even when the network answers slowly', pg.evaluate("document.getElementById('log-panel').classList.contains('circuits-focus')") and 'Hide' in pg.inner_text('.circuits-toggle'), pg.inner_text('.circuits-toggle'))
    pg.wait_for_timeout(9000)
    check('…and stays on while slow answers keep coming', pg.evaluate("document.getElementById('log-panel').classList.contains('circuits-focus')"))
    pg.click('.circuits-toggle'); pg.wait_for_timeout(500)
    check('Hide takes effect at once too', not pg.evaluate("document.getElementById('log-panel').classList.contains('circuits-focus')") and 'Show' in pg.inner_text('.circuits-toggle'), pg.inner_text('.circuits-toggle'))
    pg.wait_for_timeout(8000)
    check('…and the list still refreshes while answers are slow', len(ids()) >= 1, ids())
    fake('/delays', {'list':[]}); pg.wait_for_timeout(3500)
    # globe
    pg.click('.log-tab[data-tab=map]'); pg.wait_for_timeout(3000)
    cap=pg.inner_text('#globe-caption') if pg.query_selector('#globe-caption') else ''
    webgl=pg.evaluate("!!document.createElement('canvas').getContext('webgl')")
    print('webgl:', webgl, 'caption:', repr(cap))
    pg.screenshot(path=OUT+'/2-globe.png')
    if webgl:
      check('the globe caption names the circuit', '5' in cap, cap)
      setc([5,8]); fake('/state', {'streams':[stream(8)]}); pg.wait_for_timeout(3200)
      cap2=pg.inner_text('#globe-caption')
      check('the globe follows a change of circuit', '8' in cap2 and cap2!=cap, cap2)
      fake('/fail', {'n':2}); pg.wait_for_timeout(5500)
      check('a failed query keeps the globe caption', pg.inner_text('#globe-caption')==cap2, pg.inner_text('#globe-caption'))
      fake('/state', {'circuits':[], 'streams':[]}); pg.wait_for_timeout(3200)
      cap3=pg.inner_text('#globe-caption')
      check('no circuit → the caption says so', cap3=='No active circuit', cap3)
      pg.screenshot(path=OUT+'/3-globe-none.png')
    # the panel: closing and reopening at once leaves it visible; a double click never starts two refresh timers
    pg.click('.log-tab[data-tab=circuits]'); pg.wait_for_timeout(500)
    pg.click('#log-close') if pg.query_selector('#log-close') else pg.click('#logs-btn')
    pg.wait_for_timeout(60); pg.click('#logs-btn'); pg.wait_for_timeout(600)
    check('closing and reopening at once leaves the panel visible', pg.evaluate("!document.getElementById('log-panel').hidden && document.getElementById('log-panel').classList.contains('open')"))
    pg.click('#logs-btn'); pg.wait_for_timeout(400)
    pg.evaluate("""() => { const b = document.getElementById('logs-btn'); b.click(); b.click(); }""")
    pg.wait_for_timeout(300)
    pg.evaluate("""() => { window.__n = 0; const f = window.fetch; window.fetch = (u, o) => { if (String(u).includes('/api/circuits')) window.__n++; return f(u, o); }; }""")
    pg.wait_for_timeout(9200)
    n = pg.evaluate("window.__n")
    check('a double click on the network button still refreshes every 3 s, not twice as often', 2 <= n <= 4, n)
    check('no page errors', not errs, errs)
    b.close()
finally: p.kill(); fk.kill()
print(f"{sum(results)}/{len(results)} passed")
