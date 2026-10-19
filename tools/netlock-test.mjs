// Tests that the SOCKS proxy setting can only be loopback with remote DNS.
import { createRequire } from 'node:module';
const { normalizeSocks } = createRequire(import.meta.url)('../lib/netlock.js');

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : (failed++, console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};
const throws = (name, fn) => { let t = false; try { fn(); } catch { t = true; } eq(name, t, true); };

eq('default', normalizeSocks('socks5h://127.0.0.1:9050'), 'socks5h://127.0.0.1:9050');
eq('socks5 upgraded to socks5h', normalizeSocks('socks5://127.0.0.1:9050'), 'socks5h://127.0.0.1:9050');
eq('localhost allowed', normalizeSocks('socks5h://localhost:9150'), 'socks5h://localhost:9150');
eq('default port', normalizeSocks('socks5h://127.0.0.1'), 'socks5h://127.0.0.1:9050');
throws('remote host rejected', () => normalizeSocks('socks5h://10.0.0.5:9050'));
throws('public host rejected', () => normalizeSocks('socks5h://proxy.example.com:1080'));
throws('http proxy rejected', () => normalizeSocks('http://127.0.0.1:8080'));
throws('garbage rejected', () => normalizeSocks('not a url'));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
