"""Full-app voice-call test: two real UIs (Playwright + Chromium with a fake microphone), real ratchet signalling, real call bridge.
Run: python3 tools/e2e/run-calls.py   (needs: playwright for Python, Chromium, `npm install`)"""
import subprocess, json, time, os, shutil, tempfile, re, math, struct, wave, sys
HERE=os.path.dirname(os.path.abspath(__file__)); ROOT=os.path.abspath(os.path.join(HERE,'..','..'))
TONE=os.path.join(tempfile.gettempdir(),'anonchat-tone.wav')
w=wave.open(TONE,'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
w.writeframes(b''.join(struct.pack('<h',int(9000*math.sin(2*math.pi*440*i/48000)*(0.6+0.4*math.sin(2*math.pi*3*i/48000)))) for i in range(48000*4))); w.close()
CHROMIUM=os.environ.get('CHROMIUM','/opt/pw-browsers/chromium')
from playwright.sync_api import sync_playwright
ENV={**os.environ}
procs=[]
def spawn(args, extra={}, stdin=False):
    p=subprocess.Popen(args,env={**ENV,**extra},stdout=subprocess.PIPE,stderr=subprocess.STDOUT,stdin=subprocess.PIPE if stdin else None,text=True); procs.append(p); return p
socks=spawn(['node',os.path.join(HERE,'socks.mjs')],stdin=True)
dA=tempfile.mkdtemp(); dB=tempfile.mkdtemp()
nA=spawn(['node',os.path.join(HERE,'stub.mjs')],{'NAME':'A','DATA_DIR':dA}); nB=spawn(['node',os.path.join(HERE,'stub.mjs')],{'NAME':'B','DATA_DIR':dB})
time.sleep(1.5)
A_ADDR='a'*56+'.anyone'; B_ADDR='b'*56+'.anyone'
res=[]
def check(name, cond, extra=''):
    res.append(bool(cond)); print(('PASS ' if cond else 'FAIL ')+name, extra)
def wait(pg, js, ms=30000):
    t0=time.time()
    while time.time()-t0<ms/1000:
        try:
            v=pg.evaluate(js)
            if v: return v
        except Exception: pass
        time.sleep(0.2)
    return None
def prep(ctx, port, tag, urls, errs):
    pg=ctx.new_page()
    pg.on('pageerror',lambda e:errs.append(tag+': '+str(e)))
    pg.on('console',lambda m:errs.append(tag+' console: '+m.text) if m.type=='error' and 'WebSocket' not in m.text else None)
    pg.on('request',lambda r:urls.append(r.url))
    pg.on('websocket',lambda w:urls.append(w.url))
    pg.route('**/app.js',lambda r:r.fulfill(status=200,content_type='text/javascript',body=open(ROOT+'/public/app.js').read()+'\nwindow.__dbg={get calls(){return calls}, loadThread, openNone(){selected=null;selectedGroup=null;renderConversation();}};\n'))
    pg.goto(f'http://127.0.0.1:{port}/')
    return pg
def login(pg):
    pg.wait_for_selector('.welcome-cta'); pg.wait_for_timeout(300)
    if not os.path.exists(os.path.join(tempfile.gettempdir(),'anonchat-welcome.png')): pg.screenshot(path=os.path.join(tempfile.gettempdir(),'anonchat-welcome.png'))
    pg.click('.welcome-cta')
    for _ in range(2):
        for d in '123456': pg.click(f'.pin-key:text-is("{d}")')
        pg.wait_for_timeout(300)
        if pg.is_visible('#pin-ok'):
            try: pg.click('#pin-ok',timeout=500)
            except Exception: pass
        pg.wait_for_timeout(500)
    pg.wait_for_selector('#pin-screen.gone',state='attached',timeout=15000)
errs=[]; urlsA=[]; urlsB=[]
with sync_playwright() as pw:
    b=pw.chromium.launch(executable_path=CHROMIUM if os.path.exists(CHROMIUM) else None,args=['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--use-file-for-fake-audio-capture='+TONE+'','--autoplay-policy=no-user-gesture-required','--disable-audio-output'])
    cA=b.new_context(viewport={'width':1280,'height':800}); cB=b.new_context(viewport={'width':1280,'height':800})
    A=prep(cA,5101,'A',urlsA,errs); B=prep(cB,5201,'B',urlsB,errs)
    login(A); login(B)
    time.sleep(1.5)
    check('RTCPeerConnection is removed from the real page', A.evaluate('typeof RTCPeerConnection')=='undefined' and A.evaluate('typeof webkitRTCPeerConnection')=='undefined')
    for pg,addr,name in ((A,B_ADDR,'Bob'),(B,A_ADDR,'Alice')):
        pg.click('#add-contact-btn'); pg.fill('#in-petname',name); pg.fill('#in-address',addr); pg.click('#add-confirm'); pg.wait_for_timeout(1500)
    A.click('.contact-row, .contact'); B.click('.contact-row, .contact'); A.wait_for_timeout(800)
    check('call button is in the 1:1 header', A.locator('#conv-head .conv-call').count()==1 and B.locator('#conv-head .conv-call').count()==1)
    A.screenshot(path=os.path.join(tempfile.gettempdir(),'anonchat-call-header.png'))
    check('network dot pulses cyan when connected', wait(A,"document.getElementById('ws-dot').classList.contains('online')",15000) and A.evaluate("getComputedStyle(document.getElementById('ws-dot'),'::after').animationName")=='net-pulse')
    check('the status dot is really cyan (not overridden by another style)', A.evaluate("getComputedStyle(document.getElementById('ws-dot')).backgroundColor")=='rgb(27, 193, 239)')
    check('dot has a tooltip text', A.evaluate("document.getElementById('ws-dot').getAttribute('aria-label')")=='Connected to the Anyone network')
    A.evaluate("window.__dbg.fakeOffline && 0")
    A.hover('#conv-head .conv-call'); A.wait_for_timeout(700)
    print('  tip:', A.locator('#ctx-tip').inner_text() if A.locator('#ctx-tip').count() else None, '| native title:', A.get_attribute('#conv-head .conv-call','title'))
    A.click('#conv-head .conv-call')
    check('callee sees the incoming call', wait(B,'window.__dbg.calls.stats()?.state==="incoming"',40000))
    B.screenshot(path=os.path.join(tempfile.gettempdir(),'anonchat-call-incoming.png'))
    print('  A state:', A.evaluate('window.__dbg.calls.stats()?.state'))
    B.click('.call-btn.accept')
    ok=wait(A,'window.__dbg.calls.stats()?.state==="active"',90000) and wait(B,'window.__dbg.calls.stats()?.state==="active"',90000)
    check('call becomes active on both sides (real ratchet signalling + real audio link)', ok)
    time.sleep(8)
    sa,sb=A.evaluate('window.__dbg.calls.stats()'),B.evaluate('window.__dbg.calls.stats()')
    print('  A',sa); print('  B',sb)
    check('encrypted audio flows both ways and is audible', sa and sb and sa['rx']>150 and sb['rx']>150 and sa['peak']>0.03 and sb['peak']>0.03)
    A.screenshot(path=os.path.join(tempfile.gettempdir(),'anonchat-call-active.png'))
    dock=A.evaluate("(()=>{const d=document.getElementById('call-dock'),h=document.getElementById('conv-head'),b=document.getElementById('conv-body');const r=d.getBoundingClientRect();return {hidden:d.hidden,cls:d.className,top:r.top,headBottom:h.getBoundingClientRect().bottom,bodyTop:b.getBoundingClientRect().top,inConv:!!d.closest('#conv')}})()")
    check('the call bar is docked inside the chat window, between the header and the messages', dock['inConv'] and not dock['hidden'] and 'full' in dock['cls'] and 0<=dock['top']-dock['headBottom']<=16 and dock['bodyTop']>=dock['top'], str(dock))
    # while another chat (here: none selected via the welcome state) is shown the bar shrinks; open a group view is not available in the stub, so use a second contact
    A.evaluate("window.__dbg.openNone()"); A.wait_for_timeout(400)
    mini=A.evaluate("document.getElementById('call-dock').className")
    check('with another chat open the bar shrinks to a slim strip', 'mini' in mini, mini)
    A.screenshot(path=os.path.join(tempfile.gettempdir(),'anonchat-call-mini.png'))
    A.click('#call-dock'); A.wait_for_timeout(500)
    check('clicking the strip returns to the call chat and the full bar', 'full' in A.evaluate("document.getElementById('call-dock').className") and A.locator('#conv-head .conv-call').count()==1)
    A.click('.call-btn.mute'); A.wait_for_timeout(300)
    check('mute toggles (real mouse click)', A.evaluate('window.__dbg.calls.stats().muted') is True and A.locator('.call-btn.mute.on').count()==1)
    check('mute button label and pressed state follow the click', A.get_attribute('.call-btn.mute','aria-pressed')=='true' and A.get_attribute('.call-btn.mute','aria-label')=='Unmute')
    check('the microphone track itself is switched off', A.evaluate('window.__dbg.calls.micEnabled()') is False)
    B.wait_for_timeout(1500)
    lv=max(B.evaluate('window.__dbg.calls.stats().level') or 0 for _ in range(12) if not B.wait_for_timeout(100))
    print('  B hears while A muted: max level', lv)
    check('while A is muted B hears silence', lv<0.005, str(lv))
    print('  mute state A:', A.evaluate('window.__dbg.calls.stats()'))
    A.click('.call-btn.mute'); A.wait_for_timeout(300)
    B.wait_for_timeout(1500)
    lv2=max(B.evaluate('window.__dbg.calls.stats().level') or 0 for _ in range(12) if not B.wait_for_timeout(100))
    print('  B level after unmute', lv2)
    check('after unmute B hears audio again', lv2>0.02, str(lv2))
    check('unmute toggles back', A.evaluate('window.__dbg.calls.stats().muted') is False and A.locator('.call-btn.mute.on').count()==0)
    # sent signals were all ephemeral
    sentA=json.loads(A.evaluate("fetch('/stub/sent').then(r=>r.text())")); sentB=json.loads(B.evaluate("fetch('/stub/sent').then(r=>r.text())"))
    check('every call signal was sent as ephemeral (never queued)', all(s['ephemeral'] for s in sentA+sentB) and len(sentA)>=1 and len(sentB)>=1, f'{len(sentA)}/{len(sentB)}')
    A.click('.call-btn.decline'); time.sleep(4)
    check('call ended on both sides', A.evaluate('window.__dbg.calls.stats()') is None and B.evaluate('window.__dbg.calls.stats()') is None)
    A.wait_for_timeout(800)
    txtA=A.inner_text('#conv-body'); txtB=B.inner_text('#conv-body')
    check('both conversations show the call line', re.search(r'Voice call · \d+:\d\d',txtA) and re.search(r'Voice call · \d+:\d\d',txtB), repr(txtA[-60:])+' / '+repr(txtB[-60:]))
    A.screenshot(path=os.path.join(tempfile.gettempdir(),'anonchat-call-after.png'))
    # reverse direction: B calls A, A declines
    B.click('#conv-head .conv-call')
    check('reverse call rings on A', wait(A,'window.__dbg.calls.stats()?.state==="incoming"',40000))
    A.click('.call-btn.decline'); time.sleep(4)
    check('declined call is logged', 'declined' in B.inner_text('#conv-body').lower() and 'declined' in A.inner_text('#conv-body').lower())
    # incoming calls switched off in settings -> auto decline
    A.evaluate("localStorage.setItem('anyonechat.calls.off','1')")
    B.click('#conv-head .conv-call'); time.sleep(8)
    check('with calls switched off the invite is declined without ringing', A.evaluate('window.__dbg.calls.stats()') is None and B.evaluate('window.__dbg.calls.stats()') is None)
    # every URL the pages touched is local
    allurls=urlsA+urlsB
    nonlocal_=[u for u in allurls if not re.match(r'^(http|ws)://127\.0\.0\.1:(5101|5201)/',u) and not u.startswith(('data:','blob:','about:'))]
    check('the pages only ever contacted the local backend', not nonlocal_, str(nonlocal_[:5]))
    print('  errors:', errs)
    b.close()
socks.stdin.write('log\n'); socks.stdin.flush(); time.sleep(0.5)
for p in procs: p.kill()
print('RESULT', sum(res),'/',len(res))
sys.exit(0 if all(res) else 1)
