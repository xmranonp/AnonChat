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

// A corpus of hostile messages: whatever the text, the result may contain only our own few tags with their own attributes, every
// "<" or ">" outside a tag must be escaped, every link must be http(s), and a quote can never end an attribute early.
{
  const CORPUS = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'http://x.com" onmouseover="alert(1)', "http://x.com' onmouseover='alert(1)",
    'javascript:alert(1)', 'http://x.com/?a=1&b=2', '`<img src=x onerror=alert(1)>`', '**<svg onload=alert(1)>**', '[a](javascript:alert(1))',
    'http://x.com/<img src=x onerror=alert(1)>', 'a'.repeat(56) + '.anyone" onclick="alert(1)', 'http://x.com&quot;onmouseover=alert(1)',
    'http://x.com&#39;onmouseover=alert(1)', 'http://x.com&amp;" onx="', '<a href="javascript:alert(1)">x</a>',
    'data:text/html,<script>alert(1)</script>', 'http://evil\u3000.com', '*a* <iframe src=javascript:alert(1)>',
    'http://x.com\u0000" onerror="alert(1)', 'http://x.com#<svg/onload=alert(1)>', '&lt;script&gt;alert(1)&lt;/script&gt;', '&amp;lt;script&amp;gt;',
    'http://x.com/a>b" onload="alert(1)', '\u{1F600}<img src=x onerror=alert(1)>',
    // more: markup inside markup, line breaks inside links, odd schemes and letter case, tags split across formatting
    '`**<b onmouseover=alert(1)>**`', '**`<script>`**', '*<img src=x onerror=alert(1)>*', '_<svg/onload=alert(1)>_',
    'http://x.com/\n" onmouseover="alert(1)', 'http://x.com/\r\n<script>alert(1)</script>', 'HTTP://X.COM" onmouseover="alert(1)',
    'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', 'vbscript:msgbox(1)', 'http://x.com/%22%20onmouseover=%22alert(1)',
    'http://x.com/?q="><script>alert(1)</script>', 'http://x.com/?q=\'><img src=x onerror=alert(1)>', 'http://[::1]/"onmouseover="alert(1)',
    '<<script>script>alert(1)<</script>/script>', '<scr<script>ipt>alert(1)</scr</script>ipt>', '<svg><script>alert(1)</script></svg>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>', '<details open ontoggle=alert(1)>', '<body onload=alert(1)>',
    '<a href=javascript&colon;alert(1)>x</a>', '<a href="&#106;avascript:alert(1)">x</a>', '<a href="&#x6A;avascript:alert(1)">x</a>',
    '"><script>alert(1)</script>', "'><script>alert(1)</script>", '</a><script>alert(1)</script>', '</code><img src=x onerror=alert(1)>',
    '`' + 'a'.repeat(5000) + '`', '*'.repeat(3000), '_'.repeat(3000), 'http://' + 'a'.repeat(5000), ('**a** ').repeat(1000),
    '\u202Ehttp://x.com/\u202D" onmouseover="alert(1)', 'http://x.com/\u2028<script>alert(1)</script>', '\ud800<script>alert(1)</script>',
    'b'.repeat(56) + '.anyone/<script>', 'http://' + 'b'.repeat(56) + '.anyone/"onmouseover="alert(1)', '$&$`$\'<script>alert(1)</script>',
    '\\<script>alert(1)</script>', '<!--<script>alert(1)</script>-->', '<![CDATA[<script>alert(1)</script>]]>', '<?php echo 1; ?>',
  ];
  const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+="[^"<>]*")*)\s*>/g;
  const ALLOWED = new Set(['a', 'br', 'code', 'em', 'strong']);
  const ATTRS = { a: ['href', 'target', 'rel', 'class'], code: ['class'] };
  const problems = (html) => {
    const out = [];
    const rest = html.replace(TAG, (m, close, name, attrs) => {
      const n = name.toLowerCase();
      if (!ALLOWED.has(n)) out.push('tag <' + n + '>');
      for (const [, k, v] of attrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
        if (!(ATTRS[n] || []).includes(k.toLowerCase())) out.push('attribute ' + k + ' on <' + n + '>');
        if (k.toLowerCase() === 'href' && !/^https?:\/\/[^\s"'<>]*$/i.test(v.replace(/&amp;/g, '&'))) out.push('href ' + v.slice(0, 40));
      }
      return '';
    });
    if (/[<>]/.test(rest)) out.push('unescaped < or > in text: ' + rest.match(/.{0,20}[<>].{0,20}/)[0]);
    return out;
  };
  let bad = [];
  for (const p of CORPUS) { let h; try { h = render(p); } catch (e) { bad.push([p, 'threw ' + e.message]); continue; } const pr = problems(h); if (pr.length) bad.push([p.slice(0, 40), pr.join('; ')]); }
  ok(`${CORPUS.length} hostile messages: only our own tags and attributes, text escaped, links http(s)`, bad.length === 0, JSON.stringify(bad.slice(0, 3)));
  // Rendering a message must stay quick whatever it contains.
  const t = Date.now(); for (const p of CORPUS) render(p); ok('…and rendering them all is quick', Date.now() - t < 2000, (Date.now() - t) + ' ms');
  // The checker itself must catch what it is there for.
  ok('(the checker catches a planted <script>, an onclick and a javascript: link)',
    problems('<script>x</script>').length >= 1 && problems('<a href="http://x" onclick="y">z</a>').length === 1 && problems('<a href="javascript:x">z</a>').length === 1);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
