// Tests for exit-country policy, saved network preferences and port selection.
import { createRequire } from 'node:module';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const ep = require('../lib/exitpolicy.js');
const prefs = require('../lib/netprefs.js');
const circuits = require('../lib/circuits.js');
const { choosePorts, isFree } = require('../lib/ports.js');

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : (failed++, console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};
const rejects = async (name, fn, code) => {
  let got = null; try { await fn(); } catch (e) { got = e.code || e.message; }
  eq(name, got, code);
};

const fp = (n) => n.toString(16).toUpperCase().padStart(40, '0');
const relay = (n, ip, flags) => ({ fingerprint: fp(n), ip, flags });
const EXIT = ['Exit', 'Fast', 'Running', 'Valid'];
const GEO = { '1.1.1.1': 'CH', '1.1.1.2': 'CH', '1.1.1.3': 'CH', '2.2.2.2': 'DE', '3.3.3.3': 'DE', '4.4.4.4': 'DE', '4.4.4.5': 'DE',
              '5.5.5.5': 'NL', '6.6.6.6': 'FR', '6.6.6.7': 'FR', '7.7.7.1': 'EU', '7.7.7.2': 'EU', '7.7.7.3': 'EU', '8.8.8.1': 'RU', '8.8.8.2': 'RU', '8.8.8.3': 'RU', '8.8.4.1': 'RS', '8.8.4.2': 'RS', '8.8.4.3': 'RS', '9.9.9.9': null };
const lookup = (ip) => GEO[ip] || null;
const isCountry = (cc) => cc !== 'EU';
const routers = [
  relay(1, '1.1.1.1', EXIT), relay(2, '1.1.1.2', EXIT), relay(12, '1.1.1.3', EXIT),
  relay(3, '2.2.2.2', EXIT), relay(4, '3.3.3.3', EXIT), relay(5, '4.4.4.4', EXIT), relay(13, '4.4.4.5', EXIT),
  relay(6, '5.5.5.5', [...EXIT, 'BadExit']),
  relay(7, '5.5.5.5', ['Guard', 'Fast', 'Running', 'Valid']),
  relay(8, '9.9.9.9', EXIT),
  relay(9, '1.1.1.1', ['Exit', 'Valid']),
  relay(14, '6.6.6.6', EXIT), relay(15, '6.6.6.7', EXIT),
  relay(16, '7.7.7.1', EXIT), relay(17, '7.7.7.2', EXIT), relay(18, '7.7.7.3', EXIT),
  relay(19, '8.8.8.1', EXIT), relay(20, '8.8.8.2', EXIT), relay(21, '8.8.8.3', EXIT),   // RU: plenty of exits, never offered
  relay(22, '8.8.4.1', EXIT), relay(23, '8.8.4.2', EXIT), relay(24, '8.8.4.3', EXIT),
];
eq('summary (everything)', ep.summarize(routers, lookup).map((c) => c.code), ['DE', 'CH', 'EU', 'RS', 'RU', 'FR']);
eq('summary hides small countries and non-countries', ep.summarize(routers, lookup, { minExits: ep.MIN_EXITS, isCountry }).map((c) => c.code), ['DE', 'CH', 'RS', 'RU']);
eq('minimum is three', ep.MIN_EXITS, 3);
eq('BadExit excluded', ep.isUsableExit(routers.find((r) => r.fingerprint === fp(6))), false);
eq('groupExits fingerprints', ep.groupExits(routers, lookup).get('CH'), [fp(1), fp(2), fp(12)]);
eq('reset command', ep.confCommand(null), 'SETCONF ExitNodes StrictNodes');
eq('country command', ep.confCommand('CH', [fp(1), fp(2)]), `SETCONF ExitNodes=$${fp(1)},$${fp(2)} StrictNodes=1`);
eq('empty country fails closed', ep.confCommand('CH', []), `SETCONF ExitNodes=$${ep.NO_RELAY} StrictNodes=1`);
eq('ok reply', ep.confOk('250 OK\r\n250 OK\r\n250 closing connection\r\n'), true);
eq('error reply', ep.confOk('250 OK\r\n552 Unrecognized option\r\n250 closing connection\r\n'), false);
eq('auth failed', ep.confOk('515 Authentication failed\r\n'), false);

const logged = [];
function makeService({ ready = true, boot = true, pct, ctrlReply = '250 OK\r\n250 OK\r\n250 closing connection\r\n', initial = {} } = {}) {
  const sent = []; let stored = { exitCountry: null, dynamicPort: true, ...initial };
  const svc = ep.createExitService({
    ctrl: async (c) => { sent.push(c); return c.startsWith('SIGNAL') ? '250 OK\r\n250 OK\r\n' : ctrlReply; },
    getRouters: async () => { sent.push('GETINFO ns/all'); return routers; }, lookup, isCountry, log: (m) => logged.push(m), ready: () => ready, bootstrapPct: async () => (pct !== undefined ? pct : boot ? 100 : 40),
    load: () => ({ ...stored }), save: (p) => { stored = { ...p }; },
  });
  return { svc, sent, stored: () => stored };
}
{
  const { svc, sent, stored } = makeService();
  eq('select CH', await svc.select('ch'), { ok: true, count: 3 });
  eq('commands sent', sent.filter((c) => c !== 'GETINFO ns/all'), [`SETCONF ExitNodes=$${fp(1)},$${fp(2)},$${fp(12)} StrictNodes=1`, 'SIGNAL NEWNYM']);
  eq('saved', stored().exitCountry, 'CH');
  eq('back to Global', (await svc.select(null)).ok, true);
  eq('reset sent', sent.filter((c) => c !== 'GETINFO ns/all')[2], 'SETCONF ExitNodes StrictNodes');
  eq('Global saved', stored().exitCountry, null);
  eq('countries()', (await svc.countries()).countries, [{ code: 'DE', count: 4 }, { code: 'CH', count: 3 }]);
  eq('total counts every usable exit', (await svc.countries()).total, 19);
}
{
  const { svc, stored } = makeService();
  await rejects('unknown country', () => svc.select('NL'), 'unknown_country');
  await rejects('country with fewer than 3 exits is not selectable', () => svc.select('FR'), 'unknown_country');
  await rejects('non-country code is not selectable', () => svc.select('EU'), 'unknown_country');
  await rejects('Russia is never selectable', () => svc.select('RU'), 'unknown_country');
  await rejects('Serbia is never selectable', () => svc.select('RS'), 'unknown_country');
  await rejects('invalid code', () => svc.select('X1'), 'unknown_country');
  eq('nothing saved on failure', stored().exitCountry, null);
}
{
  const { svc } = makeService({ ready: false });
  await rejects('db not ready', () => svc.select('CH'), 'not_ready');
  eq('countries empty until ready', (await svc.countries()).countries, []);
}
{
  const { svc, stored } = makeService({ ctrlReply: '250 OK\r\n552 nope\r\n' });
  await rejects('anon rejects', () => svc.select('CH'), 'ctrl_failed');
  eq('rejected choice not saved', stored().exitCountry, null);
}
{
  const { svc, sent } = makeService({ initial: { exitCountry: 'DE' } });
  await svc.reapply();
  eq('reapply sends saved choice', sent.find((c) => c.startsWith('SETCONF')), `SETCONF ExitNodes=$${fp(3)},$${fp(4)},$${fp(5)},$${fp(13)} StrictNodes=1`);
  eq('state applied', [svc.state.applied, svc.state.count], [true, 4]);
  const g = makeService();
  await g.svc.reapply();
  eq('reapply is a no-op for Global', g.sent, []);
  const gone = makeService({ initial: { exitCountry: 'NL' } });
  await gone.svc.reapply();
  eq('country without exits fails closed', gone.sent.find((c) => c.startsWith('SETCONF')), `SETCONF ExitNodes=$${ep.NO_RELAY} StrictNodes=1`);
  eq('flagged no_exits', gone.svc.state.error, 'no_exits');
}

{
  const offeredFn = (cc) => cc !== 'EU' && !ep.EXCLUDED_COUNTRIES.has(cc);
  const d = ep.describeRelays(routers, lookup, offeredFn, 3);
  eq('relays in the list', d.relays, routers.length);
  eq('Exit flag / BadExit / not Running / not Valid', [d.exitFlag, d.badExit, d.notRunning, d.notValid], [21, 1, 1, 0]);
  eq('usable', d.usable, 19);
  eq('where the usable exits are', [d.inOffered, d.inHidden, d.unknownCountry], [7, 11, 1]);
  eq('the pieces add up', d.inOffered + d.inHidden + d.unknownCountry, d.usable);
  const recs = [];
  const rec = ep.createExitService({ ctrl: async () => '250 OK\r\n250 OK\r\n', getRouters: async () => routers, lookup, isCountry, ready: () => true,
    bootstrapPct: async () => 100, load: () => ({ exitCountry: null }), save() {}, record: (e) => recs.push(e) });
  await rec.prepare();
  eq('history entry recorded', [recs.length, recs[0].usable, recs[0].exitFlag, recs[0].top[0].code, typeof recs[0].t], [1, 19, 21, 'DE', 'string']);
  const m = makeService(); await m.svc.prepare();
  const line = logged.find((l) => l.includes('consensus:'));
  eq('log explains the count', /21 with the Exit flag -> 19 usable/.test(line || ''), true);
}

{
  const { svc, sent, stored } = makeService({ initial: { exitCountry: 'RU' } });
  eq('RU/RS are not in the list', (await svc.countries()).countries.map((c) => c.code), ['DE', 'CH']);
  await svc.reapply();
  eq('saved Russia is reset to Global in anon', sent.find((c) => c.startsWith('SETCONF')), 'SETCONF ExitNodes StrictNodes');
  eq('and in the saved prefs', stored().exitCountry, null);
}

{
  const list = [
    { id: '1', purpose: 'GENERAL' }, { id: '2', purpose: 'CONFLUX_LINKED' }, { id: '3', purpose: 'HS_CLIENT_REND', hsState: 'HSCR_JOINED' },
    { id: '4', purpose: 'GUARD' }, { id: '5', purpose: 'CIRCUIT_PADDING' }, { id: '6', purpose: 'CONTROLLER' }, { id: '7', purpose: 'GENERAL', hsState: 'X' },
  ];
  eq('only exit-traffic circuits are selected', circuits.selectGeneralTraffic(list).map((c) => c.id), ['1', '2', '6']);
  const calls = [];
  const r = await circuits.renewGeneralCircuits({
    getCircuits: async () => list, extendCircuit: async () => { calls.push('extend'); return '90'; },
    closeCircuit: async (id) => { calls.push('close ' + id); return true; },
  });
  eq('renew result', r, { ok: true, id: '90', closed: 3 });
  eq('replacement starts before anything is closed', calls, ['extend', 'close 1', 'close 2', 'close 6']);
  const none = []; const f = await circuits.renewGeneralCircuits({ getCircuits: async () => list, extendCircuit: async () => null, closeCircuit: async (id) => { none.push(id); return true; } });
  eq('if the new circuit cannot start, nothing is closed', [f.ok, none], [false, []]);
  const g = await circuits.renewGeneralCircuits({ getCircuits: async () => list, extendCircuit: async () => '91',
    closeCircuit: async (id) => { if (id === '2') throw new Error('gone'); return true; } });
  eq('a circuit that is already gone does not stop the rest', [g.ok, g.closed], [true, 2]);
}

eq('parse bootstrap 100', ep.parseBootstrap('250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY="Done"\r\n250 OK'), 100);
eq('parse bootstrap 65', ep.parseBootstrap('250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=65 TAG=loading_descriptors'), 65);
eq('parse bootstrap garbage', ep.parseBootstrap('515 Authentication failed'), null);
{
  const { svc, sent, stored } = makeService({ boot: false, initial: { exitCountry: 'DE' } });
  await rejects('select while bootstrapping', () => svc.select('CH'), 'not_ready');
  await rejects('reset while bootstrapping', () => svc.select(null), 'not_ready');
  await rejects('reapply while bootstrapping', () => svc.reapply(), 'not_ready');
  eq('countries() empty while bootstrapping', (await svc.countries()).countries, []);
  eq('no control commands at all', sent, []);
  eq('saved choice untouched', stored().exitCountry, 'DE');
}

{
  const starting = makeService({ pct: 65 });
  eq('phase starting', (({ phase, progress, ready }) => ({ phase, progress, ready }))(await starting.svc.countries()), { phase: 'starting', progress: 65, ready: false });
  eq('phase starting reads no relay list', starting.sent, []);
  const unknown = makeService({ pct: null });
  eq('unknown progress is "starting"', (await unknown.svc.countries()).phase, 'starting');
  const nodb = makeService({ ready: false, pct: 100 });
  eq('phase database', (await nodb.svc.countries()).phase, 'database');
  const ok = makeService();
  eq('phase ready', (await ok.svc.countries()).phase, 'ready');
}
{
  const m = makeService();
  eq('prepare waits while bootstrapping', (await makeService({ boot: false }).svc.prepare()), false);
  eq('prepare builds the list', await m.svc.prepare(), true);
  await m.svc.countries(); await m.svc.select('CH'); await m.svc.select('DE'); await m.svc.reapply();
  eq('relay list requested once and cached', m.sent.filter((c) => c === 'GETINFO ns/all').length, 1);
}
{
  const m = makeService();
  await Promise.all([m.svc.countries(), m.svc.countries(), m.svc.prepare()]);
  eq('concurrent callers share one build', m.sent.filter((c) => c === 'GETINFO ns/all').length, 1);
}
{
  const big = []; for (let i = 0; i < 8000; i++) big.push({ fingerprint: fp(i + 100), ip: i % 2 ? '2.2.2.2' : '1.1.1.1', flags: EXIT });
  let ticks = 0; const t = setInterval(() => ticks++, 1);
  const t0 = Date.now(); const g = await ep.groupExitsAsync(big, lookup); clearInterval(t);
  eq('8000 relays grouped', [g.get('DE').length, g.get('CH').length], [4000, 4000]);
  eq('event loop stays responsive while grouping', ticks > 0 || Date.now() - t0 < 5, true);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netprefs-'));
eq('defaults', prefs.load(tmp), { exitCountry: null, dynamicPort: true });
prefs.save(tmp, { exitCountry: 'ch', dynamicPort: false });
eq('round trip', prefs.load(tmp), { exitCountry: 'CH', dynamicPort: false });
eq('garbage sanitized', prefs.sanitize({ exitCountry: 'Switzerland', dynamicPort: 'yes' }), { exitCountry: null, dynamicPort: true });
fs.writeFileSync(path.join(tmp, 'network.json'), '{ not json');
eq('corrupt file -> defaults', prefs.load(tmp), { exitCountry: null, dynamicPort: true });
fs.rmSync(tmp, { recursive: true, force: true });

const hold = (port) => new Promise((res) => { const s = net.createServer(); s.listen(port, '127.0.0.1', () => res(s)); });
const probe = await hold(0); const busy = probe.address().port;
eq('busy port is not free', await isFree(busy), false);
{
  const r = await choosePorts({ socksPref: busy, ctrlPref: 0 + busy + 0 });
  eq('moves when busy + dynamic', [r.socksMoved, r.socks !== busy, await isFree(r.socks)], [true, true, true]);
  eq('control port differs', r.ctrl !== r.socks && r.ctrl !== busy, true);
}
{
  const r = await choosePorts({ socksPref: busy, dynamic: false });
  eq('stays + flagged when dynamic is off', [r.socks, r.socksBlocked, r.socksMoved], [busy, true, false]);
}
{
  const free = await (async () => { const s = await hold(0); const p = s.address().port; await new Promise((r) => s.close(r)); return p; })();
  const r = await choosePorts({ socksPref: free, ctrlPref: free + 1 > 65000 ? 1025 : free + 1 });
  eq('keeps preferred port when free', [r.socks, r.socksMoved, r.socksBlocked], [free, false, false]);
}
await new Promise((r) => probe.close(r));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
