// Runs every project check: syntax, crypto interop, i18n parity, CSS balance and the unit tests.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const pass = m => console.log('  \x1b[32m✓\x1b[0m ' + m);
const fail = m => { failures++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m'); };

console.log('\n1. Syntax');
const cjs = ['server.js', 'start.js', 'desktop/main.js', 'desktop/keystore.js', 'desktop/filename.js', 'desktop/preload.js',
             'desktop/preload-splash.js', ...readdirSync(join(root, 'lib'))
               .filter(f => f.endsWith('.js')).map(f => 'lib/' + f)];
for (const f of cjs) {
  try { execFileSync('node', ['--check', join(root, f)], { stdio: 'pipe' }); pass(f); }
  catch (e) { fail(f + ' — ' + (e.stderr?.toString().split('\n')[0] || e.message)); }
}
const esmDir = mkdtempSync(join(tmpdir(), 'syn-'));
for (const f of readdirSync(join(root, 'public')).filter(f => f.endsWith('.js'))) {
  const tmp = join(esmDir, f + '.mjs');
  writeFileSync(tmp, readFileSync(join(root, 'public', f)));
  try { execFileSync('node', ['--check', tmp], { stdio: 'pipe' }); pass('public/' + f); }
  catch (e) { fail('public/' + f + ' — ' + (e.stderr?.toString().split('\n')[0] || e.message)); }
}

console.log('\n2. Crypto interop (Double Ratchet + X3DH)');
try {
  const out = execFileSync('node', [join(root, 'tools/crypto-interop-test.mjs')], { stdio: 'pipe' }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`interop ${m[1]}/${m[1]}`) : fail('interop: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('interop threw — ' + (e.stdout?.toString().match(/\d+ passed, \d+ failed/) || e.message)); }

console.log('\n3. i18n parity');
try {
  const s = readFileSync(join(root, 'public/i18n.js'), 'utf8');
  const a = s.indexOf('const STRINGS = ') + 'const STRINGS = '.length;
  const b = s.indexOf('\n};\n', a) + 2;
  const T = new Function('return ' + s.slice(a, b))();
  const langs = Object.keys(T);
  const en = Object.keys(T.en);
  const ph = (v) => [...new Set(String(v).match(/\{\w+\}/g) || [])].sort().join(',');
  const problems = [];
  for (const l of langs) {
    const keys = Object.keys(T[l]);
    const missing = en.filter((k) => !(k in T[l])), extra = keys.filter((k) => !(k in T.en));
    if (missing.length) problems.push(`${l}: missing ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`);
    if (extra.length) problems.push(`${l}: extra ${extra.slice(0, 3).join(', ')}`);
    for (const k of en) if (k in T[l] && ph(T[l][k]) !== ph(T.en[k])) problems.push(`${l}: placeholders differ in ${k}`);
  }
  problems.length
    ? fail('i18n: ' + problems.slice(0, 4).join(' | '))
    : pass(`all ${langs.length} languages (${langs.join(', ')}) have the same ${en.length} keys and placeholders`);
} catch (e) { fail('i18n check threw — ' + e.message); }

// The start screen (desktop/splash/index.html) has its own small table: same languages, keys and placeholders.
try {
  const s = readFileSync(join(root, 'desktop/splash/index.html'), 'utf8');
  const a = s.indexOf('const T = {') + 'const T = '.length, b = s.indexOf('\n  };', a) + 4;
  const T = new Function('return ' + s.slice(a, b))();
  const keys = Object.keys(T.en), ph = (v) => (String(v).match(/\{\w+\}/g) || []).sort().join(',');
  const bad = [];
  for (const [l, tab] of Object.entries(T)) for (const k of keys) {
    if (!(k in tab)) bad.push(`${l}: missing ${k}`); else if (ph(tab[k]) !== ph(T.en[k])) bad.push(`${l}: placeholders differ in ${k}`);
  }
  bad.length ? fail('start screen i18n: ' + bad.slice(0, 4).join(' | ')) : pass(`start screen: ${Object.keys(T).length} languages with the same ${keys.length} keys`);
} catch (e) { fail('start screen i18n check threw — ' + e.message); }

console.log('\n4. CSS brace balance');
try {
  const css = readFileSync(join(root, 'public/styles.css'), 'utf8');
  const o = (css.match(/{/g) || []).length, c = (css.match(/}/g) || []).length;
  o === c ? pass(`balanced (${o}/${c})`) : fail(`UNBALANCED (${o}/${c})`);
} catch (e) { fail('css check threw — ' + e.message); }

console.log('\n5. Update checker');
try {
  const out = execFileSync('node', [join(root, 'tools/updater-test.mjs')], { stdio: 'pipe' }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`updater ${m[1]}/${m[1]}`) : fail('updater: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('updater threw — ' + (e.stdout?.toString().match(/FAIL .*/g)?.[0] || e.message)); }

console.log('\n6. Network lock');
try {
  const out = execFileSync('node', [join(root, 'tools/netlock-test.mjs')], { stdio: 'pipe' }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`netlock ${m[1]}/${m[1]}`) : fail('netlock: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('netlock threw — ' + (e.stdout?.toString().match(/FAIL .*/g)?.[0] || e.message)); }

console.log('\n7. Process shutdown');
try {
  const out = execFileSync('node', [join(root, 'tools/proctree-test.mjs')], { stdio: 'pipe' }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(out.includes('skipped') ? 'proctree (skipped on this OS)' : `proctree ${m[1]}/${m[1]}`) : fail('proctree: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('proctree threw — ' + (e.stdout?.toString().match(/FAIL .*/g)?.[0] || e.message)); }

console.log('\n8. Exit country & ports');
try {
  const out = execFileSync('node', [join(root, 'tools/network-test.mjs')], { stdio: 'pipe' }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`network ${m[1]}/${m[1]}`) : fail('network: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('network threw — ' + (e.stdout?.toString().match(/FAIL .*/g)?.[0] || e.message)); }

console.log('\n9. Country flags');
try {
  const codes = Object.keys(JSON.parse(readFileSync(join(root, 'lib/country-centroids.json'), 'utf8'))).filter((k) => /^[A-Z]{2}$/.test(k));
  const missing = codes.filter((k) => { try { readFileSync(join(root, 'public/flags', k + '.png')); return false; } catch { return true; } });
  missing.length ? fail('flags missing for: ' + missing.join(' ')) : pass(`flag image for all ${codes.length} countries`);
} catch (e) { fail('flag check threw - ' + e.message); }

console.log('\n10. Emoji set');
try {
  const tmp = join(tmpdir(), `anonchat-emoji-${process.pid}.mjs`);
  writeFileSync(tmp, readFileSync(join(root, 'public/emoji-data.js')));
  const { EMOJI_CATEGORIES, EMOJI_TONES, REACTION_PRESETS, EMOJI_IDS, emojiToCodepoint, emojiSrc } = await import(pathToFileURL(tmp).href);
  unlinkSync(tmp);
  const all = [...EMOJI_CATEGORIES.flatMap((c) => c.emojis), ...Object.values(EMOJI_TONES).flat()];
  const problems = [];
  if (new Set(all).size !== all.length) problems.push('an emoji is listed twice');
  const empty = EMOJI_CATEGORIES.filter((c) => !c.emojis.length).map((c) => c.id); if (empty.length) problems.push('empty category ' + empty.join(' '));
  const noImage = all.filter((e) => !existsSync(join(root, 'public', emojiSrc(e).split('?')[0]))); if (noImage.length) problems.push(`no image for ${noImage.length}: ` + noImage.slice(0, 4).join(' '));
  const used = new Set(all.filter((e) => emojiSrc(e).startsWith('emoji/')).map((e) => emojiToCodepoint(e).toUpperCase()));
  const stray = readdirSync(join(root, 'public/emoji')).map((f) => f.replace(/\.png$/i, '').toUpperCase()).filter((id) => !used.has(id)); if (stray.length) problems.push('image not in the set: ' + stray.slice(0, 4).join(' '));
  const usedFlags = new Set(all.filter((e) => emojiSrc(e).startsWith('flags/')).map((e) => emojiSrc(e).split('?')[0].slice(6)));
  const strayFlags = readdirSync(join(root, 'public/flags')).filter((f) => !usedFlags.has(f)); if (strayFlags.length) problems.push('flag image not in the picker: ' + strayFlags.slice(0, 4).join(' '));
  const flat = new Set(EMOJI_CATEGORIES.flatMap((c) => c.emojis));
  const outside = REACTION_PRESETS.filter((e) => !flat.has(e)); if (outside.length) problems.push('reaction not in the set: ' + outside.join(' '));
  const badIcon = EMOJI_CATEGORIES.filter((c) => !c.emojis.includes(c.icon)).map((c) => c.id); if (badIcon.length) problems.push('tab icon not in its category: ' + badIcon.join(' '));
  const badTone = Object.entries(EMOJI_TONES).filter(([b, v]) => !flat.has(b) || v.length !== 5).map(([b]) => b); if (badTone.length) problems.push('skin-tone list is wrong for ' + badTone.slice(0, 4).join(' '));
  const i18n = readFileSync(join(root, 'public/i18n.js'), 'utf8');
  const noLabel = EMOJI_CATEGORIES.filter((c) => !i18n.includes(`'${c.labelKey}'`)).map((c) => c.id); if (noLabel.length) problems.push('no translation for the category ' + noLabel.join(' '));
  if (EMOJI_IDS.size < all.length) problems.push('EMOJI_IDS is missing entries');
  problems.length ? fail('emoji set: ' + problems.join('; ')) : pass(`${flat.size} emoji in ${EMOJI_CATEGORIES.length} categories + ${Object.keys(EMOJI_TONES).length} with skin tones; every one has an image, none left over`);
} catch (e) { fail('emoji check threw - ' + e.message); }

console.log('\n11. Contact circuit');
try {
  const out = execFileSync('node', [join(root, 'tools/circuit-test.mjs')], { stdio: 'pipe' }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`circuit ${m[1]}/${m[1]}`) : fail('circuit: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('circuit threw — ' + (e.stdout?.toString().match(/FAIL .*/g)?.[0] || e.message)); }

console.log('\n12. Voice-call crypto');
try {
  const out = execFileSync('node', [join(root, 'tools/call-crypto-test.mjs')], { stdio: 'pipe' }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`call crypto ${m[1]}/${m[1]}`) : fail('call crypto: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('call crypto threw — ' + (e.stdout?.toString().match(/FAIL .*/g)?.[0] || e.message.split('\n')[0])); }

console.log('\n13. Voice-call transport (needs `npm install`)');
try {
  const out = execFileSync('node', [join(root, 'tools/call-test.mjs')], { stdio: 'pipe' }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`call transport ${m[1]}/${m[1]}`) : fail('call transport: ' + (m ? m[0] : 'no summary'));
} catch (e) {
  const msg = (e.stderr?.toString() || '') + (e.stdout?.toString() || '');
  if (/Cannot find module '(ws|socks-proxy-agent)'/.test(msg)) console.log('  \x1b[33m- skipped: dependencies are not installed (run npm install)\x1b[0m');
  else fail('call transport threw — ' + (msg.match(/FAIL .*/g)?.[0] || e.message.split('\n')[0]));
}

console.log('\n14. Voice calls never leave the Anyone network');
try {
  const out = execFileSync('node', [join(root, 'tools/call-leak-check.mjs')], { stdio: 'pipe' }).toString().trim();
  pass(out);
} catch (e) { fail('clearnet leak check — ' + ((e.stdout?.toString().match(/FAIL .*/g) || [e.message]).join(' | '))); }

console.log('\n15. Contacts cannot be impersonated; message requests (identity-key pin)');
try {
  const out = execFileSync('node', [join(root, 'tools/identity-pin-test.mjs')], { stdio: 'pipe' }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`identity pin ${m[1]}/${m[1]}`) : fail('identity pin: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('identity pin — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.message.split('\n')[0]]).join(' | '))); }

console.log('\n16. Group members who aren\u2019t contacts: inbox allowance and key fetching (needs `npm install`)');
try {
  const out = execFileSync('node', [join(root, 'tools/group-allowance-test.mjs')], { stdio: 'pipe', timeout: 240000 }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`group allowance ${m[1]}/${m[1]}`) : fail('group allowance: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('group allowance — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.stderr?.toString().match(/^\w*Error\b.*$/m)?.[0] || e.message.split('\n')[0]]).join(' | '))); }

console.log('\n17. Saved data: encrypted at rest, never read as empty, planted or swapped files refused, one file per waiting message');
try {
  const out = execFileSync('node', [join(root, 'tools/store-test.mjs')], { stdio: 'pipe', timeout: 240000 }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`store ${m[1]}/${m[1]}`) : fail('store: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('store — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.message.split('\n')[0]]).join(' | '))); }

console.log('\n18. Inbox limits: proof of work only in a flood, forged addresses ignored, full inbox = retry later (needs `npm install`)');
try {
  const out = execFileSync('node', [join(root, 'tools/inbox-limits-test.mjs')], { stdio: 'pipe', timeout: 240000 }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`inbox limits ${m[1]}/${m[1]}`) : fail('inbox limits: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('inbox limits — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.stderr?.toString().match(/^\w*Error\b.*$/m)?.[0] || e.message.split('\n')[0]]).join(' | '))); }

console.log('\n19. Data key: OS vault or passphrase, switching without re-keying, damaged keystore never replaced');
try {
  const out = execFileSync('node', [join(root, 'tools/keystore-test.mjs')], { stdio: 'pipe', timeout: 120000 }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`keystore ${m[1]}/${m[1]}`) : fail('keystore: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('keystore — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.message.split('\n')[0]]).join(' | '))); }

console.log('\n20. Message stamps: only real contacts get a contact’s allowance; one-time keys handed out sparingly (needs `npm install`)');
try {
  const out = execFileSync('node', [join(root, 'tools/stamp-test.mjs')], { stdio: 'pipe', timeout: 240000 }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`stamps and one-time keys ${m[1]}/${m[1]}`) : fail('stamps: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('stamps — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.message.split('\n')[0]]).join(' | '))); }

console.log('\n21. Lockfiles match package.json (root and desktop)');
try {
  const out = execFileSync('node', [join(root, 'tools/lockfile-test.mjs')], { stdio: 'pipe' }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`lockfiles ${m[1]}/${m[1]}`) : fail('lockfiles: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('lockfiles — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.message.split('\n')[0]]).join(' | '))); }

console.log('\n22. Offline queue: every message saved before its first try, kept in order per contact; what each answer does');
try {
  const out = execFileSync('node', [join(root, 'tools/outbox-test.mjs')], { stdio: 'pipe', timeout: 30000 }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`offline queue ${m[1]}/${m[1]}`) : fail('offline queue: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('offline queue — ' + ((e.stdout?.toString().match(/FAIL .*/g) || [e.message.split('\n')[0]]).join(' | '))); }

console.log('\n23. Identity backups: the file format and restoring on a fresh install (needs `npm install`)');
try {
  const out = execFileSync('node', [join(root, 'tools/backup-test.mjs')], { stdio: 'pipe', timeout: 120000 }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`backups ${m[1]}/${m[1]}`) : fail('backups: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('backups — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.message.split('\n')[0]]).join(' | '))); }

console.log('\n24. Error answers never show a stack trace or a file path (needs `npm install`)');
try {
  const out = execFileSync('node', [join(root, 'tools/error-page-test.mjs')], { stdio: 'pipe', timeout: 60000 }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`error answers ${m[1]}/${m[1]}`) : fail('error answers: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('error answers — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.message.split('\n')[0]]).join(' | '))); }

console.log('\n25. Profile and key data from other nodes is checked before it is stored');
try {
  const out = execFileSync('node', [join(root, 'tools/peerdata-test.mjs')], { stdio: 'pipe', timeout: 30000 }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`peer data ${m[1]}/${m[1]}`) : fail('peer data: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('peer data — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.message.split('\n')[0]]).join(' | '))); }

console.log('\n26. Inbox allowance: stamped contacts and members are never throttled by everyday bursts; strangers still are');
try {
  const out = execFileSync('node', [join(root, 'tools/ratelimit-test.mjs')], { stdio: 'pipe', timeout: 30000 }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`allowance ${m[1]}/${m[1]}`) : fail('allowance: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('allowance — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.message.split('\n')[0]]).join(' | '))); }

console.log('\n27. Message text, letter avatars and message fields: links open what was written, markup stays text, bad fields dropped');
try {
  const out = execFileSync('node', [join(root, 'tools/render-test.mjs')], { stdio: 'pipe', timeout: 30000 }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`rendering ${m[1]}/${m[1]}`) : fail('rendering: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('rendering — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.message.split('\n')[0]]).join(' | '))); }

console.log('\n28. Network status: the network\u2019s own answer counts, a late one doesn\u2019t show "Connecting", anon finds its country files (needs `npm install`)');
try {
  const out = execFileSync('node', [join(root, 'tools/netstatus-test.mjs')], { stdio: 'pipe', timeout: 60000 }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`network status ${m[1]}/${m[1]}`) : fail('network status: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('network status — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.stderr?.toString().match(/^\w*Error\b.*$/m)?.[0] || e.message.split('\n')[0]]).join(' | '))); }

console.log('\n29. Audit fixes: port held by another program, contacts never added twice, small public requests, proof-of-work cap, unpacker limits, safe file names, separate routes (needs `npm install`)');
try {
  const out = execFileSync('node', [join(root, 'tools/hardening-test.mjs')], { stdio: 'pipe', timeout: 120000 }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`audit fixes ${m[1]}/${m[1]}`) : fail('audit fixes: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('audit fixes — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.stderr?.toString().match(/^\w*Error\b.*$/m)?.[0] || e.message.split('\n')[0]]).join(' | '))); }

console.log('\n30. Why messages wait, in the Status log; introduction points counted from the open circuits (needs `npm install`)');
try {
  const out = execFileSync('node', [join(root, 'tools/deliverylog-test.mjs')], { stdio: 'pipe', timeout: 120000 }).toString();
  const m = out.match(/(\d+) passed, (\d+) failed/);
  (m && m[2] === '0') ? pass(`delivery log ${m[1]}/${m[1]}`) : fail('delivery log: ' + (m ? m[0] : 'no summary'));
} catch (e) { fail('delivery log — ' + ((e.stdout?.toString().match(/✗ .*/g) || [e.stderr?.toString().match(/^\w*Error\b.*$/m)?.[0] || e.message.split('\n')[0]]).join(' | '))); }

console.log('\n' + (failures === 0 ? '\x1b[32m✅ ALL CHECKS PASSED\x1b[0m' : `\x1b[31m❌ ${failures} CHECK(S) FAILED\x1b[0m`) + '\n');
process.exit(failures === 0 ? 0 : 1);
