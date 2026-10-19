'use strict';

// Exit-country selection: applies a strict list of exit-relay fingerprints to anon. Only traffic that leaves the network is affected.

const CC_RE = /^[A-Z]{2}$/;
const MIN_EXITS = 3;
// Never offered; a saved choice of one of these is reset to Global.
const EXCLUDED_COUNTRIES = new Set(['RU', 'RS']);
// A fingerprint no relay has: with StrictNodes on, clearnet streams fail instead of silently using another country.
const NO_RELAY = '0'.repeat(40);

const fail = (code, msg) => Object.assign(new Error(msg || code), { code });

function isUsableExit(r) {
  const f = (r && r.flags) || [];
  return f.includes('Exit') && f.includes('Running') && f.includes('Valid') && !f.includes('BadExit');
}

function groupExits(routers, lookup) {
  const m = new Map();
  for (const r of routers || []) {
    if (!isUsableExit(r) || !r.fingerprint) continue;
    const cc = String(lookup(r.ip) || '').toUpperCase();
    if (!CC_RE.test(cc)) continue;
    if (!m.has(cc)) m.set(cc, []);
    m.get(cc).push(r.fingerprint.toUpperCase());
  }
  return m;
}

const sortSummary = (groups, { minExits = 1, isCountry = () => true } = {}) => [...groups]
  .filter(([code, fps]) => fps.length >= minExits && isCountry(code))
  .map(([code, fps]) => ({ code, count: fps.length }))
  .sort((x, y) => y.count - x.count || x.code.localeCompare(y.code));

function summarize(routers, lookup, opts) { return sortSummary(groupExits(routers, lookup), opts); }

// Yields to the event loop every few hundred relays so a ~7000-relay list never blocks the server.
async function groupExitsAsync(routers, lookup) {
  const m = new Map();
  let n = 0;
  for (const r of routers || []) {
    if (++n % 250 === 0) await new Promise((res) => setImmediate(res));
    if (!isUsableExit(r) || !r.fingerprint) continue;
    const cc = String(lookup(r.ip) || '').toUpperCase();
    if (!CC_RE.test(cc)) continue;
    if (!m.has(cc)) m.set(cc, []);
    m.get(cc).push(r.fingerprint.toUpperCase());
  }
  return m;
}

function describeRelays(routers, lookup, offered = () => true, minExits = 1) {
  const d = { relays: 0, exitFlag: 0, badExit: 0, notRunning: 0, notValid: 0, usable: 0, inOffered: 0, inHidden: 0, unknownCountry: 0 };
  const per = new Map();
  for (const r of routers || []) {
    d.relays++;
    const f = r.flags || [];
    if (!f.includes('Exit')) continue;
    d.exitFlag++;
    if (f.includes('BadExit')) d.badExit++;
    if (!f.includes('Running')) d.notRunning++;
    if (!f.includes('Valid')) d.notValid++;
    if (!isUsableExit(r)) continue;
    d.usable++;
    const cc = String(lookup(r.ip) || '').toUpperCase();
    if (!CC_RE.test(cc)) { d.unknownCountry++; continue; }
    per.set(cc, (per.get(cc) || 0) + 1);
  }
  for (const [cc, n] of per) { if (n >= minExits && offered(cc)) d.inOffered += n; else d.inHidden += n; }
  return d;
}

function confCommand(code, fps) {
  if (!code) return 'SETCONF ExitNodes StrictNodes';
  const list = (fps && fps.length ? fps : [NO_RELAY]).map((f) => '$' + f).join(',');
  return `SETCONF ExitNodes=${list} StrictNodes=1`;
}

function parseBootstrap(raw) {
  const m = /PROGRESS=(\d+)/.exec(String(raw || ''));
  return m ? Number(m[1]) : null;
}

function confOk(raw) {
  const s = String(raw || '');
  return (s.match(/^250 OK/gm) || []).length >= 2 && !/^[45]\d\d[ -]/m.test(s);
}

// Stateful part, with every dependency injected for testing.
// Nothing is sent to anon, and no relay list is requested, until anon has finished bootstrapping: restricting exits while it still downloads descriptors can keep it from ever finishing.
function createExitService({ ctrl, getRouters, lookup, ready, load, save, bootstrapPct, log, record, isCountry = () => true, minExits = MIN_EXITS }) {
  const state = { applied: false, count: 0, error: null };
  const CACHE_TTL = 20 * 60 * 1000;
  const offered = (cc) => !EXCLUDED_COUNTRIES.has(cc) && isCountry(cc);
  let cache = null;
  let building = null;

  async function send(cmd) {
    const raw = await ctrl(cmd);
    if (!confOk(raw)) throw fail('ctrl_failed', 'anon rejected the exit setting');
  }

  async function progress() { try { return await bootstrapPct(); } catch { return null; } }
  async function usable() { return ready() && (await progress()) === 100; }

  async function build() {
    const t0 = Date.now();
    const routers = await getRouters();
    const groups = await groupExitsAsync(routers, lookup);
    const list = sortSummary(groups, { minExits, isCountry: offered });
    const total = routers.filter(isUsableExit).length;
    cache = { groups, list, total, ts: Date.now() };
    const stats = describeRelays(routers, lookup, offered, minExits);
    cache.stats = stats;
    if (record) { try { record({ t: new Date().toISOString(), ...stats, offeredCountries: list.length, top: list.slice(0, 6) }); } catch {} }
    if (log) {
      log(`[exit] consensus: ${stats.relays} relays, ${stats.exitFlag} with the Exit flag -> ${stats.usable} usable ` +
          `(BadExit ${stats.badExit}, not Running ${stats.notRunning}, not Valid ${stats.notValid})`);
      log(`[exit] country list ready: ${list.length} countries offered (${stats.inOffered} exits), ${stats.inHidden} exits in countries not offered, ` +
          `${stats.unknownCountry} with no country data, ${total} usable in total (${Date.now() - t0} ms)`);
    }
    return cache;
  }
  async function current() {
    if (cache && Date.now() - cache.ts < CACHE_TTL) return cache;
    if (!building) building = build().finally(() => { building = null; });
    return building;
  }

  async function exitsFor(code) {
    if (!(await usable())) throw fail('not_ready', 'anon is still starting up');
    return (await current()).groups.get(code) || [];
  }

  return {
    state,

    async prepare() {
      if (!(await usable())) return false;
      await current();
      return true;
    },

    async countries() {
      const prefs = load();
      const base = { selected: prefs.exitCountry, applied: state.applied, error: state.error, countries: [], total: 0 };
      const pct = await progress();
      if (pct !== 100) return { ...base, ready: false, phase: 'starting', progress: pct };
      if (!ready())    return { ...base, ready: false, phase: 'database', progress: pct };
      const c = await current();
      return { ...base, ready: true, phase: 'ready', progress: pct, countries: c.list, total: c.total, stats: c.stats };
    },

    // Applies first, then saves, so a failure leaves the previous choice in place.
    async select(code) {
      const cc = code ? String(code).toUpperCase() : null;
      if (cc && !CC_RE.test(cc)) throw fail('unknown_country');
      if (!(await usable())) throw fail('not_ready', 'anon is still starting up');
      let fps = [];
      if (cc) {
        const c = await current();
        if (!c.list.some((x) => x.code === cc)) throw fail('unknown_country', `${cc} is not offered`);
        fps = c.groups.get(cc);
      }
      await send(confCommand(cc, fps));
      await ctrl('SIGNAL NEWNYM');
      save({ ...load(), exitCountry: cc });
      Object.assign(state, { applied: true, count: fps.length, error: null });
      return { ok: true, count: fps.length };
    },

    // If the saved country has no exit right now, traffic pauses (fail closed) instead of leaving that country.
    async reapply() {
      const { exitCountry } = load();
      if (!exitCountry) { Object.assign(state, { applied: true, count: 0, error: null }); return; }
      if (EXCLUDED_COUNTRIES.has(exitCountry)) {
        if (!(await usable())) throw fail('not_ready', 'anon is still starting up');
        await send(confCommand(null));
        save({ ...load(), exitCountry: null });
        Object.assign(state, { applied: true, count: 0, error: null });
        return;
      }
      const fps = await exitsFor(exitCountry);
      await send(confCommand(exitCountry, fps));
      Object.assign(state, { applied: true, count: fps.length, error: fps.length ? null : 'no_exits' });
    },
  };
}

module.exports = { describeRelays, MIN_EXITS, EXCLUDED_COUNTRIES, NO_RELAY, isUsableExit, groupExits, groupExitsAsync, summarize, confCommand, confOk, parseBootstrap, createExitService };
