// F-8: a packaged build refuses debugging switches and ignores ANONCHAT_DEBUG (desktop/debug-guard.js and its place in desktop/main.js).
import fs from 'node:fs'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { refusedSwitch, REFUSED } = require('../desktop/debug-guard.js');
let pass = 0, fail = 0; const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x ?? ''); } };

for (const s of ['--remote-debugging-port=9222', '--remote-debugging-port', '--remote-debugging-pipe', '--remote-allow-origins=*', '--inspect', '--inspect-brk=0.0.0.0:9229',
  '--js-flags=--allow-natives-syntax', '--renderer-cmd-prefix=/tmp/x', '--gpu-launcher=/tmp/x', '--load-extension=/tmp/e', '--proxy-server=socks5://1.2.3.4:1', '--host-rules=MAP * 1.2.3.4',
  '--disable-web-security', '--Remote-Debugging-Port=1'])
  ok(refusedSwitch(['--ozone-platform=x11', s]) !== null, 'refused: ' + s);
for (const s of ['--ozone-platform=x11', '--disable-gpu', '--no-sandbox', '--lang=de', '/home/me/file.txt', 'inspect', '-inspect'])
  ok(refusedSwitch([s]) === null, 'allowed: ' + s);
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
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
