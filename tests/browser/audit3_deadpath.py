"""Third pass: a dead route to one contact. When a try to a contact fails, the app closes the route (circuit) the last try to them used,
so the next try builds a fresh one: what "Rebuild network path" does by hand. Looking their address up again is rare (every 5 minutes:
the network won't ask the same directory twice in 15 minutes). When they come back online, their app tells us (a profile bump), and
while our messages to them are failing the network's stale lookups are cleared (NEWNYM) and the waiting messages go, without them
writing first. A fake Anyone control port records the commands."""
import sys, os, json, time, socket, threading
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
CMDS = []
def fake_ctrl(srv, bob_addr):
    def serve(c):
        buf = b''
        try:
            while True:
                d = c.recv(4096)
                if not d: return
                buf += d
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1); line = line.decode().strip()
                    if not line: continue
                    CMDS.append(line)
                    if line.startswith('SETEVENTS STREAM'):
                        c.sendall(b'250 OK\r\n')
                        # the last stream to Bob went out on circuit 77
                        c.sendall(f'650 STREAM 5 SENTCONNECT 77 {bob_addr}:80\r\n'.encode())
                    elif line == 'QUIT': c.sendall(b'250 closing connection\r\n'); c.close(); return
                    else: c.sendall(b'250 OK\r\n')
        except Exception: pass
    while True:
        c, _ = srv.accept(); threading.Thread(target=serve, args=(c,), daemon=True).start()
srv = socket.socket(); srv.bind(('127.0.0.1', 0)); srv.listen(20); CTRL = srv.getsockname()[1]
net = H.Net(['ana', 'bob'], env={'RL_BURST': '1000', 'RL_PER_MIN': '10000', 'ANNOUNCE_MAX_WAIT_MS': '1000', 'ANNOUNCE_SETTLE_MS': '500'})
A = {n: net.nodes[n]['addr'] for n in net.nodes}
threading.Thread(target=fake_ctrl, args=(srv, A['bob']), daemon=True).start()
# Ana's backend talks to the fake control port: restart her with it and a cookie
net.stop('ana'); open(net.nodes['ana']['dir'] + '/anon/control_auth_cookie', 'wb').write(b'\x01' * 32)
net.env = dict(net.env, ANON_CTRL_PORT=str(CTRL)); net.start('ana'); time.sleep(2)
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ana = H.prep(b.new_context(viewport={'width': 1180, 'height': 780}), net, 'ana'); bob = H.prep(b.new_context(viewport={'width': 1180, 'height': 780}), net, 'bob')
        H.login(ana); H.login(bob)
        H.add_contact(ana, 'Bob', A['bob']); H.add_contact(bob, 'Ana', A['ana'])
        H.open_contact(ana, 'Bob'); H.send(ana, 'hello'); H.open_contact(bob, 'Ana'); H.check('Bob gets Ana’s message', H.sees(bob, 'hello'))
        H.check('the route to Bob is closed only when a try fails, not after it worked', not any(c.startswith('CLOSECIRCUIT') for c in CMDS), [c for c in CMDS if 'CIRC' in c])
        net.stop('bob')
        H.send(ana, 'are you there')
        closed = H.wait(ana, "true", 1) and None
        end = time.time() + 60
        while time.time() < end and not any(c == 'CLOSECIRCUIT 77' for c in CMDS): time.sleep(0.5)
        H.check('a failed try to Bob closes the route the last try to him used', 'CLOSECIRCUIT 77' in CMDS, [c for c in CMDS if 'CIRC' in c or 'HSFETCH' in c])
        H.check('…and asks for his address to be looked up again', any(c.startswith('HSFETCH ' + A['bob'].replace('.anyone', '')) for c in CMDS))
        n = sum(1 for c in CMDS if c.startswith('CLOSECIRCUIT'))
        H.send(ana, 'still there'); time.sleep(20)
        H.check('…at most once a minute per contact', sum(1 for c in CMDS if c.startswith('CLOSECIRCUIT')) == n, [c for c in CMDS if 'CIRC' in c])
        H.check('his address is looked up again only once, not after every failed try', sum(1 for c in CMDS if c.startswith('HSFETCH')) == 1, [c for c in CMDS if 'HSFETCH' in c])
        H.check('no NEWNYM while he is simply away', 'SIGNAL NEWNYM' not in CMDS)
        net.start('bob'); time.sleep(2); bob.goto(net.url('bob')); H.unlock(bob); H.open_contact(bob, 'Ana')
        end = time.time() + 15
        while time.time() < end and 'SIGNAL NEWNYM' not in CMDS: time.sleep(0.3)
        H.check('Bob comes back without writing: his app tells Ana’s, and her stale lookups are cleared', 'SIGNAL NEWNYM' in CMDS, [c for c in CMDS if 'NEWNYM' in c])
        H.check('…and the waiting messages arrive', H.sees(bob, 'are you there', 60000) and H.sees(bob, 'still there', 60000))
        n = sum(1 for c in CMDS if c == 'SIGNAL NEWNYM')
        time.sleep(11)   # the network takes NEWNYM at most every 10 s
        ana.click('.head-more'); ana.wait_for_timeout(300); ana.click('#ctx-menu .ctx-item:has-text("Rebuild network path")'); time.sleep(2)
        H.check('"Rebuild network path" clears them too', sum(1 for c in CMDS if c == 'SIGNAL NEWNYM') == n + 1, [c for c in CMDS if 'NEWNYM' in c])
        b.close()
finally:
    net.close()
bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
H.check('no page errors', not bad, bad[:5])
H.summary()
