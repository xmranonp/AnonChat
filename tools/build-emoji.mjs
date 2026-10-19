// Builds the emoji picker and the flag images from an emoji image pack (Noto Emoji "emoji_u1f600.png" naming, any resolution).
// Usage: node tools/build-emoji.mjs <folder with the pack's PNGs>
// Reads tools/emoji-categories.json, replaces public/emoji/ and public/flags/ (shrunk to 256-colour PNGs by tools/compress-pngs.py,
// which needs Python with Pillow and numpy) and rewrites public/emoji-data.js. Nothing is replaced unless the whole build succeeds.
import { readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pack = process.argv[2];
if (!pack || !existsSync(pack)) { console.error('Usage: node tools/build-emoji.mjs <folder with the pack PNGs>'); process.exit(1); }

const data = JSON.parse(readFileSync(join(root, 'tools/emoji-categories.json'), 'utf8'));
const TONES = [0x1F3FB, 0x1F3FC, 0x1F3FD, 0x1F3FE, 0x1F3FF];
const hex = (cp) => cp.toString(16).toUpperCase().padStart(4, '0');
const idOf = (seq) => seq.filter((c) => c !== 0xFE0F).map(hex).join('-');
const seqOf = (name) => name.replace(/^emoji_u|\.png$/gi, '').split('_').map((h) => parseInt(h, 16));

// A character that has both a text and an emoji look needs U+FE0F to be shown as an emoji.
const isEmoji = (cp) => /\p{Emoji}/u.test(String.fromCodePoint(cp));
const hasEmojiLook = (cp) => /\p{Emoji_Presentation}/u.test(String.fromCodePoint(cp));
function glyph(seq) {
  let s = '';
  seq.forEach((cp, i) => {
    s += String.fromCodePoint(cp);
    const tone = TONES.includes(cp), next = seq[i + 1];
    if (!tone && cp !== 0x200D && cp !== 0x20E3 && isEmoji(cp) && !hasEmojiLook(cp) && !TONES.includes(next)) s += '\uFE0F';
  });
  return s;
}

// What the pack contains: every image by id, and the single-tone variants of each base emoji.
const files = new Map(), variants = new Map();
for (const name of readdirSync(pack).filter((n) => /^emoji_u.*\.png$/i.test(n))) {
  const seq = seqOf(name), tones = seq.filter((c) => TONES.includes(c));
  files.set(idOf(seq), name);
  if (tones.length && new Set(tones).size === 1) {
    const base = idOf(seq.filter((c) => !TONES.includes(c)));
    if (!variants.has(base)) variants.set(base, new Map());
    variants.get(base).set(tones[0], seq);
  }
}

// The pack must have every image the picker needs before anything is replaced.
const needed = [...data.specialFlags, ...Object.values(data.categories).flat()];
const lacking = needed.filter((id) => !files.has(id));
if (lacking.length) { console.error(`This pack is missing ${lacking.length} emoji the picker needs, so nothing was changed. First few: ${lacking.slice(0, 8).join(' ')}`); process.exit(1); }

// The pack's country flags: every file named after two regional-indicator letters.
const flagFiles = new Map();
for (const name of readdirSync(pack)) {
  const m = /^emoji_u1f1([e-f][0-9a-f])_1f1([e-f][0-9a-f])\.png$/i.exec(name);
  if (m) flagFiles.set(String.fromCharCode(parseInt(m[1], 16) - 0xE6 + 65) + String.fromCharCode(parseInt(m[2], 16) - 0xE6 + 65), name);
}
const ourCountries = readdirSync(join(root, 'public/flags')).filter((f) => /^[A-Z]{2}\.png$/.test(f)).map((f) => f.slice(0, 2));
const noFlag = ourCountries.filter((c) => !flagFiles.has(c));
if (noFlag.length) { console.error(`This pack has no flag for ${noFlag.join(' ')}, so nothing was changed.`); process.exit(1); }

// Fresh image folders with exactly what the picker uses, built beside the real ones and swapped in at the end.
const outDir = join(root, 'public/emoji.new'), flagDir = join(root, 'public/flags.new');
for (const d of [outDir, flagDir]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }
const copy = (id) => copyFileSync(join(pack, files.get(id)), join(outDir, id + '.png'));
for (const [code, name] of flagFiles) copyFileSync(join(pack, name), join(flagDir, code + '.png'));
const LABELS = { smileys: 'Smileys', people: 'People', animals: 'Animals & Nature', food: 'Food', activities: 'Activities', travel: 'Travel', objects: 'Objects', symbols: 'Symbols', flags: 'Flags' };
const categories = [];
let images = 0;
for (const id of Object.keys(LABELS)) {
  const baseIds = id === 'flags' ? data.specialFlags : data.categories[id];
  const emojis = [];
  for (const b of baseIds) {
    copy(b); images++; emojis.push(glyph(b.split('-').map((h) => parseInt(h, 16))));
  }
  if (id === 'flags') {                                                    // every flag in the pack, A to Z by name
    const names = new Intl.DisplayNames(['en'], { type: 'region' });
    const codes = [...flagFiles.keys()];
    const label = (c) => { try { return names.of(c) || c; } catch { return c; } };
    codes.sort((a, b) => label(a).localeCompare(label(b)));
    for (const c of codes) emojis.push([...c].map((ch) => String.fromCodePoint(0x1F1E6 + ch.charCodeAt(0) - 65)).join(''));
  }
  const icon = glyph(data.icons[id].split('-').map((h) => parseInt(h, 16)));
  categories.push({ id, icon, labelKey: 'emoji.' + id, label: LABELS[id], emojis });
}
// Skin-tone choices: base emoji -> its five variants
const tones = {};
for (const c of categories) for (const e of c.emojis) {
  const v = variants.get(idOf([...e].map((ch) => ch.codePointAt(0))));
  if (!v || TONES.some((t) => !v.has(t))) continue;
  tones[e] = TONES.map((t) => { const seq = v.get(t); copy(idOf(seq)); images++; return glyph(seq); });
}

const fail = (msg) => { rmSync(outDir, { recursive: true, force: true }); rmSync(flagDir, { recursive: true, force: true }); console.error(msg + ' Nothing was changed.'); process.exit(1); };
const squeeze = spawnSync('python3', ['-I', join(root, 'tools/compress-pngs.py'), outDir, flagDir], { encoding: 'utf8' });
if (squeeze.status !== 0) fail('Compressing the images failed (needs Python 3 with Pillow and numpy): ' + (squeeze.stderr || squeeze.error || '').toString().trim().split('\n').pop());
process.stdout.write(squeeze.stdout);
for (const [live, fresh] of [['public/emoji', outDir], ['public/flags', flagDir]]) { rmSync(join(root, live), { recursive: true, force: true }); renameSync(fresh, join(root, live)); }

const stamp = createHash('sha1');
for (const dir of ['public/emoji', 'public/flags']) for (const f of readdirSync(join(root, dir)).sort()) stamp.update(f).update(readFileSync(join(root, dir, f)));
const version = stamp.digest('hex').slice(0, 8);

const q = (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const lines = ['// Emoji picker data. Generated by tools/build-emoji.mjs from tools/emoji-categories.json and the image pack: edit those, not this file.', '', 'export const EMOJI_CATEGORIES = ['];
for (const c of categories) {
  lines.push(`  {\n    id: '${c.id}', icon: ${q(c.icon)}, labelKey: '${c.labelKey}', label: ${q(c.label)},\n    emojis: [`);
  for (let i = 0; i < c.emojis.length; i += 12) lines.push('      ' + c.emojis.slice(i, i + 12).map(q).join(', ') + ',');
  lines.push('    ],\n  },');
}
lines.push('];', '', '// The five skin-tone variants of an emoji, light to dark.', 'export const EMOJI_TONES = {');
for (const [b, v] of Object.entries(tones)) lines.push(`  ${q(b)}: [${v.map(q).join(', ')}],`);
lines.push('};', '', '// Quick-reaction bar: the eight most-used emoji in the Unicode Consortium\'s 2021 ranking.', "export const REACTION_PRESETS = ['😂', '❤️', '🤣', '👍', '😭', '🙏', '😘', '🥰'];", '',
`// Changes whenever the images do: part of every image address, so the browser never shows an old one.
export const EMOJI_VERSION = '${version}';
`,
`export function emojiToCodepoint(emoji) {
  return Array.from(emoji).map((ch) => ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).filter((cp) => cp !== 'FE0F').join('-');
}

// Address of a country flag image; the version keeps the browser from showing an old one.
export function flagSrc(code) { return 'flags/' + code + '.png?v=' + EMOJI_VERSION; }

// Image for an emoji: country flags come from flags/, everything else from emoji/.
export function emojiSrc(emoji) {
  const cps = Array.from(emoji);
  if (cps.length === 2 && cps.every((c) => c >= '\\u{1F1E6}' && c <= '\\u{1F1FF}')) return flagSrc(cps.map((c) => String.fromCharCode(c.codePointAt(0) - 0x1F1E6 + 65)).join(''));
  return 'emoji/' + emojiToCodepoint(emoji) + '.png?v=' + EMOJI_VERSION;
}

// Ids of every emoji we have an image for.
export const EMOJI_IDS = new Set([...EMOJI_CATEGORIES.flatMap((c) => c.emojis), ...Object.values(EMOJI_TONES).flat()].map(emojiToCodepoint));
`);
writeFileSync(join(root, 'public/emoji-data.js'), lines.join('\n'));

const total = categories.reduce((n, c) => n + c.emojis.length, 0);
console.log(`${total} emoji in ${categories.length} categories: ` + categories.map((c) => `${c.id} ${c.emojis.length}`).join(', '));
console.log(`${Object.keys(tones).length} emoji with a skin-tone choice | ${images} emoji images and ${flagFiles.size} flags written`);
