// lib/ratelimit.js: stamped contacts and group members have their own, larger allowance; strangers keep the small one; Retry-After says
// how long until there is room again. Run: node tools/ratelimit-test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const rl = require('../lib/ratelimit.js');
const { TRUSTED_BURST, BURST } = rl._internals;
let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else fail++; console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  [' + detail + ']')); };
const burst = (key, n) => { let refused = null; for (let i = 0; i < n; i++) { const r = rl.classify(key); if (r && refused === null) refused = i; } return refused; };

ok('a stamped contact can send 12 messages in a second (12 photos)', burst({ ip: null, from: 'a.anyone', trusted: true }, 12) === null);
ok(`…and is limited only past ${TRUSTED_BURST} a second`, burst({ ip: null, from: 'b.anyone', trusted: true }, TRUSTED_BURST + 5) === TRUSTED_BURST);
ok(`a stranger is still limited after ${BURST} a second`, burst({ ip: '127.0.0.1', from: 'c.anyone' }, BURST + 2) === BURST);
const k = { ip: null, from: 'd.anyone', trusted: true };
burst(k, TRUSTED_BURST + 1);
const reason = rl.classify(k);
ok('a burst limit asks to retry after a second or two', reason === 'burst_trusted' && rl.retryAfter(reason, k) <= 2, reason + ' ' + rl.retryAfter(reason, k));
ok('the trusted allowance is separate from the stranger one for the same address', rl.classify({ ip: '127.0.0.2', from: 'a.anyone' }) === null);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
