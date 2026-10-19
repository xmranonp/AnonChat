"""Hostile contact: a node serving huge or malformed profile data and keys. Nothing malformed is stored and the contact list still draws."""
import sys, os, time, json, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
from playwright.sync_api import sync_playwright
import sys as _sys, os as _os; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__))); import _args
OUT = _args.out(__file__)
pz, py = H.free_port(), H.free_port()
Z, Y = 'z' * 56 + '.anyone', 'y' * 56 + '.anyone'
ev = [subprocess.Popen(['node', os.path.dirname(os.path.abspath(__file__)) + '/evilpeer.mjs', str(pz), 'bigavatar']),
      subprocess.Popen(['node', os.path.dirname(os.path.abspath(__file__)) + '/evilpeer.mjs', str(py), 'objkeys'])]
net = H.Net(['ana'], extra_peers={Z: pz, Y: py})
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        ctx = b.new_context(viewport={'width': 1180, 'height': 780})
        ana = H.prep(ctx, net, 'ana'); H.login(ana)
        t0 = time.time(); H.add_contact(ana, 'Zed', Z, 4000)
        c = H.api(ana, '/api/contacts')
        z = [x for x in c['body'] if x['address'] == Z]
        H.check('a 7 MB avatar is dropped and a 300 KB status cut', z and not z[0].get('avatar') and len(z[0].get('bio') or '') <= 280, f"stored avatar {len(z[0].get('avatar') or '') if z else None} bytes, bio {len(z[0].get('bio') or '') if z else None}")
        t1 = time.time(); [H.api(ana, '/api/contacts') for _ in range(3)]; per = (time.time() - t1) / 3
        H.check('listing contacts stays fast with that contact', per < 0.3, f'{per:.2f} s per /api/contacts')
        H.add_contact(ana, 'Yan', Y, 4000)
        c = H.api(ana, '/api/contacts')
        y = [x for x in c['body'] if x['address'] == Y]
        H.check('a contact serving keys that are objects, not strings, is refused', not y, json.dumps(y)[:300])
        ana.reload(); ana.wait_for_selector('.pin-key'); H.pin(ana, 1); ana.wait_for_timeout(3000)
        H.check('the app still opens after adding both', ana.locator('#contacts .contact').count() >= 1, ana.locator('#contacts .contact').count())
        ana.screenshot(path=OUT + '/peer.png')
        bad = [e for e in H.errs if 'net::ERR' not in e and '502 (Bad Gateway)' not in e]   # the refused contact's 502 is expected
        H.check('no page errors', not bad, bad[:5])
        b.close()
finally:
    net.close(); [p.terminate() for p in ev]
H.summary()
