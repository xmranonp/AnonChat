"""Command line for the browser suites: every argument is optional.
   python3 tests/browser/<suite>.py [APP] [NODE_PATH] [OUT]   (defaults: this project, none, a new temporary folder)"""
import os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
# Playwright's own Chromium, or the one preinstalled at /opt/pw-browsers (some CI images).
CHROME = '/opt/pw-browsers/chromium' if os.path.exists('/opt/pw-browsers/chromium') else None

def paths(script):
    name = os.path.splitext(os.path.basename(script))[0]
    app = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else os.path.abspath(os.path.join(HERE, '..', '..'))
    shim = sys.argv[2] if len(sys.argv) > 2 else ''
    out = sys.argv[3] if len(sys.argv) > 3 else tempfile.mkdtemp(prefix='anonchat-' + name + '-')
    os.makedirs(out, exist_ok=True)
    return app, shim, out

def out(script):
    """Audit tests take only the output folder."""
    name = os.path.splitext(os.path.basename(script))[0]
    o = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix='anonchat-' + name + '-')
    os.makedirs(o, exist_ok=True)
    return o
