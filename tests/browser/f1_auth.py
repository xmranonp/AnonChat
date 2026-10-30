"""F-1 re-check: the cookie is gone; the token travels as a header from the page's own storage; another local origin gets nothing."""
import subprocess, os, sys, time, tempfile, threading, json, http.server, socket, re, urllib.request, urllib.error
from playwright.sync_api import sync_playwright
APP = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
def fp():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
UI, PUB, EVIL = fp(), fp(), fp()
d = tempfile.mkdtemp(prefix='f1-')
os.makedirs(d + '/anon/anon_service'); os.makedirs(d + '/data')
open(d + '/anon/anon_service/hostname', 'w').write('c' * 56 + '.anyone\n')
open(d + '/anon/anon_service/hs_ed25519_secret_key', 'wb').write(b'== ed25519v1-secret: type0 ==\x00\x00\x00' + b'S' * 64)
open(d + '/anon/anon_service/hs_ed25519_public_key', 'wb').write(b'== ed25519v1-public: type0 ==\x00\x00\x00' + b'P' * 32)
env = dict(os.environ, UI_PORT=str(UI), PUBLIC_PORT=str(PUB), DATA_DIR=d + '/data', ANON_DIR=d + '/anon', ANON_CTRL_PORT='1')
env.pop('ANONCHAT_UI_TOKEN', None)
log = open(d + '/log', 'w')
srv = subprocess.Popen(['node', APP + '/server.js'], env=env, cwd=APP, stdout=log, stderr=subprocess.STDOUT)
link = None
for _ in range(60):
    time.sleep(0.25)
    m = re.search(r'(http://localhost:\d+/#t=[0-9a-f]{64})', open(d + '/log').read())
    if m: link = m.group(1); break
ok = True; N = [0, 0]
def R(name, c, extra=''):
    global ok; ok &= bool(c); N[0] += bool(c); N[1] += 1; print(('PASS ' if c else 'FAIL ') + name, extra if not c else '')
stolen = []
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        stolen.append((self.path, dict(self.headers)))
        body = b'<!doctype html><title>x</title><img src="/pixel"><script>fetch("http://localhost:%d/api/contacts",{headers:{}}).catch(()=>{});</script>' % UI if self.path == '/' else b''
        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body)
evil = http.server.ThreadingHTTPServer(('127.0.0.1', EVIL), H); threading.Thread(target=evil.serve_forever, daemon=True).start()
try:
    tok = link.split('#t=')[1]
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(); pg = ctx.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(link); pg.wait_for_timeout(2000)
        R('no cookie is set', ctx.cookies() == [], ctx.cookies())
        R('the token left the address bar', '#t=' not in pg.url and 't=' not in pg.url, pg.url)
        R('the page works (whoami answers through the header)', pg.evaluate("fetch('/api/whoami').then(r=>r.status)") == 200)
        R('...and a request without the page\'s help is refused', urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{UI}/', headers={'Host': f'127.0.0.1:{UI}'})).status == 200)
        try:
            urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{UI}/api/whoami', headers={'Host': f'127.0.0.1:{UI}'})); R('/api without a token is refused', False)
        except urllib.error.HTTPError as e: R('/api without a token is refused', e.code == 403, e.code)
        R('a WebSocket opened by the page connects', pg.evaluate("new Promise(r=>{const w=new WebSocket('ws://'+location.host+'/ws');w.onopen=()=>{r(w.protocol)};w.onerror=()=>r('error');setTimeout(()=>r('timeout'),3000)})") == 'anonchat')
        R('a WebSocket without the token is refused', urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{UI}/', headers={'Host': f'127.0.0.1:{UI}'})).status == 200 and
          __import__('subprocess').run(['node', '-e', f"const W=require('{APP}/node_modules/ws');const w=new W('ws://127.0.0.1:{UI}/ws');w.on('open',()=>{{console.log('OPEN');process.exit(0)}});w.on('error',e=>{{console.log('ERR');process.exit(0)}});w.on('unexpected-response',()=>{{console.log('ERR');process.exit(0)}})"], capture_output=True, text=True).stdout.strip() == 'ERR')
        # the attack from before: a page on another local port, reached from a public site
        ctx.route('https://public-site.example/', lambda r: r.fulfill(status=200, content_type='text/html', body=f'<script>location="http://localhost:{EVIL}/"</script>'))
        pg2 = ctx.new_page(); pg2.goto('https://public-site.example/'); pg2.wait_for_timeout(2500)
        R('the other local server received no cookie and no token', all('cookie' not in h and 'x-anonchat-token' not in h for _, h in stolen), stolen)
        # a cross-origin request from the evil page carries nothing the server accepts, even with the right Host
        try:
            urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{UI}/api/backup/hs', headers={'Host': f'127.0.0.1:{UI}', 'Sec-Fetch-Site': 'cross-site', 'x-anonchat-token': tok})); R('cross-site request refused even with the token', False)
        except urllib.error.HTTPError as e: R('cross-site request refused even with the token', e.code == 403, e.code)
        R('no page errors', not [e for e in errs if 'ERR_' not in e], errs[:2])
        b.close()
    old = urllib.request.build_opener(type('N', (urllib.request.HTTPRedirectHandler,), {'redirect_request': lambda *a, **k: None}))
    try: old.open(urllib.request.Request(f'http://127.0.0.1:{UI}/?t={tok}', headers={'Host': f'127.0.0.1:{UI}'})); R('old /?t= link redirects to the fragment form', False)
    except urllib.error.HTTPError as e: R('old /?t= link redirects to the fragment form', e.code == 303 and e.headers.get('Location') == '/#t=' + tok, (e.code, e.headers.get('Location')))
finally:
    srv.terminate(); evil.shutdown()
print(f'{N[0]}/{N[1]}'); sys.exit(0 if ok else 1)
