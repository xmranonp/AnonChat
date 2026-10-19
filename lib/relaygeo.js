'use strict';

// Relay IP to globe coordinates, offline: libloc country lookup, then country centroid. The database is fetched once through the anon proxy.

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');

const CENTROIDS = require('./country-centroids.json');
const NAMES     = require('./country-names.json');

const SOCKS        = require('./netlock').normalizeSocks(process.env.SOCKS || 'socks5h://127.0.0.1:9050');
const DB_URL       = process.env.LIBLOC_DB_URL || 'https://location.ipfire.org/databases/1/location.db.xz';
const LOCATION_BIN = process.env.LOCATION_BINARY || 'location';
const GEO_DIR      = process.env.GEO_DIR
  || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'geo') : path.join(__dirname, '..', 'data', 'geo'));
const DB_PATH      = process.env.LIBLOC_DB_PATH || path.join(GEO_DIR, 'location.db');
const MAX_AGE_MS   = 24 * 60 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;     // the compressed download
const MAX_DB_BYTES       = 256 * 1024 * 1024;    // unpacked

function centroidFor(code) {
  if (!code) return null;
  return CENTROIDS[String(code).toUpperCase()] || null;
}

function parseCountryName(text) {
  if (!text) return null;
  const line = String(text).split('\n').find(l => /^\s*Country\b/i.test(l));
  if (!line) return null;
  const m = line.match(/:\s*(.+?)\s*$/);
  return m ? m[1].trim() : null;
}

const NAME_FALLBACK = {
  'united states':'US','united states of america':'US','germany':'DE','netherlands':'NL',
  'france':'FR','united kingdom':'GB','canada':'CA','russia':'RU','russian federation':'RU',
  'sweden':'SE','switzerland':'CH','finland':'FI','romania':'RO','austria':'AT','poland':'PL',
  'czechia':'CZ','czech republic':'CZ','luxembourg':'LU','japan':'JP','singapore':'SG',
  'australia':'AU','spain':'ES','italy':'IT','belgium':'BE','denmark':'DK','norway':'NO',
  'ireland':'IE','ukraine':'UA','bulgaria':'BG','hungary':'HU','greece':'GR','portugal':'PT',
  'lithuania':'LT','latvia':'LV','estonia':'EE','slovakia':'SK','slovenia':'SI','croatia':'HR',
  'moldova':'MD','iceland':'IS','hong kong':'HK','taiwan':'TW','south korea':'KR',
  'korea, republic of':'KR','india':'IN','brazil':'BR','indonesia':'ID','china':'CN',
  'south africa':'ZA','new zealand':'NZ','mexico':'MX','turkey':'TR','israel':'IL',
  'serbia':'RS','cyprus':'CY','malta':'MT','belarus':'BY','kazakhstan':'KZ','georgia':'GE',
  'armenia':'AM','thailand':'TH','vietnam':'VN','malaysia':'MY','philippines':'PH',
  'united arab emirates':'AE','saudi arabia':'SA','argentina':'AR','chile':'CL','colombia':'CO',
};

let _nameToCode = null;
function countryIndex() {
  if (_nameToCode) return _nameToCode;
  const idx = Object.assign({}, NAME_FALLBACK);
  try {
    const r = spawnSync(LOCATION_BIN, ['list-countries', '--show-name'], { encoding: 'utf8', timeout: 10000 });
    const out = (r.status === 0 && r.stdout) ? r.stdout : '';
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*([A-Za-z]{2})\b[\s:]+(.+?)\s*$/);
      if (m) idx[m[2].trim().toLowerCase()] = m[1].toUpperCase();
    }
  } catch {}
  _nameToCode = idx;
  return idx;
}

function nameToCode(name) {
  if (!name) return null;
  if (/^[A-Z]{2}$/.test(name)) return name;
  return countryIndex()[name.trim().toLowerCase()] || null;
}

const _ipCountryCache = new Map();
let _liblocDb = null, _liblocTried = false;
function jsDb() {
  if (!_liblocTried) {
    _liblocTried = true;
    try { _liblocDb = require('./libloc').Libloc.open(DB_PATH); }
    catch { _liblocDb = null; }
  }
  return _liblocDb;
}
function resetDb() { _liblocDb = null; _liblocTried = false; _ipCountryCache.clear(); }

function cliLookup(ip) {
  try {
    const r = spawnSync(LOCATION_BIN, ['--database', DB_PATH, 'lookup', ip], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0 && r.stdout) return nameToCode(parseCountryName(r.stdout));
  } catch {}
  return null;
}

function lookupCountry(ip) {
  if (!ip) return null;
  if (_ipCountryCache.has(ip)) return _ipCountryCache.get(ip);
  let code = null;
  const db = jsDb();
  if (db) { try { code = db.lookup(ip); } catch { code = null; } }
  else    { code = cliLookup(ip); }
  if (code) _ipCountryCache.set(ip, code);
  return code;
}

function resolveHops(hops) {
  const out = [];
  for (const h of (Array.isArray(hops) ? hops : [])) {
    if (!h) continue;
    const code = h.country || (h.ip ? lookupCountry(h.ip) : null);
    const c = centroidFor(code);
    if (!c) continue;                       // unknown country → skip (never plot at 0,0)
    out.push({
      lat: c.lat, lng: c.lng,
      nickname: h.nickname || '',
      country: code ? String(code).toUpperCase() : '',
      countryName: (code && NAMES[String(code).toUpperCase()]) || '',
      role: h.role || '',
      fingerprint: h.fingerprint || '',
    });
  }
  return spreadSameCountry(out);
}

// Relays in the same country share one centroid; spread them slightly so dots, labels and arcs stay distinguishable.
function spreadSameCountry(hops) {
  const byCountry = {};
  hops.forEach((h, i) => { (byCountry[h.country] = byCountry[h.country] || []).push(i); });
  const R = 2.6;
  for (const code in byCountry) {
    const idxs = byCountry[code];
    if (idxs.length < 2) continue;
    const base = hops[idxs[0]];
    const lngScale = 1 / Math.max(0.3, Math.cos(base.lat * Math.PI / 180));
    idxs.forEach((idx, k) => {
      const ang = (2 * Math.PI * k) / idxs.length;
      hops[idx] = {
        ...hops[idx],
        lat: +(base.lat + R * Math.sin(ang)).toFixed(3),
        lng: +(base.lng + R * Math.cos(ang) * lngScale).toFixed(3),
      };
    });
  }
  return hops;
}

function hopsFromCircuit(circuit) {
  const relays = (circuit && Array.isArray(circuit.relays)) ? circuit.relays : [];
  const n = relays.length;
  const isHS = /HS_/.test((circuit && circuit.purpose) || '') || !!(circuit && circuit.hsState);
  const roleFor = i => {
    if (n === 1) return 'relay';
    if (i === 0) return 'guard';
    if (i === n - 1) return isHS ? 'rendezvous' : 'exit';
    return 'relay';
  };
  const input = relays.map((r, i) => ({
    ip: r.ip,
    country: r.country,
    nickname: r.nickname,
    fingerprint: r.fingerprint,
    role: roleFor(i),
  }));
  return resolveHops(input);
}

function databaseReady() {
  try { return fs.statSync(DB_PATH).size > 0; } catch { return false; }
}
function databaseStale() {
  try {
    const age = Date.now() - fs.statSync(DB_PATH).mtimeMs;
    return age > MAX_AGE_MS;
  } catch { return true; }
}

// A download is written beside the copy in use (see updateDatabase) and moved into place only once it checks out. If the app stopped in
// between, that half-finished file stays behind: removed at start, before anything is downloaded again.
function cleanLeftovers() {
  const base = path.basename(DB_PATH);
  let names = [];
  try { names = fs.readdirSync(path.dirname(DB_PATH)); } catch { return 0; }
  let n = 0;
  for (const f of names) {
    if (f.startsWith(base + '.') && /^\.\d+\.new$/.test(f.slice(base.length))) { try { fs.unlinkSync(path.join(path.dirname(DB_PATH), f)); n++; } catch {} }
  }
  return n;
}
cleanLeftovers();

// Fails closed: the download only goes through the SOCKS proxy and never falls back to clearnet.
async function updateDatabase({ force = false } = {}) {
  if (!force && databaseReady() && !databaseStale()) return { updated: false, reason: 'fresh' };
  fs.mkdirSync(GEO_DIR, { recursive: true });

  // Its own route out of the network (see netlock.isolatedSocks); no redirects (only the address above is accepted, never one it points
  // to, which could even be unencrypted); and a size cap well above the real file (under 10 MB packed, about 40 MB unpacked in 2026), so
  // a broken or hostile answer can't fill memory. Anything refused leaves the copy already here in place.
  const agent = new SocksProxyAgent(require('./netlock').isolatedSocks(process.env.SOCKS || 'socks5h://127.0.0.1:9050', 'geo'));
  const resp = await axios.get(DB_URL, {
    httpsAgent: agent, httpAgent: agent, proxy: false, adapter: 'http',
    responseType: 'arraybuffer', timeout: 120000,
    maxRedirects: 0, maxContentLength: MAX_DOWNLOAD_BYTES,
    headers: { 'User-Agent': 'anonchat-relaygeo' },
  });

  const plain = require('./xz').decompressXz(Buffer.from(resp.data), { maxBytes: MAX_DB_BYTES });
  // Written beside the copy in use and checked there; only a file that passes replaces it (in one step), so a download that fails its
  // check, or is cut short, never costs the copy that works.
  const tmp = DB_PATH + '.' + process.pid + '.new';
  fs.writeFileSync(tmp, plain);

  // Verify the built-in signature with the location CLI when installed; the download itself is already TLS-authenticated.
  const ver = spawnSync(LOCATION_BIN, ['--database', tmp, 'verify'], { encoding: 'utf8', timeout: 15000 });
  if (ver.error && ver.error.code === 'ENOENT') {
    console.warn('[relaygeo] location CLI not installed — skipping signature verify (download was over TLS)');
  } else if (ver.status !== 0) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new Error('libloc signature verify failed');
  }
  // Without the CLI, at least the file must open as a location database.
  try { require('./libloc').Libloc.open(tmp); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw new Error('downloaded database does not open: ' + e.message); }
  fs.renameSync(tmp, DB_PATH);

  resetDb();
  return { updated: true, path: DB_PATH };
}

module.exports = {
  cleanLeftovers,
  centroidFor,
  countryIndex,
  lookupCountry,
  hopsFromCircuit,
  updateDatabase,
  databaseReady,
  databaseStale,
};
