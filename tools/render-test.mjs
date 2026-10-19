// What a message's text turns into (public/app.js renderMarkdownText) and the letter avatar (public/fingerprint.js).
// Run: node tools/render-test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = process.argv[2] || join(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = readFileSync(join(APP, 'public/app.js'), 'utf8');
const grab = (name) => { const i = src.indexOf('function ' + name); return src.slice(i, src.indexOf('\n}\n', i) + 2); };
const render = new Function(grab('mdEscape') + '\n' + grab('renderMarkdownText').replace('return emojify(s);', 'return s;') + '\nreturn renderMarkdownText;')();
const tmp = join(mkdtempSync(join(tmpdir(), 'render-')), 'fingerprint.mjs');
writeFileSync(tmp, readFileSync(join(APP, 'public/fingerprint.js')));
const { fingerprintSVG } = await import(pathToFileURL(tmp).href);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else fail++; console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '  [' + detail + ']')); };
const hrefs = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

let h = render('see http://example.com/a?b=1&c=2 now');
ok('a link with & opens exactly what was written', hrefs(h)[0] === 'http://example.com/a?b=1&c=2' && h.includes('>http://example.com/a?b=1&amp;c=2</a>'), h);
h = render('"http://x.com/q" and \'https://a.org/p\'.');
ok('a link in quotes stops before the closing quote', JSON.stringify(hrefs(h)) === '["http://x.com/q","https://a.org/p"]', h);
h = render('<img src=x onerror=alert(1)> <script>alert(1)</script>');
ok('HTML in a message stays text', !/<img|<script/i.test(h) && h.includes('&lt;img'), h);
h = render('http://e.com/"onmouseover="alert(1)');
ok('a quote can’t break out of a link', !/"\s*onmouseover/.test(h), h);
h = render('javascript:alert(1) data:text/html,x');
ok('only http(s) and .anyone become links', !h.includes('<a '), h);
h = render('b'.repeat(56) + '.anyone');
ok('a .anyone address becomes a link', hrefs(h)[0] === 'http://' + 'b'.repeat(56) + '.anyone');
ok('**bold** and `code` still work', render('**x** `y`') === '<strong>x</strong> <code class="md-code">y</code>');

const letter = (name) => (fingerprintSVG('a'.repeat(56) + '.anyone', 40, name).match(/>([^<>]*)<\/text>/) || [])[1];
ok('the letter avatar uses a whole emoji, not half of it', letter('😀 Ana') === '😀', JSON.stringify(letter('😀 Ana')));
ok('…and an ordinary first letter, capitalised', letter('ana') === 'A');
ok('…and escapes markup', letter('<b>') === '&lt;');

// What a peer can put in a message: every field checked on arrival (cleanFrame), and a reaction must be a short string (applyReaction).
const constSrc = (name) => (src.match(new RegExp(`^const ${name} = .*;$`, 'm')) || [''])[0];
const env = new Function(`const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'voice', 'file']);
  ${['MAX_EMOJI_LEN', 'FRAME_KIND_RE', 'THUMB_RE', 'MEMBER_ADDR_RE'].map(constSrc).join('\n')}
  const store = new Map(); const loadThread = (k) => store.get(k) || []; const persistField = () => {};
  ${grab('cleanFrame')}\n${grab('cleanMember')}\n${grab('applyReaction')}
  return { cleanFrame, cleanMember, applyReaction, store };`)();
const F = (kind, meta) => env.cleanFrame({ kind, meta, payload: new Uint8Array(0) });
ok('a frame without a proper kind is dropped', F(undefined, {}) === null && F({}, {}) === null && F('<b>', {}) === null);
ok('a reaction emoji that isn’t a short string is dropped', !('emoji' in F('reaction', { emoji: [1], reactTo: 'x' }).meta) && !('emoji' in F('reaction', { emoji: 'x'.repeat(40) }).meta) && F('reaction', { emoji: '👍' }).meta.emoji === '👍');
const f1 = F('image', { name: { a: 1 }, size: 'big', thumb: 'http://evil/x.png', type: 7, mid: ['m'], replyTo: { id: 'r1', text: 'forged' } });
ok('media fields of the wrong type are dropped', !('name' in f1.meta) && !('size' in f1.meta) && !('thumb' in f1.meta) && !('type' in f1.meta) && !('mid' in f1.meta), JSON.stringify(f1.meta));
ok('…a reply keeps only the id it points to', JSON.stringify(f1.meta.replyTo) === '{"id":"r1"}');
ok('…and good ones are kept', F('image', { name: 'a.jpg', size: 10, thumb: 'data:image/jpeg;base64,AAAA' }).meta.thumb === 'data:image/jpeg;base64,AAAA');
ok('a group member entry must be an address and a short name', env.cleanMember({ address: 'x', petname: 'Bob' }) === null && env.cleanMember({ address: 'a'.repeat(56) + '.anyone', petname: 'B'.repeat(99) }).petname.length === 40);
env.store.set('t', [{ id: 'm1' }]);
env.applyReaction('t', 'm1', [1], 'a'.repeat(56) + '.anyone', null);
ok('applyReaction ignores an emoji that isn’t a string', !env.store.get('t')[0].reactions);

// Shown in the order written: arrivals in any order, each placed strictly between its neighbours, never above our own messages
{
  const th = [];
  const wot = new Function('loadThread', grab('writtenOrderTs') + '\nreturn writtenOrderTs;')(() => th);
  const order = (arrival, out = null) => {
    th.length = 0; let now = 1000;
    if (out) th.push({ dir: 'out', kind: 'text', text: 'mine', ts: (now += 10) });
    for (const k of arrival) { const rec = { dir: 'in', kind: 'text', text: 'q' + k, meta: { at: 100 + k }, ts: (now += 10) }; rec.ts = wot('x', rec); th.push(rec); }
    return [...th].sort((a, b) => a.ts - b.ts).map((m) => m.text).join(',');
  };
  let all = true, bad = '';
  const perms = (a) => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r]));
  for (const p of perms([0, 1, 2, 3, 4])) { const r = order(p, true); if (r !== 'mine,q0,q1,q2,q3,q4') { all = false; bad = p.join('') + ' -> ' + r; break; } }
  ok('messages arriving in any order (all 120 orders of 5) are shown in the order written, below our own', all, bad);
  th.length = 0; th.push({ dir: 'in', text: 'a', meta: { at: 500 }, ts: 10 }, { dir: 'out', text: 'mine', ts: 20 });
  const late = { dir: 'in', text: 'b', meta: { at: 400 }, ts: 30 };
  ok('…but never moved above something we wrote since', wot('x', late) === 30);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
