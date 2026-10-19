// Lockfiles match their package lists, so `npm ci` installs exactly what package.json asks for (root and desktop).
// Works offline: it only compares the files. Run: node tools/lockfile-test.mjs

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => { cond ? (passed++, console.log('  ✓ ' + name)) : (failed++, console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : ''))); };

// Enough semver for the ranges this project uses: exact, ^x.y.z, ~x.y.z.
const parse = (v) => String(v).replace(/^[\^~=v]/, '').split('-')[0].split('.').map(Number);
function satisfies(version, range) {
  const v = parse(version), r = parse(range);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); return 0; };
  if (/^\d/.test(range)) return cmp(v, r) === 0;
  if (cmp(v, r) < 0) return false;
  if (range.startsWith('~')) return v[0] === r[0] && v[1] === r[1];
  if (range.startsWith('^')) return r[0] > 0 ? v[0] === r[0] : r[1] > 0 ? v[0] === 0 && v[1] === r[1] : cmp(v, r) === 0;
  return false;
}

for (const dir of ['.', 'desktop']) {
  const label = dir === '.' ? 'root' : dir;
  console.log(label);
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, dir, 'package-lock.json'), 'utf8'));
  const wanted = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const top = lock.packages?.[''] || {};
  const locked = { ...(top.dependencies || {}), ...(top.devDependencies || {}) };
  const diff = Object.keys({ ...wanted, ...locked }).filter((k) => wanted[k] !== locked[k]);
  ok(`${label}: the lockfile records the same package list`, diff.length === 0, diff.map((k) => `${k}: ${wanted[k]} vs ${locked[k]}`).join(', '));
  const bad = Object.entries(wanted).filter(([name, range]) => !satisfies(lock.packages?.['node_modules/' + name]?.version, range));
  ok(`${label}: every locked version fits package.json`, bad.length === 0,
    bad.map(([n, r]) => `${n} wants ${r}, locked ${lock.packages?.['node_modules/' + n]?.version}`).join(', '));
  const noHash = Object.entries(lock.packages || {}).filter(([k, p]) => k && !p.link && p.resolved && !/^sha512-/.test(p.integrity || ''));
  ok(`${label}: every downloaded package has a sha512 checksum`, noHash.length === 0, noHash.slice(0, 3).map(([k]) => k).join(', '));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
