"""Runs every browser suite one after another and prints a summary. Needs `npm install` in the project, and Playwright for Python
(`pip install playwright && playwright install chromium`).
   python3 tests/browser/run.py              all suites
   python3 tests/browser/run.py groups pin   only these"""
import os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
SUITES = ['circuits', 'emoji', 'firstpass', 'novault', 'security', 'backup', 'callnotice', 'groups', 'notify', 'pin', 'ring', 'storage',
          'audit_peer', 'audit_misc', 'audit_walk', 'audit_burst', 'audit_esc', 'audit_load',
          'audit2_groups', 'audit2_delivery', 'audit2_keys', 'audit2_waiting', 'audit2_groupwait', 'audit2_names',
          'audit2_removed', 'audit3_cross', 'audit3_deadpath', 'audit3_map', 'audit3_callaudio', 'audit4_fixes', 'audit5_groups', 'audit6_fixes', 'f1_auth', 'media_clean', 'connection_test', 'network_ready', 'spk_rotation']
pick = sys.argv[1:] or SUITES
failed = []
for name in pick:
    t0 = time.time()
    try:
        r = subprocess.run([sys.executable, os.path.join(HERE, name + '.py')], capture_output=True, text=True, timeout=1800)
        out = r.stdout + r.stderr
    except subprocess.TimeoutExpired:
        out = 'TIMEOUT'
    m = re.findall(r'^(\d+)/(\d+)(?: passed)?$', out, re.M)
    ok = bool(m) and m[-1][0] == m[-1][1] and 'Traceback' not in out
    fails = [l for l in out.splitlines() if l.startswith('FAIL ')]
    print(f"{'ok  ' if ok else 'FAIL'} {name:12} {m[-1][0] + '/' + m[-1][1] if m else 'no summary':>8}  {time.time() - t0:5.0f} s", flush=True)
    for l in fails[:5]: print('       ' + l[:160])
    if not ok:
        failed.append(name)
        if not fails: print('       ' + '\n       '.join(out.strip().splitlines()[-4:]))
print(('\nall suites passed' if not failed else '\nfailed: ' + ', '.join(failed)))
sys.exit(1 if failed else 0)
