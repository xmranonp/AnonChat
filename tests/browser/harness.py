"""Shared audit harness: real server.js nodes (real Express/axios/socks-proxy-agent) behind a fake SOCKS proxy, real UIs in Chromium."""
import subprocess, os, sys, time, json, tempfile, socket
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fsocks
APP = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
TOKEN = 'f' * 64
def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
class Net:
    """apps: {name: app folder} for nodes that run another copy of the app (a modified, hostile client: see hostile_app)."""
    def __init__(self, names, extra_peers=None, env=None, apps=None):
        self.nodes = {}; self.procs = {}; self.apps = apps or {}
        letters = 'cbdghjkmn'
        for i, n in enumerate(names):
            self.nodes[n] = {'addr': letters[i] * 56 + '.anyone', 'ui': free_port(), 'pub': free_port()}
        peers = {v['addr']: v['pub'] for v in self.nodes.values()}
        peers.update(extra_peers or {})
        self.peers = peers
        self.hide_file = tempfile.mktemp(prefix='hidden-'); open(self.hide_file, 'w').write('[]')
        os.environ['FSOCKS_HIDE_FILE'] = self.hide_file
        fsocks.start(json.dumps(peers))
        self.env = env or {}
        for n in names: self.start(n)
        time.sleep(2)
    def start(self, n, fresh=False):
        v = self.nodes[n]
        if 'dir' not in v or fresh:
            d = tempfile.mkdtemp(prefix='aud-' + n + '-'); v['dir'] = d
            os.makedirs(d + '/anon/anon_service'); os.makedirs(d + '/data')
            open(d + '/anon/anon_service/hostname', 'w').write(v['addr'] + '\n')
        env = dict(os.environ, PUBLIC_PORT=str(v['pub']), UI_PORT=str(v['ui']), DATA_DIR=v['dir'] + '/data', ANON_DIR=v['dir'] + '/anon',
                   ANONCHAT_UI_TOKEN=TOKEN, ANON_CTRL_PORT='1')
        env.update(self.env)                 # a suite may override any of these (a fake control port, say)
        app = self.apps.get(n, APP)
        self.procs[n] = subprocess.Popen(['node', app + '/server.js'], env=env, cwd=app, stdout=open(v['dir'] + '/log', 'a'), stderr=subprocess.STDOUT)
    def hide(self, *names):
        """The network can't find these nodes' addresses ("descriptor not found") until hide() is called without names."""
        open(self.hide_file, 'w').write(json.dumps([self.nodes[n]['addr'] for n in names]))
    def stop(self, n):
        p = self.procs.pop(n, None)
        if p: p.terminate(); p.wait(10)
    def close(self):
        for n in list(self.procs): self.stop(n)
    def url(self, n): return f"http://127.0.0.1:{self.nodes[n]['ui']}/?t={TOKEN}"

def hostile_app():
    """A copy of the app whose window exposes its own send functions (window.__evil), standing in for a modified client that sends
    whatever it likes over a genuine encrypted session."""
    import shutil
    d = tempfile.mkdtemp(prefix='hostile-app-')
    for x in ('server.js', 'start.js', 'package.json', 'lib', 'public'):
        src = os.path.join(APP, x)
        (shutil.copytree if os.path.isdir(src) else shutil.copy)(src, os.path.join(d, x))
    if os.path.exists(os.path.join(APP, 'node_modules')): os.symlink(os.path.realpath(os.path.join(APP, 'node_modules')), os.path.join(d, 'node_modules'))
    with open(os.path.join(d, 'public', 'app.js'), 'a') as f:
        f.write("\nwindow.__evil = { deliver, deliverToGroup, encodeFrame, groupById, contactByAddress, loadThread };\n")
    return d

# A window whose clock can be moved forward: window.__skew (ms) is added to Date.now() and new Date() (add_init_script on its context).
SKEW_JS = """(() => { const RD = Date; const now = RD.now.bind(RD); window.__skew = 0;
  class D extends RD { constructor(...a) { if (a.length) super(...a); else super(now() + window.__skew); } static now() { return now() + window.__skew; } }
  window.Date = D; })();"""

def unlock(pg):
    pg.wait_for_selector('.pin-key', timeout=20000); pg.wait_for_timeout(300)
    pin(pg, 1)
    pg.wait_for_selector('#pin-screen.gone', state='attached', timeout=20000)

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else '  [' + str(detail)[:400] + ']'), flush=True)
def wait(pg, js, ms=20000):
    end = time.time() + ms / 1000
    while time.time() < end:
        try:
            v = pg.evaluate(js)
            if v: return v
        except Exception: pass
        time.sleep(0.25)
    return None
errs = []
def prep(ctx, net, n, tag=None):
    tag = tag or n
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append(tag + ': ' + str(e)))
    pg.on('console', lambda m: errs.append(tag + ' console: ' + m.text) if m.type == 'error' else None)
    pg.goto(net.url(n))
    return pg
def pin(pg, times, code='123456'):
    for _ in range(times):
        for dg in code: pg.click(f'.pin-key:text-is("{dg}")')
        pg.wait_for_timeout(300)
        if pg.is_visible('#pin-ok'):
            try: pg.click('#pin-ok', timeout=500)
            except Exception: pass
        pg.wait_for_timeout(500)
def login(pg):
    pg.wait_for_selector('.welcome-cta'); pg.wait_for_timeout(300)
    pg.click('.welcome-cta'); pin(pg, 2)
    pg.wait_for_selector('#pin-screen.gone', state='attached', timeout=15000)
def add_contact(pg, name, addr, wait_ms=1500):
    pg.click('#add-contact-btn'); pg.fill('#in-petname', name); pg.fill('#in-address', addr); pg.click('#add-confirm'); pg.wait_for_timeout(wait_ms)
def send(pg, text):
    pg.fill('#msg-input', text); pg.press('#msg-input', 'Enter'); pg.wait_for_timeout(600)
def open_contact(pg, name):
    pg.click(f'#contacts .contact:has-text("{name}")'); pg.wait_for_timeout(400)
def open_group(pg):
    pg.click('#groups .contact'); pg.wait_for_timeout(400)
def sees(pg, text, ms=40000):
    return wait(pg, f"[...document.querySelectorAll('#conv-body .bubble-text')].some(e => e.textContent.includes({json.dumps(text)}))", ms)
def api(pg, path, method='GET', body=None):
    return pg.evaluate("([p, m, b]) => fetch(p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))", [path, method, body])
def summary():
    print(f"{sum(1 for r in results if r[1])}/{len(results)} passed")
