// F-8: a packaged build refuses debugging switches and ignores ANONCHAT_DEBUG (desktop/debug-guard.js and its place in desktop/main.js).
import fs from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { refusedSwitch, refusedParsedSwitch, REFUSED } = require('../desktop/debug-guard.js');
let pass = 0, fail = 0; const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x ?? ''); } };

for (const s of ['--remote-debugging-port=9222', '--remote-debugging-port', '--remote-debugging-pipe', '--remote-allow-origins=*', '--inspect', '--inspect-brk=0.0.0.0:9229',
  '--js-flags=--allow-natives-syntax', '--renderer-cmd-prefix=/tmp/x', '--gpu-launcher=/tmp/x', '--load-extension=/tmp/e', '--proxy-server=socks5://1.2.3.4:1', '--host-rules=MAP * 1.2.3.4',
  '--disable-web-security', '--Remote-Debugging-Port=1'])
  ok(refusedSwitch(['--ozone-platform=x11', s]) !== null, 'refused: ' + s);
// A-2: Chromium also reads one dash (and a slash on Windows).
for (const s of ['-remote-debugging-port=9222', '-remote-debugging-pipe', '-inspect', '-Remote-Debugging-Port=1', '-renderer-cmd-prefix=/tmp/x', '-proxy-server=socks5://1.2.3.4:1'])
  ok(refusedSwitch(['--ozone-platform=x11', s], 'linux') !== null, 'refused (one dash): ' + s);
for (const s of ['/remote-debugging-port=9222', '/inspect', '-remote-debugging-port=9222'])
  ok(refusedSwitch([s], 'win32') !== null, 'refused on Windows: ' + s);
for (const s of ['--ozone-platform=x11', '--disable-gpu', '--no-sandbox', '--lang=de', '/home/me/file.txt', 'inspect', '-', '-lang=de'])
  ok(refusedSwitch([s], 'linux') === null, 'allowed: ' + s);
ok(refusedSwitch(['C:\\Users\\me\\file.txt', '/home'], 'win32') === null, 'allowed on Windows: paths');
const cl = (set) => ({ hasSwitch: (n) => set.includes(n) });
ok(refusedParsedSwitch(cl(['remote-debugging-port'])) === 'remote-debugging-port', 'parsed check: debugging port seen by Chromium');
ok(refusedParsedSwitch(cl(['ozone-platform', 'no-sandbox'])) === null, 'parsed check: harmless switches pass');
ok(refusedParsedSwitch(cl(['allow-file-access-from-files'])) === null && refusedSwitch(['--allow-file-access-from-files']) !== null,
  'parsed check: the switch Electron adds itself (file:// fuse) is not mistaken for one given on the command line; given on it, it is refused');
ok(refusedParsedSwitch(undefined) === null && refusedParsedSwitch({}) === null, 'parsed check: odd input does not throw');
ok(refusedSwitch(['--', '--inspect']) === null, 'after "--" nothing is a switch');
ok(refusedSwitch(undefined) === null && refusedSwitch([1, null, {}]) === null, 'odd input does not throw');
ok(REFUSED.includes('remote-debugging-port') && REFUSED.includes('remote-debugging-pipe') && REFUSED.includes('inspect'), 'list has the main ones');

const main = fs.readFileSync(new URL('../desktop/main.js', import.meta.url), 'utf8');
const guardAt = main.indexOf("require('./debug-guard')"), wayland = main.indexOf('ANONCHAT_WAYLAND');
ok(guardAt > 0 && guardAt < wayland, 'main.js: the guard runs before the Wayland re-exec (which would pass the switches on)');
ok(!/ANONCHAT_DEBUG\s*===/.test(main), 'main.js: ANONCHAT_DEBUG no longer switches anything on');
ok(/delete process\.env\.ANONCHAT_DEBUG/.test(main) && /const DEBUG_UI = !app\.isPackaged/.test(main), 'main.js: debug tools only in an unpackaged run');
ok(!/openDevTools/.test(main.replace(/if \(DEBUG_UI\) \{[\s\S]*?openDevTools[\s\S]*?\}/, '')), 'main.js: DevTools only inside the DEBUG_UI block');
const pkg = JSON.parse(fs.readFileSync(new URL('../desktop/package.json', import.meta.url), 'utf8'));
ok(pkg.build.files.includes('debug-guard.js'), 'package.json: debug-guard.js is packaged');
ok(/refusedParsedSwitch\(app\.commandLine\)/.test(main), 'main.js: also checks what Chromium parsed');
const fz = pkg.build.electronFuses || {};
ok(fz.runAsNode === false && fz.enableNodeOptionsEnvironmentVariable === false && fz.enableNodeCliInspectArguments === false
  && fz.onlyLoadAppFromAsar === true && fz.enableEmbeddedAsarIntegrityValidation === true, 'package.json: fuses switch off RunAsNode, NODE_OPTIONS, --inspect; asar only, checked');
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
