// "Test connection" (lib/contacttest.js): how the results of the checks are read into a verdict. No network. Run: node tools/contacttest-test.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { summarize, readProbeError, clockSkew, SKEW_WARN_MS } = require('../lib/contacttest.js');
const { reasonFor } = require('../lib/deliverylog.js');

let passed = 0, failed = 0;
const ok = (n, c, d = '') => { if (c) { passed++; console.log('  ✓ ' + n); } else { failed++; console.log('  ✗ ' + n + (d ? '  [' + d + ']' : '')); } };

const own = { detail: 'reachable', introPoints: 6 };
const socks = (name) => new Error('Socks5 proxy rejected connection - ' + name);
const http = (status, error) => Object.assign(new Error('Request failed ' + status), { response: { status, data: { error } } });
const run = (probe, o = own, queue = { count: 0, lastStatus: null }, self = null) => summarize({ own: o, probe, queue, self });
const fail = (err, extra = {}) => ({ ok: false, error: readProbeError(err), ...extra });

console.log('1. Where it breaks');
ok('address not found on the network', run(fail(socks('HsDescNotFound'))).verdict === 'not-found');
ok('…and the lookup row fails, the route row is skipped over', (() => { const r = run(fail(socks('HsDescNotFound'))); return r.find.state === 'fail' && r.reach.state === 'fail'; })());
ok('address details unreadable counts as not found', run(fail(socks('HsDescInvalid'))).verdict === 'not-found');
ok('found, but the introduction timed out → unreachable', (() => { const r = run(fail(socks('HsIntroTimedOut'))); return r.verdict === 'unreachable' && r.find.state === 'ok'; })());
ok('found, but the route failed → unreachable', run(fail(socks('HsRendFailed'))).verdict === 'unreachable');
ok('no answer in time → unreachable, lookup unknown', (() => { const r = run(fail(Object.assign(new Error('timeout of 45000ms exceeded'), { code: 'ECONNABORTED' }))); return r.verdict === 'unreachable' && r.find.state === 'unknown'; })());
ok('their app answered with an error → refused', (() => { const r = run(fail(http(500, 'boom'))); return r.verdict === 'refused' && r.reach.state === 'refused' && r.reach.status === 500 && r.find.state === 'ok'; })());
ok('the network program is not running → network-down', run(fail(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9050'), { code: 'ECONNREFUSED' }))).verdict === 'network-down');
ok('the network is unreachable → network-down', run(fail(socks('NetworkUnreachable'))).verdict === 'network-down');

console.log('2. When it works');
ok('reached, clocks agree, nothing refused', run({ ok: true, skewMs: 4000 }).verdict === 'ok');
ok('reached, no clock reading (no Date header)', (() => { const r = run({ ok: true, skewMs: null }); return r.verdict === 'ok' && r.clock.state === 'unknown'; })());
ok('reached, waiting messages were refused earlier → ok-but-refused', run({ ok: true, skewMs: 0 }, own, { count: 2, lastStatus: 503 }).verdict === 'ok-but-refused');
ok('a rate limit (429) is not a refusal', run({ ok: true, skewMs: 0 }, own, { count: 2, lastStatus: 429 }).verdict === 'ok');
ok('clocks several minutes apart → clock', (() => { const r = run({ ok: true, skewMs: 7 * 60 * 1000 }); return r.verdict === 'clock' && r.clock.state === 'warn' && r.clock.skewSec === 420; })());
ok('a clock that is behind counts too', run({ ok: true, skewMs: -30 * 60 * 1000 }).verdict === 'clock');
ok('just under the limit is fine', run({ ok: true, skewMs: SKEW_WARN_MS - 1000 }).verdict === 'ok');
ok('they can be reached but our address is not published → own-not-published', run({ ok: true, skewMs: 0 }, { detail: 'not-published', introPoints: null }).verdict === 'own-not-published');
ok('our address still being published is not an error', (() => { const r = run({ ok: true, skewMs: 0 }, { detail: 'establishing' }); return r.verdict === 'ok' && r.own.state === 'wait'; })());
ok('the clock is read from an error answer too (refused, clocks apart)', run(fail(http(503, 'x'), { skewMs: 600000 })).clock.state === 'warn');

console.log('2b. Our own address can be found, or not (the self-test)');
const found = { state: 'findable' }, notFound = { state: 'not-findable' };
ok('they can be reached, our address is not found → own-not-findable', (() => { const r = run({ ok: true, skewMs: 0 }, own, undefined, notFound); return r.verdict === 'own-not-findable' && r.own.state === 'warn' && r.own.findable === 'no'; })());
ok('…findable: nothing to say', (() => { const r = run({ ok: true, skewMs: 0 }, own, undefined, found); return r.verdict === 'ok' && r.own.state === 'ok' && r.own.findable === 'yes'; })());
ok('…not looked at yet: nothing to say', run({ ok: true, skewMs: 0 }, own, undefined, { state: 'idle' }).own.findable === 'unknown');
ok('theirs not found and ours is not either → lookup-broken (the fault is here)', run(fail(socks('HsDescNotFound')), own, undefined, notFound).verdict === 'lookup-broken');
ok('theirs not found, ours is → not-found (the fault is theirs)', run(fail(socks('HsDescNotFound')), own, undefined, found).verdict === 'not-found');
ok('a clock difference still comes first', run({ ok: true, skewMs: 9e6 }, own, undefined, notFound).verdict === 'clock');
ok('our address not published beats not findable', run({ ok: true, skewMs: 0 }, { detail: 'not-published' }, undefined, notFound).verdict === 'own-not-published');
ok('the network down is the network down, whatever the self-test says', run(fail(socks('NetworkUnreachable')), own, undefined, notFound).verdict === 'network-down');

console.log('3. The parts');
ok('own: introduction points are passed on', run({ ok: true, skewMs: 0 }).own.introPoints === 6);
ok('own: unknown health does not throw', run({ ok: true, skewMs: 0 }, { detail: 'unknown' }).own.state === 'fail');
ok('queue: count and last answer are passed on', (() => { const q = run({ ok: true, skewMs: 0 }, own, { count: 3, lastStatus: 503 }).queue; return q.count === 3 && q.lastStatus === 503; })());
ok('queue: missing is zero', run({ ok: true, skewMs: 0 }, own, undefined).queue.count === 0);
ok('every verdict is one the window has a sentence for', (() => {
  const all = ['ok', 'ok-but-refused', 'clock', 'own-not-published', 'own-not-findable', 'lookup-broken', 'network-down', 'not-found', 'refused', 'unreachable'];
  const seen = new Set([
    run({ ok: true, skewMs: 0 }).verdict, run({ ok: true, skewMs: 0 }, own, { count: 1, lastStatus: 503 }).verdict, run({ ok: true, skewMs: 9e6 }).verdict,
    run({ ok: true, skewMs: 0 }, { detail: 'not-published' }).verdict, run(fail(socks('NetworkUnreachable'))).verdict, run(fail(socks('HsDescNotFound'))).verdict,
    run(fail(http(500))).verdict, run(fail(socks('HsIntroFailed'))).verdict,
    run({ ok: true, skewMs: 0 }, own, undefined, notFound).verdict, run(fail(socks('HsDescNotFound')), own, undefined, notFound).verdict,
  ]);
  return all.every((v) => seen.has(v)) && seen.size === all.length;
})());

console.log('4. Clock reading');
const sent = Date.UTC(2026, 9, 26, 12, 0, 0), got = sent + 2000;
ok('same time → about zero', Math.abs(clockSkew(new Date(sent + 1000).toUTCString(), sent, got)) <= 1000);
ok('ten minutes ahead → about +10 min', Math.abs(clockSkew(new Date(sent + 1000 + 600000).toUTCString(), sent, got) - 600000) <= 1000);
ok('no header → null', clockSkew(undefined, sent, got) === null);
ok('garbage header → null', clockSkew('not a date', sent, got) === null);
ok('a header that is not text → null', clockSkew(12345, sent, got) === null);
ok('reasonFor and readProbeError agree on the term', readProbeError(socks('HsDescNotFound')).term === reasonFor(socks('HsDescNotFound')).term);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
