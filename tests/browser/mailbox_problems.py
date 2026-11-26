"""The problems the app explains (1.1.0, mailbox): what the backend lists in /api/swarm/own (here faked with a route) is said in the
person's language as the window connects: several one after another, not over each other; each once a day (a reload doesn't say it
again; a "said" time from the future counts as not said); a clock off by the same amount at every peer is "your computer's clock",
at one peer it names that peer; one of several peers unreachable is only in Settings."""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness as H
import _args
from playwright.sync_api import sync_playwright
OUT = _args.out(__file__)
net = H.Net(['ana'])
P1 = 'p' * 56 + '.anyone'
PROBS = [{'code': 'clock-off-mine', 'minutes': 180}, {'code': 'clock-off', 'peer': P1, 'minutes': 12}, {'code': 'peer-unreachable', 'peer': P1, 'since': 0}]
def fake(route):
    route.fulfill(status=200, content_type='application/json', body=json.dumps({'peers': [], 'joinAllowed': False, 'seq': 0, 'problems': PROBS}))
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=_args.CHROME)
        c = b.new_context(viewport={'width': 1180, 'height': 820})
        c.route('**/api/swarm/own', fake)
        seen = []
        c.expose_function('noteToast', lambda s: seen.append(s))
        c.add_init_script("""document.addEventListener('DOMContentLoaded', () => { const n = document.getElementById('toast'); if (!n) return;
          new MutationObserver(() => { if (n.classList.contains('show')) window.noteToast(n.textContent); }).observe(n, { attributes: true, childList: true, characterData: true }); });""")
        pg = H.prep(c, net, 'ana'); H.login(pg)
        pg.evaluate("localStorage.removeItem('anyonechat.swarmProblemsTold')"); seen.clear()
        pg.reload(); H.unlock(pg)
        pg.wait_for_timeout(2500)
        first = pg.text_content('#toast')
        H.check('on connecting: the first problem is said', 'Your computer’s clock is off by about 3 hours' in first, first)
        pg.wait_for_timeout(10500)
        second = pg.text_content('#toast')
        H.check('…then the next, after it (not over it), naming the peer', 'mailbox peer' in second and '12' in second and 'pppp' in second, second)
        pg.wait_for_timeout(11500)
        uniq = sorted(set(seen))
        H.check('one of several peers unreachable: no notice', len(uniq) == 2, uniq)
        told = pg.evaluate("JSON.parse(localStorage.getItem('anyonechat.swarmProblemsTold') || '{}')")
        H.check('both kept as said today', len(told) == 2, told)
        seen.clear(); pg.reload(); H.unlock(pg); pg.wait_for_timeout(3000)
        H.check('a reload the same day: not said again', not pg.evaluate("document.getElementById('toast').classList.contains('show')") or 'clock' not in pg.text_content('#toast'))
        pg.evaluate("""(() => { const t = JSON.parse(localStorage.getItem('anyonechat.swarmProblemsTold')); for (const k in t) t[k] = Date.now() + 5 * 86400e3;
          localStorage.setItem('anyonechat.swarmProblemsTold', JSON.stringify(t)); })()""")
        pg.reload(); H.unlock(pg); pg.wait_for_timeout(2500)
        H.check('a "said" time in the future (clock set back): said again', 'clock' in pg.text_content('#toast'))
        pg.screenshot(path=OUT + '/problems-1.png')
        pg.evaluate("localStorage.setItem('anyonechat.lang', 'es'); localStorage.removeItem('anyonechat.swarmProblemsTold')")
        pg.reload(); H.unlock(pg); pg.wait_for_timeout(2500)
        H.check('in Spanish', 'reloj' in pg.text_content('#toast'), pg.text_content('#toast'))
        b.close()
finally:
    net.close()
bad = [e for e in H.errs if 'net::ERR' not in e and 'Failed to load' not in e and 'WebSocket' not in e]
H.check('no page errors', not bad, bad[:5])
H.summary()
