// AnonChat UI. All cryptography runs client-side (ratchet.js, crypto.js).
import { b64 } from './crypto.js';
import * as Ratchet from './ratchet.js';
import { fingerprintSVG, shortAddr } from './fingerprint.js';
import { createCalls, CALL_ICON, callsSupported } from './call.js';
import { t, setLang, getLang, applyI18n, LANGS } from './i18n.js';
import { EMOJI_CATEGORIES, EMOJI_TONES, REACTION_PRESETS as REACTION_PRESETS_DATA, EMOJI_IDS, emojiToCodepoint, emojiSrc, flagSrc } from './emoji-data.js';
import { mountRelayGlobe, warmUpRelayGlobe } from './globe.js';
import * as Backup from './backup.js';
import { cleanForSending } from './mediaclean.js';

function emojiImg(emoji, size = 24, lazy = false) {
  const img = el('img', {
    className: 'emoji-img',
    src: emojiSrc(emoji),
    alt: emoji, width: size, height: size, draggable: false,
  });
  if (lazy) img.loading = 'lazy';
  // Not in the shipped set (say, a reaction from a newer app): show the character itself instead of a broken image.
  img.onerror = () => { const s = el('span', { className: 'emoji-fallback', textContent: emoji }); s.style.fontSize = Math.round(size * 0.85) + 'px'; img.replaceWith(s); };
  return img;
}

// Key agreement algorithm: ECDH over NIST P-256.
//   • 65-byte uncompressed public keys; 32-byte (X-coordinate) shared secret
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const te = new TextEncoder();
const td = new TextDecoder();

let ikPrivJwk = null, ikPub = null;
let spk = null;
let ikSig = null;
let spkSig = null;
let pinKey = null;
let myAddress = null;
let myAvatar = null;
let myBio = null;
let contacts = [];
let groups    = [];
const MAX_GROUP = 10;
let selected = null;
let selectedGroup = null;
const unreadContacts = new Map();
const unreadSeparatorAt = new Map();
function firstUnreadId(convKey, unreadCount) {
  if (!unreadCount || unreadCount <= 0) return null;
  const thread = gatherThread(convKey);
  if (unreadCount > thread.length) return thread[0]?.id || null;
  const m = thread[thread.length - unreadCount];
  return m ? m.id : null;
}

const sessions = new Map();
// Decode the whole audio buffer up front and play it through Web Audio: no streaming dependency, so playback always runs to completion.
let _audioCtx = null;
function audioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
  return _audioCtx;
}

const tgPlayers = new Map();

class TgPlayer {
  constructor(msgId, blob) {
    this.msgId = msgId; this.blob = blob;
    this.buffer = null; this.source = null;
    this.playing = false; this.startTime = 0; this.offset = 0;
    this.duration = 0; this.failed = false;
    this.root = el('div', { className: 'tg-player' });
    this.btn  = el('button', { className: 'tg-play', type: 'button' });
    this.bar  = el('div', { className: 'tg-bar' });
    this.fill = el('div', { className: 'tg-bar-fill' });
    this.time = el('span', { className: 'tg-time', textContent: '0:00' });
    this.bar.append(this.fill);
    this.root.append(this.btn, this.bar, this.time);
    this.btn.onclick = () => this.toggle();
    this.bar.onclick = (e) => this.seekTo(e);
    this._renderIcon('load');
    this._decode();
  }
  async _decode() {
    try {
      const ab = await this.blob.arrayBuffer();
      this.buffer = await audioCtx().decodeAudioData(ab.slice(0));
      this.duration = this.buffer.duration;
      this.time.textContent = this._fmt(this.duration);
      this._renderIcon('play');
    } catch (e) {
      this.failed = true;
      this.time.textContent = t('msg.cantPlay');
      this._renderIcon('err');
    }
  }
  _fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }
  _renderIcon(kind) {
    const stroke = 'stroke="currentColor" stroke-width="2" fill="currentColor"';
    if (kind === 'load') this.btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="14 14"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></circle></svg>';
    else if (kind === 'play') this.btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" '+stroke+' stroke-linejoin="round"><polygon points="6,4 20,12 6,20"/></svg>';
    else if (kind === 'pause') this.btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" '+stroke+'><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>';
    else this.btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M9 9 L15 15 M15 9 L9 15"/></svg>';
  }
  toggle() {
    if (this.failed || !this.buffer) return;
    if (this.playing) this.pause(); else this.play();
  }
  play() {
    const ctx = audioCtx();
    this.source = ctx.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(ctx.destination);
    this.source.onended = () => {
      if (this.playing) { this.playing = false; this.offset = 0; this._renderIcon('play'); this._update(0); }
    };
    this.source.start(0, this.offset);
    this.startTime = ctx.currentTime - this.offset;
    this.playing = true;
    this._renderIcon('pause');
    this._tick();
  }
  pause() {
    if (!this.playing) return;
    this.offset = audioCtx().currentTime - this.startTime;
    try { this.source.onended = null; this.source.stop(); } catch {}
    this.playing = false;
    this._renderIcon('play');
  }
  seekTo(e) {
    if (this.failed || !this.duration) return;
    const r = this.bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();
    this.offset = pct * this.duration;
    this._update(this.offset);
    if (wasPlaying) this.play();
  }
  _tick() {
    if (!this.playing) return;
    const elapsed = audioCtx().currentTime - this.startTime;
    this._update(Math.min(elapsed, this.duration));
    if (this.playing) requestAnimationFrame(() => this._tick());
  }
  _update(t) {
    this.fill.style.width = (100 * t / this.duration) + '%';
    this.time.textContent = this._fmt(this.duration - t);
  }
  destroy() { try { this.source?.stop(); } catch {} }
}

function getOrCreateTgPlayer(msgId, blob) {
  let p = tgPlayers.get(msgId);
  if (!p) { p = new TgPlayer(msgId, blob); tgPlayers.set(msgId, p); }
  return p;
}

const sessionUrls = new Map();
const sessionBlobs = new Map();

// Chromium blocks audio until the first user interaction (autoplay policy); a play() before that rejects with NotAllowedError, which is transient.
let soundEnabled = localStorage.getItem('anyonechat.sound') !== 'false';
let _notifAudio = null;
let _audioFatal = false;     // only set on real media errors, never on autoplay policy
let _audioPrimed = false;

function _ensureAudio() {
  if (!_notifAudio) {
    _notifAudio = new Audio('/notification.mp3');
    _notifAudio.preload = 'auto';
    _notifAudio.volume = 0.7;
    _notifAudio.addEventListener('error', () => { _audioFatal = true; });
  }
  return _notifAudio;
}

function primeAudioOnce() {
  if (_audioPrimed || _audioFatal) return;
  const a = _ensureAudio();
  const prevMuted = a.muted;
  a.muted = true;
  a.play().then(() => {
    a.pause(); a.currentTime = 0; a.muted = prevMuted; _audioPrimed = true;
  }).catch(() => {
    a.muted = prevMuted;
  });
}

function playNotification() {
  if (!soundEnabled || _audioFatal) return;
  try {
    const base = _ensureAudio();
    // Play a fresh clone each time: one shared element can't restart while it is playing, so back-to-back sounds would be dropped.
    const a = base.cloneNode(true);
    a.volume = 0.7;
    a.play().catch(err => {
    });
    a.addEventListener('ended', () => { try { a.src = ''; } catch {} });
  } catch {}
}

const _BELL_ON  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
const _BELL_OFF = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

function initSound() {
  const btn = $('#sound-btn');
  const primeHandler = () => { primeAudioOnce(); };
  window.addEventListener('pointerdown', primeHandler, { once: true });
  window.addEventListener('keydown', primeHandler, { once: true });
  if (!btn) return;
  function sync() {
    btn.innerHTML = soundEnabled ? _BELL_ON : _BELL_OFF;
    btn.title     = soundEnabled ? (t('sound.mute')) : (t('sound.unmute'));
    btn.classList.toggle('sound-off', !soundEnabled);
  }
  sync();
  btn.onclick = () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem('anyonechat.sound', String(soundEnabled));
    sync();
    if (soundEnabled) { _audioPrimed = true; playNotification(); }
  };
}

const $ = (s, r = document) => r.querySelector(s);
const el = (t, p = {}, ...k) => {
  const n = document.createElement(t);
  for (const [key, v] of Object.entries(p)) { if (key.includes('-')) n.setAttribute(key, v); else n[key] = v; }   // 'aria-label' and 'data-x' are attributes, not properties
  for (const c of k) n.append(c); return n;
};
const concat = (...a) => { const t = a.reduce((n, x) => n + x.length, 0); const o = new Uint8Array(t); let f = 0; for (const x of a) { o.set(x, f); f += x.length; } return o; };
const clone = (o) => JSON.parse(JSON.stringify(o));

// Anything that slips past every handler (a bug) is noted instead of vanishing: the last 20, in memory only (never stored or sent
// anywhere), with the console line a developer would look for. Nothing is shown to the person, and the page keeps running.
const pageErrors = [];
function notePageError(kind, e) {
  try {
    const msg = String((e && e.message) || e || 'unknown').slice(0, 300);
    pageErrors.push({ kind, message: msg, stack: String((e && e.stack) || '').split('\n').slice(0, 6).join('\n'), ts: Date.now() });
    if (pageErrors.length > 20) pageErrors.shift();
    console.error('[AnonChat] ' + kind + ': ' + msg);
  } catch {}
}
window.addEventListener('error', (ev) => notePageError('error', ev.error || ev.message));
window.addEventListener('unhandledrejection', (ev) => notePageError('unhandled promise rejection', ev.reason));
window.__anonchatErrors = () => pageErrors.slice();   // for a bug report or a test

// Names of the encrypted fields. A chat's history and session are stored under an opaque tag (a keyed hash of the contact address or
// group id), never the address itself: the list of field names would otherwise give away who you talk to without any decryption.
// The tag key and the tag → address map live in the encrypted preferences (prefs.names), loaded right after unlock.
const LS = {
  session: (a) => 'anyonechat.s.' + nameTag(a),
  thread:  (a) => 'anyonechat.t.' + nameTag(a),
  processed: 'anyonechat.processed',
};
const SESSION_FIELD_PREFIX = 'anyonechat.s.', THREAD_FIELD_PREFIX = 'anyonechat.t.';
function isThreadField(k) { return k.startsWith(THREAD_FIELD_PREFIX); }

// SHA-256 (FIPS 180-4), synchronous, for the field-name tags above (WebCrypto is async only).
const SHA_K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
function sha256Hex(bytes) {
  const l = bytes.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n);
  m.set(bytes); m[l] = 0x80;
  const dv = new DataView(m.buffer); dv.setUint32(n - 4, l * 8); dv.setUint32(n - 8, Math.floor(l / 0x20000000));
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const W = new Uint32Array(64), r = (x, k) => (x >>> k) | (x << (32 - k));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) W[i] = (W[i-16] + (r(W[i-15],7) ^ r(W[i-15],18) ^ (W[i-15] >>> 3)) + W[i-7] + (r(W[i-2],17) ^ r(W[i-2],19) ^ (W[i-2] >>> 10))) >>> 0;
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e,6) ^ r(e,11) ^ r(e,25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + W[i]) >>> 0;
      const t2 = ((r(a,2) ^ r(a,13) ^ r(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return [...H].map((x) => x.toString(16).padStart(8, '0')).join('');
}
function nameTag(key) {
  const names = prefs.names;
  if (!names.salt) throw new Error('storage names used before unlock');
  const tag = sha256Hex(new TextEncoder().encode(names.salt + '|' + key)).slice(0, 32);
  if (names.map[tag] !== key) { names.map[tag] = key; savePrefs(); }
  return tag;
}

// ---- Preferences that would reveal contacts, kept encrypted ----
// Pinned chats, disappearing-message timers, how long an offline message waits, which contacts you verified, your own picture and
// status, and the field-name tags. Small settings that name nobody (theme, sounds, clock) stay in localStorage.
const PREFS_FIELD = 'anyonechat.prefs';
let prefs = { names: { salt: null, map: {} }, pinned: [], ttl: {}, offlineTtl: {}, verified: {}, avatar: null, bio: null };
let _prefsTimer = null;
function savePrefs() {
  clearTimeout(_prefsTimer);
  _prefsTimer = setTimeout(() => persistField(PREFS_FIELD, prefs), 50);
}

// Pins are local only (never sent), keyed by contact address or group id, kept in the encrypted preferences.
function isPinned(key) { return prefs.pinned.includes(key); }
function togglePinned(key) {
  const on = !isPinned(key);
  prefs.pinned = on ? prefs.pinned.concat(key) : prefs.pinned.filter((k) => k !== key);
  savePrefs();
  return on;
}
function sortPinnedFirst(items, keyFn) {
  const pinned = [], rest = [];
  for (const it of items) (isPinned(keyFn(it)) ? pinned : rest).push(it);
  return pinned.concat(rest);
}
function pinSVG(filled) {
  return '<svg width="15" height="15" viewBox="0 0 24 24" fill="' + (filled ? 'currentColor' : 'none') + '" fill-opacity="' + (filled ? '0.22' : '0') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
}

// Small icons for the menu rows (all 16 px, drawn with the text colour).
const MENU_ICONS = {
  rename: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  block: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
  more:  '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>',
  timer: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></svg>',
  clock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
  path:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>',
  test:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  leave: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  back:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
  next:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
};

// One pop-up menu for the whole app: the chat header's three-dot button and right-click on a chat in the list.
// items: { label, icon, value, danger, checked, run(), page: () => items } or { sep: true }. A row with a page opens a second page with a back row.
// A short explanation beside the hovered menu row (a custom bubble: the system tooltip is a separate OS window).
let _tipTimer = null, _tipWatch = null;
function hideTip() { clearTimeout(_tipTimer); clearInterval(_tipWatch); document.getElementById('ctx-tip')?.remove(); }
function showTip(row, text) {
  hideTip();
  _tipTimer = setTimeout(() => {
    if (!row.isConnected) return;
    const menu = document.getElementById('ctx-menu');
    const tip = el('div', { id: 'ctx-tip', role: 'tooltip', textContent: text });
    document.body.append(tip);
    _tipWatch = setInterval(() => { if (!row.isConnected) hideTip(); }, 300);   // the row was redrawn under the pointer: nothing left to explain
    const r = row.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    if (menu) {
      const m = menu.getBoundingClientRect();
      let x = m.left - w - 8;                                 // left of the menu, or right of it when there is no room
      if (x < 8) x = Math.min(m.right + 8, window.innerWidth - w - 8);
      tip.style.left = x + 'px';
      tip.style.top = Math.max(8, Math.min(r.top + r.height / 2 - h / 2, window.innerHeight - h - 8)) + 'px';
    } else {                                                  // anywhere else: centred above the element, below it when there is no room
      tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)) + 'px';
      tip.style.top = (r.top - h - 8 >= 8 ? r.top - h - 8 : r.bottom + 8) + 'px';
    }
  }, 350);
}
function closeMenu() {
  hideTip();
  const m = document.getElementById('ctx-menu');
  if (m) { m._off?.(); m.remove(); }
}
function openMenu(where, items) {
  closeMenu();
  const menu = el('div', { id: 'ctx-menu', role: 'menu' });
  // Measured once: the chat header is redrawn now and then, and a detached button would report a rect of zeros and send the menu to the top-left corner.
  const spot = where.anchor ? where.anchor.getBoundingClientRect() : null;
  const place = () => {
    const w = menu.offsetWidth, h = menu.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let x, y;
    if (spot) { x = spot.right - w; y = spot.bottom + 6; if (y + h > vh - 8) y = spot.top - h - 6; }
    else { x = where.x; y = where.y; }
    menu.style.left = Math.max(8, Math.min(x, vw - w - 8)) + 'px';
    menu.style.top  = Math.max(8, Math.min(y, vh - h - 8)) + 'px';
  };
  const render = (list, back) => {
    menu.innerHTML = '';
    if (back) {
      const b = el('button', { type: 'button', className: 'ctx-item ctx-back', role: 'menuitem' });
      b.innerHTML = MENU_ICONS.back; b.append(el('span', { className: 'ctx-label', textContent: t('menu.back') }));
      b.onclick = back; menu.append(b, el('div', { className: 'ctx-sep' }));
    }
    for (const it of list) {
      if (it.sep) { menu.append(el('div', { className: 'ctx-sep' })); continue; }
      const b = el('button', { type: 'button', className: 'ctx-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''), role: it.checked !== undefined ? 'menuitemradio' : 'menuitem' });
      if (it.checked !== undefined) b.setAttribute('aria-checked', String(!!it.checked));
      const ic = el('span', { className: 'ctx-icon' }); if (it.icon) ic.innerHTML = it.icon; else if (it.checked) ic.innerHTML = MENU_ICONS.check;
      b.append(ic, el('span', { className: 'ctx-label', textContent: it.label }));
      if (it.value) b.append(el('span', { className: 'ctx-value', textContent: it.value }));
      if (it.page) b.insertAdjacentHTML('beforeend', '<span class="ctx-next">' + MENU_ICONS.next + '</span>');
      if (it.desc) { b.addEventListener('mouseenter', () => showTip(b, it.desc)); b.addEventListener('focus', () => { if (b.matches(':focus-visible')) showTip(b, it.desc); }); b.addEventListener('mouseleave', hideTip); b.addEventListener('blur', hideTip); }
      b.onclick = () => {
        if (it.page) { render(it.page(), () => { render(list, back); place(); focusFirst(); }); place(); focusFirst(); return; }
        closeMenu(); it.run?.();
      };
      menu.append(b);
    }
  };
  const focusFirst = () => menu.querySelector('.ctx-item')?.focus({ preventScroll: true });
  render(items);
  document.body.append(menu);
  place(); focusFirst();
  where.anchor?.setAttribute('aria-expanded', 'true');
  const onDown = (e) => { if (!menu.contains(e.target) && !(where.anchor && where.anchor.contains(e.target))) closeMenu(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { closeMenu(); where.anchor?.focus?.(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const els = [...menu.querySelectorAll('.ctx-item')], i = els.indexOf(document.activeElement);
    els[(i + (e.key === 'ArrowDown' ? 1 : -1) + els.length) % els.length]?.focus();
  };
  const onGone = () => closeMenu();
  const onScroll = (e) => { if (!menu.contains(e.target)) closeMenu(); };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onGone);
  window.addEventListener('blur', onGone);
  document.addEventListener('scroll', onScroll, true);
  menu._off = () => { where.anchor?.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onGone); window.removeEventListener('blur', onGone); document.removeEventListener('scroll', onScroll, true); };
}
// Sessions and threads are sensitive: plaintext lives only in memory (the sessions and threadCache maps) and is persisted as AES-GCM ciphertext under the storage key (PIN + device share, or the device share alone in passphrase mode). Reads hit the cache; writes update it and persist asynchronously; loadEncryptedState() decrypts everything once on unlock.

const threadCache = new Map();
let opkCache = {};
const OPK_KEY = 'anyonechat.opks';
// Group messages for members whose keys we don't have yet (offline when the group started): kept here, encrypted, until the keys come.
const GROUP_WAIT_KEY = 'anyonechat.grpwait';
let groupWaiting = [];                   // [{ id, gid, to, frame (base64), at }], oldest first
let _corruptStateCount = 0;
const corruptSessions = new Set();

// ---- Local database (IndexedDB) ----
// Chat history, sessions, requests and one-time prekeys live here, encrypted as before (each value is { __enc, ct, iv } under the
// storage key). localStorage, which Chromium caps at about 5 million characters, now only holds small settings and the PIN-wrapped
// identity keys. Photos, voice messages and files are kept here too ('media'), each encrypted with a random media key that is itself
// stored encrypted under the storage key, so changing the PIN or passphrase never re-encrypts gigabytes. 'mediaMeta' holds only id,
// chat, date and size, so usage and clean-up never load the media itself.
const DB_NAME = 'anonchat', DB_VERSION = 1;
let _db = null;
function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('fields')) db.createObjectStore('fields');
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media');
      if (!db.objectStoreNames.contains('mediaMeta')) {
        const m = db.createObjectStore('mediaMeta', { keyPath: 'id' });
        m.createIndex('thread', 'thread'); m.createIndex('ts', 'ts');
      }
    };
    r.onsuccess = () => { _db = r.result; resolve(_db); };
    r.onerror = () => reject(r.error);
  });
}
function idbRun(stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = _db.transaction(stores, mode);
    let out;
    try { out = fn(tx); } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(out && typeof out === 'object' && 'result' in out && out.readyState ? out.result : out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}
// The encrypted fields, mirrored in memory (they are read synchronously all over the app); writes go to the database in order.
const fields = {
  map: new Map(),
  async open() {
    await openDb();
    await idbRun('fields', 'readonly', (tx) => {
      const c = tx.objectStore('fields').openCursor();
      c.onsuccess = () => { const cur = c.result; if (cur) { fields.map.set(cur.key, cur.value); cur.continue(); } };
    });
  },
  get(k) { return this.map.has(k) ? this.map.get(k) : null; },
  keys() { return [...this.map.keys()]; },
  set(k, v) { this.map.set(k, v); return idbRun('fields', 'readwrite', (tx) => { tx.objectStore('fields').put(v, k); }); },
  delete(k) { this.map.delete(k); return idbRun('fields', 'readwrite', (tx) => { tx.objectStore('fields').delete(k); }); },
};

// One promise chain per key: encrypted writes to the same key run in submission order, so the latest value always wins.
const persistQueues = new Map();

function persistField(lsKey, value) {
  const json = JSON.stringify(value);
  if (!pinKey) return Promise.resolve();   // locked: never persist plaintext
  const prev = persistQueues.get(lsKey) || Promise.resolve();
  const next = prev.then(async () => {
    try {
      const { ct, iv } = await pinEncrypt(pinKey, json);
      await fields.set(lsKey, JSON.stringify({ __enc: 1, ct, iv }));
      storageSaved(lsKey, value);
    } catch (e) { storageFailed(lsKey, value, e); }
  });
  persistQueues.set(lsKey, next);
  next.finally(() => { if (persistQueues.get(lsKey) === next) persistQueues.delete(lsKey); });
  return next;
}

// ---- Nothing is lost silently ----
// A message that couldn't be written stays on screen with a "not saved" mark, and a banner explains; the mark goes once a later write
// of that chat succeeds. Low free space shows the banner before it comes to that.
const unsavedIds = new Set();
const lastSavedIds = new Map();      // thread field key -> ids in its last successful write
let storageWarning = null;           // null | 'low' | 'full'
function storageSaved(k, value) {
  if (!isThreadField(k) || !Array.isArray(value)) return;
  lastSavedIds.set(k, new Set(value.map((m) => m.id)));
  let changed = false;
  for (const m of value) if (unsavedIds.delete(m.id)) changed = true;
  if (changed) { if (!unsavedIds.size && storageWarning === 'full') setStorageWarning(null); refreshOpenChat(); }
}
function storageFailed(k, value, err) {
  console.error('[storage] could not save', k, err && (err.name || err.message));
  if (isThreadField(k) && Array.isArray(value)) {
    const saved = lastSavedIds.get(k) || new Set();
    for (const m of value) if (!saved.has(m.id)) unsavedIds.add(m.id);
    refreshOpenChat();
  }
  setStorageWarning('full');
}
function refreshOpenChat() { try { if (selectedGroup) renderGroupConv(); else if (selected) renderConversation(); } catch {} }
function setStorageWarning(level) {
  storageWarning = level;
  let b = document.getElementById('storage-banner');
  if (!level) { b?.remove(); return; }
  if (!b) {
    b = el('div', { id: 'storage-banner', role: 'alert' });
    document.querySelector('.rail-scroll')?.prepend(b);
  }
  b.innerHTML = '';
  const open = el('button', { type: 'button', className: 'set-pill', textContent: t('storage.open') });
  open.onclick = () => openSettingsDialog('storage');
  b.append(el('b', { textContent: level === 'full' ? t('storage.fullTitle') : t('storage.lowTitle') }),
    el('span', { textContent: level === 'full' ? t('storage.fullText') : t('storage.lowText') }), open);
}
const LOW_SPACE_BYTES = 200 * 1024 * 1024;
async function checkFreeSpace() {
  try {
    const e = await navigator.storage.estimate();
    const free = (e.quota || 0) - (e.usage || 0);
    if (storageWarning !== 'full') setStorageWarning(e.quota && free < LOW_SPACE_BYTES ? 'low' : null);
    return e;
  } catch { return null; }
}

// ---- Photos, voice messages and files ----
const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'voice', 'file']);
const MEDIA_KEY_FIELD = 'anyonechat.mediakey';
let _mediaKey = null;
async function mediaKey() {
  if (_mediaKey) return _mediaKey;
  const r = await readFieldChecked(MEDIA_KEY_FIELD, null);
  if (r.corrupt) throw new Error('media key unreadable');
  let raw = r.value ? b64.dec(r.value) : null;
  if (!raw) { raw = crypto.getRandomValues(new Uint8Array(32)); await persistField(MEDIA_KEY_FIELD, b64.enc(raw)); }
  _mediaKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return _mediaKey;
}
// The file type travels inside the ciphertext; the readable index holds only the chat's opaque tag, a day and a size.
async function mediaPut(id, thread, blob, ts) {
  const key = await mediaKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const type = new TextEncoder().encode((blob.type || '').slice(0, 200));
  const body = new Uint8Array(2 + type.length + blob.size);
  body[0] = type.length >> 8; body[1] = type.length & 255; body.set(type, 2); body.set(new Uint8Array(await blob.arrayBuffer()), 2 + type.length);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, body);
  const day = Math.floor((ts || Date.now()) / 86400000) * 86400000;
  await idbRun(['media', 'mediaMeta'], 'readwrite', (tx) => {
    tx.objectStore('media').put({ iv, ct }, id);
    tx.objectStore('mediaMeta').put({ id, thread: nameTag(thread), ts: day, size: blob.size });
  });
}
async function mediaGet(id) {
  let rec = null;
  await idbRun('media', 'readonly', (tx) => { const r = tx.objectStore('media').get(id); r.onsuccess = () => { rec = r.result || null; }; });
  if (!rec) return null;
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, await mediaKey(), rec.ct));
  const tl = (pt[0] << 8) | pt[1];
  const type = new TextDecoder().decode(pt.subarray(2, 2 + tl));
  return new Blob([pt.subarray(2 + tl)], { type: type || 'application/octet-stream' });
}
function mediaDelete(ids) {
  if (!ids.length || !_db) return Promise.resolve();
  return idbRun(['media', 'mediaMeta'], 'readwrite', (tx) => {
    for (const id of ids) { tx.objectStore('media').delete(id); tx.objectStore('mediaMeta').delete(id); }
  }).catch(() => {});
}
// Metadata of stored media: all of it, or one chat's.
async function mediaList(thread) {
  const out = [];
  if (!_db) return out;
  await idbRun('mediaMeta', 'readonly', (tx) => {
    const st = tx.objectStore('mediaMeta');
    const c = thread ? st.index('thread').openCursor(IDBKeyRange.only(nameTag(thread))) : st.openCursor();
    c.onsuccess = () => { const cur = c.result; if (cur) { out.push(cur.value); cur.continue(); } };
  });
  return out;
}
// Keep a photo, voice message or file: shown now, stored encrypted for later. A failed save marks it "not saved".
function rememberMedia(id, blob, thread, ts, url) {
  sessionBlobs.set(id, blob);
  sessionUrls.set(id, url || URL.createObjectURL(blob));
  mediaPut(id, thread, blob, ts).catch((e) => { console.error('[storage] media not saved', e && e.name); unsavedIds.add(id); setStorageWarning('full'); refreshOpenChat(); });
}
function forgetMedia(id) {
  const u = sessionUrls.get(id); if (u) { try { URL.revokeObjectURL(u); } catch {} }
  sessionUrls.delete(id); sessionBlobs.delete(id);
  const p = tgPlayers.get(id); if (p) { p.destroy(); tgPlayers.delete(id); }
  mediaDelete([id]);
}
async function forgetThreadMedia(thread) {
  const list = await mediaList(thread);
  for (const m of list) { forgetMediaMemory(m.id); }
  await mediaDelete(list.map((m) => m.id));
}
function forgetMediaMemory(id) {
  const u = sessionUrls.get(id); if (u) { try { URL.revokeObjectURL(u); } catch {} }
  sessionUrls.delete(id); sessionBlobs.delete(id);
  const p = tgPlayers.get(id); if (p) { p.destroy(); tgPlayers.delete(id); }
}
// Media stored for messages in a chat is loaded when the chat is shown (decrypted on demand, then kept for the session).
const _mediaTried = new Set();
let _mediaLoading = false;
const _mediaQueue = [];
function loadThreadMedia(thread, msgs) {
  for (const m of msgs) {
    if (!MEDIA_KINDS.has(m.kind) || m.mediaCleared || sessionUrls.has(m.id) || _mediaTried.has(m.id)) continue;
    _mediaTried.add(m.id);
    _mediaQueue.push({ id: m.id, thread });
  }
  if (_mediaQueue.length && !_mediaLoading) drainMediaQueue();
}
async function drainMediaQueue() {
  _mediaLoading = true;
  const touched = new Set();
  while (_mediaQueue.length) {
    const { id, thread } = _mediaQueue.shift();
    try {
      const blob = await mediaGet(id);
      if (blob) { sessionBlobs.set(id, blob); sessionUrls.set(id, URL.createObjectURL(blob)); touched.add(thread); }
    } catch (e) { console.warn('[storage] media unreadable', id, e && e.name); }
    if (touched.size && _mediaQueue.length % 20 === 0) { flushMediaRender(touched); }
  }
  flushMediaRender(touched);
  _mediaLoading = false;
}
function flushMediaRender(touched) {
  const open = selectedGroup ? 'grp:' + selectedGroup : selected;
  if (open && touched.has(open)) refreshOpenChat();
  touched.clear();
}
// Remove stored media (all chats older than a date, or one chat), keeping the text: the messages show "removed to save space".
async function clearMedia({ thread = null, olderThan = null } = {}) {
  let list = await mediaList(thread);
  if (olderThan) list = list.filter((m) => m.ts < olderThan);
  const ids = new Set(list.map((m) => m.id));
  for (const id of ids) forgetMediaMemory(id);
  await mediaDelete([...ids]);
  for (const [addr, t] of threadCache.entries()) {
    if (thread && addr !== thread) continue;
    let changed = false;
    for (const m of t) {
      if (!MEDIA_KINDS.has(m.kind) || m.mediaCleared) continue;
      const old = olderThan && (m.ts || 0) < olderThan;
      if (ids.has(m.id) || (thread && !olderThan) || old) { m.mediaCleared = true; if (m.meta) delete m.meta.thumb; changed = true; forgetMediaMemory(m.id); }
    }
    if (changed) persistField(LS.thread(addr), t);
  }
  refreshOpenChat();
  return { count: ids.size, bytes: list.reduce((n, m) => n + (m.size || 0), 0) };
}

// Reports a corrupt or undecryptable blob separately from an absent key, so corruption is never mistaken for 'no data'.
async function readFieldChecked(lsKey, fallback) {
  const raw = fields.get(lsKey);
  if (raw == null) return { ok: true, value: fallback, corrupt: false };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.__enc || !pinKey) return { ok: false, value: fallback, corrupt: true };
    const pt = await pinDecrypt(pinKey, parsed.ct, parsed.iv);
    return { ok: true, value: JSON.parse(pt), corrupt: false };
  } catch {
    return { ok: false, value: fallback, corrupt: true };
  }
}

async function loadEncryptedState() {
  let corruptCount = 0;
  const pr = await readFieldChecked(PREFS_FIELD, null);
  if (pr.corrupt) corruptCount++;
  prefs = { ...prefs, ...(pr.value || {}) };
  prefs.names = prefs.names && prefs.names.salt ? prefs.names : { salt: b64.enc(crypto.getRandomValues(new Uint8Array(32))), map: {} };
  if (!pr.value) savePrefs();
  restoreTtls();

  for (const k of fields.keys()) {
    const tagOf = (prefix) => k.slice(prefix.length);
    if (k.startsWith(SESSION_FIELD_PREFIX)) {
      const addr = prefs.names.map[tagOf(SESSION_FIELD_PREFIX)];
      if (!addr) continue;                 // a tag nobody knows any more: left for the next clean-up
      const r = await readFieldChecked(k, null);
      if (r.corrupt) { corruptSessions.add(addr); corruptCount++; }
      else if (r.value) sessions.set(addr, r.value);
    } else if (k.startsWith(THREAD_FIELD_PREFIX)) {
      const addr = prefs.names.map[tagOf(THREAD_FIELD_PREFIX)];
      if (!addr) continue;
      const r = await readFieldChecked(k, []);
      if (r.corrupt) { corruptCount++; }
      else { threadCache.set(addr, r.value); lastSavedIds.set(k, new Set((r.value || []).map((m) => m.id))); }
    }
  }
  const reqR = await readFieldChecked(REQ_KEY, {});
  if (reqR.corrupt) { corruptCount++; }
  requests = (reqR.value && typeof reqR.value === 'object') ? reqR.value : {};
  const opkR = await readFieldChecked(OPK_KEY, {});
  if (opkR.corrupt) { corruptCount++; }
  opkCache = opkR.value || {};
  const gwR = await readFieldChecked(GROUP_WAIT_KEY, []);
  if (gwR.corrupt) { corruptCount++; }
  groupWaiting = Array.isArray(gwR.value) ? gwR.value : [];

  // Surface corruption: a corrupt session would silently re-handshake (defeating the pinned-identity check) and a corrupt thread would silently lose history.
  if (corruptCount > 0) {
    _corruptStateCount = corruptCount;
  }
}

function loadSession(addr) {
  if (sessions.has(addr)) return sessions.get(addr);
  return null;
}
function saveSession(addr, s) { sessions.set(addr, s); persistField(LS.session(addr), s); }
function loadThread(addr) {
  if (threadCache.has(addr)) return threadCache.get(addr);
  const t = [];
  threadCache.set(addr, t);
  return t;
}
// Local delete only: the other party keeps their copy.
function deleteMessage(addr, msgId) {
  const t = loadThread(addr).filter(m => m.id !== msgId);
  threadCache.set(addr, t);
  persistField(LS.thread(addr), t);
  forgetMedia(msgId);
  if (selectedGroup) renderGroupConv(); else renderConversation();
}
function clearThread(addr) {
  const t = loadThread(addr);
  forgetThreadMedia(addr);
  threadCache.set(addr, []);
  persistField(LS.thread(addr), []);
  if (selectedGroup) renderGroupConv(); else renderConversation();
}
// True only when this thread is open AND the window is focused and visible; used to decide whether an incoming message needs an unread badge.
function isViewingThread(addr) {
  const open = selectedGroup ? ('grp:' + selectedGroup) : selected;
  return open === addr && document.visibilityState === 'visible' && document.hasFocus();
}

function appendThread(addr, rec) {
  const t = loadThread(addr); t.push(rec);
  threadCache.set(addr, t);
  persistField(LS.thread(addr), t);
  if (rec.dir === 'in' && !isViewingThread(addr)) {
    unreadContacts.set(addr, (unreadContacts.get(addr) || 0) + 1);
    if (addr.startsWith('grp:')) renderGroups(); else renderContacts();
  }
  if (rec.dir === 'in' && rec.kind !== 'system') { playNotification(); notifyIncoming(addr, rec); }
}

// ---- Desktop notifications: a notice from the system when something arrives while the window isn't in front. What it shows is the
// person's choice (Settings → Notifications): the name only (default), the name and the message, or nothing but "New message".
// System notices can outlive the app (notification history, lock screen), which is why the message itself is opt-in.
const NOTIFY_SHOW = ['name', 'full', 'none'];
function notifyOn() {
  // In a plain browser tab they need the browser's permission first; the desktop app shows them itself.
  if (!window.electron?.notify && (typeof Notification === 'undefined' || Notification.permission !== 'granted')) return false;
  try { return localStorage.getItem('anyonechat.notify') !== 'off'; } catch { return true; }
}
function notifyShow() { try { const v = localStorage.getItem('anyonechat.notifyShow'); return NOTIFY_SHOW.includes(v) ? v : 'name'; } catch { return 'name'; } }
function windowInFront() { return document.visibilityState === 'visible' && document.hasFocus(); }
function noticePreview(rec) {
  if (rec.kind === 'text') return String(rec.text || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return t('kind.' + (REPLY_KINDS.has(rec.kind) ? rec.kind : 'file'));
}
function notifyIncoming(key, rec) {
  if (!notifyOn() || windowInFront()) return;
  const isGroup = key.startsWith('grp:');
  const name = isGroup ? (groupById(key.slice(4))?.name || 'AnonChat') : (contactByAddress(key)?.petname || shortAddr(key));
  const show = notifyShow();
  if (show === 'none') return systemNotice('AnonChat', t('notif.newMessage'), key);
  if (show === 'name') return systemNotice(name, t('notif.newMessage'), key);
  systemNotice(name, (isGroup && rec.senderName ? rec.senderName + ': ' : '') + noticePreview(rec), key);
}
// Calls: a notice that stays on screen while it rings (and makes the taskbar or dock ask for attention), taken away once the call is
// answered, declined or missed; a missed call leaves its own notice. Who is calling follows the same setting as messages.
function callNoticeTitle(addr) { return notifyShow() === 'none' ? 'AnonChat' : (contactByAddress(addr)?.petname || shortAddr(addr)); }
function notifyCall(addr) {
  if (!addr || !notifyOn() || windowInFront()) return;
  systemNotice(callNoticeTitle(addr), t('call.incoming'), 'call:' + addr);
}
function notifyMissedCall(addr) {
  if (!addr || !notifyOn() || windowInFront()) return;
  systemNotice(callNoticeTitle(addr), t('call.log.missed'), addr);
}
function notifyRequest() {
  if (!notifyOn() || windowInFront()) return;
  systemNotice('AnonChat', t('req.new'), 'req');      // never a stranger's name or words
}
const _tabNotices = new Map();      // browser tab only: tag -> the Notification on screen, so a call's notice can be taken away
function systemNotice(title, body, tag) {
  if (window.electron?.notify) { try { window.electron.notify({ title, body, tag }); } catch {} return; }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;   // asked for when switched on in Settings
  try {
    const n = new Notification(title, { body, tag, silent: true, requireInteraction: String(tag).startsWith('call:') });
    n.onclick = () => { try { window.focus(); } catch {} openNoticeTarget(tag); n.close(); };
    n.onclose = () => { if (_tabNotices.get(tag) === n) _tabNotices.delete(tag); };
    _tabNotices.set(tag, n);
  } catch {}
}
function closeNotice(tag) {
  if (window.electron?.closeNotice) { try { window.electron.closeNotice(tag); } catch {} return; }
  const n = _tabNotices.get(tag); if (n) { _tabNotices.delete(tag); try { n.close(); } catch {} }
}
function openNoticeTarget(tag) {
  if (typeof tag === 'string' && tag.startsWith('call:')) tag = tag.slice(5);   // the call card is in the window; open their chat too
  if (tag === 'req') { const b = $('#requests-btn'); if (b && !document.getElementById('req-panel')) b.click(); return; }
  if (typeof tag === 'string' && tag.startsWith('grp:')) { const g = groupById(tag.slice(4)); if (g) openGroupChat(g); return; }
  const c = contactByAddress(tag); if (c) openContactChat(c);
}
try { window.electron?.onNoticeClick?.((tag) => openNoticeTarget(tag)); } catch {}

const groupById = (id) => groups.find(g => g.id === id);
async function loadGroups() {
  groups = await fetch('/api/groups').then(r => r.json()).catch(() => []);
  renderGroups();
  prefetchPeers();
}
async function saveGroup(g) {
  await fetch('/api/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(g) });
  groups = await fetch('/api/groups').then(r => r.json()).catch(() => []);
  prefetchPeers();
}
async function deleteGroup(id) {
  await fetch('/api/groups', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  groups = groups.filter(g => g.id !== id);
  prunePeers();
  threadCache.delete('grp:' + id);
  fields.delete(LS.thread('grp:' + id)).catch(() => {});
  forgetThreadMedia('grp:' + id);
}

// A group picture travels as a small image data URL; anything else is ignored.
const GROUP_PIC_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
function cleanGroupPicture(v) { return typeof v === 'string' && v.length <= 300000 && GROUP_PIC_RE.test(v) ? v : undefined; }
// Everything a new member needs to see the group the way the others do.
function groupInviteMeta(g) { return { id: g.id, name: g.name, description: g.description || '', members: g.members, avatar: cleanGroupPicture(g.avatar) }; }
// The admin sends every member the whole list after any change, so all members write to the same people even if an update was missed.
function syncRoster(g, extra = null) {
  return deliverToGroup(g, encodeFrame('group-invite', { ...groupInviteMeta(g), ...(extra || {}) }, new Uint8Array(0))).catch(() => 0);
}
function groupInfoUpdate(g) { return { grp: g.id, action: 'meta', name: g.name, description: g.description || '', avatar: cleanGroupPicture(g.avatar) }; }

// A member whose keys can't be fetched now (offline, and never reached before) gets the message later: it waits here and is encrypted
// and handed to the backend's queue as soon as the keys arrive, in the order written. Only a real refusal counts as failed.
async function deliverToGroup(group, frameBytes) {
  const others = group.members.filter(m => m.address !== myAddress);
  const results = await Promise.allSettled(others.map(async (m) => {
    let holder;
    try { holder = await ensurePeer(m.address); }
    catch (e) { if (e.code === 'IK_MISMATCH') throw e; keepForMember(group.id, m.address, frameBytes); return 'kept'; }
    await sendGroupWaiting(m.address);   // anything older for them goes first
    return deliver(holder, frameBytes, { offlineTtl: OFFLINE_TTL_DEFAULT });   // waits as long as a one-to-one message does by default (24 h), not the queue's 7 days
  }));
  return results.filter(r => r.status === 'rejected').length;
}
const GROUP_WAIT_MS = 24 * 3600 * 1000, GROUP_WAIT_MAX_BYTES = 64 * 1024 * 1024;
function saveGroupWaiting() { persistField(GROUP_WAIT_KEY, groupWaiting); }
function keepForMember(gid, to, frameBytes) {
  groupWaiting.push({ id: crypto.randomUUID(), gid, to, frame: b64.enc(frameBytes), at: Date.now() });
  // A ceiling on what can wait: the oldest go first.
  let total = groupWaiting.reduce((n, w) => n + w.frame.length, 0);
  while (total > GROUP_WAIT_MAX_BYTES && groupWaiting.length > 1) total -= groupWaiting.shift().frame.length;
  saveGroupWaiting();
}
// Everything waiting for one member (or for everyone whose keys we now have), oldest first.
const _groupWaitBusy = new Set();
async function sendGroupWaiting(to = null) {
  const now = Date.now();
  const before = groupWaiting.length;
  groupWaiting = groupWaiting.filter((w) => now - w.at < GROUP_WAIT_MS && groups.some((g) => g.id === w.gid && !g.removedMe && g.members.some((m) => m.address === w.to)));
  if (groupWaiting.length !== before) saveGroupWaiting();
  for (const addr of [...new Set(groupWaiting.filter((w) => !to || w.to === to).map((w) => w.to))]) {
    const holder = keyHolder(addr);
    if (!holder || _groupWaitBusy.has(addr)) continue;
    _groupWaitBusy.add(addr);
    try {
      for (const w of groupWaiting.filter((x) => x.to === addr)) {
        try { await deliver(holder, b64.dec(w.frame), { offlineTtl: OFFLINE_TTL_DEFAULT }); }
        catch (e) { if (!/delivery failed/i.test(e.message || '')) break; }   // refused outright: dropped; anything else: try again later
        groupWaiting = groupWaiting.filter((x) => x !== w);
        saveGroupWaiting();
      }
    } finally { _groupWaitBusy.delete(addr); }
  }
}

// The secret in a group's invite code, kept by the admin only (never in what members receive): a "joined" message counts only with it.
// A new one is made whenever the admin removes someone, so a code they kept stops working.
function newJoinKey() { return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join(''); }

// How the admin appears in a new group's member list: the short address (nobody picks a display name; each member's app shows its own
// nickname for a contact instead). Never "You", which every other member's app would show literally.
function selfGroupName() {
  return myAddress ? shortAddr(myAddress) : 'Member';
}

async function createGroup(name, selectedAddresses, description = '', picture = null) {
  if (!name.trim()) return;
  const others = contacts
    .filter(c => (selectedAddresses || []).includes(c.address))
    .slice(0, MAX_GROUP - 1);
  const self   = { address: myAddress, petname: selfGroupName() };
  const members = [self, ...others.map(c => ({ address: c.address, petname: c.petname }))];
  const group  = { id: crypto.randomUUID(), name: name.trim().slice(0, 60), description: (description || '').slice(0, 280), createdAt: Date.now(), createdBy: myAddress, adminAddr: myAddress, members, joinKey: newJoinKey() };
  if (cleanGroupPicture(picture)) group.avatar = picture;
  await saveGroup(group);
  // Open the group immediately — don't block on network fan-out.
  selected = null; selectedGroup = group.id;
  renderGroups(); renderGroupConv();
  if (others.length) {
    const inviteBytes = encodeFrame('group-invite', groupInviteMeta(group), new Uint8Array(0));
    deliverToGroup(group, inviteBytes)
      .then(failed => toast(failed ? t('groups.partialFail', { n: failed }) : (t('groups.created'))))
      .catch(() => {});
  } else {
    toast(t('groups.createdSolo'));
  }
  return group;
}

async function leaveGroup(group) {
  const adminAddr = group.adminAddr || group.createdBy || (group.members[0] && group.members[0].address);
  const iAmAdmin  = !!myAddress && adminAddr === myAddress;
  const bytes = encodeFrame(iAmAdmin ? 'group-dissolve' : 'group-leave', { grp: group.id }, new Uint8Array(0));
  // The notice is encrypted now and handed to the backend's queue, which delivers it in the background (and keeps trying for anyone
  // offline). Waiting for every member's node to answer used to hold the group on screen for minutes when one was offline. Members
  // whose keys we never had are skipped: nothing was ever exchanged with them, and fetching their keys could take as long.
  const to = group.members.filter(m => m.address !== myAddress).map(m => keyHolder(m.address)).filter(Boolean);
  await Promise.allSettled(to.map(c => deliver(c, bytes, { queueOnly: true })));
  await deleteGroup(group.id);
  if (selectedGroup === group.id) { selectedGroup = null; renderConversation(); }
  renderGroups();
  toast(t('groups.left'));
}
// The processed-id set guards against handling the same envelope twice (WebSocket push + poll); kept in memory and persisted only on change.
let _processedCache = null;
function processedSet() {
  if (_processedCache) return _processedCache;
  try { _processedCache = new Set(JSON.parse(localStorage.getItem(LS.processed) || '[]')); }
  catch { _processedCache = new Set(); }
  return _processedCache;
}
function markProcessed(id) {
  const set = processedSet();
  if (set.has(id)) return;
  set.add(id);
  let arr = [...set];
  if (arr.length > 5000) { arr = arr.slice(arr.length - 5000); _processedCache = new Set(arr); }
  localStorage.setItem(LS.processed, JSON.stringify(arr));
}

function encodeFrame(kind, meta, payload) {
  // at: when it was written, by the writer's clock (inside the encryption). Compared only with other times from the same writer (see
  // "late copy" in handleInbound), so clocks that differ between computers don't matter.
  const head = te.encode(JSON.stringify({ kind, meta: { ...(meta || {}), at: Date.now() } }));
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, head.length);
  return concat(len, head, payload || new Uint8Array(0));
}
function decodeFrame(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hl = dv.getUint32(0);
  const head = JSON.parse(td.decode(bytes.slice(4, 4 + hl)));
  return { kind: head.kind, meta: head.meta, payload: bytes.slice(4 + hl) };
}

// Read receipts are sent only when enabled in Settings (off by default).

let _readReceiptsEnabled = false;
async function refreshReadReceiptSetting() {
  try {
    const s = await fetch('/api/settings').then(r => r.json());
    _readReceiptsEnabled = !!s.readReceipts;
  } catch {}
}

function markMessagesRead(addr, ids) {
  if (!ids || !ids.length) return;
  const thread = loadThread(addr);
  const set = new Set(ids);
  let changed = false;
  for (const m of thread) {
    if (m.dir === 'out' && set.has(m.id) && !m.read) { m.read = true; changed = true; }
  }
  if (!changed) return;
  threadCache.set(addr, thread);
  persistField(LS.thread(addr), thread);
  if (selected === addr) renderConversation();
}

async function sendReadReceipt(contact, ids) {
  if (!ids.length) return;
  await deliver(contact, encodeFrame('read', { ids }, new Uint8Array(0)));
}

function sendPendingReadReceipts(contact) {
  if (!_readReceiptsEnabled) return;
  const thread = loadThread(contact.address);
  const pending = thread.filter(m => m.dir === 'in' && !m.receipt_sent);
  if (!pending.length) return;
  const ids = pending.map(m => m.id);
  const updated = thread.map(m => pending.some(p => p.id === m.id) ? { ...m, receipt_sent: true } : m);
  threadCache.set(contact.address, updated);
  persistField(LS.thread(contact.address), updated);
  sendReadReceipt(contact, ids).catch(() => {});
}

// The PIN protects the identity keys (ikPrivJwk, spk, ikSig) with AES-GCM: a wrong PIN fails authenticated decryption, and the plaintext keys are never stored. Key derivation: PBKDF2-SHA-256 with a per-installation random salt; the iteration count is stored with the salt so it can be raised later.
// In the desktop app the key also depends on a device share kept in the OS vault (or under a passphrase), so a copy of this storage can't
// be brute-forced through the PIN's 1,000,000 values (see "The device's share of the key" below). In browser mode the PIN alone protects it.

const PIN_SALT_KEY   = 'anyonechat.pin.salt';
const PIN_ITER_KEY   = 'anyonechat.pin.iter';
const PIN_IK_CT_KEY  = 'anyonechat.ik.ct';
const PIN_IK_IV_KEY  = 'anyonechat.ik.iv';
const PIN_SPK_CT_KEY = 'anyonechat.spk.ct';
const PIN_SPK_IV_KEY = 'anyonechat.spk.iv';
const PIN_SIG_CT_KEY = 'anyonechat.iksig.ct';
const PIN_SIG_IV_KEY = 'anyonechat.iksig.iv';
// Every ciphertext/IV pair that pinSaveKeys writes and pinLoadKeys reads. changePin must re-key ALL of them.
const PIN_KEY_PAIRS = [[PIN_IK_CT_KEY, PIN_IK_IV_KEY], [PIN_SPK_CT_KEY, PIN_SPK_IV_KEY], [PIN_SIG_CT_KEY, PIN_SIG_IV_KEY]];
const PIN_LEN        = 6;
const PIN_ITERATIONS   = 600_000;

function pinIterations() {
  const stored = parseInt(localStorage.getItem(PIN_ITER_KEY) || '', 10);
  if (Number.isInteger(stored) && stored > 0) return stored;
  return PIN_ITERATIONS;
}

async function pinDerive(pin, saltB64, iterations = pinIterations()) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64.dec(saltB64), iterations, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// ---- The device's share of the key (desktop app) ----
// The desktop app keeps a random data key in the operating system's vault (or under a passphrase) and gives this page its share of it.
// Storage keys then come from the PIN AND that share: a copy of this storage can't be unlocked by trying the PIN's million values,
// because the share never leaves the vault. With a passphrase, the share alone unlocks (the passphrase was typed at start), and there is
// no PIN. In browser mode there is no share and the PIN alone protects the storage, as before.
//   anyonechat.pin.kdf: absent = PIN only (browser mode) · '2' = PIN + device · 'device' (passphrase mode)
const PIN_KDF_KEY = 'anyonechat.pin.kdf';
let securityInfo = null;          // { mode: 'os' | 'passphrase', vault, windowKey, minPassphrase } from the desktop app, or null
let deviceShare = null;           // Uint8Array(32)
// A backup opened on the welcome screen of a fresh install, waiting to be put in place once a PIN or passphrase has been chosen.
let pendingRestore = null;
async function loadSecurityInfo() {
  try { securityInfo = (await window.electron?.securityInfo?.()) || null; } catch { securityInfo = null; }
  deviceShare = securityInfo?.windowKey ? b64.dec(securityInfo.windowKey) : null;
  return securityInfo;
}
function storageKdf() { return localStorage.getItem(PIN_KDF_KEY) || '1'; }
async function hkdfKey(ikm, saltBytes, info) {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: new TextEncoder().encode(info) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
// PIN + device share (kdf '2').
async function pinDeviceKey(pin, saltB64, iterations = pinIterations()) {
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: b64.dec(saltB64), iterations, hash: 'SHA-256' }, km, 256));
  const ikm = new Uint8Array(64); ikm.set(bits, 0); ikm.set(deviceShare, 32);
  return hkdfKey(ikm, b64.dec(saltB64), 'anonchat pin+device v2');
}
// Device share only (kdf 'device': passphrase mode).
function deviceOnlyKey() { return hkdfKey(deviceShare, new Uint8Array(16), 'anonchat device only v2'); }
// The key for a PIN under whichever scheme this storage uses now.
function keyForPin(pin, saltB64, kdf = storageKdf()) {
  if (kdf === '2') { if (!deviceShare) throw new Error('device key unavailable'); return pinDeviceKey(pin, saltB64); }
  return pinDerive(pin, saltB64);
}

async function pinEncrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { ct: b64.enc(new Uint8Array(ct)), iv: b64.enc(iv) };
}
async function pinDecrypt(key, ctB64, ivB64) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64.dec(ivB64) }, key, b64.dec(ctB64));
  return new TextDecoder().decode(pt);
}

async function pinSaveKeys(key) {
  const { ct: ikCt, iv: ikIv } = await pinEncrypt(key, JSON.stringify({ priv: ikPrivJwk, pub: ikPub }));
  const { ct: sCt,  iv: sIv  } = await pinEncrypt(key, JSON.stringify(spk));
  localStorage.setItem(PIN_IK_CT_KEY,  ikCt); localStorage.setItem(PIN_IK_IV_KEY, ikIv);
  localStorage.setItem(PIN_SPK_CT_KEY, sCt);  localStorage.setItem(PIN_SPK_IV_KEY, sIv);
  if (ikSig) {
    const { ct: gCt, iv: gIv } = await pinEncrypt(key, JSON.stringify(ikSig));
    localStorage.setItem(PIN_SIG_CT_KEY, gCt); localStorage.setItem(PIN_SIG_IV_KEY, gIv);
  }
}
async function pinLoadKeys(key) {
  const ikCt = localStorage.getItem(PIN_IK_CT_KEY);
  const ikIv = localStorage.getItem(PIN_IK_IV_KEY);
  if (!ikCt || !ikIv) return false;
  const ik  = JSON.parse(await pinDecrypt(key, ikCt, ikIv));
  ikPrivJwk = ik.priv; ikPub = ik.pub;
  const sCt = localStorage.getItem(PIN_SPK_CT_KEY);
  const sIv = localStorage.getItem(PIN_SPK_IV_KEY);
  if (sCt && sIv) spk = JSON.parse(await pinDecrypt(key, sCt, sIv));
  const gCt = localStorage.getItem(PIN_SIG_CT_KEY);
  const gIv = localStorage.getItem(PIN_SIG_IV_KEY);
  if (gCt && gIv) ikSig = JSON.parse(await pinDecrypt(key, gCt, gIv));
  return true;
}

// Re-encrypts all at-rest data from oldKey to newKey. Everything is decrypted and re-encrypted into a staging map first; only if all of it
// succeeds is anything written, so a wrong key or corrupt blob can't leave a half-migrated store. finalize() writes the new key's
// parameters (salt, scheme) last: a crash mid-write leaves the old parameters able to read any not-yet-overwritten old ciphertext.
async function rekeyStorage(oldKey, newKey, finalize) {
  await Promise.allSettled([...persistQueues.values()]);      // let writes already queued under the old key land first
  const staged = new Map();
  const reKeyPair = async (ctKey, ivKey) => {
    const ct = localStorage.getItem(ctKey), iv = localStorage.getItem(ivKey);
    if (!ct || !iv) return;
    const pt = await pinDecrypt(oldKey, ct, iv);
    const r  = await pinEncrypt(newKey, pt);
    staged.set(ctKey, r.ct); staged.set(ivKey, r.iv);
  };
  for (const [ctKey, ivKey] of PIN_KEY_PAIRS) await reKeyPair(ctKey, ivKey);
  const stagedFields = new Map();
  for (const k of fields.keys()) {
    let parsed;
    try { parsed = JSON.parse(fields.get(k)); } catch { continue; }
    if (!parsed || !parsed.__enc) continue;
    const pt = await pinDecrypt(oldKey, parsed.ct, parsed.iv);
    const r  = await pinEncrypt(newKey, pt);
    stagedFields.set(k, JSON.stringify({ __enc: 1, ct: r.ct, iv: r.iv }));
  }
  for (const [k, v] of stagedFields) await fields.set(k, v);
  for (const [k, v] of staged) localStorage.setItem(k, v);
  finalize();
}
async function verifyKey(key) {
  const ikCt = localStorage.getItem(PIN_IK_CT_KEY), ikIv = localStorage.getItem(PIN_IK_IV_KEY);
  if (ikCt && ikIv) { await pinDecrypt(key, ikCt, ikIv); return; }
  for (const k of fields.keys()) {
    try { const p = JSON.parse(fields.get(k)); if (p && p.__enc) { await pinDecrypt(key, p.ct, p.iv); return; } } catch (e) { if (e && e.name === 'OperationError') throw e; }
  }
  throw new Error('nothing to verify against');
}
// A new PIN (Change PIN, or leaving passphrase mode): new salt, and the device share included whenever there is one.
async function setNewPin(fromKey, newPin) {
  if (!newPin || newPin.length < PIN_LEN) throw shownError(t('settings.pinTooShort'));
  const newSalt = b64.enc(crypto.getRandomValues(new Uint8Array(16)));
  const kdf = deviceShare ? '2' : '1';
  const newKey = kdf === '2' ? await pinDeviceKey(newPin, newSalt, PIN_ITERATIONS) : await pinDerive(newPin, newSalt, PIN_ITERATIONS);
  await rekeyStorage(fromKey, newKey, () => {
    localStorage.setItem(PIN_SALT_KEY, newSalt);
    localStorage.setItem(PIN_ITER_KEY, String(PIN_ITERATIONS));
    if (kdf === '2') localStorage.setItem(PIN_KDF_KEY, '2'); else localStorage.removeItem(PIN_KDF_KEY);
  });
  pinKey = newKey;
}
async function changePin(oldPin, newPin) {
  if (!newPin || newPin.length < PIN_LEN) throw shownError(t('settings.pinTooShort'));
  const salt = localStorage.getItem(PIN_SALT_KEY);
  if (!salt) throw new Error('no PIN is currently set');
  let oldKey;
  try { oldKey = await keyForPin(oldPin, salt); await verifyKey(oldKey); }
  catch { throw shownError(t('settings.pinWrong')); }
  await setNewPin(oldKey, newPin);
}
// Passphrase mode: storage moves to the device share alone (the passphrase typed at start already protects it).
async function storageToDeviceOnly() {
  if (!deviceShare || storageKdf() === 'device') return;
  const newKey = await deviceOnlyKey();
  await rekeyStorage(pinKey, newKey, () => localStorage.setItem(PIN_KDF_KEY, 'device'));
  pinKey = newKey;
}

function initPinScreen() {
  const screen  = $('#pin-screen');
  const subEl   = $('#pin-sub');
  const dotsEl  = $('#pin-dots');
  const errEl   = $('#pin-error');
  const hintEl  = $('#pin-hint');
  const okBtn   = $('#pin-ok');
  const clrBtn  = $('#pin-clear');
  const dots    = Array.from(dotsEl.querySelectorAll('span'));
  const hasSalt = !!localStorage.getItem(PIN_SALT_KEY);
  const hasKeys = !!localStorage.getItem(PIN_IK_CT_KEY);
  let digits    = '';
  // A returning user has saved keys and either a PIN (salt) or passphrase mode ('device': no PIN). Passphrase mode has no salt, and
  // treating it as a first launch would start over with new identity keys on every restart.
  let mode      = hasKeys && (hasSalt || storageKdf() === 'device') ? 'enter' : 'setup';
  let setupFirst = '';
  let _pinAttempts = 0;
  let _pinLockUntil = 0;
  let passFormOpen = false;

  return new Promise(resolve => {
    (async () => {
      await loadSecurityInfo();
      // Passphrase mode: the passphrase typed on the start screen already unlocked this computer's key; there is no PIN.
      if (deviceShare && (storageKdf() === 'device' || (mode === 'setup' && securityInfo?.mode === 'passphrase'))) {
        try {
          const key = await deviceOnlyKey();
          if (mode === 'setup') { await showWelcome(); localStorage.setItem(PIN_KDF_KEY, 'device'); pinKey = key; dismiss(true); return; }
          await pinLoadKeys(key);
          pinKey = key;
          dismiss(false);
          return;
        } catch { /* fall through to the PIN screen; its error explains */ }
      }
      if (mode === 'setup') {
        await showWelcome();
      }
      boot();
      if (mode === 'setup' && deviceShare && securityInfo?.mode === 'os' && window.electron?.setPassphrase) offerPassphrase();
    })();

    // First launch in the desktop app: a quiet link under the keypad to protect the data with a passphrase instead of the PIN. The same
    // switch as Settings → Security, made before anything is stored: the key leaves the system's vault, and the passphrase is asked for
    // on the start screen from the next launch on.
    function offerPassphrase() {
      const inner = screen.querySelector('.pin-inner');
      const pinParts = [dotsEl, errEl, inner.querySelector('.pin-pad'), hintEl];
      const toPass = el('button', { type: 'button', className: 'pin-alt', innerHTML: KEY_ICON });
      toPass.append(el('span', { textContent: t('pin.usePass') }));
      const form = el('div', { className: 'pin-pass', hidden: true });
      const lead = el('p', { className: 'pin-lead', textContent: t('pin.passLead') });
      const err = el('p', { className: 'changepin-err' });
      const go = el('button', { type: 'button', className: 'pin-go', textContent: t('sec.usePassBtn'), disabled: true });
      const pf = passphraseFields((ready) => { go.disabled = !ready; });
      const toPin = el('button', { type: 'button', className: 'pin-alt', innerHTML: LOCK_ICON_SM });
      toPin.append(el('span', { textContent: t('pin.usePin') }));
      form.append(lead, ...pf.nodes, err, go, toPin);
      inner.append(toPass, form);
      const show = (pass) => {
        passFormOpen = pass;
        for (const n of pinParts) n.hidden = pass;
        toPass.hidden = pass; form.hidden = !pass;
        subEl.textContent = pass ? t('pin.passTitle') : t('pin.setup');
        if (pass) { pf.sync(); setTimeout(() => pf.focus(), 30); } else { pf.clear(); err.textContent = ''; setMode('setup'); }
      };
      toPass.onclick = () => show(true);
      toPin.onclick = () => show(false);
      go.onclick = async () => {
        if (go.disabled) return;
        err.textContent = '';
        go.disabled = toPin.disabled = true; go.textContent = t('sec.saving');
        try {
          const r = await window.electron.setPassphrase(pf.value());
          if (!r || !r.ok) throw new Error(r?.error || 'failed');
          securityInfo.mode = 'passphrase';
          pinKey = await deviceOnlyKey();
          localStorage.setItem(PIN_KDF_KEY, 'device');
          pf.clear();
          dismiss(true);
        } catch {
          err.textContent = t('toast.failed');
          toPin.disabled = false; go.textContent = t('sec.usePassBtn'); pf.sync();
        }
      };
      pf.onEnter(() => go.onclick());
    }

    function syncDots() {
      dots.forEach((d, i) => {
        d.classList.toggle('filled', i < digits.length);
        d.classList.remove('error');
      });
      errEl.textContent = '';
    }
    function shake() {
      dots.forEach(d => d.classList.add('error'));
      screen.style.animation = 'none';
      setTimeout(() => { screen.style.animation = ''; digits = ''; syncDots(); }, 600);
    }
    function setMode(m) {
      mode = m;
      if (m === 'enter') {
        subEl.textContent = t('pin.enter');
        hintEl.textContent = '';
      } else if (m === 'setup') {
        subEl.textContent = t('pin.setup');
        hintEl.textContent = t('pin.setupHint');
      } else if (m === 'confirm') {
        subEl.textContent = t('pin.confirm');
        hintEl.textContent = t('pin.confirmHint');
      }
      digits = ''; syncDots();
    }
    function dismiss(isNewUser) { passFormOpen = false; screen.querySelectorAll('.pin-alt, .pin-pass').forEach((n) => n.remove()); screen.classList.add('gone'); resolve(!!isNewUser); }

    async function submit() {
      if (digits.length !== PIN_LEN) return;
      errEl.textContent = '';

      if (mode === 'enter') {
        // Escalating backoff after wrong attempts: it only slows guessing at the running app (see the PIN limitation above), but makes casual guessing impractical.
        if (_pinLockUntil > Date.now()) {
          const secs = Math.ceil((_pinLockUntil - Date.now()) / 1000);
          shake(); errEl.textContent = t('pin.tooMany', { n: secs });
          return;
        }
        const salt = localStorage.getItem(PIN_SALT_KEY);
        let key;
        try { key = await keyForPin(digits, salt); }
        catch { shake(); errEl.textContent = t('pin.deriveError'); return; }
        try {
          await pinLoadKeys(key);
          pinKey = key;
          _pinAttempts = 0;
          // Passphrase chosen (or a switch to it that was interrupted): storage follows.
          if (securityInfo?.mode === 'passphrase') { try { await storageToDeviceOnly(); } catch {} }
          dismiss();
        } catch {
          _pinAttempts++;
          if (_pinAttempts >= 5) {
            const delay = Math.min(60_000, 1000 * 2 ** (_pinAttempts - 5));
            _pinLockUntil = Date.now() + delay;
          }
          shake(); errEl.textContent = t('pin.incorrect');
        }
      } else if (mode === 'setup') {
        setupFirst = digits;
        setMode('confirm');
      } else if (mode === 'confirm') {
        if (digits !== setupFirst) {
          shake(); errEl.textContent = t('pin.mismatch');
          setMode('setup'); return;
        }
        const saltBytes = crypto.getRandomValues(new Uint8Array(16));
        const saltB64   = b64.enc(saltBytes);
        localStorage.setItem(PIN_SALT_KEY, saltB64);
        localStorage.setItem(PIN_ITER_KEY, String(PIN_ITERATIONS));
        try {
          if (deviceShare) { pinKey = await pinDeviceKey(digits, saltB64, PIN_ITERATIONS); localStorage.setItem(PIN_KDF_KEY, '2'); }
          else pinKey = await pinDerive(digits, saltB64, PIN_ITERATIONS);
        }
        catch { errEl.textContent = t('pin.deriveFailed'); return; }
        dismiss(true);
      }
    }

    function push(d) {
      if (digits.length >= PIN_LEN) return;
      digits += d; syncDots();
      if (digits.length === PIN_LEN) submit();
    }
    function pop() { digits = digits.slice(0, -1); syncDots(); }

    function boot() {
      setMode(mode);
      $('#pin-screen').querySelectorAll('.pin-key[data-n]').forEach(b => b.onclick = () => push(b.dataset.n));
      okBtn.onclick  = () => submit();
      clrBtn.onclick = () => pop();
      document.addEventListener('keydown', function onPinKey(e) {
        if (!screen || screen.classList.contains('gone')) { document.removeEventListener('keydown', onPinKey); return; }
        if (passFormOpen) return;                  // typing a passphrase, not a PIN
        if (e.key >= '0' && e.key <= '9') push(e.key);
        else if (e.key === 'Backspace') pop();
        else if (e.key === 'Enter') submit();
      });
    }
  });
}

async function ensureIdentity() {
  if (!ikPrivJwk) {
    const kp = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
    ikPrivJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    ikPub = b64.enc(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  if (!spk) spk = { ...(await newSpkPair()), created: Date.now(), old: [] };
  // A separate ECDSA identity-signing key signs the SPK, so a peer can verify the prekey is ours.
  if (!ikSig) ikSig = await Ratchet.genSigningKey();
  spkSig = await Ratchet.signSPK(ikSig.priv, spk.pub);
  if (!localStorage.getItem(PIN_IK_CT_KEY)) {
    await pinSaveKeys(pinKey);
  }
  myAvatar = prefs.avatar || null;
  myBio = prefs.bio || null;
  await publishIdentity();
}
async function publishIdentity() {
  await fetch('/api/identity', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ecdhPub: ikPub, ratchetPub: spk.pub, ikSigPub: ikSig.pub, spkSig, avatar: myAvatar, bio: myBio }),
  });
}

// The signed prekey is replaced every week. A first message to us that is sent before we reply (a message request, or the first message
// of a new session) depends on it and on our long-term key only, so replacing it and then deleting the old private half limits what a
// stolen copy of this computer's keys could read later: only first messages from the last SPK_KEEP_MS, not every one ever sent.
// Retired ones are kept that long because a contact's app may still hold an older one (it learns the new one from our profile, see
// server.js maybeRefreshProfile, but only when it next reaches us); a first message is read with whichever one its sender used.
const SPK_ROTATE_MS = 7 * 24 * 3600 * 1000, SPK_KEEP_MS = 60 * 24 * 3600 * 1000, SPK_KEEP_MAX = 12;
async function newSpkPair() {
  const kp = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
  return { priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: b64.enc(await crypto.subtle.exportKey('raw', kp.publicKey)) };
}
// Our signed prekeys, the current one first: only the key pair of each (never the list of retired ones) goes into a session.
function spkCandidates() {
  return [spk, ...((spk && Array.isArray(spk.old)) ? spk.old : [])].filter((k) => k && k.priv && k.pub).map((k) => ({ priv: k.priv, pub: k.pub }));
}
let _spkRotating = false;
async function rotateSpkIfDue(now = Date.now()) {
  if (!spk || !ikSig || !pinKey || _spkRotating) return false;
  _spkRotating = true;
  try {
    const before = JSON.stringify(spk);
    const old = (Array.isArray(spk.old) ? spk.old : []).filter((k) => k && now - (k.retired || 0) < SPK_KEEP_MS);
    // An installation from before rotation existed: its prekey is counted from today.
    let next = { priv: spk.priv, pub: spk.pub, created: Number.isFinite(spk.created) ? spk.created : now, old };
    const due = now - next.created >= SPK_ROTATE_MS;
    if (due) next = { ...(await newSpkPair()), created: now, old: [{ priv: spk.priv, pub: spk.pub, retired: now }, ...old].slice(0, SPK_KEEP_MAX) };
    if (JSON.stringify(next) === before) return false;
    const prevSpk = spk, prevSig = spkSig;
    spk = next;
    if (due) spkSig = await Ratchet.signSPK(ikSig.priv, spk.pub);
    try { await pinSaveKeys(pinKey); }
    catch (e) { spk = prevSpk; spkSig = prevSig; throw e; }          // nothing published that isn't saved
    if (due) {
      await publishIdentity();
      fetch('/api/profile/broadcast', { method: 'POST' }).catch(() => {});   // contacts fetch our profile, which carries the new prekey
    }
    return due;
  } finally { _spkRotating = false; }
}
// For a test (tests/browser/spk_rotation.py): rotate as if `days` had passed, and read what is kept. Exposes nothing a script running in
// this page couldn't reach anyway.
window.__anonchatSpk = { rotate: (days) => rotateSpkIfDue(Date.now() + days * 24 * 3600 * 1000), count: () => spkCandidates().length, pub: () => spk && spk.pub };
// The responder side of a handshake, built with whichever of our signed prekeys the sender used: the first whose session reads this
// message (a handshake doesn't say which one). With only the current one there is nothing to try.
async function respondWithSpk(x3dh, opkPriv, meta, header, ct) {
  const keys = spkCandidates();
  let first = null;
  for (const k of keys) {
    const sk = await Ratchet.x3dhResponder(k.priv, ikPrivJwk, x3dh.ik, x3dh.ek, opkPriv);
    const s = Ratchet.initResponder(sk, k, meta);
    if (keys.length === 1) return s;
    if (!first) first = s;
    try { await Ratchet.ratchetDecrypt(clone(s), header, ct); return s; } catch {}
  }
  return first;
}

fetch('/api/version').then(r => r.json()).then(v => {
  const b = document.querySelector('.brand-version');
  if (b && v.version) b.textContent = 'v' + v.version;
}).catch(() => {});

// "Protected" badge in the conversation header: green once the Anyone network is up, amber while it connects.
let networkReady = false;
const SEARCH_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const GLOBE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
const CHEVRON_ICON = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const RESTORE_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
const BACKUP_FILE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
const KEY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14 9l2 2"/></svg>';
const LOCK_ICON_SM = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
const LOCK_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
function paintLockPill(p) {
  p.classList.toggle('connecting', !networkReady);
  const label = networkReady ? t('conv.protected') : t('conv.connecting');
  p.title = networkReady ? t('conv.lock') : t('conv.connectingTip');
  p.setAttribute('aria-label', label + '. ' + p.title);
  p.querySelector('.lock-label').textContent = label;
}
function makeLockPill() {
  const p = el('span', { className: 'lock-pill' });
  p.innerHTML = LOCK_ICON + '<span class="lock-label"></span>';
  paintLockPill(p);
  return p;
}

async function refreshWhoami() {
  const r = await fetch('/api/whoami').then(r => r.json()).catch(() => ({}));
  const was = networkReady;
  networkReady = r.network === 'ready';
  if (was !== networkReady) document.querySelectorAll('.lock-pill').forEach(paintLockPill);
  const had = myAddress;
  // The address never changes while the app runs (a restore restarts it). A failed check (the backend restarting) must not forget it:
  // a group invite arriving in the seconds before the next check would otherwise not find us in its member list and be dropped.
  myAddress = r.address || had || null;
  // When the address first resolves, circuits are available: flush the outbox so queued messages don't wait.
  if (!had && myAddress) {
    if (contactsReady) syncMailboxKeys().catch(() => {});   // the shared keys include our address: work them out now
    fetch('/api/outbox/flush', { method: 'POST' }).catch(() => {});
  }
  renderIdentityCard();
  return !!myAddress;
}

function pollWhoamiUntilReady() {
  let tries = 0;
  const tick = async () => {
    tries++;
    const ready = await refreshWhoami();
    if (ready || tries > 90) return;   // stop after ~3 min even if not ready
    setTimeout(tick, 2000);
  };
  tick();
}

// Largest picture file accepted for a profile or group picture; it is scaled down to 256 px before it is stored or sent.
const MAX_PICTURE_FILE = 5 * 1024 * 1024;

// JPEG data URL no longer than `limit` characters (lowering the quality until it fits).
function toJpegUnderLimit(canvas, quality = 0.85, limit = 60000) {
  let q = quality, url = canvas.toDataURL('image/jpeg', q);
  while (url.length > limit && q > 0.3) { q -= 0.1; url = canvas.toDataURL('image/jpeg', q); }
  return url;
}

async function resizeImageToDataURL(file, maxSize = 256, quality = 0.85) {
  const objUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('could not read image'));
      i.src = objUrl;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2, sy = (img.naturalHeight - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = maxSize;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, side, side, 0, 0, maxSize, maxSize);
    return toJpegUnderLimit(canvas, quality);
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}
// A group picture as one control, the way your own picture works: the picture is the button, with a small pencil badge. Only the admin
// gets the button; everyone else sees the plain picture. onPick receives the resized image.
function groupPictureControl({ picture, seed, name, size = 64, editable, onPick }) {
  const pic = cleanGroupPicture(picture);
  const face = () => pic ? el('img', { src: pic, className: 'avatar', width: size, height: size, style: `width:${size}px;height:${size}px`, alt: '' })
                         : renderAvatarEl(seed, null, size, '', name || '');
  if (!editable) { const box = el('div', { className: 'grp-pic' }); box.append(face()); return box; }
  const btn = el('button', { type: 'button', className: 'avatar-btn pic-edit' + (pic || name ? '' : ' empty'), title: t('groups.setPic'), 'aria-label': t('groups.setPic') });
  btn.style.width = btn.style.height = size + 'px';
  if (pic || name) btn.append(face());
  else btn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const input = el('input', { type: 'file', accept: 'image/*', hidden: true });
  btn.onclick = () => input.click();
  input.onchange = async () => {
    const f = input.files[0]; input.value = '';
    if (!f) return;
    if (f.size > MAX_PICTURE_FILE) { toast(t('toast.imageTooBig', { mb: MAX_PICTURE_FILE / 1048576 })); return; }
    try { await onPick(await resizeImageToDataURL(f, 256)); }
    catch { toast(t('toast.failed')); }
  };
  const wrap = el('div', { className: 'grp-pic' });
  wrap.append(btn, input);
  return wrap;
}
function renderAvatarEl(address, avatarDataUrl, size, extraClass = '', name = '') {
  const className = 'avatar' + (extraClass ? ' ' + extraClass : '');
  // Only our own kinds of picture: a value of any other type or form (sent by someone else) falls back to the drawn letter instead of
  // throwing and taking the rest of the list with it.
  if (typeof avatarDataUrl === 'string' && /^(?:data:image\/|blob:)/.test(avatarDataUrl)) {
    const img = el('img', { className, src: avatarDataUrl, alt: '', draggable: false });
    img.style.width = img.style.height = size + 'px';
    return img;
  }
  const div = el('div', { className });
  div.innerHTML = fingerprintSVG(address, size, name);
  return div;
}

const GROUP_ICON_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

const CHATSIZE_OPTIONS = ['small', 'medium', 'large', 'xlarge'];
function getChatSize() { return localStorage.getItem('anyonechat.chatsize') || 'medium'; }
function applyChatSize(name) {
  const s = CHATSIZE_OPTIONS.includes(name) ? name : 'medium';
  document.documentElement.setAttribute('data-chatsize', s);
}
function initAppearance() {
  applyChatSize(getChatSize());
}

function initLang() {
  applyI18n();
  // The desktop app's own dialogs and its start screen use the same language as the window.
  try {
    window.electron?.setLanguage?.(getLang(), {
      'link.title': t('link.title'), 'link.message': t('link.message'), 'link.detail': t('link.detail'),
      'link.open': t('link.open'), 'link.cancel': t('nav.cancel'),
      'stopped.title': t('stopped.title'), 'stopped.anon': t('stopped.anon'), 'stopped.other': t('stopped.other'),
    });
  } catch {}
}

// One-time prekeys: each is a fresh ECDH key used in at most one X3DH handshake and then destroyed, which gives the first message real forward secrecy.
// The backend hands them out sparingly (server.js, takeOpkToken) and keeps at most 100 waiting. Here each private half is stored as
// { k: jwk, out }, where `out` is when this window first noticed the key had been handed out: within a minute of it, since this runs
// every minute. A handed-out key no first message used is forgotten OPK_KEEP_MS after that, and at most OPK_KEEP_MAX are kept, so
// someone asking for our identity over and over can't make this storage grow.
const OPK_TARGET_MIN = 10;
const OPK_TARGET_MAX = 100;
const OPK_KEEP_MS = 14 * 24 * 3600 * 1000;
// Room for every key the backend can hand out in that time (20 at once, then 10 an hour: about 3,400 in 14 days), so asking for our keys
// over and over can't push out one a real contact is about to use.
const OPK_KEEP_MAX = 4000;
// The other side: a key we were handed is used only for this long, well inside OPK_KEEP_MS.
const OPK_USE_MS = 7 * 24 * 3600 * 1000;
let opkTarget   = OPK_TARGET_MIN;
let opkLastSeen = null;

// OPK private keys are persisted encrypted-at-rest; leaving them in plaintext would undercut the forward secrecy they exist to provide.
function loadOPKs() { return opkCache; }
function saveOPKs(o) { opkCache = o; persistField(OPK_KEY, o); }

async function ensurePrekeys() {
  let ids;
  try { ({ ids } = await fetch('/api/prekeys').then(r => r.json())); }
  catch { return; }
  if (!Array.isArray(ids)) return;
  const count = ids.length;

  if (opkLastSeen !== null) {
    const claimed = Math.max(0, opkLastSeen - count);
    if (claimed >= Math.max(3, Math.floor(opkTarget * 0.4))) {
      opkTarget = Math.min(OPK_TARGET_MAX, opkTarget * 2);
    } else if (claimed === 0 && count >= opkTarget * 0.9 && opkTarget > OPK_TARGET_MIN) {
      opkTarget = Math.max(OPK_TARGET_MIN, Math.floor(opkTarget / 2));
    }
  }
  opkLastSeen = count;

  const opks = loadOPKs();
  const waiting = new Set(ids);
  const now = Date.now();
  let changed = false;
  const handedOut = [];
  for (const [id, o] of Object.entries(opks)) {
    if (waiting.has(id)) continue;
    if (!o || typeof o !== 'object' || !o.k) { delete opks[id]; changed = true; continue; }
    if (!o.out) { o.out = now; changed = true; }
    if (now - o.out > OPK_KEEP_MS) { delete opks[id]; changed = true; }
    else handedOut.push([id, o.out]);
  }
  if (handedOut.length > OPK_KEEP_MAX) {
    handedOut.sort((x, y) => x[1] - y[1]);
    for (const [id] of handedOut.slice(0, handedOut.length - OPK_KEEP_MAX)) delete opks[id];
    changed = true;
  }

  // A waiting key whose private half is gone (storage cleared, say) would make that sender's first message unreadable: withdraw it.
  const drop = ids.filter((id) => !opks[id]);
  const usable = count - drop.length;
  const lowWater = Math.max(4, Math.floor(opkTarget * 0.4));
  const upload = [];
  if (usable < lowWater) {
    for (let i = 0; i < opkTarget - usable; i++) {
      const kp = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
      const id = crypto.randomUUID();
      opks[id] = { k: await crypto.subtle.exportKey('jwk', kp.privateKey) };
      upload.push({ id, pub: b64.enc(await crypto.subtle.exportKey('raw', kp.publicKey)) });
    }
    changed = true;
  }
  if (changed) saveOPKs(opks);           // the private halves are stored before the public halves go out
  if (!upload.length && !drop.length) return;
  try {
    const r = await fetch('/api/prekeys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys: upload, drop }) }).then(r => r.json());
    opkLastSeen = Array.isArray(r?.ids) ? r.ids.length : opkTarget;
  } catch {}
}
let _bioEditingActive = false;

// Profile picture size on the identity card (stored pictures are 128 px).
const ME_AVATAR_SIZE = 96;

function renderIdentityCard() {
  if (_bioEditingActive) return;        // never tear down an open editor
  const box = $('#me'); box.innerHTML = '';

  const top = el('div', { className: 'me-top' });
  const avatarBtn = el('button', { className: 'avatar-btn', type: 'button', title: t('nav.setPic') });
  avatarBtn.append(renderAvatarEl(myAddress || 'pending', myAvatar, ME_AVATAR_SIZE));
  avatarBtn.onclick = () => $('#avatar-input').click();
  const meta = el('div', { className: 'me-meta' });
  const addrRow = el('div', { className: 'me-addr-row' });
  const copy = el('button', { className: 'icon-btn', title: t('nav.copy'), textContent: '⧉' });
  copy.onclick = async () => { if (!myAddress) return; await navigator.clipboard.writeText(myAddress); copy.textContent = '✓'; setTimeout(() => (copy.textContent = '⧉'), 1500); };
  addrRow.append(el('div', { className: 'me-addr', title: myAddress || '', textContent: myAddress ? shortAddr(myAddress) : 'publishing…' }), copy);
  meta.append(el('div', { className: 'me-label', textContent: t('nav.myIdentity') }), addrRow);
  top.append(avatarBtn, meta);
  box.append(top);

  if (myBio) box.append(el('div', { className: 'me-bio', textContent: myBio, title: myBio }));

  const actions = el('div', { className: 'me-actions' });
  const bioBtn = el('button', { className: 'me-action-btn', type: 'button', textContent: myBio ? t('nav.editBio') : t('nav.addBio') });
  bioBtn.onclick = () => editBio();
  actions.append(bioBtn);
  box.append(actions);
}

function highlightShareAddress() {
  const box = $('#me');
  if (!box) return;
  box.classList.add('share-pulse');
  const hint = el('div', { className: 'share-hint', textContent: t('nav.shareHint') });
  box.append(hint);
  setTimeout(() => { box.classList.remove('share-pulse'); hint.remove(); }, 9000);
}

function editBio() {
  _bioEditingActive = true;
  const box = $('#me');
  const old = box.querySelector('.me-actions');
  if (old) old.remove();
  const oldBio = box.querySelector('.me-bio');
  if (oldBio) oldBio.remove();

  const wrap = el('div', { className: 'me-bio-edit' });
  const input = el('input', { type: 'text', className: 'me-bio-input', maxLength: 140, value: myBio || '', placeholder: t('nav.bioPlaceholder') });
  const save = el('button', { className: 'me-action-btn', type: 'button', textContent: t('nav.save') });
  const cancel = el('button', { className: 'me-action-btn', type: 'button', textContent: t('nav.cancel') });
  wrap.append(input, save, cancel);
  box.append(wrap);
  input.focus();
  input.onkeydown = (e) => { if (e.key === 'Enter') save.click(); if (e.key === 'Escape') cancel.click(); };

  cancel.onclick = () => { _bioEditingActive = false; renderIdentityCard(); };
  save.onclick = async () => {
    myBio = input.value.trim().slice(0, 140) || null;
    prefs.bio = myBio || ''; savePrefs();
    try {
      await fetch('/api/identity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ecdhPub: ikPub, ratchetPub: spk.pub, bio: myBio }),
      });
      fetch('/api/profile/broadcast', { method: 'POST' }).catch(() => {});
    } catch { toast(t('toast.bioFail')); }
    _bioEditingActive = false;
    renderIdentityCard();
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') save.onclick();
    if (e.key === 'Escape') cancel.onclick();
  });
}

// Inbound messages wait for the first contact list: until then every contact would look like a stranger and skip the identity-key pin.
let _contactsLoadedResolve, contactsReady = false;
const contactsLoaded = new Promise((r) => { _contactsLoadedResolve = r; });
async function loadContacts() {
  const prev = contacts;
  const [list, peerList] = await Promise.all([
    fetch('/api/contacts').then(r => (r.ok ? r.json() : null)).catch(() => null),
    fetch('/api/peers').then(r => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (!Array.isArray(list)) return;      // keep the last good list: an empty one would also turn contacts into strangers
  contacts = list;
  if (Array.isArray(peerList)) peers = peerList;
  _contactsLoadedResolve();
  contactsReady = true;
  syncMailboxKeys().catch(() => {});
  absorbRequestsOfContacts();
  renderContacts();
  renderRequests();
  if (selected) {
    const before = (prev || []).find(c => c.address === selected);
    const after  = contacts.find(c => c.address === selected);
    if (after && before && (before.avatar !== after.avatar || before.bio !== after.bio || before.name !== after.name)) {
      renderConversation();
    }
  }
}
function contactByAddress(a) { return contacts.find(c => c.address === a); }

// ---- Group members who aren't contacts ("peers") ----
// Everyone in a group writes to everyone else directly, so a member we never added still needs keys. They are fetched from the member's
// own .anyone address (as for a contact) and pinned: a handshake claiming to be that member with any other key is refused.
let peers = [];
const _peerFetches = new Map();
function peerByAddress(a) { return peers.find(p => p.address === a); }
function inAnyGroup(a) { return groups.some(g => g.members.some(m => m.address === a)); }
// The keys to use for someone: theirs as a contact if they are one, otherwise as a group member.
function keyHolder(a) { return contactByAddress(a) || peerByAddress(a) || null; }
async function ensurePeer(addr) {
  const known = keyHolder(addr);
  if (known) return known;
  if (_peerFetches.has(addr)) return _peerFetches.get(addr);
  const job = (async () => {
    const res = await fetch('/api/peers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: addr }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || 'could not reach group member'); if (data.error === 'key_mismatch') e.code = 'IK_MISMATCH'; throw e; }
    if (!peerByAddress(addr)) peers.push(data);
    ensureMailboxKey(data).catch(() => {});
    if (groupWaiting.some((w) => w.to === addr)) setTimeout(() => sendGroupWaiting(addr).catch(() => {}), 0);
    return data;
  })();
  _peerFetches.set(addr, job);
  try { return await job; } finally { _peerFetches.delete(addr); }
}
// Fetch keys for every group member we can't write to yet, in the background, so the first group message doesn't wait on it.
function prefetchPeers() {
  for (const g of groups) for (const m of g.members) {
    if (m.address && m.address !== myAddress && !keyHolder(m.address)) ensurePeer(m.address).catch(() => {});
  }
}
// Forget the keys of people who are in none of our groups any more, or who have since become contacts.
function prunePeers() {
  let removed = 0;
  for (const p of peers.slice()) {
    if (inAnyGroup(p.address) && !contactByAddress(p.address)) continue;
    peers = peers.filter(x => x !== p);
    removed++;
    if (!contactByAddress(p.address) && !requests[p.address]) discardSession(p.address);
    fetch('/api/peers', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: p.address }) }).catch(() => {});
  }
  if (removed) syncMailboxKeys().catch(() => {});
}
// ---- Mailbox keys (lib/stamp.js) ----
// Each contact and group member shares a key with us that only the two of us can work out: HKDF over the ECDH of our identity keys.
// The backend stamps every message to them with it and checks the stamp on every message claiming to be from them, so nobody else can
// borrow a contact's inbox allowance by writing their address on a message. Worked out here because only the window holds our
// identity key; the backend gets the result.
const _mboxKeys = new Map();             // address|their identity key -> our shared key (base64)
const _mboxGiven = new Map();            // address -> the key the backend has
let _mboxChain = Promise.resolve();
async function mailboxKeyFor(holder) {
  if (!holder?.address || !holder.ecdhPub || !ikPrivJwk || !myAddress) return null;
  const ck = holder.address + '|' + holder.ecdhPub;
  if (_mboxKeys.has(ck)) return _mboxKeys.get(ck);
  const priv = await crypto.subtle.importKey('jwk', ikPrivJwk, EC, false, ['deriveBits']);
  const pub = await crypto.subtle.importKey('raw', b64.dec(holder.ecdhPub), EC, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256);
  const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const pair = [myAddress, holder.address].sort().join('|');
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('anonchat mailbox v1|' + pair) }, hk, 256);
  const key = b64.enc(new Uint8Array(bits));
  _mboxKeys.set(ck, key);
  return key;
}
function postMailboxKeys(keys, replace) {
  return fetch('/api/mailbox-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys, replace }) })
    .then((r) => { if (!r.ok) throw new Error('mailbox keys refused'); });
}
// The full set, for everyone we have keys for (at start and whenever the contact or member lists change).
function syncMailboxKeys() {
  _mboxChain = _mboxChain.catch(() => {}).then(async () => {
    if (!ikPrivJwk || !myAddress) return;
    const holders = [...contacts, ...peers.filter((p) => !contactByAddress(p.address))];
    const keys = [];
    for (const h of holders) { const key = await mailboxKeyFor(h).catch(() => null); if (key) keys.push({ address: h.address, key }); }
    await postMailboxKeys(keys, true);
    _mboxGiven.clear();
    for (const k of keys) _mboxGiven.set(k.address, k.key);
  });
  return _mboxChain;
}
// Just this one, before the first message to someone the backend may not have a key for yet.
function ensureMailboxKey(holder) {
  _mboxChain = _mboxChain.catch(() => {}).then(async () => {
    const key = await mailboxKeyFor(holder);
    if (!key || _mboxGiven.get(holder.address) === key) return;
    await postMailboxKeys([{ address: holder.address, key }], false);
    _mboxGiven.set(holder.address, key);
  });
  return _mboxChain;
}

async function addContact(petname, address) {
  const clean = address.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (myAddress && clean === myAddress) throw shownError(t('contacts.ownAddress'));
  const already = contactByAddress(clean);
  if (already) throw shownError(t('contacts.exists', { name: already.petname }));
  const res = await fetch('/api/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ petname, address }) });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    if (e.error === 'own_address') throw shownError(t('contacts.ownAddress'));
    if (e.error === 'already_contact') { await loadContacts(); throw shownError(t('contacts.exists', { name: contactByAddress(clean)?.petname || shortAddr(clean) })); }
    if (e.error === 'key_mismatch') throw shownError(t('contacts.keyMismatch'));
    throw new Error(e.error || 'could not add contact');
  }
  // Adding someone again after removing them: the session kept from before is set aside, so the first message carries a new handshake.
  // Their app then shows it as a message request if they removed us too, and we write text only until they accept or answer, as with
  // anyone new. Kept when they have a request waiting here (it is read with that session) or share a group with us (in use there).
  const a = address.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!requests[a] && !inAnyGroup(a) && loadSession(a)) discardSession(a);
  await loadContacts();
  prunePeers();                          // a group member just added as a contact: the contact's keys take over
  if (!selected && !selectedGroup) renderConversation();
}
// The chat history goes. The encrypted session stays (unless blocking): their app still uses it, so whatever they write next can be read
// and arrives as a message request, instead of being lost unreadable. Nothing is sent to them. Accepting it checks the key served at
// their address against the one this session was made with, as for any request.
async function removeContact(address, { keepSession = true } = {}) {
  await fetch('/api/contacts', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }) });
  fields.delete(LS.thread(address)).catch(() => {});
  forgetThreadMedia(address);
  threadCache.delete(address);
  if (!keepSession) { fields.delete(LS.session(address)).catch(() => {}); sessions.delete(address); corruptSessions.delete(address); }
  if (selected === address) selected = null;
  await loadContacts(); renderConversation();
}

// ---- Message requests ----
// A direct message from someone who isn't a contact is held as a request. Until it is accepted nothing reaches the sender: no read
// receipts, no profile fetch, no ringing, no media shown, no group joined. Accepting fetches the sender's key from their own address
// (only its real owner can answer) and requires it to be the key the request was made with, so a forged request can't be accepted.
const REQ_KEY = 'anyonechat.requests';
const MAX_REQUESTS = 50, MAX_REQ_ITEMS = 20, REQ_TTL_MS = 30 * 24 * 3600 * 1000, MAX_REQ_BLOB_BYTES = 25 * 1024 * 1024;
let requests = {};                       // address -> { address, name, firstAt, lastAt, items: [...], invite }
const requestBlobs = new Map();          // item id -> Blob: a stranger's attachment stays in memory only, and is stored once accepted
let _requestBlobBytes = 0;

function saveRequests() { persistField(REQ_KEY, requests); }
// A request is shown by its .anyone address only: AnonChat has no self-chosen display names, and nothing the sender claims is trusted.
function requestName(r) { return shortAddr(r.address); }
function dropRequestBlobs(r) {
  for (const it of r.items || []) {
    const b = requestBlobs.get(it.id);
    if (b) { _requestBlobBytes -= b.size; requestBlobs.delete(it.id); }
  }
}
// keepSession: a deleted request keeps the hidden session, so the sender's next message can still be read and opens a new request.
function forgetRequest(addr, { keepSession = true } = {}) {
  const r = requests[addr];
  if (r) dropRequestBlobs(r);
  delete requests[addr];
  if (!keepSession) discardSession(addr);
  if (expandedRequest === addr) expandedRequest = null;
  saveRequests();
}
function expireRequests() {
  const now = Date.now();
  for (const r of Object.values(requests)) if (now - (r.lastAt || 0) > REQ_TTL_MS) forgetRequest(r.address, { keepSession: false });
}

// Direct traffic from a non-contact. Group messages from a fellow member are not requests: they keep the normal group path.
function isGroupFrameFromMember(from, frame) {
  // An invite names its group by id (it is also how a group's admin re-sends the full member list): for a group we already have, it
  // belongs to that group, not to the message requests.
  const gid = frame.meta?.grp || (frame.kind === 'group-invite' && typeof frame.meta?.id === 'string' && groupById(frame.meta.id) ? frame.meta.id : null);
  const g = gid ? groupById(gid) : null;
  if (!g) return false;
  if (g.members.some((m) => m.address === from)) return true;
  // Joining with an invite code: the newcomer isn't a member yet and tells the admin (us) they joined.
  const admin = g.adminAddr || g.createdBy || (g.members[0] && g.members[0].address);
  return frame.kind === 'group-update' && frame.meta?.action === 'joined' && admin === myAddress;
}
function addToRequest(env, frame) {
  const k = frame.kind;
  if (k === 'read' || k === 'reaction' || k === 'accept' || k === 'request') return;
  if (k.startsWith('group-') && k !== 'group-invite') return;
  if (k === 'call' && frame.meta?.op !== 'invite') return;
  const now = Date.now();
  let r = requests[env.from];
  const isNew = !r;
  if (!r) {
    const all = Object.values(requests);
    if (all.length >= MAX_REQUESTS) {
      const oldest = all.reduce((a, b) => ((a.lastAt || 0) <= (b.lastAt || 0) ? a : b));
      forgetRequest(oldest.address, { keepSession: false });
    }
    r = requests[env.from] = { address: env.from, firstAt: now, lastAt: now, items: [], invite: null };
  }
  const id = (typeof frame.meta?.mid === 'string' && frame.meta.mid) ? frame.meta.mid.slice(0, 80) : env.id;
  if (r.items.some((x) => x.id === id)) return;
  const ts = env.receivedAt || now;
  const meta = { ...(frame.meta || {}) };
  let item;
  if (k === 'text') item = { id, kind: 'text', text: td.decode(frame.payload).slice(0, 4000), ts, meta };
  else if (k === 'call') item = { id, kind: 'call', ts };
  else if (k === 'group-invite') {
    if (typeof frame.meta?.name !== 'string' || typeof frame.meta?.id !== 'string') return;
    r.invite = frame.meta;
    item = { id, kind: 'invite', text: frame.meta.name.slice(0, 60), ts };
  } else {
    item = { id, kind: k, ts, meta };
    const size = frame.payload ? frame.payload.byteLength : 0;
    if (size && _requestBlobBytes + size <= MAX_REQ_BLOB_BYTES) {
      requestBlobs.set(id, new Blob([frame.payload], { type: frame.meta?.type || 'application/octet-stream' }));
      _requestBlobBytes += size;
    }
  }
  r.items.push(item);
  r.lastAt = now;
  if (r.items.length > MAX_REQ_ITEMS) {
    for (const gone of r.items.splice(0, r.items.length - MAX_REQ_ITEMS)) {
      const b = requestBlobs.get(gone.id); if (b) { _requestBlobBytes -= b.size; requestBlobs.delete(gone.id); }
    }
  }
  saveRequests();
  renderRequests();
  if (isNew) { toast(t('req.new')); try { playNotification(); } catch {} notifyRequest(); }
}

// A request becomes an ordinary chat once its sender is a contact (accepted here, or added by hand). Its messages move over only if the
// session was made with the key saved for the contact; otherwise pinnedSession has already thrown that session away and they are dropped.
function absorbRequestsOfContacts() {
  for (const addr of Object.keys(requests)) {
    const c = contactByAddress(addr);
    if (!c) continue;
    const r = requests[addr];
    const s = pinnedSession(c);
    if (!s) {
      forgetRequest(addr, { keepSession: false });
      toast(t('req.forged'), 8000);
      continue;
    }
    const moved = [];
    const taken = new Set(loadThread(addr).map((x) => x.id));
    for (const it of r.items) {
      const rec = { id: taken.has(it.id) ? 'rq-' + crypto.randomUUID() : it.id, dir: 'in', ts: it.ts, verified: true, senderAddr: addr, replyTo: it.meta?.replyTo || null };
      if (it.kind === 'text') Object.assign(rec, { kind: 'text', text: it.text, meta: it.meta || null });
      else if (it.kind === 'call') Object.assign(rec, { id: 'call-' + it.id, kind: 'system', text: t('call.log.missed') });
      else if (it.kind === 'invite') continue;
      else {
        Object.assign(rec, { kind: it.kind, meta: it.meta || null });
        const blob = requestBlobs.get(it.id);
        if (!blob) Object.assign(rec, { kind: 'system', text: t('req.mediaGone') });
        else rememberMedia(rec.id, blob, addr, rec.ts);
      }
      const ttl = Number(it.meta?.ttl) || 0;
      if (ttl && rec.kind !== 'system') rec.expiresAt = Date.now() + ttl * 1000;
      moved.push(rec);
    }
    if (moved.length) {                  // written in one go: these were already announced as a request, so no sound or unread count again
      const thread = loadThread(addr);
      thread.push(...moved);
      threadCache.set(addr, thread);
      persistField(LS.thread(addr), thread);
    }
    const invite = r.invite;
    forgetRequest(addr);
    if (invite) applyGroupInvite({ from: addr }, { meta: invite }).catch(() => {});
  }
}

// Accept under a name the person chooses. Returns { ok } or { error }: 'offline' can be retried from the dialog; a forged or
// unverifiable request is removed here and can't be retried.
async function acceptRequest(addr, petname) {
  const r = requests[addr];
  if (!r) return { error: 'gone' };
  const name = String(petname || '').trim().slice(0, 40);
  if (!name) return { error: 'name' };
  const s = loadSession(addr);
  if (!s || !s.remoteIk) {
    forgetRequest(addr, { keepSession: false });
    toast(t('req.noKey'), 7000);
    renderRequests(); renderConversation();
    return { error: 'nokey' };
  }
  let res, data = {};
  try {
    res = await fetch('/api/contacts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ petname: name, address: addr, expectIk: s.remoteIk }),
    });
    data = await res.json().catch(() => ({}));
  } catch { res = null; }
  if (res && res.status === 409 && data.error === 'key_mismatch') {
    forgetRequest(addr, { keepSession: false });
    toast(t('req.forged'), 8000);
    renderRequests(); renderConversation();
    return { error: 'forged' };
  }
  if (!res || !res.ok) return { error: 'offline' };
  await loadContacts();                  // absorbs the request into a normal chat
  toast(t('req.accepted', { name }));
  const c = contactByAddress(addr);
  if (c) {
    // Let the sender's app know, so voice notes, attachments and calls unlock there without waiting for a typed reply.
    deliver(c, encodeFrame('accept', { via: 'request' }, new Uint8Array(0))).catch(() => {});
    openContactChat(c);
  } else renderConversation();
  return { ok: true };
}

// One dialog for naming a contact (accepting a request, renaming one). submit(name) resolves to { ok } or { error: text to show };
// anything else closes the dialog (the caller has already said what happened).
function askContactName({ title, okLabel, address, initial = '', busy, submit }) {
  const dialog = $('#name-dialog'), input = $('#in-nickname'), ok = $('#name-ok'), status = $('#name-status');
  $('#name-title').textContent = title;
  $('#name-addr').textContent = address;
  ok.textContent = okLabel;
  input.value = initial;
  input.disabled = false;
  status.textContent = ''; status.className = '';
  const sync = () => { ok.disabled = !input.value.trim() || input.value.trim() === initial.trim(); };
  input.oninput = sync; sync();
  $('#name-cancel').onclick = () => dialog.close();
  $('#name-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name || ok.disabled) return;
    ok.disabled = true; input.disabled = true;
    status.className = 'busy'; status.textContent = busy || '';
    let r;
    try { r = await submit(name); } catch { r = { error: t('toast.contactFail') }; }
    input.disabled = false;
    if (r && r.error) { status.className = ''; status.textContent = r.error; sync(); input.focus(); return; }
    dialog.close();
  };
  dialog.showModal();
  input.focus(); input.select();
}

function openAcceptDialog(addr) {
  askContactName({
    title: t('req.acceptTitle'), okLabel: t('req.acceptOk'), address: addr, busy: t('req.checking'),
    submit: async (name) => {
      const r = await acceptRequest(addr, name);
      if (r.ok) return { ok: true };
      if (r.error === 'offline') return { error: t('req.offline') };
      return {};                         // forged, unverifiable or gone: already reported, so just close
    },
  });
}

// Rename a contact: the name is only ever stored on this device.
function openRenameDialog(c) {
  askContactName({
    title: t('contacts.renameTitle'), okLabel: t('contacts.renameOk'), address: c.address, initial: c.petname || '', busy: t('contacts.saving'),
    submit: async (name) => {
      const res = await fetch('/api/contacts/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: c.address, petname: name }),
      }).catch(() => null);
      if (!res || !res.ok) return { error: t('contacts.renameFail') };
      await loadContacts();
      renderConversation();
      toast(t('contacts.renamed'));
      return { ok: true };
    },
  });
}

// Block a contact: removed from contacts (chat and session cleared, as with Remove), and the backend drops anything more from the address.
async function blockContact(c) {
  if (!(await askConfirm(t('contacts.blockConfirm', { name: c.petname }), t('req.block')))) return;
  try {
    const res = await fetch('/api/blocked', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: c.address }) });
    if (!res.ok) throw new Error();
  } catch { toast(t('req.blockFailed')); return; }
  await removeContact(c.address, { keepSession: false });
  toast(t('contacts.blocked', { name: c.petname }));
}

function deleteRequest(addr) {
  forgetRequest(addr);
  toast(t('req.deleted'));
  renderRequests(); renderConversation();
}
async function blockRequest(addr) {
  if (!(await askConfirm(t('req.blockConfirm'), t('req.block')))) return;
  try {
    const res = await fetch('/api/blocked', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: addr }) });
    if (!res.ok) throw new Error();
  } catch { toast(t('req.blockFailed')); return; }
  forgetRequest(addr, { keepSession: false });
  toast(t('req.blocked'));
  renderRequests(); renderConversation();
}

// Composer state for a contact who hasn't accepted our request yet: a note above the box, and the attach and voice buttons dimmed.
function paintTextOnly(c) {
  const composer = $('#composer');
  const on = !!c && !richSendAllowed(c.address);
  composer.classList.remove('read-only');
  composer.classList.toggle('text-only', on);
  let note = $('#compose-note');
  if (!note) { note = el('div', { id: 'compose-note', role: 'note' }); composer.prepend(note); }
  note.hidden = !on;
  note.textContent = on ? t('compose.textOnly', { name: c.petname }) : '';
  for (const id of ['#file-btn', '#voice-btn']) { const b = $(id); if (b) b.setAttribute('aria-disabled', on ? 'true' : 'false'); }
}

// Requests live behind the inbox button next to Add contact: muted when there are none, a dot (no number) when some are waiting.
// The panel under it lists them; opening a row shows what was sent, with Accept, Delete and Block.
let expandedRequest = null;
function renderRequests() {
  expireRequests();
  updateUnreadTotal();
  const n = Object.keys(requests).length;
  const btn = $('#requests-btn');
  if (btn) btn.classList.toggle('has', n > 0);
  if ($('#req-panel')) paintRequestPanel();
}
function closeRequestPanel() {
  const p = $('#req-panel');
  if (!p) return;
  p._off?.(); p.remove();
  $('#requests-btn')?.setAttribute('aria-expanded', 'false');
}
function openRequestPanel() {
  if ($('#req-panel')) { closeRequestPanel(); return; }
  closeMenu();
  const btn = $('#requests-btn');
  const panel = el('div', { id: 'req-panel', role: 'dialog', 'aria-label': t('req.title') });
  document.body.append(panel);
  btn.setAttribute('aria-expanded', 'true');
  paintRequestPanel();
  // Clicks inside the Accept and Block dialogs belong to the panel's flow, so they don't close it.
  const onDown = (e) => {
    if (panel.contains(e.target) || btn.contains(e.target)) return;
    if (e.target.closest?.('dialog, #confirm-overlay')) return;
    closeRequestPanel();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape' || document.querySelector('dialog[open]') || ($('#confirm-overlay') && !$('#confirm-overlay').hidden)) return;
    closeRequestPanel(); btn.focus();
  };
  const onResize = () => placeRequestPanel();
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);
  panel._off = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
  };
}
function placeRequestPanel() {
  const panel = $('#req-panel'), btn = $('#requests-btn');
  if (!panel || !btn) return;
  const r = btn.getBoundingClientRect(), w = panel.offsetWidth, h = panel.offsetHeight;
  panel.style.left = Math.max(8, Math.min(r.left - 8, window.innerWidth - w - 8)) + 'px';
  panel.style.top = Math.max(8, Math.min(r.bottom + 8, window.innerHeight - h - 8)) + 'px';
}
function paintRequestPanel() {
  const panel = $('#req-panel');
  const all = Object.values(requests).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  if (expandedRequest && !requests[expandedRequest]) expandedRequest = null;
  panel.innerHTML = '';
  const head = el('div', { className: 'req-panel-head' });
  head.append(el('span', { textContent: t('req.title') }));
  if (all.length) head.append(el('span', { className: 'req-panel-count', textContent: String(all.length) }));
  panel.append(head);
  if (!all.length) {
    panel.append(el('div', { className: 'req-panel-empty', textContent: t('req.empty') }));
    placeRequestPanel();
    return;
  }
  for (const r of all) panel.append(requestEntry(r));
  panel.append(el('div', { className: 'req-panel-note', textContent: t('req.note') }));
  placeRequestPanel();
}
function requestEntry(r) {
  const open = expandedRequest === r.address;
  const name = requestName(r);
  const entry = el('div', { className: 'req-entry' + (open ? ' open' : '') });
  const headBtn = el('button', { type: 'button', className: 'req-entry-head', 'aria-expanded': String(open) });
  const txt = el('div', { className: 'contact-text' });
  txt.append(el('div', { className: 'contact-name', textContent: name }),
    el('div', { className: 'request-sub' }, el('span', { className: 'req-notverified', innerHTML: WARN_ICON_SM }, el('span', { textContent: t('req.notVerified') })),
      document.createTextNode(' · ' + requestWhen(r.lastAt))));
  const chev = el('span', { className: 'req-chev', 'aria-hidden': 'true', innerHTML: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>' });
  headBtn.append(renderAvatarEl(r.address, null, 34, 'sm', name), txt, chev);
  headBtn.title = r.address;
  headBtn.onclick = () => { expandedRequest = open ? null : r.address; paintRequestPanel(); };
  entry.append(headBtn);
  if (!open) return entry;

  const body = el('div', { className: 'req-entry-body' });
  // The address on a request is only what the sender wrote: it is checked against the keys served there when Accept is pressed.
  body.append(el('div', { className: 'req-unverified' }, el('span', { textContent: t('req.unverified') })));
  const items = el('div', { className: 'req-items' });
  for (const it of r.items) {
    if (it.kind === 'text') items.append(el('div', { className: 'bubble in req-bubble' }, el('div', { className: 'bubble-text', textContent: it.text })));
    else if (it.kind === 'call') items.append(el('div', { className: 'req-line', textContent: t('req.call') }));
    else if (it.kind === 'invite') items.append(el('div', { className: 'req-line', textContent: t('req.invite', { name: it.text }) }));
    else items.append(el('div', { className: 'req-line', textContent: t('req.media') }));
  }
  const actions = el('div', { className: 'req-actions' });
  const accept = el('button', { className: 'btn primary', type: 'button', textContent: t('req.accept') });
  accept.onclick = () => openAcceptDialog(r.address);
  const del = el('button', { className: 'btn', type: 'button', textContent: t('req.delete') });
  del.onclick = () => deleteRequest(r.address);
  const block = el('button', { className: 'btn req-block', type: 'button', textContent: t('req.block') });
  block.onclick = () => blockRequest(r.address);
  actions.append(accept, del, block);
  body.append(items, actions);
  entry.append(body);
  return entry;
}
const WARN_ICON_SM = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
function requestWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return formatTime(ts);
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

// Unread chats: bold name, "N new messages" in place of the second line, and a small dot at the end of the row.
function unreadLine(n) { return el('div', { className: 'contact-addr unread-line', textContent: n === 1 ? t('unread.one') : t('unread.many', { n: n > 999 ? '999+' : n }) }); }
function rowTrail(pinned, unread) {
  const trail = el('span', { className: 'row-trail' });
  if (pinned) trail.append(el('span', { className: 'pin-mark', 'aria-hidden': 'true', innerHTML: pinSVG(true) }));
  if (unread) trail.append(el('span', { className: 'unread-dot', 'aria-hidden': 'true' }));
  return trail;
}
// Total unread across chats and groups (requests aren't counted: a stranger shouldn't be able to light up the taskbar): on the window title and, in the desktop app, on the app icon.
let _lastUnreadTotal = -1;
function updateUnreadTotal() {
  let n = 0;
  for (const v of unreadContacts.values()) n += v || 0;
  if (n === _lastUnreadTotal) return;
  _lastUnreadTotal = n;
  document.title = n ? `(${n > 99 ? '99+' : n}) AnonChat` : 'AnonChat';
  try { window.electron?.setUnreadCount?.(n); } catch {}
}

function renderContacts() {
  updateUnreadTotal();
  const list = $('#contacts'); list.innerHTML = '';
  if (!contacts.length) { list.append(el('div', { className: 'empty-rail', textContent: t('contacts.empty') })); return; }
  for (const c of sortPinnedFirst(contacts, (c) => c.address)) {
    const unread = unreadContacts.get(c.address) || 0;
    const pinned = isPinned(c.address);
    const ringing = c.address === ringingFrom;
    const row = el('button', { className: 'contact' + (c.address === selected ? ' active' : '') + (unread > 0 ? ' unread' : '') + (pinned ? ' pinned' : '') + (ringing ? ' ringing' : '') });
    const av = renderAvatarEl(c.address, c.avatar, 34, 'sm', c.petname);
    const avWrap = el('div', { className: 'avatar-wrap' });
    avWrap.append(av);
    if (c.online !== null) {
      const dot = el('span', { className: 'presence-dot' + (c.online ? ' online' : ' offline') });
      dot.title = c.online ? t('contacts.online') : t('contacts.offline');
      avWrap.append(dot);
    }
    const txt = el('div', { className: 'contact-text' });
    txt.append(el('div', { className: 'contact-name', textContent: c.petname }),
      ringing ? el('div', { className: 'contact-call-line', textContent: t('call.incoming') })
        : unread > 0 ? unreadLine(unread) : el('div', { className: 'contact-addr', textContent: shortAddr(c.address) }));
    row.oncontextmenu = (e) => {
      e.preventDefault();
      openMenu({ x: e.clientX, y: e.clientY }, [
        { label: pinned ? t('pin.unpin') : t('pin.pin'), icon: pinSVG(pinned), desc: t(pinned ? 'menu.d.unpin' : 'menu.d.pin'), run: () => { togglePinned(c.address); renderContacts(); } },
        { label: t('contacts.rename'), icon: MENU_ICONS.rename, desc: t('menu.d.rename'), run: () => openRenameDialog(c) },
        { sep: true },
        { label: t('contacts.block'), icon: MENU_ICONS.block, danger: true, desc: t('menu.d.block'), run: () => blockContact(c) },
        { label: t('contacts.remove'), icon: MENU_ICONS.trash, danger: true, desc: t('menu.d.remove'), run: async () => { if (await askConfirm(t('contacts.removeConfirm', { name: c.petname }))) removeContact(c.address); } },
      ]);
    };
    row.append(avWrap, txt, rowTrail(pinned, unread > 0));
    if (ringing) row.append(el('span', { className: 'ring-phone', 'aria-hidden': 'true', innerHTML: CALL_ICON.replace(/width="22" height="22"/, 'width="16" height="16"') }));
    if (ringing) row.setAttribute('aria-label', c.petname + ', ' + t('call.incoming'));
    else if (unread > 0) row.setAttribute('aria-label', c.petname + ', ' + (unread === 1 ? t('unread.one') : t('unread.many', { n: unread })));
    row.onclick = () => openContactChat(c);
    list.append(row);
  }
}

function openGroupChat(g) {
  const gkey = 'grp:' + g.id;
  selected = null; selectedGroup = g.id;
  const u = unreadContacts.get(gkey) || 0;
  const fid = firstUnreadId(gkey, u);
  if (fid) unreadSeparatorAt.set(gkey, fid); else unreadSeparatorAt.delete(gkey);
  unreadContacts.delete(gkey);
  renderContacts(); renderGroups(); renderGroupConv();
}

function openContactChat(c) {
  selected = c.address; selectedGroup = null;
  const u = unreadContacts.get(c.address) || 0;
  const fid = firstUnreadId(c.address, u);
  if (fid) unreadSeparatorAt.set(c.address, fid); else unreadSeparatorAt.delete(c.address);
  unreadContacts.delete(c.address);
  renderContacts(); renderGroups(); renderRequests(); renderConversation();
}

function identityMismatch() {
  const e = new Error('handshake identity key does not match the key saved for this contact');
  e.code = 'IK_MISMATCH';
  return e;
}

// A session belongs to a contact only if it was built with the identity key saved for them. One adopted while they were still a stranger
// (or built with a key they have since replaced and been re-added with) may be an impostor's: it is thrown away, so neither our replies
// nor their messages ever use it, and the next handshake with the right key starts a clean session.
function sessionMatchesPin(contact, s) {
  if (!contact.ecdhPub) return false;
  if (s.remoteIk) return s.remoteIk === contact.ecdhPub;
  return s.verified === true;           // sessions from before remoteIk was recorded: only those that were checked at the time
}
function discardSession(addr) {
  sessions.delete(addr);
  const k = LS.session(addr);
  fields.delete(k).catch(() => {});
  const pending = persistQueues.get(k);   // an encrypted write still in flight would bring it back
  if (pending) pending.then(() => { if (!sessions.has(addr)) fields.delete(k).catch(() => {}); });
}
function pinnedSession(contact) {
  const s = loadSession(contact.address);
  if (!s) return null;
  if (sessionMatchesPin(contact, s)) {
    if (!s.verified) { s.verified = true; saveSession(contact.address, s); }
    return s;
  }
  console.warn('[session] discarding a session whose identity key does not match the key saved for', contact.address);
  discardSession(contact.address);
  return null;
}

async function ensureSession(contact) {
  let s = pinnedSession(contact);
  if (s) return s;
  if (!contact.ratchetPub) throw new Error('contact has no ratchet prekey — re-add them');

  // Signed-prekey verification fails closed: the prekey must carry a valid signature from the contact's identity signing key.
  if (!contact.ikSigPub || !contact.spkSig) {
    throw new Error('contact has no signed prekey — re-add them');
  }
  const sigOk = await Ratchet.verifySPK(contact.ikSigPub, contact.ratchetPub, contact.spkSig);
  if (!sigOk) {
    throw new Error('prekey signature verification failed — refusing to start a session (possible tampering). Re-add this contact if you trust them.');
  }

  // A one-time key is used only while fresh: their app forgets a handed-out key's private half after OPK_KEEP_MS, and a handshake naming
  // one it no longer has can't be read. A stale one is left out; the session is then built from the other three keys, as when none was left.
  const opkFresh = !!(contact.opkId && contact.opkPub && Date.now() - (contact.opkAt || 0) < OPK_USE_MS);
  const { sk, ekPub } = await Ratchet.x3dhInitiator(ikPrivJwk, contact.ecdhPub, contact.ratchetPub, opkFresh ? contact.opkPub : null);
  const pendingX3DH = { ik: ikPub, ek: ekPub };
  if (opkFresh) pendingX3DH.opkId = contact.opkId;

  s = await Ratchet.initInitiator(sk, contact.ratchetPub, { verified: true, pendingX3DH, remoteIk: contact.ecdhPub });
  s.startedAt = Date.now();          // what was written on it can be sent again if it loses to theirs (see resendOnAdoptedSession)
  saveSession(contact.address, s);

  // A one-time prekey is single-use: it is now part of this session's root key, so clear it from the local contact cache.
  if (contact.opkId) {
    contact.opkId = null; contact.opkPub = null;
    fetch('/api/contacts/opk-used', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: contact.address }) }).catch(() => {});
  }
  return s;
}
// Both wrote first and their session won the tie-break: everything we wrote on ours is unreadable for them. What is still waiting in the
// queue on ours is taken out (a late copy would only fail on their side), and the text we wrote since ours started is sent again on
// theirs, with the same message ids, so nothing shows twice. Before an answer only text can be sent, so text is all there is.
async function resendOnAdoptedSession(contact, { ek, since }) {
  const addr = contact.address;
  try {
    const items = await fetch('/api/outbox').then((r) => r.json()).then((j) => j.items || []);
    for (const i of items) if (i.toAddress === addr && i.ek === ek) await fetch('/api/outbox/' + encodeURIComponent(i.id), { method: 'DELETE' }).catch(() => {});
  } catch {}
  const thread = loadThread(addr);
  const again = thread.filter((m) => m.dir === 'out' && m.kind === 'text' && typeof m.text === 'string' && (m.ts || 0) >= since - 1000 && !(m.expiresAt && m.expiresAt < Date.now()));
  for (const m of again) {
    m.pending = true; delete m.failed; delete m.queueId;
  }
  if (again.length) { persistField(LS.thread(addr), thread); if (selected === addr && !selectedGroup) renderConversation(); }
  for (const m of again) {
    const ttl = m.expiresAt ? Math.max(1, Math.ceil((m.expiresAt - Date.now()) / 1000)) : undefined;   // what is left of a disappearing message's time
    try {
      const r = await deliver(contact, encodeFrame('text', { mid: m.id, ttl, replyTo: m.replyTo || undefined }, te.encode(m.text)), { offlineTtl: offlineTtlFor(addr), msgId: m.id });
      const th = loadThread(addr), x = th.find((y) => y.id === m.id);
      if (x) { if (r && r.queued) x.queueId = r.queueId; else delete x.pending; persistField(LS.thread(addr), th); }
    } catch {}
  }
  if (again.length && selected === addr && !selectedGroup) renderConversation();
}
function shouldAdoptResponder(existing, x3dh) {
  if (!existing) return true;
  if (existing.confirmed || existing.role === 'responder') return false;
  return x3dh.ik < ikPub; // deterministic tie-break for simultaneous init
}

// Until the other side has accepted our message request (or written to us), only text goes out: their app would hold anything else in
// the request anyway. Group traffic is not affected. 'accept' is the silent signal an app sends when it accepts a request.
const TEXT_ONLY_KINDS = new Set(['text', 'read', 'reaction', 'accept', 'request']);
function richSendAllowed(addr) {
  const s = loadSession(addr);
  return !!s && !s.asRequest && (s.role === 'responder' || s.confirmed === true);
}
// Tells a former contact's app that it is a message request here now (sent once per new request, on the session kept from before).
function tellNowARequest(addr, remoteIk) {
  setTimeout(() => {
    const holder = { address: addr, ecdhPub: remoteIk };
    deliver(holder, encodeFrame('request', {}, new Uint8Array(0)), { queueOnly: true }).catch(() => {});
  }, 0);
}
// What to show for an error: a translated sentence. Errors made with a translated message are shown as they are; the few the person
// can act on get their own sentence; anything else (a network or internal error, in English) becomes the fallback message.
function errorText(e, fallback = 'toast.failed') {
  if (e && e.i18n) return e.message;
  const m = String((e && e.message) || '');
  if (/too large/i.test(m)) return t('err.tooLarge');
  if ((e && e.code === 'IK_MISMATCH') || /key_mismatch|identity key|prekey|re-add|session state corrupt/i.test(m)) return t('err.keys');
  if (/could not read image/i.test(m)) return t('err.image');
  if (/media cleanup failed/i.test(m)) return t('err.mediaClean');
  return t(fallback);
}
function shownError(text) { const e = new Error(text); e.i18n = true; return e; }

function textOnlyError(c) {
  const e = shownError(t('compose.textOnly', { name: c.petname }));
  e.code = 'TEXT_ONLY';
  return e;
}
function directTextOnly() {
  if (selectedGroup || !selected) return false;
  return !richSendAllowed(selected);
}

async function deliver(contact, frameBytes, opts = {}) {
  {
    const f = decodeFrame(frameBytes);
    const groupTraffic = !!f.meta?.grp || f.kind.startsWith('group-');
    if (!TEXT_ONLY_KINDS.has(f.kind) && !groupTraffic && !richSendAllowed(contact.address)) throw textOnlyError(contact);
  }
  // Advancing the sending ratchet and persisting it must be atomic with respect to inbound processing: otherwise a concurrent receive can clone the session first and overwrite this chain step (see withSessionLock). Only the state change is locked; the network send runs outside the lock.
  const env = await withSessionLock(async () => {
    const s = await ensureSession(contact);
    // Stop attaching the X3DH handshake once the peer has answered: carrying it forever would make them re-adopt a fresh responder session and discard their own ratchet state.
    if (s.confirmed && s.pendingX3DH) { delete s.pendingX3DH; saveSession(contact.address, s); }
    const { header, ct } = await Ratchet.ratchetEncrypt(s, frameBytes);
    const e = { dh: header.dh, pn: header.pn, n: header.n, ct };
    if (s.pendingX3DH) e.x3dh = s.pendingX3DH;
    saveSession(contact.address, s);
    return e;
  });
  // The backend stamps the message with our shared mailbox key; make sure it has the key (a contact or member just added).
  await ensureMailboxKey(contact).catch(() => {});
  const body = { toAddress: contact.address, envelope: env };
  if (opts.offlineTtl) body.offlineTtl = opts.offlineTtl;
  if (opts.ephemeral) body.ephemeral = true;     // call signalling: delivered now or not at all, never queued
  if (opts.queueOnly) body.queueOnly = true;     // straight into the backend's queue: the caller doesn't wait on the network
  if (opts.msgId) body.msgId = opts.msgId;       // lets the outcome find this message even if its queue id never reached us
  const res = await fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'delivery failed'); }
  const data = await res.json();
  try { document.dispatchEvent(new CustomEvent('anon:traffic')); } catch {}
  return data;
}

const OFFLINE_TTL_OPTIONS = [3600, 43200, 86400];
const OFFLINE_TTL_DEFAULT = 86400;
function offlineTtlFor(addr) {
  const v = Number(prefs.offlineTtl[addr]);
  return OFFLINE_TTL_OPTIONS.includes(v) ? v : OFFLINE_TTL_DEFAULT;
}
function setOfflineTtlFor(addr, secs) {
  prefs.offlineTtl[addr] = secs; savePrefs();
}
function offlineTtlLabel(secs) {
  return t('ttl.short.h', { n: secs === 3600 ? 1 : secs === 43200 ? 12 : 24 });
}
// Voice calls (call.js): signalling goes through the normal ratchet as 'call' frames; the audio has its own encrypted link.
const CALLS_OFF_KEY = 'anyonechat.calls.off';
const callsOff = () => localStorage.getItem(CALLS_OFF_KEY) === '1';
let ringingFrom = null;            // the contact whose call is ringing right now: their card is shaded until it's answered or ends
const calls = createCalls({
  t, el,
  ringing: (addr) => { const was = ringingFrom; ringingFrom = addr; renderContacts(); if (was && was !== addr) closeNotice('call:' + was); },
  ring: (addr) => notifyCall(addr),
  findContact: (addr) => contactByAddress(addr),
  sendSignal: (contact, meta) => deliver(contact, encodeFrame('call', meta, new Uint8Array(0)), { ephemeral: true }),
  avatar: (addr, av, size, cls, name) => renderAvatarEl(addr, av, size, cls, name),
  toast: (m) => toast(m),
  callsOff,
  viewing: (addr) => selected === addr && !selectedGroup,
  openChat: (addr) => { const c = contactByAddress(addr); if (c) openContactChat(c); },
  tip: (b, text) => { b._tipText = text; b.addEventListener('mouseenter', () => showTip(b, b._tipText)); b.addEventListener('mouseleave', hideTip); b.addEventListener('click', hideTip); },
  // A line in the conversation: a missed call counts as unread, everything else is just history.
  log: (addr, dir, text) => {
    const missed = text === t('call.log.missed');
    if (missed) notifyMissedCall(addr);
    appendThread(addr, { id: 'call-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), dir: missed ? 'in' : 'out', kind: 'system', text, ts: Date.now() });
    if (selected === addr && !selectedGroup) renderConversation();
  },
});

let replyToMsg = null;
const threadTtl = new Map();

function setReply(m) { replyToMsg = m; renderReplyBar(); }
function clearReply() { replyToMsg = null; renderReplyBar(); }
function activeThreadKey() { return selectedGroup ? ('grp:' + selectedGroup) : selected; }

// What a reply carries about the quoted message: who wrote it as an .anyone address (each app shows its own label for it: "You" or
// its nickname for that person), never a name chosen by the sender. Media is described by its kind, so the label is translated.
const REPLY_KINDS = new Set(['image', 'video', 'audio', 'voice', 'file']);
// A reply carries only the id of the quoted message. Who wrote it and what it said are always taken from the reader's own copy
// (quoteFor), never from the sender: anything the sender supplied could put words in someone else's mouth.
function replyRef(m) { return { id: m.id }; }
function kindLabel(kind) { return t('kind.' + (REPLY_KINDS.has(kind) ? kind : 'file')); }
// Label for whoever wrote a quoted message, as this app knows them.
function personLabel(addr) {
  if (typeof addr !== 'string' || !addr) return null;
  if (addr === myAddress) return t('react.you');
  const c = contactByAddress(addr);
  if (c) return c.petname;
  const g = selectedGroup ? groupById(selectedGroup) : null;
  const gm = g && g.members.find((x) => x.address === addr);
  if (gm && gm.petname) return gm.petname;
  return /^[a-z2-7]{56}\.anyone$/.test(addr) ? shortAddr(addr) : null;
}
// Message ids are chosen by the sender. An id already used in this conversation by someone else gets a fresh local id, so nobody
// can stand in for another person's message (in quotes, reactions or read marks); the same message arriving twice is dropped (null).
function incomingId(threadKey, wanted, env) {
  const id = typeof wanted === 'string' && wanted ? wanted.slice(0, 80) : env.id;
  const prev = loadThread(threadKey).find((x) => x.id === id);
  if (!prev) return id;
  if (prev.dir === 'in' && prev.senderAddr === env.from) return null;
  return env.id;
}
function messageAuthorLabel(m) { return m.dir === 'out' ? t('react.you') : (personLabel(m.senderAddr || selected) || ''); }
function messageGist(m) {
  if (m.text) return String(m.text).slice(0, 100);
  if (m.kind === 'file' && m.meta?.name) return String(m.meta.name).slice(0, 100);
  return kindLabel(m.kind);
}
// The quote shown above a reply: found in this conversation by id, or "not available" (deleted, expired, or never existed).
function quoteFor(rt, index) {
  const orig = rt && typeof rt.id === 'string' && index ? index.get(rt.id) : null;
  if (!orig || orig.kind === 'system') return { found: false, author: null, text: t('reply.unavailable') };
  return { found: true, author: messageAuthorLabel(orig), text: messageGist(orig) };
}

function renderReplyBar() {
  let bar = document.getElementById('reply-bar');
  if (!replyToMsg) { if (bar) bar.remove(); return; }
  if (!bar) { bar = el('div', { id: 'reply-bar' }); const composer = $('#composer'); if (composer) composer.prepend(bar); }
  bar.innerHTML = '';
  const preview = el('div', { className: 'reply-preview' });
  preview.append(el('span', { className: 'reply-author', textContent: messageAuthorLabel(replyToMsg) }));
  const txt = replyToMsg.text || (replyToMsg.kind === 'file' && replyToMsg.meta?.name ? replyToMsg.meta.name : kindLabel(replyToMsg.kind));
  preview.append(el('span', { className: 'reply-text', textContent: String(txt).slice(0, 80) }));
  const close = el('button', { className: 'reply-close', type: 'button', textContent: 'x', 'aria-label': t('nav.cancel') });
  close.onclick = clearReply;
  bar.append(preview, close);
}

async function sendText(str) {
  if (!str.trim()) return;
  const id = crypto.randomUUID();
  const ttl = threadTtl.get(activeThreadKey()) || null;
  const expiresAt = ttl ? Date.now() + ttl * 1000 : null;
  const reply = replyToMsg ? replyRef(replyToMsg) : null;
  if (selectedGroup) {
    const gid = selectedGroup, g = groupById(gid); if (!g || g.removedMe) return;
    // Shown at once, in this group, at the time it was written (⏳ until every member's copy has been handed to the queue), as in a
    // direct chat. Waiting for every member first held it back for as long as the slowest one took (minutes for an unreachable member),
    // and a chat opened meanwhile got it instead of this group.
    appendThread('grp:' + gid, { id, dir: 'out', kind: 'text', text: str, ts: Date.now(), grp: gid, expiresAt, replyTo: reply, pending: true });
    clearReply(); renderGroupConv();
    finishGroupSend(gid, id, deliverToGroup(g, encodeFrame('text', { grp: gid, mid: id, ttl: ttl || undefined, replyTo: reply || undefined }, te.encode(str))));
    return;
  }
  const c = contactByAddress(selected); if (!c) return;
  const rec = { id, dir: 'out', kind: 'text', text: str, ts: Date.now(), verified: true, expiresAt, replyTo: reply, pending: true };
  // Optimistic UI: show the message at once as pending and deliver in the background (an offline contact can take 25-45 s to time out).
  appendThread(c.address, rec);
  clearReply(); renderConversation();
  deliver(c, encodeFrame('text', { mid: id, ttl: ttl || undefined, replyTo: reply || undefined }, te.encode(str)), { offlineTtl: offlineTtlFor(c.address), msgId: id })
    .then(result => {
      const thread = loadThread(c.address);
      const m = thread.find(x => x.id === id);
      if (m) {
        if (result.queued) { m.pending = true; m.queueId = result.queueId; }
        else { delete m.pending; delete m.queueId; }
        threadCache.set(c.address, thread);
        persistField(LS.thread(c.address), thread);
        if (selected === c.address) renderConversation();
      }
    })
    .catch(e => { markSendFailed(c.address, id); toast(errorText(e, 'err.send')); });
}
async function makeImageThumb(blob, maxDim = 200, quality = 0.6) {
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = rej;
      i.src = URL.createObjectURL(blob);
    });
    const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(img.src);
    return canvas.toDataURL('image/jpeg', quality);
  } catch { return null; }
}

async function sendBlob(blob, kind, fileName) {
  if (directTextOnly()) throw textOnlyError(contactByAddress(selected));
  // Photos, videos and audio lose their hidden data (location, camera, time, embedded thumbnails) and their file name before anything
  // else happens. If that is not possible the file is not sent: the original is never used instead. Other files are sent as chosen.
  if (kind === 'image' || kind === 'video' || kind === 'audio') {
    const cleaned = await cleanForSending(blob, kind);
    blob = cleaned.blob; fileName = cleaned.name || fileName;
  }
  if (blob.size > 5 * 1024 * 1024) throw new Error('file too large (5 MB max)');
  const id  = crypto.randomUUID();
  const url = URL.createObjectURL(blob);
  const ttl = threadTtl.get(activeThreadKey()) || null;
  const expiresAt = ttl ? Date.now() + ttl * 1000 : null;
  const reply = replyToMsg ? replyRef(replyToMsg) : null;

  let thumb = null;
  if (kind === 'image') thumb = await makeImageThumb(blob);

  showSendProgress(0);
  try {
    if (selectedGroup) {
      const gid = selectedGroup, g = groupById(gid); if (!g || g.removedMe) { hideSendProgress(); return; }
      const meta = { name: fileName || 'file', type: blob.type || 'application/octet-stream', size: blob.size, grp: gid, thumb, mid: id, ttl: ttl || undefined, replyTo: reply || undefined };
      showSendProgress(40);
      const frame = encodeFrame(kind, meta, new Uint8Array(await blob.arrayBuffer()));
      const ts = Date.now();
      rememberMedia(id, blob, 'grp:' + gid, ts, url);
      appendThread('grp:' + gid, { id, dir: 'out', kind, meta, ts, grp: gid, expiresAt, replyTo: reply, pending: true });   // at once (see sendText)
      showSendProgress(100);
      clearReply(); renderGroupConv();
      finishGroupSend(gid, id, deliverToGroup(g, frame));
    } else {
      const c = contactByAddress(selected); if (!c) { hideSendProgress(); return; }
      const meta = { name: fileName || 'file', type: blob.type || 'application/octet-stream', size: blob.size, thumb, mid: id, ttl: ttl || undefined, replyTo: reply || undefined };
      showSendProgress(40);
      const rec = { id, dir: 'out', kind, meta, ts: Date.now(), verified: true, expiresAt, replyTo: reply, pending: true };
      rememberMedia(id, blob, c.address, rec.ts, url);
      appendThread(c.address, rec);
      clearReply(); renderConversation();
      showSendProgress(100);
      deliver(c, encodeFrame(kind, meta, new Uint8Array(await blob.arrayBuffer())), { offlineTtl: offlineTtlFor(c.address), msgId: id })
        .then(result => {
          const thread = loadThread(c.address);
          const m = thread.find(x => x.id === id);
          if (m) {
            if (result.queued) { m.pending = true; m.queueId = result.queueId; }
            else { delete m.pending; delete m.queueId; }
            threadCache.set(c.address, thread);
            persistField(LS.thread(c.address), thread);
            if (selected === c.address) renderConversation();
          }
        })
        .catch(e => { markSendFailed(c.address, id); toast(errorText(e, 'err.send')); });
    }
  } finally {
    hideSendProgress();
  }
}

// Delivery failed outright (not queued): the message stops showing as on its way and is marked as not delivered.
// A group message is on screen (⏳) while every member's copy is handed to the queue; then the mark goes. Members who couldn't be reached
// get theirs from the queue later, as in a direct chat; one that refused it outright is reported.
const _groupSending = new Set();
function finishGroupSend(gid, id, delivery) {
  _groupSending.add(id);
  Promise.resolve(delivery).then((failed) => { if (failed) toast(t('groups.partialFail', { n: failed })); }, () => {})
    .finally(() => {
      _groupSending.delete(id);
      const key = 'grp:' + gid, thread = loadThread(key), m = thread.find((x) => x.id === id);
      if (m && m.pending) { delete m.pending; threadCache.set(key, thread); persistField(LS.thread(key), thread); }
      if (selectedGroup === gid) renderGroupConv();
    });
}
function markSendFailed(addr, id) {
  const thread = loadThread(addr);
  const m = thread.find(x => x.id === id);
  if (!m) return;
  delete m.pending; delete m.queueId; m.failed = true;
  threadCache.set(addr, thread);
  persistField(LS.thread(addr), thread);
  if (selected === addr) renderConversation();
}

function showSendProgress(pct) {
  let bar = $('#send-progress');
  if (!bar) {
    bar = el('div', { id: 'send-progress' });
    bar.innerHTML = '<div id="send-progress-fill"></div>';
    const composer = $('#composer');
    if (composer) composer.prepend(bar);
  }
  bar.hidden = false;
  const fill = $('#send-progress-fill');
  if (fill) fill.style.width = pct + '%';
}
function hideSendProgress() {
  const bar = $('#send-progress');
  if (bar) setTimeout(() => { bar.hidden = true; if ($('#send-progress-fill')) $('#send-progress-fill').style.width = '0%'; }, 350);
}

async function applyGroupInvite(env, frame) {
    // A new group comes only from someone in our contacts (a stranger's invite waits in Requests). A group we already have can be
    // re-sent only by its admin, contact or not: that is how every member's list is kept the same. env.from is authenticated by the ratchet.
    const inviter = contacts.find(c => c.address === env.from);
    const prior = groupById(typeof frame.meta?.id === 'string' ? frame.meta.id.slice(0, 64) : '');
    const fromAdmin = !!prior && env.from === (prior.adminAddr || prior.createdBy);
    if (!inviter && !fromAdmin) return;

    const { id, name, description, members } = frame.meta || {};
    if (!id || typeof id !== 'string' || !name || typeof name !== 'string' || !Array.isArray(members)) return;

    // Sanitize the member list and cap it at MAX_GROUP; drop malformed entries.
    const seenAddr = new Set();
    const clean = members
      .map(cleanMember)
      .filter(m => m && !seenAddr.has(m.address) && seenAddr.add(m.address))
      .slice(0, MAX_GROUP)
      .map(m => {
        if (m.address === myAddress) return m;
        let petname = m.petname;
        if (petname === 'You' || !petname.trim()) {
          const known = contacts.find(c => c.address === m.address);
          petname = known ? known.petname : shortAddr(m.address);
        }
        if (m.address === env.from && inviter?.petname) petname = inviter.petname;
        return { ...m, petname };
      });
    if (clean.length < 2) return;
    if (clean.length > MAX_GROUP) return;
    if (!clean.some(m => m.address === myAddress)) return;
    // The inviter must be in the member list they sent.
    if (!clean.some(m => m.address === env.from)) return;

    const gid = id.slice(0, 64);
    const existing = groupById(gid);
    // A group we already have can only be re-sent by its own admin, so no other member can take it over.
    if (existing && env.from !== (existing.adminAddr || existing.createdBy)) return;

    const g = {
      id: gid,
      name: String(name).slice(0, 60),
      description: typeof description === 'string' ? description.slice(0, 280) : '',
      members: clean,
      createdAt: existing?.createdAt || Date.now(),
      createdBy: existing?.createdBy || env.from,
      adminAddr: env.from,
    };
    const picture = cleanGroupPicture(frame.meta.avatar) || existing?.avatar;
    if (picture) g.avatar = picture;
    await saveGroup(g); await loadGroups();
    if (existing) {
      // The admin's full list replaced ours: note who came and went since the last one (an 'add' or 'remove' that already arrived
      // has changed our list already, so nothing is announced twice).
      const before = new Set(existing.members.map(m => m.address));
      const after = new Set(clean.map(m => m.address));
      for (const m of clean) if (!before.has(m.address) && m.address !== myAddress)
        appendThread('grp:' + g.id, { id: 'roster-' + crypto.randomUUID(), dir: 'in', kind: 'system', text: t('groups.memberAdded', { name: m.petname }), ts: env.receivedAt });
      const left = new Set(Array.isArray(frame.meta.left) ? frame.meta.left.filter((a) => typeof a === 'string') : []);
      for (const m of existing.members) if (!after.has(m.address))
        appendThread('grp:' + g.id, { id: 'roster-' + crypto.randomUUID(), dir: 'in', kind: 'system', text: t(left.has(m.address) ? 'groups.memberLeft' : 'groups.memberRemoved', { name: m.petname }), ts: env.receivedAt });
      prunePeers();
      renderGroups();
      if (selectedGroup === g.id) renderGroupConv();
      replayHeldGroupFrames(g.id).catch(() => {});
      return;
    }
    if (selectedGroup === g.id) renderGroupConv();
    replayHeldGroupFrames(g.id).catch(() => {});
    appendThread('grp:' + g.id, { id: env.id, dir: 'in', kind: 'system',
      text: t('groups.invited', { name: g.name }), ts: env.receivedAt });
    toast(t('groups.invited', { name: g.name }));
    playNotification();

}

const _rosterAnswered = new Map();
async function applyGroupUpdate(env, frame) {
    const gid = frame.meta?.grp; const g = groupById(gid);
    if (!g) return;
    const adminAddr = g.adminAddr || g.createdBy || (g.members[0] && g.members[0].address);
    const action = frame.meta?.action;

    if (action === 'joined') {
      if (myAddress !== adminAddr) return;
      // Only with the code's current secret, and never someone the admin removed (until the admin adds them again).
      if (!g.joinKey || frame.meta?.key !== g.joinKey) return;
      if ((g.removed || []).includes(env.from)) return;
      if (g.members.length >= MAX_GROUP) return;
      if (g.members.find(m => m.address === env.from)) return;
      // Nobody chooses their own name: the admin's nickname for a contact, otherwise the short address. (The name a joiner's app sends
      // is ignored; a modified app could otherwise join as "Bob".)
      const petname = contacts.find(c => c.address === env.from)?.petname || shortAddr(env.from);
      g.members.push({ address: env.from, petname });
      await saveGroup(g);
      // The address in a 'joined' message is only a claim until the keys served at that address match the ones it was sent with.
      // Checked in the background (a network fetch must not hold the session lock); anything else undoes the join.
      const joinEnvId = env.id, joinTs = env.receivedAt, joiner = env.from;
      (async () => {
        let holder = null;
        try { holder = await ensurePeer(joiner); } catch {}
        const sess = loadSession(joiner);
        const gNow = groupById(gid);
        if (!gNow) return;
        if (!holder || !sess || !sessionMatchesPin(holder, sess)) {
          gNow.members = gNow.members.filter(m => m.address !== joiner);
          await saveGroup(gNow);
          prunePeers();
          console.warn('[groups] join not confirmed by the keys served at', joiner);
          return;
        }
        appendThread('grp:' + gid, { id: joinEnvId, dir: 'in', kind: 'system', text: t('groups.memberJoined', { name: petname }), ts: joinTs });
        const meta = { grp: gNow.id, action: 'add', added: { address: joiner, petname } };
        const others = { ...gNow, members: gNow.members.filter(m => m.address !== joiner) };
        deliverToGroup(others, encodeFrame('group-update', meta, new Uint8Array(0))).catch(() => {});
        // Everyone, the newcomer included, gets the full list: someone who joined with a code only knows the group's name.
        syncRoster(gNow);
        renderGroups();
        if (selectedGroup === gid) renderGroupConv();
      })();
      return;
    }

    // A member asks for the current list (their app was just restored from a backup, which can't read what was written to the old app
    // meanwhile). Only the admin answers, only to a current member, at most every 10 minutes each.
    if (action === 'roster') {
      if (myAddress !== adminAddr || !g.members.some((m) => m.address === env.from)) return;
      const k = gid + '|' + env.from, now = Date.now();
      if (now - (_rosterAnswered.get(k) || 0) < 10 * 60 * 1000) return;
      _rosterAnswered.set(k, now);
      const holder = keyHolder(env.from);
      const left = (Array.isArray(g.leftRecently) ? g.leftRecently : []).filter((x) => x && now - x.at < 30 * 86400000).map((x) => x.address);
      if (holder) deliver(holder, encodeFrame('group-invite', { ...groupInviteMeta(g), left }, new Uint8Array(0))).catch(() => {});
      return;
    }
    if (env.from !== adminAddr) return;
    const added = cleanMember(frame.meta.added);
    if (action === 'add' && added && g.members.length < MAX_GROUP && !g.members.find(m => m.address === added.address)) {
      g.members.push(added);
      appendThread('grp:' + gid, { id: env.id, dir: 'in', kind: 'system',
        text: t('groups.memberAdded', { name: added.petname }), ts: env.receivedAt });
    } else if (action === 'remove' && frame.meta.removed === myAddress) {
      // We were removed: the history stays readable, nothing more is sent (see renderGroupConv). Adding us again undoes it (applyGroupInvite).
      if (g.removedMe) return;
      g.members = g.members.filter(m => m.address !== myAddress);
      g.removedMe = { by: env.from, at: env.receivedAt || Date.now() };
      const by = contactByAddress(env.from)?.petname || g.members.find(m => m.address === env.from)?.petname || shortAddr(env.from);
      appendThread('grp:' + gid, { id: env.id, dir: 'in', kind: 'system', text: t('groups.youWereRemoved', { name: by }), ts: env.receivedAt });
    } else if (action === 'remove' && frame.meta.removed) {
      const rm = g.members.find(m => m.address === frame.meta.removed);
      g.members = g.members.filter(m => m.address !== frame.meta.removed);
      if (rm) appendThread('grp:' + gid, { id: env.id, dir: 'in', kind: 'system',
        text: t('groups.memberRemoved', { name: rm.petname }), ts: env.receivedAt });
    } else if (action === 'meta') {
      if (typeof frame.meta.name === 'string')        g.name        = frame.meta.name.slice(0, 80);
      if (typeof frame.meta.description === 'string') g.description = frame.meta.description.slice(0, 280);
      const picture = cleanGroupPicture(frame.meta.avatar); if (picture) g.avatar = picture;
      appendThread('grp:' + gid, { id: env.id, dir: 'in', kind: 'system',
        text: t('groups.infoUpdated'), ts: env.receivedAt });
    }
    await saveGroup(g);
    renderGroups();
    if (selectedGroup === gid) renderGroupConv();
    if (action === 'add') replayHeldGroupFrames(gid).catch(() => {});
    if (action === 'remove') prunePeers();
    return;

}

async function handleInbound(env) {
  const contact = contactByAddress(env.from);
  // A fellow group member who isn't a contact is pinned the same way, with keys fetched from the member's own address. If they aren't
  // here yet, they are fetched before anything is decrypted; a failure throws, and the message is retried later with the session untouched.
  let peer = contact ? null : peerByAddress(env.from);
  // Keys not fetched yet: fetch them in the background and retry this message later (it stays on the backend). Fetching here would hold
  // the session lock, and every send and receive with it, for as long as the network takes, which a forged sender could exploit.
  if (!contact && !peer && inAnyGroup(env.from)) {
    ensurePeer(env.from).catch(() => {});
    throw new Error('group member keys not fetched yet');
  }
  const pin = contact || peer;
  // The from-address is only a claim. For a known contact, a handshake must use the identity key fetched from their own .anyone address when they were added: making one with that key needs their private key.
  if (pin && env.x3dh && env.x3dh.ik !== pin.ecdhPub) throw identityMismatch();
  let s = pin ? pinnedSession(pin) : loadSession(env.from);
  let consumedOpkId = null;
  const wasWaiting = !!contact && !!s && s.role === 'initiator' && !s.confirmed;
  let adoptedNow = false;

  // If this contact's session blob is corrupt, never silently create a fresh responder session: that would discard the pinned ratchet state and accept a new handshake as if they were new.
  if (!s && corruptSessions.has(env.from)) {
    throw new Error('session state corrupt — refusing silent re-handshake');
  }

  // Adopt a responder session when there is no usable session or the tie-break says so, but never re-adopt a handshake we already adopted (same ephemeral key): a peer that keeps attaching its handshake would otherwise make us rebuild the session on every message and lose our sending-ratchet state.
  const seenEks = s ? [s.adoptedEk, ...(s.pastEks || [])].filter(Boolean) : [];
  const alreadyAdopted = !!s && !!env.x3dh && seenEks.includes(env.x3dh.ek);
  // A new handshake made with this person's pinned identity key (only they can complete one).
  const pinnedHandshake = !!env.x3dh && !!pin && !alreadyAdopted && env.x3dh.ik === pin.ecdhPub;
  // It names one of our one-time keys that we no longer have (handed out long ago, or pushed out): nothing can read it. Their app is
  // told so with a new session from us; it switches to ours (see "Their app couldn't use ours" below), and from then on both sides write.
  const opkGone = !!env.x3dh?.opkId && !loadOPKs()[env.x3dh.opkId]?.k;
  const cantReadTheirs = () => {
    if (pinnedHandshake) offerNewSession(env.from, false, 'opk');
    return new Error('handshake names a one-time key this app no longer has');
  };
  // Ours unanswered and theirs wins the tie-break (both wrote first): what we wrote on ours can't be read on their side.
  const lostTie = !!contact && !!s && s.role === 'initiator' && !s.confirmed && !!s.pendingX3DH;
  const header = { dh: env.dh, pn: env.pn || 0, n: env.n };
  let abandoned = null;
  if (env.x3dh && !alreadyAdopted && !opkGone && shouldAdoptResponder(s, env.x3dh)) {
    if (lostTie) abandoned = { ek: s.pendingX3DH.ek, since: s.startedAt || 0 };
    let opkPriv = null;
    if (env.x3dh.opkId) {
      const opks = loadOPKs();
      if (opks[env.x3dh.opkId]?.k) {
        opkPriv = opks[env.x3dh.opkId].k;
        consumedOpkId = env.x3dh.opkId;
      }
    }
    const verified = !!pin && pin.ecdhPub === env.x3dh.ik;
    s = await respondWithSpk(env.x3dh, opkPriv, { verified, remoteIk: env.x3dh.ik }, header, env.ct);   // remoteIk: checked against the pin if this stranger is added later
    s.adoptedEk = env.x3dh.ek;   // remember so a repeat handshake won't re-adopt
    if (seenEks.length) s.pastEks = seenEks.slice(-20);
    adoptedNow = true;
  }
  if (!s && opkGone) throw cantReadTheirs();
  if (!s) throw new Error('no session and no handshake header');

  // Decrypt on a clone and commit only on success, so a bad message can't desync the session.
  // There is deliberately no re-handshake-on-decrypt-failure path: the deterministic tie-break above is the only way a responder session is adopted. That is what stops simultaneous initiation (first messages crossing on fresh installs) from deadlocking; adopt-on-failure would flip both sides into responders on mismatched roots.
  let work = clone(s);
  let pt, resetNow = false;
  try { pt = await Ratchet.ratchetDecrypt(work, header, env.ct); }
  catch (e) {
    // Session reset: a contact (or pinned group member) whose app was restored from a backup, or reinstalled with the same identity,
    // has lost our shared session and starts a new one. Accepted only when ALL hold: we already had an established session with them
    // (so this is never the simultaneous-first-message case the tie-break above handles), it can't read this message, the handshake
    // uses their pinned identity key, its ephemeral key is new to us, and the new session really decrypts the message. That last check
    // needs their identity private key (X3DH), so nobody else can force a reset.
    const established = !!s && !adoptedNow && (s.confirmed === true || s.role === 'responder');
    if (pinnedHandshake && opkGone) throw cantReadTheirs();
    // Their app couldn't use ours: our first message named a one-time key their app had already forgotten. Then we are still waiting
    // for an answer, the tie-break may have kept our own session, and they say so in a silent 'accept' (why: 'opk') on a new session of
    // theirs. Taken only with that word, read from inside their new session: on any other message the tie-break stands, so two first
    // messages crossing can't leave both sides on different sessions.
    const waitingOnOurs = !!s && !adoptedNow && s.role === 'initiator' && !s.confirmed;
    // Someone who isn't a contact (any more) starts over with a new handshake, while we still keep the session from when they were one
    // (removing a contact keeps it, so their next message can be read). Their new session replaces it, unverified, and what they write
    // arrives as a message request: accepting it checks the key served at their address, as for any request.
    const formerContact = !!env.x3dh && !pin && !alreadyAdopted && established;
    if (!(pinnedHandshake && (established || waitingOnOurs)) && !formerContact) throw e;
    let opkPriv = null;
    if (env.x3dh.opkId) { const opks = loadOPKs(); if (opks[env.x3dh.opkId]?.k) { opkPriv = opks[env.x3dh.opkId].k; consumedOpkId = env.x3dh.opkId; } }
    const fresh = await respondWithSpk(env.x3dh, opkPriv, { verified: !!pin, remoteIk: env.x3dh.ik }, header, env.ct);
    fresh.adoptedEk = env.x3dh.ek;
    fresh.pastEks = seenEks.slice(-20);
    work = clone(fresh);
    pt = await Ratchet.ratchetDecrypt(work, header, env.ct);   // throws if the handshake isn't genuinely theirs: nothing is replaced
    // A late copy of their first session, the one that lost the tie-break when both wrote first (still in the network, or retried): it
    // was written before they first wrote on ours, by their own clock. A real restore starts a session after that. Taking the copy for
    // a restore would put a session their app has dropped in place of the one both use, and nothing would get through after it.
    if (established) {
      let f = null; try { f = decodeFrame(pt); } catch {}
      const at = Number(f?.meta?.at);
      if (Number.isFinite(at) && Number.isFinite(s.peerSince) && at < s.peerSince) {
        s.pastEks = [...(s.pastEks || []), env.x3dh.ek].slice(-20);
        saveSession(env.from, s);
        throw e;
      }
    }
    if (!established && pin) {
      let f = null; try { f = decodeFrame(pt); } catch {}
      if (!(f && f.kind === 'accept' && f.meta?.why === 'opk')) {
        // Their first session, which lost the tie-break to ours (both wrote first): their app drops it once ours reaches it. Remembered,
        // so a copy arriving later (a retry, a delay in the network) is never taken for "their app was restored" and put in place of ours.
        s.pastEks = [...(s.pastEks || []), env.x3dh.ek].slice(-20);
        saveSession(env.from, s);
        throw e;
      }
      console.info('[session] new session from', env.from, '(their app could not use our first handshake)');
    } else console.info('[session] new session from', env.from, '(their app was restored or reinstalled with the same identity)');
    resetNow = adoptedNow = true;
  }
  // When they first wrote on this session, by their clock (see "late copy" above).
  if (!Number.isFinite(work.peerSince)) { try { const at = Number(decodeFrame(pt)?.meta?.at); if (Number.isFinite(at) && at > 0) work.peerSince = at; } catch {} }
  saveSession(env.from, work);
  if (abandoned && contact) setTimeout(() => resendOnAdoptedSession(contact, abandoned).catch(() => {}), 0);

  if (consumedOpkId) {
    const opks = loadOPKs();
    delete opks[consumedOpkId];
    saveOPKs(opks);
  }

  const frame = cleanFrame(decodeFrame(pt));
  if (!frame) return;                    // not a message this app could show: dropped, the session step above is kept

  // Someone who isn't a contact: only group traffic from a fellow member takes the normal path below; everything else is a message request.
  if (!contact && !isGroupFrameFromMember(env.from, frame)) {
    if (typeof frame.meta?.grp === 'string' && !frame.kind.startsWith('group-')) { applyGroupFrame(env, frame, !!work.verified); return; }
    // Written on a session from when they were our contact (we removed them): their app still treats us as a contact. A new request
    // from them tells their app it is one now, so it limits them to text until we accept, as for anyone new.
    const fromFormerContact = !adoptedNow && !!work.remoteIk && (work.confirmed === true || work.role === 'responder');
    const isNewRequest = !requests[env.from];
    addToRequest(env, frame);
    if (fromFormerContact && isNewRequest && requests[env.from]) tellNowARequest(env.from, work.remoteIk);
    return;
  }
  if (!contact) {
    // A group member we don't have as a contact: group traffic only, nothing direct.
    if (frame.kind === 'accept' || frame.kind === 'read' || frame.kind === 'call') return;
  }

  // A contact started a session with us (they added us, and we already had them): tell their app it can send everything, as Accept does.
  // After a session reset, answer even their silent 'accept': that confirms the new session on their side, so they can send everything again.
  if (contact && adoptedNow && (frame.kind !== 'accept' || resetNow)) setTimeout(() => deliver(contact, encodeFrame('accept', { via: 'contact' }, new Uint8Array(0))).catch(() => {}), 0);
  // They removed us: what we write arrives as a message request, so only text goes out until they accept (or write to us again).
  if (contact && frame.kind === 'request') {
    const cur = loadSession(env.from);
    if (cur && !cur.asRequest) { cur.asRequest = true; saveSession(env.from, cur); }
    if (selected === env.from && !selectedGroup) renderConversation();
    return;
  }
  if (contact) { const cur = loadSession(env.from); if (cur && cur.asRequest) { delete cur.asRequest; saveSession(env.from, cur); if (selected === env.from && !selectedGroup) renderConversation(); } }
  if (frame.kind === 'accept') {
    if (wasWaiting && frame.meta?.via === 'request') toast(t('req.acceptedBy', { name: contact.petname }), 6000);
    if (selected === env.from && !selectedGroup) renderConversation();
    return;
  }

  if (frame.kind === 'read') { markMessagesRead(env.from, frame.meta?.ids || []); return; }
  if (frame.kind === 'call') {
    // An invite that sat in the inbox (app locked, window closed) is not a live call any more: show it as missed instead of ringing.
    if (frame.meta?.op === 'invite' && Date.now() - (env.receivedAt || Date.now()) > 60_000) {
      if (contactByAddress(env.from)) appendThread(env.from, { id: 'call-' + env.id, dir: 'in', kind: 'system', text: t('call.log.missed'), ts: env.receivedAt });
    } else calls.onSignal(env.from, frame.meta || {});
    return;
  }

  if (frame.kind === 'group-invite') return applyGroupInvite(env, frame);

  if (frame.kind === 'group-leave') {
    const gid = frame.meta?.grp; const g = groupById(gid);
    if (g) {
      const leaving = g.members.find(m => m.address === env.from);
      if (!leaving) return;
      appendThread('grp:' + gid, { id: env.id, dir: 'in', kind: 'system',
        text: t('groups.memberLeft', { name: leaving.petname }), ts: env.receivedAt });
      g.members = g.members.filter(m => m.address !== env.from);
      // Kept a while, so a list the admin sends later still says who left rather than who was removed.
      g.leftRecently = [...(Array.isArray(g.leftRecently) ? g.leftRecently : []).filter((x) => x && x.address !== env.from && Date.now() - x.at < 30 * 86400000), { address: env.from, at: Date.now() }].slice(-20);
      await saveGroup(g);
      if (selectedGroup === gid) renderGroupConv();
      // The admin passes the new list on: a member who missed the notice (offline for longer than the leaver's app kept it, or restoring
      // from a backup, which can't read what was written to the old app) would otherwise keep writing to someone who left.
      const adminAddr = g.adminAddr || g.createdBy || (g.members[0] && g.members[0].address);
      if (adminAddr === myAddress) syncRoster(g, { left: [env.from] });
    }
    return;
  }

  // Only honour a dissolve from the recorded admin.
  if (frame.kind === 'group-dissolve') {
    const gid = frame.meta?.grp; const g = groupById(gid);
    if (g) {
      const adminAddr = g.adminAddr || g.createdBy || (g.members[0] && g.members[0].address);
      if (env.from !== adminAddr) return;
      await deleteGroup(gid);
      if (selectedGroup === gid) { selectedGroup = null; renderConversation(); }
      renderGroups();
      toast(t('groups.dissolved', { name: g.name }));
    }
    return;
  }

  // Most group updates are admin-only; 'joined' is the exception because a new member sends it to the admin.
  if (frame.kind === 'group-update') return applyGroupUpdate(env, frame);

  if (frame.meta?.grp) { applyGroupFrame(env, frame, !!work.verified); return; }

  if (frame.kind === 'reaction') {
    applyReaction(env.from, frame.meta?.reactTo, frame.meta?.emoji, env.from, null);
    if (selected === env.from) renderConversation();
    return;
  }
  const ttl       = Number(frame.meta?.ttl) || 0;
  const expiresAt = ttl ? Date.now() + ttl * 1000 : null;
  const dmid = incomingId(env.from, frame.meta?.mid, env);
  if (!dmid) return;
  const rec = { id: dmid, dir: 'in', kind: frame.kind, ts: env.receivedAt,
    verified: !!work.verified, meta: frame.meta, expiresAt, senderAddr: env.from,
    replyTo: frame.meta?.replyTo || null };
  rec.ts = writtenOrderTs(env.from, rec);
  if (frame.kind === 'text') rec.text = td.decode(frame.payload);
  else {
    const blob = new Blob([frame.payload], { type: frame.meta?.type || 'application/octet-stream' });
    rememberMedia(rec.id, blob, env.from, rec.ts);
  }
  appendThread(env.from, rec);
}
// Messages a moment apart each go out on their own (one at a time, each would wait a whole network round trip for the one before), so
// a later one can arrive first. Shown in the order they were written: by the time the writer's app put on each (its own clock, so a
// difference between computers doesn't matter), never moved above anything we wrote since.
function writtenOrderTs(addr, rec) {
  const at = Number(rec.meta?.at);
  if (!Number.isFinite(at)) return rec.ts;
  // The run of their messages since the last thing that isn't theirs (our own message, a call line): nothing moves above that.
  const th = loadThread(addr), run = [];
  let floor = -Infinity;
  for (let i = th.length - 1; i >= 0; i--) {
    const m = th[i];
    if (m.dir !== 'in' || m.kind === 'system') { floor = Number(m.ts) || -Infinity; break; }
    if (rec.senderAddr && m.senderAddr && m.senderAddr !== rec.senderAddr) continue;   // in a group: only the same writer's messages
    if (Number.isFinite(Number(m.meta?.at))) run.push(m);
  }
  const later = run.filter((m) => Number(m.meta.at) > at);
  if (!later.length) return rec.ts;                                   // the newest they wrote: its place is at the end
  const next = Math.min(...later.map((m) => m.ts));                   // goes before the first of those written after it…
  const prev = Math.max(floor, ...run.filter((m) => Number(m.meta.at) < at && m.ts < next).map((m) => m.ts));   // …after those before it
  return Number.isFinite(prev) ? (prev + next) / 2 : next - 1;        // strictly between, never equal to a neighbour
}

// What arrives in a message is the sender's to choose: every field the app stores or draws is checked here, once, the same way as the
// profile fields on the backend (lib/peerdata.js). A field of the wrong type or size is dropped; a frame with no proper kind is dropped
// whole. Group lists (group-invite, group-update) are checked where they are applied.
const MAX_EMOJI_LEN = 32;
const FRAME_KIND_RE = /^[a-z][a-z-]{0,31}$/;
const THUMB_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MEMBER_ADDR_RE = /^[a-z2-7]{56}\.anyone$/;
function cleanFrame(f) {
  if (!f || typeof f.kind !== 'string' || !FRAME_KIND_RE.test(f.kind)) return null;
  const m = f.meta && typeof f.meta === 'object' && !Array.isArray(f.meta) ? { ...f.meta } : {};
  const str = (k, max) => { if (k in m && !(typeof m[k] === 'string' && m[k].length > 0 && m[k].length <= max)) delete m[k]; };
  str('mid', 80); str('reactTo', 80); str('grp', 64); str('emoji', MAX_EMOJI_LEN);
  if ('replyTo' in m) {
    const id = m.replyTo && typeof m.replyTo === 'object' && typeof m.replyTo.id === 'string' && m.replyTo.id.length <= 80 ? m.replyTo.id : null;
    if (id) m.replyTo = { id }; else delete m.replyTo;
  }
  if ('at' in m && !(Number.isFinite(m.at) && m.at > 0)) delete m.at;
  if ('ttl' in m) { const n = Number(m.ttl); if (Number.isFinite(n) && n > 0 && n <= 366 * 86400) m.ttl = n; else delete m.ttl; }
  if ('ids' in m) m.ids = Array.isArray(m.ids) ? m.ids.filter((x) => typeof x === 'string' && x.length <= 80).slice(0, 1000) : [];
  if (MEDIA_KINDS.has(f.kind)) {
    str('name', 255); str('type', 200);
    if ('size' in m && !(Number.isFinite(m.size) && m.size >= 0)) delete m.size;
    if ('thumb' in m && !(typeof m.thumb === 'string' && m.thumb.length <= 200000 && THUMB_RE.test(m.thumb))) delete m.thumb;
  }
  return { kind: f.kind, meta: m, payload: f.payload instanceof Uint8Array ? f.payload : new Uint8Array(0) };
}
// One member in a group list from the admin: an address and a short name, nothing else kept.
function cleanMember(m) {
  if (!m || typeof m.address !== 'string' || !MEMBER_ADDR_RE.test(m.address) || typeof m.petname !== 'string') return null;
  return { address: m.address, petname: m.petname.slice(0, 40) };
}

// A group message. One that arrives before we know the group or the sender as a member (the admin's updated list is still on its way)
// is held for a few minutes and replayed when the list comes, instead of being lost.
const HELD_GROUP_TTL = 10 * 60 * 1000, MAX_HELD_GROUP = 100;
let heldGroupFrames = [];
function applyGroupFrame(env, frame, verified) {
    const gid = frame.meta?.grp;
    if (typeof gid !== 'string') return;
    const g = groupById(gid);
    if (g && g.removedMe) return;            // we were removed: nothing new is shown
    // Sender must be a current member of this group. env.from is authenticated.
    const sender = g && g.members.find(m => m.address === env.from);
    if (!sender) {
      heldGroupFrames.push({ env, frame, verified, at: Date.now() });
      if (heldGroupFrames.length > MAX_HELD_GROUP) heldGroupFrames.splice(0, heldGroupFrames.length - MAX_HELD_GROUP);
      return;
    }
    const shownName = contactByAddress(env.from)?.petname || sender.petname;
    const grpMeta = { ...frame.meta }; delete grpMeta.grp;

    if (frame.kind === 'reaction') {
      applyReaction('grp:' + gid, frame.meta?.reactTo, frame.meta?.emoji, env.from, shownName);
      if (selectedGroup === gid) renderGroupConv();
      return;
    }

    const ttl       = Number(frame.meta?.ttl) || 0;
    const expiresAt = ttl ? Date.now() + ttl * 1000 : null;
    const gmid = incomingId('grp:' + gid, frame.meta?.mid, env);
    if (!gmid) return;
    const rec = { id: gmid, dir: 'in', kind: frame.kind, ts: env.receivedAt,
      verified: !!verified, grp: gid,
      senderAddr: env.from, senderPetname: shownName, senderName: shownName,
      meta: grpMeta, expiresAt, replyTo: frame.meta?.replyTo || null };
    rec.ts = writtenOrderTs('grp:' + gid, rec);
    if (frame.kind === 'text') rec.text = td.decode(frame.payload);
    else {
      const blob = new Blob([frame.payload], { type: frame.meta?.type || 'application/octet-stream' });
      rememberMedia(rec.id, blob, 'grp:' + gid, rec.ts);
    }
    appendThread('grp:' + gid, rec);
    if (selectedGroup === gid) renderGroupConv();
}
// Replay held messages for a group whose list just changed. A sender who wasn't pinned when the message came must now prove to be the
// owner of the address: the keys served there have to match the ones the message was sent with.
async function replayHeldGroupFrames(gid) {
  const now = Date.now();
  heldGroupFrames = heldGroupFrames.filter(h => now - h.at < HELD_GROUP_TTL);
  const g = groupById(gid);
  if (!g) return;
  const ready = heldGroupFrames.filter(h => h.frame.meta?.grp === gid && g.members.some(m => m.address === h.env.from));
  heldGroupFrames = heldGroupFrames.filter(h => !ready.includes(h));
  for (const h of ready) {
    let holder = keyHolder(h.env.from);
    if (!holder) { try { holder = await ensurePeer(h.env.from); } catch { continue; } }
    const sess = loadSession(h.env.from);
    if (!sess || !sessionMatchesPin(holder, sess)) continue;
    applyGroupFrame(h.env, h.frame, true);
  }
}

function applyReaction(threadKey, msgId, emoji, fromAddr, fromName) {
  if (typeof msgId !== 'string' || !msgId || typeof emoji !== 'string' || !emoji || emoji.length > MAX_EMOJI_LEN || !fromAddr) return;
  const thread = loadThread(threadKey);
  const m = thread.find(x => x.id === msgId);
  if (!m) return;
  m.reactions = m.reactions || {};
  if (m.reactions[fromAddr] && m.reactions[fromAddr].emoji === emoji) {
    delete m.reactions[fromAddr];
  } else {
    m.reactions[fromAddr] = { emoji, name: fromName || null, ts: Date.now() };
  }
  persistField(LS.thread(threadKey), thread);
}

// Serialize every session read-modify-write (send and receive) through one queue. Without it, a send and a receive (or two receives) interleave: each reads the session, advances it, and the later save discards the earlier chain progress. That desyncs the ratchet: one side's messages reuse a consumed message number and the peer drops them as duplicates until a restart. Only the session mutation is locked; the slow network send runs outside the lock (see deliver).
let _sessionOpChain = Promise.resolve();
function withSessionLock(fn) {
  const run = _sessionOpChain.then(fn, fn);
  _sessionOpChain = run.then(() => {}, () => {});
  return run;
}
async function processEnvelope(env) {
  await contactsLoaded;
  return withSessionLock(() => _processEnvelopeInner(env));
}
async function _processEnvelopeInner(env) {
  const proc = processedSet();
  if (proc.has(env.id)) return true;
  try {
    await handleInbound(env);
    markProcessed(env.id);
    _inboundFails.delete(env.id);
    return true;
  } catch (e) {
    // Wrong identity key for a known contact: an impostor. Retrying can't change that, so drop it now and say what happened.
    if (e && e.code === 'IK_MISMATCH') {
      markProcessed(env.id);
      _inboundFails.delete(env.id);
      const who = contactByAddress(env.from);
      console.warn('[inbound] rejected handshake with the wrong identity key', env.id, 'claiming', env.from);
      toast(t('msg.keyMismatch', { name: who ? who.petname : shortAddr(env.from) }), 8000);
      return true;
    }
    // A contact or group member writing on a session we don't have (this app was restored from a backup) or can't read: offer them a
    // new one. Their app accepts it only from our pinned identity key (see "Session reset" in handleInbound).
    if (!env.x3dh && keyHolder(env.from) && !/group member keys not fetched/.test(e.message || '')) offerNewSession(env.from);
    // Surface the failure instead of dropping it silently; keep the message on the server for a few retries in case the session recovers.
    const n = (_inboundFails.get(env.id) || 0) + 1;
    _inboundFails.set(env.id, n);
    console.warn(`[inbound] handle failed (attempt ${n}/${MAX_INBOUND_RETRIES})`, env.id, 'from', env.from, '-', e.message);
    _lastInboundError = { id: env.id, from: env.from, message: e.message, attempts: n, ts: Date.now() };
    const who = contactByAddress(env.from);
    if (n === 1 && who) {                // strangers' undecryptable messages are dropped quietly: a toast per message would let anyone spam them
      toast(t('msg.decryptFail', { name: who.petname }));
    }
    if (n >= MAX_INBOUND_RETRIES) {
      markProcessed(env.id);
      _inboundFails.delete(env.id);
      return true;
    }
    return false;                       // retry — caller must NOT ack yet
  }
}
const MAX_INBOUND_RETRIES = 5;
// A new session for someone, at most every 10 minutes each: our next message carries a fresh handshake. Sent as a silent 'accept' (for a
// group member who isn't a contact, tagged with a group we share, so their app doesn't take it for a message request).
const _sessionOffers = new Map();
function offerNewSession(addr, force = false, why = null) {
  const now = Date.now();
  if (!force && now - (_sessionOffers.get(addr) || 0) < 10 * 60 * 1000) return;
  _sessionOffers.set(addr, now);
  setTimeout(() => {                                 // outside the session lock this runs under
    const holder = keyHolder(addr);
    if (!holder) return;
    const meta = { via: 'session' };
    if (why) meta.why = why;
    if (!contactByAddress(addr)) { const g = groups.find((x) => x.members.some((m) => m.address === addr)); if (!g) return; meta.grp = g.id; }
    // With no session, deliver() starts one and the message carries the handshake; with our own new, unconfirmed one it still does.
    deliver(holder, encodeFrame('accept', meta, new Uint8Array(0))).catch(() => {});
  }, 0);
}
const _inboundFails = new Map();
let _lastInboundError = null;
async function ackEnvelopes(ids) {
  if (!ids.length) return;
  try { await fetch('/api/messages/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) }); }
  catch {}
}

let ws = null;
// Every message shown as waiting (⏳) is checked against the backend whenever the window (re)connects. An outcome reported while the
// window was closed or reloading (delivered, or not delivered in time) would otherwise never reach it, and ⏳ would stay for good.
async function reconcileWaiting() {
  let items, outcomes;
  try {
    // The queue first, then the outcomes: a message gone from the first was answered before the second was asked, so it is in it.
    items = await fetch('/api/outbox').then((r) => r.json()).then((j) => j.items);
    outcomes = await fetch('/api/outbox/outcomes').then((r) => r.json()).then((j) => j.outcomes);
  } catch { return; }
  if (!Array.isArray(items) || !Array.isArray(outcomes)) return;
  const byQueue = new Map(outcomes.map((o) => [o.id, o]));
  const byMsg = new Map(outcomes.filter((o) => o.msgId).map((o) => [o.msgId, o]));
  const queued = new Set(items.map((i) => i.id));
  const queuedByMsg = new Map(items.filter((i) => i.msgId).map((i) => [i.msgId, i.id]));
  const now = Date.now();
  for (const [addr, thread] of threadCache) {
    if (addr.startsWith('grp:')) {
      // A group message still marked ⏳ that this window isn't handing over (the app was closed meanwhile): the mark can't come off by
      // itself any more.
      let stale = false;
      for (const m of thread) if (m.dir === 'out' && m.pending && !_groupSending.has(m.id) && now - (m.ts || 0) > 60_000) { delete m.pending; stale = true; }
      if (stale) { persistField(LS.thread(addr), thread); if (selectedGroup === addr.slice(4)) renderGroupConv(); }
      continue;
    }
    let changed = false;
    for (const m of thread) {
      if (m.dir !== 'out' || !(m.pending || m.queueId)) continue;
      const o = (m.queueId && byQueue.get(m.queueId)) || byMsg.get(m.id);
      if (o) { delete m.pending; delete m.queueId; if (o.outcome !== 'delivered') m.failed = true; changed = true; continue; }
      if (m.queueId && queued.has(m.queueId)) continue;                       // still waiting
      const q = queuedByMsg.get(m.id);
      if (q) { if (m.queueId !== q) { m.queueId = q; m.pending = true; changed = true; } continue; }   // waiting, its queue id never reached us
      // Neither waiting nor answered, a minute after it was written: it never reached the queue (the app closed while it was being
      // encrypted), or so long ago that its outcome is no longer kept. Either way it can't be shown as on its way.
      if (now - (m.ts || 0) > 60_000) { delete m.pending; delete m.queueId; m.failed = true; changed = true; }
    }
    if (changed) {
      persistField(LS.thread(addr), thread);
      if (selected === addr && !selectedGroup) renderConversation();
    }
  }
}
// The dot beside the name, in one look: can people reach me?
//   cyan, pulsing  the network is ready, our address is reachable (published, introduction points open) and our own lookup finds it
//   amber          the network is still starting, or our address is not reachable yet, or our own lookup of it failed (the app is repairing it)
//   red            the window has lost its link to the app
// Only what is confirmed turns it amber: "not checked yet", "checking" and "could not check" leave it as it is.
let _wsOnline = true, _netReady = null, _reach = null, _netTimer = 0, _dotTipBound = false;
function netDotState() {
  if (!_wsOnline) return ['offline', 'net.offline'];
  if (!_netReady) return ['amber', 'net.connecting'];
  if (_reach) {
    if (['not-published', 'establishing', 'published-no-intro', 'no-address'].includes(_reach.detail)) return ['amber', 'net.publishing'];
    if (_reach.self === 'not-findable') return ['amber', 'net.notfindable'];
  }
  return ['online', 'net.online'];
}
function paintNetDot() {
  const dot = $('#ws-dot'); if (!dot) return;
  const [st, key] = netDotState();
  dot.classList.toggle('online', st === 'online');
  dot.classList.toggle('connecting', st === 'amber');
  dot.classList.toggle('offline', st === 'offline');
  dot._tipText = t(key);
  dot.setAttribute('aria-label', dot._tipText); dot.removeAttribute('aria-hidden'); dot.setAttribute('role', 'img');
  if (!_dotTipBound) { _dotTipBound = true; dot.addEventListener('mouseenter', () => showTip(dot, dot._tipText)); dot.addEventListener('mouseleave', hideTip); }
}
async function pollNet() {
  clearTimeout(_netTimer);
  let ready = false;
  try { const w = await fetch('/api/whoami').then((r) => r.json()); ready = w.network === 'ready'; _wsOnline = true; }
  catch { ready = false; _wsOnline = false; }
  _netReady = ready;
  // Whether our address is reachable and findable (the same answer as the Status tab). No answer: nothing is known, so nothing is claimed.
  _reach = null;
  if (ready) {
    try {
      const r = await fetch('/api/hs/health');
      if (r.ok) { const h = await r.json(); _reach = { detail: h.detail || 'unknown', self: (h.selfTest && h.selfTest.state) || 'idle' }; }
    } catch {}
  }
  paintNetDot();
  _netTimer = setTimeout(pollNet, ready ? 10000 : 3000);
}
function setWsStatus(online) { _wsOnline = online; if (!online) { _netReady = false; _reach = null; } paintNetDot(); if (online) pollNet(); }
let _wsEverConnected = false;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try { ws = new WebSocket(`${proto}://${location.host}/ws`); }
  catch { setTimeout(connectWS, 3000); return; }

  ws.onopen = () => { _wsEverConnected = true; setWsStatus(true); reconcileWaiting().catch(() => {}); };
  ws.onclose = () => { if (_wsEverConnected) setWsStatus(false); setTimeout(connectWS, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'outbox:delivered' || msg.type === 'outbox:expired') {
      const { toAddress, id: queueId, msgId } = msg;
      const thread = loadThread(toAddress);
      let changed = false, wasWaiting = false;
      for (const m of thread) {
        // By queue id once the window knows it; by the message's own id while its first tries are still running (or if their answer never
        // came back: the window closed meanwhile).
        const byQueue = m.queueId === queueId, byId = !!msgId && m.id === msgId && (m.pending || m.queueId);
        if (byQueue || byId) {
          if (m.queueId) wasWaiting = true;
          delete m.pending; delete m.queueId;
          if (msg.type === 'outbox:expired') m.failed = true;
          changed = true;
        }
      }
      if (changed) {
        persistField(LS.thread(toAddress), thread);
        if (selected === toAddress) renderConversation();
      }
      // Only for a message that was shown as waiting: receipts, reactions and group copies are queued too, and need no word.
      if (changed && (wasWaiting || msg.type === 'outbox:expired')) toast(msg.type === 'outbox:delivered' ? t('msg.pendingDelivered') : t('msg.pendingExpired'));
      return;
    }

    // The backend got a message from a contact or group member it has no mailbox key for (it asked the sender to retry): hand it over.
    if (msg.type === 'mailbox:missing') {
      const holder = keyHolder(msg.address);
      _mboxGiven.delete(msg.address);              // the backend says it doesn't have it, whatever we thought
      if (holder) ensureMailboxKey(holder).catch(() => {});
      else if (inAnyGroup(msg.address)) ensurePeer(msg.address).catch(() => {});
      return;
    }

    if (msg.type !== 'inbox' || !msg.envelope) return;
    const ok = await processEnvelope(msg.envelope);
    if (ok) await ackEnvelopes([msg.envelope.id]);
    try { document.dispatchEvent(new CustomEvent('anon:traffic')); } catch {}
    await loadContacts();
    if (selected) renderConversation();
  };
}

async function poll() {
  try {
    // The backend answers in parts of ~32 MB; ask again while it says there is more and this round cleared something.
    for (let round = 0; round < 50; round++) {
      const r = await fetch('/api/messages');
      if (!r.ok) break;
      const inbox = await r.json();
      const ack = [];
      for (const env of inbox) {
        const ok = await processEnvelope(env);
        if (ok) ack.push(env.id);
      }
      await ackEnvelopes(ack);
      if (r.headers.get('X-More') !== '1' || !ack.length) break;
    }
    await loadContacts();
    await refreshReadReceiptSetting();
    if (selected) renderConversation();
  } catch {}
}

function gatherThread(addr) {
  const now = Date.now();
  const raw = loadThread(addr);
  const fresh = raw.filter(m => !m.expiresAt || m.expiresAt > now);
  if (fresh.length !== raw.length) {
    for (const m of raw) {
      if (!fresh.find(x => x.id === m.id)) forgetMedia(m.id);
    }
    threadCache.set(addr, fresh);
    persistField(LS.thread(addr), fresh);
  }
  loadThreadMedia(addr, fresh);
  return fresh.map(m => ({ ...m, url: sessionUrls.get(m.id) || null })).sort((a, b) => a.ts - b.ts);
}

function sweepExpiredMessages() {
  const now = Date.now();
  let visibleThreadChanged = false;
  const activeKey = selectedGroup ? ('grp:' + selectedGroup) : selected;

  for (const [addr, thread] of threadCache.entries()) {
    if (!thread.some(m => m.expiresAt && m.expiresAt <= now)) continue;
    const fresh = thread.filter(m => !m.expiresAt || m.expiresAt > now);
    for (const m of thread) {
      if (m.expiresAt && m.expiresAt <= now) forgetMedia(m.id);
    }
    threadCache.set(addr, fresh);
    persistField(LS.thread(addr), fresh);
    if (addr === activeKey) visibleThreadChanged = true;
  }
  if (visibleThreadChanged) {
    if (selectedGroup) renderGroupConv(); else renderConversation();
  }
}
setInterval(sweepExpiredMessages, 2000);

function formatDayHeader(ts) {
  const d = new Date(ts);
  const today = new Date(); today.setHours(0,0,0,0);
  const that  = new Date(ts); that.setHours(0,0,0,0);
  const diffDays = Math.round((today - that) / 86400000);
  if (diffDays === 0) return t('date.today');
  if (diffDays === 1) return t('date.yesterday');
  if (diffDays < 7)   return d.toLocaleDateString(getLang(), { weekday: 'long' });
  return d.toLocaleDateString(getLang(), { day: 'numeric', month: 'short', year: today.getFullYear() === d.getFullYear() ? undefined : 'numeric' });
}

function buildBubbleNodes(thread, convKey) {
  const nodes = [];
  const index = new Map();                 // message id -> the first message with that id in this conversation
  for (const x of thread) if (x && typeof x.id === 'string' && !index.has(x.id)) index.set(x.id, x);
  let lastDay = null, prev = null;
  const sepId = convKey ? unreadSeparatorAt.get(convKey) : null;
  for (let i = 0; i < thread.length; i++) {
    const m = thread[i];
    if (sepId && m.id === sepId) {
      nodes.push(el('div', { className: 'unread-sep' },
        el('span', { className: 'unread-sep-label', textContent: t('conv.newMessages') })));
      prev = null;
    }
    const day = new Date(m.ts); day.setHours(0,0,0,0);
    if (lastDay === null || day.getTime() !== lastDay) {
      nodes.push(el('div', { className: 'day-divider' },
        el('span', { className: 'day-divider-label', textContent: formatDayHeader(m.ts) })));
      lastDay = day.getTime();
      prev = null;
    }
    // In a group, messages in a row from the same person show their name and picture once, on the first.
    const cont = !!(prev && m.grp && m.dir === 'in' && prev.grp && prev.dir === 'in' && prev.kind !== 'system' && m.kind !== 'system'
      && m.senderAddr && prev.senderAddr === m.senderAddr);
    nodes.push(renderBubble(m, index, cont));
    prev = m;
  }
  return nodes;
}
function renderGroups() {
  updateUnreadTotal();
  const list = $('#groups'); if (!list) return;
  list.innerHTML = '';
  if (!groups.length) {
    list.append(el('div', { className: 'empty-rail', textContent: '' }));
    return;
  }
  for (const g of sortPinnedFirst(groups, (g) => 'grp:' + g.id)) {
    const gkey = 'grp:' + g.id;
    const unread = unreadContacts.get(gkey) || 0;
    const pinned = isPinned(gkey);
    const row = el('button', { className: 'contact' + (selectedGroup === g.id ? ' active' : '') + (unread > 0 ? ' unread' : '') + (pinned ? ' pinned' : '') });
    const av = el('div', { className: 'grp-avatar' });
    if (cleanGroupPicture(g.avatar)) {
      const img = el('img', { src: g.avatar, className: 'grp-avatar-custom', alt: g.name });
      av.append(img);
    } else {
      const shown = g.members.filter(m => m.address !== myAddress).slice(0, 2);
      if (shown.length === 0) {
        av.append(el('div', { className: 'grp-avatar-default', innerHTML: GROUP_ICON_SVG }));
      } else {
        shown.forEach((m, i) => {
          const c = contacts.find(c => c.address === m.address);
          const d = el('div', { className: 'grp-av-mini' });
          d.append(renderAvatarEl(m.address, c?.avatar || peerByAddress(m.address)?.avatar || null, 18, '', m.petname));
          d.style.zIndex = 10 - i;
          av.append(d);
        });
      }
    }
    const txt = el('div', { className: 'contact-text' });
    const count = g.members.length;
    txt.append(
      el('div', { className: 'contact-name', textContent: g.name }),
      unread > 0 ? unreadLine(unread) : el('div', { className: 'contact-addr', textContent: t('groups.membersCount', { n: count }) })
    );
    row.oncontextmenu = (e) => {
      e.preventDefault();
      openMenu({ x: e.clientX, y: e.clientY }, [
        { label: pinned ? t('pin.unpin') : t('pin.pin'), icon: pinSVG(pinned), desc: t(pinned ? 'menu.d.unpin' : 'menu.d.pin'), run: () => { togglePinned(gkey); renderGroups(); } },
        { sep: true },
        groupLeaveItem(g),
      ]);
    };
    row.append(av, txt);
    row.append(rowTrail(pinned, unread > 0));
    row.onclick = () => openGroupChat(g);
    list.append(row);
  }
}

// Header helpers: the disappearing-messages setting and the small badge beside the chat name that shows it.
const ttlShort = (secs) => secs >= 604800 ? Math.round(secs / 604800) + 'w' : secs >= 86400 ? Math.round(secs / 86400) + 'd' : secs >= 3600 ? Math.round(secs / 3600) + 'h' : secs >= 60 ? Math.round(secs / 60) + 'm' : secs + 's';
function ttlBadgeEl(key) {
  const secs = threadTtl.get(key) || 0;
  if (!secs) return null;
  const b = el('span', { className: 'ttl-badge', title: t('ttl.title') });
  b.innerHTML = MENU_ICONS.timer.replace('width="16" height="16"', 'width="12" height="12"');
  b.append(el('span', { textContent: ttlShort(secs) }));
  return b;
}
function refreshTtlBadge(key) {
  const name = document.querySelector('#conv-head .conv-name');
  if (!name) return;
  name.querySelector('.ttl-badge')?.remove();
  const b = ttlBadgeEl(key); if (b) name.append(b);
}
function setThreadTtl(key, p) {
  if (p.secs) threadTtl.set(key, p.secs); else threadTtl.delete(key);
  if (p.secs) prefs.ttl[key] = p.secs; else delete prefs.ttl[key];
  savePrefs();
  refreshTtlBadge(key);
  toast(p.secs ? t('ttl.on', { time: p.label }) : t('ttl.off'));
}
const ttlLabelOf = (key) => (TTL_PRESETS.find((p) => p.secs === (threadTtl.get(key) || 0)) || TTL_PRESETS[0]).label;
const ttlItem = (key) => ({ label: t('ttl.title'), icon: MENU_ICONS.timer, value: ttlLabelOf(key), desc: t('menu.d.ttl'),
  page: () => TTL_PRESETS.map((p) => ({ label: p.label, checked: p.secs === (threadTtl.get(key) || 0), run: () => setThreadTtl(key, p) })) });
const pinItem = (key, redraw) => { const on = isPinned(key); return { label: on ? t('pin.unpin') : t('pin.pin'), icon: pinSVG(on), desc: t(on ? 'menu.d.unpin' : 'menu.d.pin'), run: () => { togglePinned(key); redraw(); } }; };
const headBtn = (cls, title, html) => {
  const b = el('button', { className: 'head-btn ' + cls, type: 'button', 'aria-label': title, innerHTML: html });
  b.addEventListener('mouseenter', () => showTip(b, title)); b.addEventListener('mouseleave', hideTip); b.addEventListener('click', hideTip);   // in-page bubble: a native title is a separate OS window
  return b;
};

// Leave group (or Delete group, once the admin removed us): in the chat's ⋮ menu and on a right-click in the group list.
function groupLeaveItem(g) {
  return g.removedMe
    ? { label: t('groups.deleteGroup'), icon: MENU_ICONS.trash, danger: true, desc: t('menu.d.deleteGroup'), run: async () => { if (await askConfirm(t('groups.deleteConfirm', { name: g.name }), t('groups.deleteGroup'))) { await deleteGroup(g.id); if (selectedGroup === g.id) selectedGroup = null; renderGroups(); renderConversation(); } } }
    : { label: t('groups.leave'), icon: MENU_ICONS.leave, danger: true, desc: t('menu.d.leave'), run: async () => { if (await askConfirm(t('groups.leaveConfirm', { name: g.name }), t('groups.leave'))) leaveGroup(g); } };
}
function renderGroupConv() {
  calls.rerender();
  const head = $('#conv-head'), body = $('#conv-body'), composer = $('#composer');
  const g = groupById(selectedGroup);
  if (!g) { selectedGroup = null; renderConversation(); return; }
  composer.style.display = '';
  // Removed from the group: the message box gives way to a note; the history stays readable.
  composer.classList.remove('text-only');
  composer.classList.toggle('read-only', !!g.removedMe);
  { let note = $('#compose-note'); if (!note) { note = el('div', { id: 'compose-note', role: 'note' }); composer.prepend(note); }
    note.hidden = !g.removedMe; note.textContent = g.removedMe ? t('groups.removedNote') : ''; }
  head.innerHTML = '';
  const avs = el('div', { className: 'grp-head-avatars' });
  if (cleanGroupPicture(g.avatar)) {
    const d = el('div', { className: 'grp-head-av' });
    d.append(el('img', { src: g.avatar, className: 'grp-avatar-custom', alt: g.name }));
    avs.append(d);
  } else {
    const others = g.members.filter(m => m.address !== myAddress).slice(0, 5);
    if (others.length === 0) {
      const d = el('div', { className: 'grp-head-av grp-avatar-default' });
      d.innerHTML = GROUP_ICON_SVG;
      avs.append(d);
    } else {
      others.forEach(m => {
        const c = contacts.find(c => c.address === m.address);
        const d = el('div', { className: 'grp-head-av' });
        d.append(renderAvatarEl(m.address, c?.avatar || peerByAddress(m.address)?.avatar || null, 28, '', m.petname));
        d.title = m.petname;
        avs.append(d);
      });
    }
  }
  const hmeta = el('div', { className: 'conv-meta' });
  hmeta.append(el('div', { className: 'conv-name', textContent: g.name }));
  if (g.description && g.description.trim()) {
    hmeta.append(el('div', { className: 'conv-grp-desc', textContent: g.description.trim() }));
  } else {
    hmeta.append(el('div', { className: 'conv-addr', textContent: g.members.map(m => m.address === myAddress ? t('react.you') : m.petname).join(', ') }));
  }
  const grpManageBtn = headBtn('conv-manage-btn', t('groups.manage'), '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>');
  grpManageBtn.onclick = () => openGroupManage(g);
  const grpMore = headBtn('head-more', t('menu.more'), MENU_ICONS.more);
  grpMore.setAttribute('aria-haspopup', 'menu');
  grpMore.onclick = () => openMenu({ anchor: grpMore }, [
    ttlItem('grp:' + g.id),
    pinItem('grp:' + g.id, () => renderGroups()),
    { sep: true },
    { label: t('conv.clearAll'), icon: MENU_ICONS.trash, danger: true, desc: t('menu.d.clear'), run: async () => { if (await askConfirm(t('conv.clearGroup', { name: g.name }))) clearThread('grp:' + g.id); } },
    groupLeaveItem(g),
  ]);
  { const nb = ttlBadgeEl('grp:' + g.id); if (nb) hmeta.firstChild.append(nb); }

  head.append(avs, hmeta, makeLockPill(), grpManageBtn, grpMore);
  renderBodyPreservingScroll(body, () => {
    body.innerHTML = '';
    const thread = gatherThread('grp:' + selectedGroup);
    if (!thread.length) body.append(el('div', { className: 'placeholder small' }, el('p', { textContent: t('groups.empty') })));
    for (const node of buildBubbleNodes(thread, 'grp:' + selectedGroup)) body.append(node);
  });
}

function withPreservedAudio(fn) {
  const playing = [];
  document.querySelectorAll('#conv-body audio[data-mid]').forEach(a => {
    if (!a.paused) playing.push({ id: a.dataset.mid, t: a.currentTime });
  });
  fn();
  if (playing.length) requestAnimationFrame(() => {
    playing.forEach(({ id, t }) => {
      const a = document.querySelector(`#conv-body audio[data-mid="${CSS.escape(String(id))}"]`);
      if (a) { a.currentTime = t; a.play().catch(() => {}); }
    });
  });
}

function renderConversation() {
  calls.rerender();                       // the call bar is full in its own chat and a slim strip elsewhere
  if (selectedGroup) { renderGroupConv(); return; }
  const head = $('#conv-head'), body = $('#conv-body'), composer = $('#composer');
  if (!selected) {
    head.innerHTML = ''; body.innerHTML = '';
    const ph = el('div', { className: 'placeholder' });
    if (!contacts.length) {
      const steps = el('div', { className: 'welcome-steps placeholder-steps' });
      steps.append(el('div', { className: 'welcome-steps-title', textContent: t('welcome.nextTitle') }));
      const ol = el('ol', { className: 'welcome-steplist' });
      for (const k of ['welcome.s1', 'welcome.s2', 'welcome.s3']) {
        ol.append(el('li', { textContent: t(k) }));
      }
      steps.append(ol);
      ph.append(steps);
    } else {
      ph.append(el('p', { className: 'placeholder-lead', textContent: t('conv.empty') }));
    }
    body.append(ph);
    composer.style.display = 'none'; return;
  }
  composer.style.display = '';
  const c = contactByAddress(selected);
  paintTextOnly(c);
  sendPendingReadReceipts(c);
  head.innerHTML = '';
  const av = renderAvatarEl(c.address, c.avatar, 36, '', c.petname);
  const avBtn = el('button', { className: 'conv-av-btn', type: 'button', title: t('conv.viewPic') });
  avBtn.append(av);
  avBtn.onclick = () => showAvatarZoom(c.address, c.avatar, c.petname);
  const hmeta = el('div', { className: 'conv-meta' });
  hmeta.append(el('div', { className: 'conv-name', textContent: c.petname }), el('div', { className: 'conv-addr', textContent: shortAddr(c.address) }));
  if (c.bio) hmeta.append(el('div', { className: 'conv-bio', textContent: c.bio, title: c.bio }));
  const isVerified = !!prefs.verified[c.address] && prefs.verified[c.address] === c.ecdhPub;   // only the keys that were verified, never newer ones
  const safeBtn = headBtn('conv-safe-btn' + (isVerified ? ' verified' : ''), t('safety.title'), '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5l-8-3z"/><path d="M9 12l2 2 4-4"/></svg>');
  safeBtn.onclick = () => {
    openSafetyDialog(c, () => {
      safeBtn.classList.add('verified');
    });
  };

  const rebuildPath = async () => {
    try {
      const res = await fetch('/api/circuit/rebuild-contact/' + encodeURIComponent(c.address), { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'failed');
      toast(data.closed
        ? (t('circuit.rebuilt'))
        : (t('circuit.noneActive')));
    } catch (e) {
      toast(errorText(e, 'circuit.rebuildFail'));
    }
  };
  const mapBtn = headBtn('conv-circuit-map', t('conv.circuitMap'), '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/></svg>');
  mapBtn.onclick = () => circuitMapHook?.(c.address, c.petname);
  const callBtn = headBtn('conv-call', t('call.start'), CALL_ICON.replace(/width="22" height="22"/, 'width="17" height="17"'));
  callBtn.onclick = () => {
    if (!richSendAllowed(c.address)) { toast(textOnlyError(c).message, 5000); return; }
    calls.start(c);
  };
  callBtn.classList.toggle('locked', !richSendAllowed(c.address));
  const more = headBtn('head-more', t('menu.more'), MENU_ICONS.more);
  more.setAttribute('aria-haspopup', 'menu');
  more.onclick = () => openMenu({ anchor: more }, [
    ttlItem(c.address),
    { label: t('menu.undelivered'), icon: MENU_ICONS.clock, value: offlineTtlLabel(offlineTtlFor(c.address)), desc: t('menu.d.undelivered'),
      page: () => OFFLINE_TTL_OPTIONS.map((secs) => ({ label: offlineTtlLabel(secs), checked: secs === offlineTtlFor(c.address), run: () => {
        setOfflineTtlFor(c.address, secs);
        toast(t('offttl.set', { time: offlineTtlLabel(secs) }));
      } })) },
    { label: t('circuit.rebuild'), icon: MENU_ICONS.path, desc: t('menu.d.rebuild'), run: rebuildPath },
    { label: t('ctest.menu'), icon: MENU_ICONS.test, desc: t('menu.d.ctest'), run: () => openContactTest(c) },
    pinItem(c.address, () => renderContacts()),
    { sep: true },
    { label: t('conv.clearAll'), icon: MENU_ICONS.trash, danger: true, desc: t('menu.d.clear'), run: async () => { if (await askConfirm(t('conv.clearDM', { name: c.petname }))) clearThread(c.address); } },
  ]);
  { const nb = ttlBadgeEl(c.address); if (nb) hmeta.firstChild.append(nb); }

  head.append(avBtn, hmeta, makeLockPill(), callBtn, safeBtn, mapBtn, more);
  withPreservedAudio(() => {
    renderBodyPreservingScroll(body, () => {
      body.innerHTML = '';
      const thread = gatherThread(selected);
      if (!thread.length) body.append(el('div', { className: 'placeholder small' }, el('p', { textContent: t('conv.emptyThread') })));
      for (const node of buildBubbleNodes(thread, selected)) body.append(node);
    });
  });
}

let _jumpUnseen = 0;
let _lastConvKey = null;
function renderBodyPreservingScroll(body, buildFn) {
  const convKey = selectedGroup ? ('grp:' + selectedGroup) : selected;
  const switched = convKey !== _lastConvKey;
  _lastConvKey = convKey;
  const wasNearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 120;
  const prevCount = body.querySelectorAll('.msg-row, .bubble, .msg').length;
  const prevTop = body.scrollTop;
  const prevHeight = body.scrollHeight;
  buildFn();
  const newCount = body.querySelectorAll('.msg-row, .bubble, .msg').length;
  if (switched || wasNearBottom) {
    body.scrollTop = body.scrollHeight;
    _jumpUnseen = 0;
  } else {
    body.scrollTop = prevTop + (body.scrollHeight - prevHeight);
    const added = newCount - prevCount;
    if (added > 0) _jumpUnseen += added;
  }
  updateJumpLatest();
}
function isConvNearBottom() {
  const body = $('#conv-body');
  if (!body) return true;
  // "near" = within 120px of the bottom, so tiny scroll offsets don't count.
  return body.scrollHeight - body.scrollTop - body.clientHeight < 120;
}
function updateJumpLatest() {
  const btn = $('#jump-latest');
  if (!btn) return;
  const show = !isConvNearBottom() && (selected || selectedGroup);
  btn.hidden = !show;
  if (!show) { _jumpUnseen = 0; }
  let badge = btn.querySelector('.jl-badge');
  if (_jumpUnseen > 0) {
    if (!badge) { badge = el('span', { className: 'jl-badge' }); btn.append(badge); }
    badge.textContent = _jumpUnseen > 99 ? '99+' : String(_jumpUnseen);
  } else if (badge) {
    badge.remove();
  }
}
function scrollConvToBottom(smooth = true) {
  const body = $('#conv-body');
  if (!body) return;
  body.scrollTo({ top: body.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  _jumpUnseen = 0;
  updateJumpLatest();
}
function wireJumpLatest() {
  const body = $('#conv-body');
  const btn  = $('#jump-latest');
  if (!body || !btn) return;
  body.addEventListener('scroll', updateJumpLatest, { passive: true });
  btn.addEventListener('click', () => scrollConvToBottom(true));
}

function wireNewGroup() {
  const dialog  = $('#new-group-dialog');
  const nameIn  = $('#grp-name');
  const mList   = $('#grp-member-list');
  const statusEl = $('#grp-status');
  const cancelBtn = $('#grp-cancel');
  const createBtn = $('#grp-create');

  // The picture is part of the form: the empty circle beside the name opens the picker. Whoever creates the group is its admin.
  let newGroupPicture = null;
  const paintNewGroupPicture = () => {
    const slot = $('#grp-pic-new'); if (!slot) return;
    slot.innerHTML = '';
    slot.append(groupPictureControl({ picture: newGroupPicture, seed: 'new-group', name: '', size: 64, editable: true,
      onPick: (dataUrl) => { newGroupPicture = dataUrl; paintNewGroupPicture(); } }));
  };
  $('#new-group-btn').onclick = () => {
    mList.innerHTML = '';
    if (contacts.length) {
      contacts.forEach(c => {
        const row = el('label', { className: 'grp-member-row' });
        const cb  = el('input', { type: 'checkbox', value: c.address });
        cb.onchange = () => {
          const checked = Array.from(mList.querySelectorAll('input:checked'));
          if (checked.length > MAX_GROUP - 1) { cb.checked = false; statusEl.textContent = t('groups.maxWarning'); }
          else statusEl.textContent = '';
          createBtn.disabled = !nameIn.value.trim();
        };
        const av = el('div', { className: 'grp-member-av' });
        av.append(renderAvatarEl(c.address, c.avatar, 32, '', c.petname));
        row.append(cb, av, el('span', { className: 'grp-member-name', textContent: c.petname }));
        mList.append(row);
      });
    }
    nameIn.value = ''; statusEl.textContent = ''; createBtn.disabled = true;
    const descIn = $('#grp-desc-new'); if (descIn) descIn.value = '';
    newGroupPicture = null; paintNewGroupPicture();
    dialog.showModal();
    nameIn.focus();
  };

  nameIn.oninput = () => {
    createBtn.disabled = !nameIn.value.trim();
  };

  cancelBtn.onclick = () => dialog.close();
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

  createBtn.onclick = async () => {
    const name = nameIn.value.trim();
    const descIn = $('#grp-desc-new');
    const description = descIn ? descIn.value.trim().slice(0, 280) : '';
    const addrs = Array.from(mList.querySelectorAll('input:checked')).map(cb => cb.value);
    if (!name) return;
    createBtn.disabled = true;
    createBtn.textContent = t('groups.creating');
    try { await createGroup(name, addrs, description, newGroupPicture); dialog.close(); }
    catch (e) { statusEl.textContent = errorText(e); createBtn.disabled = false; createBtn.textContent = t('groups.create'); }
  };
}

function wireJoinGroup() {
  const btn = document.getElementById('join-group-btn');
  if (!btn) return;
  btn.onclick = () => openJoinGroupDialog();
}

function openJoinGroupDialog() {
  let overlay = document.getElementById('join-group-overlay');
  if (!overlay) {
    overlay = el('div', { id: 'join-group-overlay', className: 'confirm-overlay' });
    document.body.append(overlay);
  }
  overlay.innerHTML = '';
  overlay.hidden = false;

  const dialog = el('div', { className: 'confirm-dialog' });
  dialog.append(el('p', { className: 'confirm-msg', textContent: t('groups.joinTitle') }));
  dialog.append(el('p', { className: 'set-desc', textContent: t('groups.joinDesc') }));

  const textarea = el('textarea', { className: 'grp-invite-code', placeholder: t('groups.joinPlaceholder'), style: 'height:80px;width:100%;margin-bottom:12px' });
  dialog.append(textarea);

  const status = el('p', { className: 'set-desc', style: 'color:var(--err);display:none' });
  dialog.append(status);

  const actions = el('div', { className: 'confirm-actions' });
  const cancel = el('button', { className: 'confirm-cancel', type: 'button', textContent: t('nav.cancel') });
  const join   = el('button', { className: 'confirm-ok', type: 'button', textContent: t('groups.joinBtn') });

  cancel.onclick = () => { overlay.hidden = true; };
  join.onclick = async () => {
    const raw = textarea.value.trim();
    if (!raw) return;
    let data;
    try {
      const padded = raw + '='.repeat((4 - raw.length % 4) % 4);
      data = JSON.parse(atob(padded));
    } catch {
      status.textContent = t('groups.joinInvalidCode');
      status.style.display = '';
      return;
    }
    if (!data || typeof data.id !== 'string' || typeof data.name !== 'string' || typeof data.k !== 'string' || !/^[0-9a-f]{32}$/.test(data.k)) {
      status.textContent = t('groups.joinInvalidCode');
      status.style.display = '';
      return;
    }
    if (groups.find(g => g.id === data.id)) {
      status.textContent = t('groups.alreadyMember');
      status.style.display = '';
      return;
    }
    const inviter = contacts.find(c => c.address === data.by);
    if (!inviter) {
      status.textContent = t('groups.joinNeedContact');
      status.style.display = '';
      return;
    }

    join.disabled = true;
    join.textContent = t('groups.joining');
    try {
      const newGroup = {
        id: data.id,
        name: data.name,
        description: data.description || '',
        adminAddr: data.by || null,
        members: [
          { address: myAddress || '', petname: 'me' },
          { address: inviter.address, petname: inviter.petname },
        ],
      };
      const joinMeta = { grp: data.id, action: 'joined', key: data.k };
      await deliver(inviter, encodeFrame('group-update', joinMeta, new Uint8Array(0)));
      await saveGroup(newGroup);
      await loadGroups();
      renderGroups();
      overlay.hidden = true;
      toast(t('groups.joined', { name: data.name }));
    } catch (e) {
      status.textContent = errorText(e);
      status.style.display = '';
      join.disabled = false;
      join.textContent = t('groups.joinBtn');
    }
  };

  actions.append(cancel, join);
  dialog.append(actions);
  overlay.append(dialog);
  overlay.onclick = e => { if (e.target === overlay) overlay.hidden = true; };
  setTimeout(() => textarea.focus(), 50);
}
// Everything is escaped first, then URLs become links, so user-supplied text can't inject HTML.
function mdEscape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
// The message's own text, without the timestamp that sits inside the text block.
function messageText(bubble) {
  const block = bubble.querySelector('.bubble-text');
  if (!block) return bubble.textContent || '';
  const walk = (n) => n.nodeType === 3 ? n.data : n.nodeType !== 1 ? '' : n.classList.contains('stamp') ? '' : n.tagName === 'IMG' ? (n.alt || '') : [...n.childNodes].map(walk).join('');
  return walk(block);
}

// Emoji (including flags and joined sequences) inside a piece of text. The two explicit ranges are where new emoji are assigned,
// so the newest ones are found even when the browser's Unicode data is older than the emoji.
const EMOJI_RE = /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|(?:\p{Emoji_Presentation}|[\u{1F6D0}-\u{1F6FF}\u{1FA70}-\u{1FAFF}]|\p{Extended_Pictographic}\uFE0F|\p{Extended_Pictographic}(?=\p{Emoji_Modifier}))\p{Emoji_Modifier}?(?:[\u{E0020}-\u{E007E}]+\u{E007F})?(?:\u200D(?:\p{Emoji_Presentation}|[\u{1F6D0}-\u{1F6FF}\u{1FA70}-\u{1FAFF}]|\p{Extended_Pictographic})\uFE0F?\p{Emoji_Modifier}?)*)/gu;
// Emoji we ship an image for are drawn with it, so they look the same everywhere and scale with the text; others stay plain text.
// At most MAX_INLINE_EMOJI per message become images; a huge message of emoji would otherwise freeze the screen.
const MAX_INLINE_EMOJI = 300;
function emojifyText(text, left) {
  return text.replace(EMOJI_RE, (m) => {
    if (left.n <= 0 || !EMOJI_IDS.has(emojiToCodepoint(m))) return m;
    left.n--;
    return `<img class="emoji-inline" src="${emojiSrc(m)}" alt="${m}" draggable="false">`;
  });
}
function emojify(html) { const left = { n: MAX_INLINE_EMOJI }; return html.replace(/(<[^>]*>)|([^<]+)/g, (m, tag, text) => tag ? tag : emojifyText(text, left)); }
// A message of only a few emoji is shown extra large: 3 = one emoji, 2 = two or three, 1 = four or five, 0 = a normal message.
function jumboTier(text) {
  const s = String(text || '').trim(); if (!s || s.length > 40) return 0;
  const rest = s.replace(EMOJI_RE, (m) => EMOJI_IDS.has(emojiToCodepoint(m)) ? '\u0001' : m);
  if (!/^(?:\u0001\s*)+$/.test(rest)) return 0;
  const n = (rest.match(/\u0001/g) || []).length;
  return n === 1 ? 3 : n <= 3 ? 2 : n <= 5 ? 1 : 0;
}

function renderMarkdownText(raw) {
  let s = mdEscape(raw);
  s = s.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<![*_\w])[*_]([^*_\n]+)[*_](?![*_\w])/g, '<em>$1</em>');
  // The text was escaped above, so a matched link holds entities (&amp;): turn them back before escaping once for the attribute and the text,
  // or a link with & would open (and show) as &amp;.
  const unEsc = (x) => x.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]));
  s = s.replace(/\b(https?:\/\/(?:(?!&(?:quot|#39|lt|gt);)[^\s<])+|[a-z2-7]{56}\.anyone)\b/gi, (m) => {
    const raw = unEsc(m);
    const href = raw.startsWith('http') ? raw : 'http://' + raw;
    return `<a href="${mdEscape(href)}" target="_blank" rel="noopener noreferrer" class="md-link">${mdEscape(raw)}</a>`;
  });
  s = s.replace(/\n/g, '<br>');
  return emojify(s);
}

function renderBubble(m, index, cont = false) {
  if (m.kind === 'system') {
    return el('div', { className: 'system-msg', textContent: m.text || '' });
  }
  const wrap = el('div', { className: `bubble-row ${m.dir}` });
  if (m.grp && m.dir === 'in' && (m.senderPetname || m.senderAddr)) {
    // A contact: your own name for them. Anyone else: the name the admin gave them, with their short address beside it, so a name
    // copied from one of your contacts can't pass for them. Beside the first of their messages in a row: their own picture (the one
    // on their profile), or their letter.
    const c = m.senderAddr ? contactByAddress(m.senderAddr) : null;
    wrap.classList.add('grp-in');
    if (cont) wrap.classList.add('grp-cont');
    else {
      const label = el('div', { className: 'bubble-sender', textContent: c ? c.petname : (m.senderPetname || '') });
      if (!c && m.senderAddr) label.append(el('span', { className: 'sender-addr', textContent: (m.senderPetname ? ' \u00b7 ' : '') + shortAddr(m.senderAddr) }));
      wrap.append(label);
      const pic = c ? c.avatar : peerByAddress(m.senderAddr)?.avatar;
      wrap.append(renderAvatarEl(m.senderAddr || m.senderPetname || '', pic, 30, 'grp-av', c ? c.petname : (m.senderPetname || '')));
    }
  }
  const bub = el('div', { className: 'bubble ' + m.dir });

  if (m.replyTo && m.replyTo.id) {
    const q = el('div', { className: 'quote', title: t('reply.jumpTo') });
    const ql = quoteFor(m.replyTo, index);
    if (!ql.found) { q.classList.add('missing'); q.removeAttribute('title'); }
    if (ql.author) q.append(el('span', { className: 'quote-author', textContent: ql.author }));
    q.append(el('span', { className: 'quote-text', textContent: ql.text }));
    q.onclick = () => {
      const orig = document.querySelector(`.bubble[data-mid="${CSS.escape(String(m.replyTo.id))}"]`);
      if (orig) { orig.scrollIntoView({ behavior: 'smooth', block: 'center' }); orig.classList.add('highlight');
        setTimeout(() => orig.classList.remove('highlight'), 1400); }
    };
    bub.append(q);
  }
  bub.dataset.mid = m.id;

  if (m.kind === 'text' || m.kind === 'error') {
    const tier = m.kind === 'text' && !m.replyTo ? jumboTier(m.text) : 0;
    if (tier) bub.classList.add('jumbo', 'jumbo-' + tier);
    bub.append(el('div', { className: 'bubble-text' + (m.kind === 'error' ? ' err' : ''), innerHTML: renderMarkdownText(m.text || '') }));
  } else if (m.mediaCleared && MEDIA_KINDS.has(m.kind)) {
    // Removed in Settings → Storage to save space; the message itself stays.
    const ico = { image: '🖼', video: '🎬', audio: '🎵', voice: '🎙', file: '📎' }[m.kind];
    bub.append(el('div', { className: 'file-chip muted media-cleared' }, el('span', { className: 'file-ico' }, emojiImg(ico, 20)),
      el('span', { className: 'file-name', textContent: t('storage.cleared') })));
  } else if (m.kind === 'image') {
    const src = m.url || m.meta?.thumb || null;
    if (src) {
      const imgWrap = el('div', { className: 'image-wrap' });
      const img = el('img', { className: 'bubble-image', src, alt: m.meta?.name || 'image', draggable: false });
      img.onclick = () => {
        if (!m.url) return;
        const overlay = $('#avatar-zoom'), inner = $('#avatar-zoom-inner');
        inner.innerHTML = ''; inner.style.cssText = 'width:min(90vw,640px);height:auto;border-radius:12px;overflow:hidden;position:relative';
        const fullImg = Object.assign(el('img'), { src: m.url, style: 'width:100%;height:auto;display:block' });
        const imgDl = dlBtn(m.id, m.meta?.name || 'image', 'image');
        imgDl.className = 'media-dl-btn zoom-dl-btn';
        inner.append(fullImg, imgDl);
        overlay.hidden = false;
        clearTimeout(_zoomTimer);
        _zoomTimer = setTimeout(() => { overlay.hidden = true; }, 12000);
        overlay.onclick = e => { if (e.target === overlay) { clearTimeout(_zoomTimer); overlay.hidden = true; } };
      };
      imgWrap.append(img);
      bub.append(imgWrap);
    } else {
      bub.append(el('div', { className: 'file-chip muted' },
        el('span', { className: 'file-ico' }, emojiImg('🖼', 22)),
        el('span', { className: 'file-name', textContent: m.meta?.name || 'image' })));
    }
  } else if (m.kind === 'audio' || m.kind === 'voice') {
    const blob = sessionBlobs.get(m.id);
    if (blob) {
      const wrap = el('div', { className: m.kind === 'voice' ? 'audio-msg voice-msg' : 'audio-msg' });
      if (m.kind === 'audio') {
        const info = el('div', { className: 'audio-info' });
        info.append(el('span', { className: 'audio-name', textContent: m.meta?.name || 'audio' }));
        info.append(el('span', { className: 'audio-size', textContent: m.meta ? formatBytes(m.meta.size) : '' }));
        wrap.append(el('span', { className: 'audio-icon' }, emojiImg('🎵', 22)), info);
      }
      const player = getOrCreateTgPlayer(m.id, blob);
      wrap.append(player.root);
      bub.append(wrap);
    } else {
      bub.append(el('div', { className: 'bubble-text muted' }, emojiImg(m.kind === 'voice' ? '🎙' : '🎵', 16), ' ' + (m.kind === 'voice' ? t('msg.notRetainedVoice') : t('msg.notRetainedAudio'))));
    }
  } else if (m.kind === 'video') {
    if (m.url) {
      const vWrap = el('div', { className: 'video-wrap' });
      const video = el('video', { controls: true, preload: 'metadata', src: m.url, className: 'bubble-video', playsinline: true });
      video.setAttribute('controlslist', 'nofullscreen nodownload noplaybackrate noremoteplayback');
      video.disablePictureInPicture = true;
      vWrap.append(video);
      bub.append(vWrap);
    } else {
      bub.append(el('div', { className: 'file-chip muted' },
        el('span', { className: 'file-ico' }, emojiImg('🎬', 22)),
        el('span', { className: 'file-name', textContent: m.meta?.name || 'video' })));
    }
  } else if (m.kind === 'file') {
    const name = m.meta?.name || 'file';
    if (m.url) {
      const chip = el('div', { className: 'file-chip' });
      chip.append(
        el('span', { className: 'file-ico' }, emojiImg('📎', 22)),
        el('span', { className: 'file-name', textContent: name }),
        el('span', { className: 'file-size', textContent: m.meta ? formatBytes(m.meta.size) : '' })
      );
      bub.append(chip);
    } else bub.append(el('div', { className: 'file-chip muted' }, el('span', { className: 'file-ico' }, emojiImg('📎', 22)), el('span', { className: 'file-name', textContent: name }), el('span', { className: 'file-size', textContent: t('file.sentTag') })));
  }
  const stamp = el('div', { className: 'stamp', textContent: formatTime(m.ts) });
  if (unsavedIds.has(m.id)) stamp.prepend(el('span', { className: 'not-saved', title: t('storage.notSavedTip'), textContent: t('storage.notSaved') + ' \u00b7 ' }));
  if (m.dir === 'in' && m.kind !== 'error')
    stamp.append(el('span', { className: 'verify ' + (m.verified ? 'ok' : 'warn'), textContent: m.verified ? ' \u2713 ' + t('msg.verifiedTag') : ' \u26a0 ' + t('msg.unverifiedTag') }));
  if (m.dir === 'out' && m.kind !== 'error') {
    if (m.pending) {
      stamp.append(el('span', { className: 'receipt-tick pending', title: t('msg.pending'), textContent: ' \u23f3' }));
    } else if (m.failed) {
      stamp.append(el('span', { className: 'receipt-tick failed', title: t('msg.pendingExpired'), textContent: ' \u26a0 ' + t('msg.undelivered') }));
    } else {
      // Before the first reply we may only be a message request on their side, so "delivered" would promise more than we know.
      const sess = !selectedGroup && selected ? loadSession(selected) : null;
      const awaiting = !m.read && sess && sess.role === 'initiator' && !sess.confirmed;
      stamp.append(el('span', { className: 'receipt-tick' + (m.read ? ' read' : ''), title: m.read ? t('msg.read') : (awaiting ? t('msg.sentAwaiting') : t('msg.delivered')), textContent: m.read ? ' \u2713\u2713' : ' \u2713' }));
    }
  }
  // Text: the time floats into the text block, so it sits beside the last line when it fits and drops below it when it doesn't.
  // Every other kind (media, voice, files) keeps it underneath.
  (bub.querySelector(':scope > .bubble-text:not(.muted)') || bub).append(stamp);

  // Only well-formed reactions are drawn: one that isn't (stored before it was checked on arrival) must not stop the chat from drawing.
  const reactions = m.reactions && typeof m.reactions === 'object'
    ? Object.entries(m.reactions).filter(([, r]) => r && typeof r.emoji === 'string' && r.emoji.length > 0 && r.emoji.length <= MAX_EMOJI_LEN) : [];
  if (reactions.length) {
    const row = el('div', { className: 'react-row' });
    const counts = new Map();
    const myAddr = (typeof myAddress !== 'undefined') ? myAddress : null;
    for (const [addr, r] of reactions) {
      const cur = counts.get(r.emoji) || { count: 0, byMe: false };
      cur.count++; if (addr === myAddr || addr === 'self') cur.byMe = true;
      counts.set(r.emoji, cur);
    }
    const grp = m.grp ? groupById(m.grp) : null;
    // Who reacted: your own name/picture, a contact's, a group member's, or just the short address.
    const whoIs = (addr, r) => {
      const isMe = addr === myAddr || addr === 'self';
      if (isMe) return { name: t('react.you'), avatar: myAvatar || null, addr: myAddr || 'self' };
      const c = contactByAddress(addr), gm = grp && grp.members.find((x) => x.address === addr);
      return { name: c?.petname || gm?.petname || r.name || shortAddr(addr), avatar: c?.avatar || peerByAddress(addr)?.avatar || null, addr };
    };
    for (const [emoji, info] of counts.entries()) {
      const who = reactions.filter(([, r]) => r.emoji === emoji).map(([addr, r]) => whoIs(addr, r));
      const chip = el('button', { className: 'react-chip' + (info.byMe ? ' mine' : ''), type: 'button', 'aria-label': emoji + ' ' + who.map((w) => w.name).join(', ') });
      chip.append(emojiImg(emoji, 20));
      if (grp && info.count <= 2) {                         // a few people: their pictures; more than two: just the total
        const stack = el('span', { className: 'react-avs' });
        for (const w of who) { const av = el('span', { className: 'react-av' }); av.append(renderAvatarEl(w.addr, w.avatar, 18, '', w.name)); stack.append(av); }
        chip.append(stack);
      } else if (info.count > 1) chip.append(el('span', { className: 'react-count', textContent: String(info.count) }));
      const tipText = who.map((w) => w.name).join(', ');
      chip.addEventListener('mouseenter', () => showTip(chip, tipText));
      chip.addEventListener('mouseleave', hideTip);
      chip.onclick = (e) => { e.stopPropagation(); hideTip(); toggleReaction(m, emoji); };
      row.append(chip);
    }
    bub.append(row);
  }

  if (m.expiresAt && m.expiresAt > Date.now()) {
    const ttlBadge = el('span', { className: 'ttl-badge', title: t('ttl.tooltip') });
    const update = () => {
      const left = Math.max(0, m.expiresAt - Date.now());
      const secs = Math.ceil(left / 1000);
      if (secs <= 0) { ttlBadge.remove(); return; }
      if (secs < 60)    ttlBadge.textContent = '⏱ ' + t('ttl.short.s', { n: secs });
      else if (secs < 3600) ttlBadge.textContent = '⏱ ' + t('ttl.short.m', { n: Math.ceil(secs / 60) });
      else if (secs < 86400) ttlBadge.textContent = '⏱ ' + t('ttl.short.h', { n: Math.ceil(secs / 3600) });
      else                  ttlBadge.textContent = '⏱ ' + t('ttl.short.d', { n: Math.ceil(secs / 86400) });
    };
    update();
    const tick = setInterval(() => { if (!ttlBadge.isConnected) { clearInterval(tick); return; } update(); }, 1000);
    stamp.append(ttlBadge);
  }

  if (m.kind !== 'system' && m.kind !== 'error') {
    const actions = el('div', { className: 'bubble-actions' });

    if (m.dir !== 'out') {
      const reply = el('button', { className: 'msg-action reply', type: 'button', 'aria-label': t('msg.reply'),
        innerHTML: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>' });
      reply.addEventListener('mouseenter', () => showTip(reply, t('msg.reply'))); reply.addEventListener('mouseleave', hideTip);
      reply.onclick = (e) => { e.stopPropagation(); setReply(m); $('#msg-input')?.focus(); };
      actions.append(reply);

      const react = el('button', { className: 'msg-action react', type: 'button', 'aria-label': t('msg.react'),
        innerHTML: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8 15s1.5 2 4 2 4-2 4-2"/><circle cx="9" cy="10" r=".8" fill="currentColor"/><circle cx="15" cy="10" r=".8" fill="currentColor"/></svg>' });
      react.addEventListener('mouseenter', () => showTip(react, t('msg.react'))); react.addEventListener('mouseleave', hideTip);
      react.onclick = (e) => { e.stopPropagation(); openReactionPicker(react, m); };
      actions.append(react);
    }

    // Media can be saved from the same toolbar (no separate button on the picture, player or file).
    const canSave = (m.kind === 'audio' || m.kind === 'voice') ? !!sessionBlobs.get(m.id) : (m.kind === 'image' || m.kind === 'video' || m.kind === 'file') ? !!m.url : false;
    if (canSave) {
      const saveName = m.kind === 'voice' ? 'voice-message.webm' : (m.meta?.name || m.kind);
      const save = el('button', { className: 'msg-action msg-save', type: 'button', 'aria-label': t('dl.save'), innerHTML: DL_ICON });
      save.onclick = (e) => { e.stopPropagation(); downloadMedia(m.id, saveName, m.kind); };
      save.addEventListener('mouseenter', () => showTip(save, t('dl.save'))); save.addEventListener('mouseleave', hideTip);
      actions.append(save);
    }
    const del = el('button', { className: 'msg-action msg-del', type: 'button', 'aria-label': t('msg.delete'),
      innerHTML: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6l-12 12"/></svg>' });
    del.addEventListener('mouseenter', () => showTip(del, t('msg.delete'))); del.addEventListener('mouseleave', hideTip);
    del.onclick = (e) => {
      e.stopPropagation();
      const addr = m.grp ? ('grp:' + m.grp) : (m.dir === 'in' ? m.senderAddr || selected : selected);
      if (addr) deleteMessage(addr, m.id);
    };
    actions.append(del);

    bub.append(actions);
  }
  wrap.append(bub); return wrap;
}

async function toggleReaction(m, emoji) {
  if (m.grp && groupById(m.grp)?.removedMe) return;       // removed from the group: nothing more is sent to it
  const myAddr = typeof myAddress !== 'undefined' ? myAddress : 'self';
  const threadKey = m.grp ? ('grp:' + m.grp) : (m.dir === 'in' ? m.senderAddr || selected : selected);
  applyReaction(threadKey, m.id, emoji, myAddr || 'self', 'You');
  if (selectedGroup) renderGroupConv(); else renderConversation();

  try {
    const meta = { reactTo: m.id, emoji, grp: m.grp || undefined };
    if (m.grp) {
      const g = groupById(m.grp); if (!g) return;
      await deliverToGroup(g, encodeFrame('reaction', meta, new Uint8Array(0)));
    } else {
      const c = contactByAddress(threadKey); if (!c) return;
      await deliver(c, encodeFrame('reaction', meta, new Uint8Array(0)));
    }
  } catch (e) { toast(errorText(e, 'msg.reactionFailed')); }
}
const REACTION_PRESETS = REACTION_PRESETS_DATA;
function openReactionPicker(anchor, m) {
  let pop = document.getElementById('react-pop');
  if (pop) pop.remove();
  pop = el('div', { id: 'react-pop' });
  for (const e of REACTION_PRESETS) {
    const b = el('button', { type: 'button', className: 'react-pick' });
    b.append(emojiImg(e, 32));
    b.onclick = () => { toggleReaction(m, e); pop.remove(); };
    pop.append(b);
  }
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top  = (r.top - pop.offsetHeight - 8 + window.scrollY) + 'px';
  pop.style.left = Math.max(8, r.left + r.width/2 - pop.offsetWidth/2) + 'px';
  setTimeout(() => {
    document.addEventListener('click', function onClose(e) {
      if (!pop.contains(e.target) && e.target !== anchor) { pop.remove(); document.removeEventListener('click', onClose); }
    });
  }, 50);
}

let mediaRecorder = null, chunks = [];
const REC_MAX_MS = 60000;                                    // a voice message lasts at most one minute
const fmtRec = (ms) => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
// Recording: the composer becomes a bar with a timer and a live level meter. Stop sends; the bin (or Escape) throws the recording away.
async function toggleVoice(btn) {
  if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); return; }
  if (directTextOnly()) { toast(textOnlyError(contactByAddress(selected)).message, 5000); return; }
  try {
    if (!navigator.mediaDevices?.getUserMedia) { toast(t('mic.unavailable')); return; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream); mediaRecorder = rec; chunks = [];
    const pill = btn.closest('.composer-pill'), timeEl = $('#rec-time');
    let cancelled = false, tick = 0;
    const t0 = Date.now();
    const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
    const cancel = () => { cancelled = true; if (rec.state === 'recording') rec.stop(); };
    $('#rec-cancel').onclick = cancel;
    rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      clearInterval(tick); document.removeEventListener('keydown', onEsc, true);
      stream.getTracks().forEach(t => t.stop());
      pill?.classList.remove('recording'); btn.classList.remove('recording');
      if (cancelled || !chunks.length) return;               // discarded: nothing is kept or sent
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      chunks = [];
      try { await sendBlob(blob, 'voice', 'voice-message'); } catch (e) { toast(errorText(e, 'err.send')); }
    };
    rec.start(); timeEl.textContent = '0:00 / ' + fmtRec(REC_MAX_MS); timeEl.classList.remove('near-max');
    tick = setInterval(() => {
      const el_ = Date.now() - t0;
      timeEl.textContent = fmtRec(Math.min(el_, REC_MAX_MS)) + ' / ' + fmtRec(REC_MAX_MS);
      timeEl.classList.toggle('near-max', el_ >= REC_MAX_MS - 10000);   // last 10 seconds: the timer warns
      if (el_ >= REC_MAX_MS && rec.state === 'recording') rec.stop();   // limit reached: stops and sends what was recorded
    }, 250);
    document.addEventListener('keydown', onEsc, true);
    pill?.classList.add('recording'); btn.classList.add('recording');
  } catch (e) {
    const msg = e?.name === 'NotAllowedError'  ? t('mic.denied')
              : e?.name === 'NotFoundError'     ? t('mic.notFound')
              : e?.name === 'NotSupportedError' ? t('mic.unsupported')
              : t('mic.error');
    toast(msg);
  }
}

const RECENT_EMOJI_KEY = 'anyonechat.recentEmoji';
const RECENT_EMOJI_MAX = 27;

function loadRecentEmoji() {
  try { return JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY) || '[]').filter((e) => EMOJI_IDS.has(emojiToCodepoint(e))); }
  catch { return []; }
}
function pushRecentEmoji(e) {
  let r = loadRecentEmoji().filter(x => x !== e);
  r.unshift(e);
  r = r.slice(0, RECENT_EMOJI_MAX);
  localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(r));
}

function insertEmoji(e) {
  const i = $('#msg-input');
  i.value += e;
  i.focus();
  pushRecentEmoji(e);
  refreshRecentRow();
}

const CLOCK_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
// A click inserts the emoji. For emoji that come in skin tones, a right-click or a long press opens the choices.
function wireEmojiButton(b, e) {
  if (!EMOJI_TONES[e]) { b.onclick = () => insertEmoji(e); return; }
  let timer = null, held = false;
  b.addEventListener('pointerdown', (ev) => { if (ev.button !== 0) return; held = false; timer = setTimeout(() => { held = true; openToneMenu(b, e); }, 450); });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(type, () => clearTimeout(timer));
  b.addEventListener('contextmenu', (ev) => { ev.preventDefault(); openToneMenu(b, e); });
  b.onclick = (ev) => { if (held) { held = false; ev.stopPropagation(); return; } insertEmoji(e); };
}
function closeToneMenu() { document.getElementById('tone-menu')?.remove(); }
function openToneMenu(anchor, base) {
  closeToneMenu();
  const pop = $('#emoji-pop'), menu = el('div', { id: 'tone-menu' });
  for (const v of [base, ...EMOJI_TONES[base]]) {
    const b = el('button', { className: 'emoji', type: 'button', 'aria-label': v });
    b.append(emojiImg(v, 28));
    b.onclick = (ev) => { ev.stopPropagation(); closeToneMenu(); insertEmoji(v); };
    menu.append(b);
  }
  pop.append(menu);
  const a = anchor.getBoundingClientRect(), p = pop.getBoundingClientRect();
  menu.style.left = Math.max(6, Math.min(a.left - p.left + a.width / 2 - menu.offsetWidth / 2, p.width - menu.offsetWidth - 6)) + 'px';
  const above = a.top - p.top - menu.offsetHeight - 6;
  menu.style.top = (above > 40 ? above : a.bottom - p.top + 6) + 'px';
}
document.addEventListener('click', (ev) => { if (!ev.target.closest?.('#tone-menu')) closeToneMenu(); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeToneMenu(); });

let _emojiBuilt = false;
function buildEmoji() {
  const pop = $('#emoji-pop');
  pop.innerHTML = '';
  pop.classList.add('emoji-pop-v2');

  const nav = el('div', { className: 'emoji-nav' });
  const scroll = el('div', { className: 'emoji-scroll' });

  const sections = {};
  const navBtns  = {};

  let pinnedTab = null;
  const secTop = (sec) => sec.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
  const setActiveTab = (id) => { for (const [k, b] of Object.entries(navBtns)) b.classList.toggle('active', k === id); };
  const firstVisibleTab = () => Object.keys(sections).find((id) => sections[id].style.display !== 'none') || EMOJI_CATEGORIES[0].id;
  function makeNavBtn(id, iconEmoji, label) {
    const b = el('button', { type: 'button', className: 'emoji-nav-btn', 'aria-label': label });
    b.addEventListener('mouseenter', () => showTip(b, label)); b.addEventListener('mouseleave', hideTip); b.addEventListener('click', hideTip);
    if (iconEmoji) b.append(emojiImg(iconEmoji, 20)); else b.innerHTML = CLOCK_SVG;
    b.onclick = () => {
      const sec = sections[id];
      if (!sec) return;
      pinnedTab = id;                                   // the tab you clicked stays highlighted, even when the list cannot scroll that far
      scroll.scrollTop = secTop(sec);
      setActiveTab(id);
    };
    b.dataset.cat = id;
    navBtns[id] = b;
    nav.append(b);
  }

  makeNavBtn('recent', null, t('emoji.recent'));
  const recentSec = el('div', { className: 'emoji-section' });
  recentSec.dataset.cat = 'recent';
  recentSec.append(el('div', { className: 'emoji-section-title', textContent: t('emoji.recent') }));
  const recentGrid = el('div', { className: 'emoji-grid' });
  recentSec.append(recentGrid);
  sections['recent'] = recentSec;
  scroll.append(recentSec);

  for (const cat of EMOJI_CATEGORIES) {
    makeNavBtn(cat.id, cat.icon, t(cat.labelKey) || cat.label);
    const sec = el('div', { className: 'emoji-section' });
    sec.dataset.cat = cat.id;
    sec.append(el('div', { className: 'emoji-section-title', textContent: t(cat.labelKey) || cat.label }));
    const grid = el('div', { className: 'emoji-grid' });
    for (const e of cat.emojis) {
      const b = el('button', { className: 'emoji', type: 'button', 'aria-label': e });
      if (EMOJI_TONES[e]) { b.addEventListener('mouseenter', () => showTip(b, t('emoji.tonesHint'))); b.addEventListener('mouseleave', hideTip); }   // only emoji with skin-tone choices get a hint
      b.append(emojiImg(e, 28, true));
      wireEmojiButton(b, e);
      grid.append(b);
    }
    sec.append(grid);
    sections[cat.id] = sec;
    scroll.append(sec);
  }

  // Search by English name or keyword (public/emoji-names.js, from Unicode CLDR; loaded on the first keystroke). Results take the
  // place of the categories in the same scroll area and reuse the same buttons, so skin tones and Recent work as usual.
  const search = el('label', { className: 'emoji-search', innerHTML: SEARCH_SVG });
  const input = el('input', { type: 'text', autocomplete: 'off', spellcheck: false, placeholder: t('emoji.search'), 'aria-label': t('emoji.search') });
  const clear = el('button', { type: 'button', className: 'emoji-search-x', hidden: true, 'aria-label': t('nav.close'), textContent: '\u2715' });
  search.append(input, clear);
  const results = el('div', { className: 'emoji-section emoji-results', hidden: true });
  const order = [];
  for (const cat of EMOJI_CATEGORIES) for (const e of cat.emojis) order.push(e);
  let names = null, loading = null;
  const loadNames = () => loading || (loading = import('./emoji-names.js').then((m) => { names = m.EMOJI_NAMES; }).catch(() => { loading = null; }));
  const showCategories = () => {
    results.hidden = true; results.innerHTML = '';
    for (const sec of Object.values(sections)) sec.hidden = false;
    nav.classList.remove('searching');
    refreshRecentRow();
    setActiveTab(firstVisibleTab());
  };
  const runSearch = async () => {
    const q = input.value.trim().toLowerCase();
    clear.hidden = !q;
    if (!q) { showCategories(); return; }
    if (!names) await loadNames();
    if (input.value.trim().toLowerCase() !== q) return;         // typed on while the names loaded
    const terms = q.split(/\s+/);
    const hits = [];
    for (const e of order) {
      const entry = names && names[e];
      if (!entry) continue;
      const bar = entry.indexOf('|');
      const name = entry.slice(0, bar), words = entry.slice(bar + 1).split(' ');
      if (!terms.every((tm) => words.some((w) => w.startsWith(tm)))) continue;
      // Exactly the name first, then names starting with what was typed (shorter ones first: "cat" before "cat with tears of joy"),
      // then the word in the name ("black cat"), then a whole search word, then the rest; ties keep the picker's order.
      const nameWords = name.toLowerCase().split(/[\s:,]+/);
      const rank = name === q ? 0 : name.startsWith(q) ? 1 : terms.every((tm) => nameWords.includes(tm)) ? 2
        : terms.every((tm) => words.includes(tm)) ? 3 : 4;
      hits.push({ e, rank, name, len: rank === 1 ? name.length : 0 });
    }
    hits.sort((a, b) => (a.rank - b.rank) || (a.len - b.len));
    for (const sec of Object.values(sections)) sec.hidden = true;
    nav.classList.add('searching');
    for (const b of Object.values(navBtns)) b.classList.remove('active');
    results.innerHTML = '';
    if (!hits.length) {
      results.append(el('div', { className: 'emoji-empty', textContent: t('emoji.noResults', { q: input.value.trim() }) }));
    } else {
      results.append(el('div', { className: 'emoji-section-title', textContent: t('emoji.results') }));
      const grid = el('div', { className: 'emoji-grid' });
      for (const { e, name } of hits.slice(0, 200)) {
        const b = el('button', { className: 'emoji', type: 'button', 'aria-label': name, title: name });
        b.append(emojiImg(e, 28, true));
        wireEmojiButton(b, e);
        grid.append(b);
      }
      results.append(grid);
    }
    results.hidden = false;
    scroll.scrollTop = 0;
  };
  input.addEventListener('input', runSearch);
  input.addEventListener('focus', () => { loadNames(); });
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    if (input.value) { input.value = ''; runSearch(); return; }
    pop.classList.remove('open');
    $('#msg-input')?.focus();
  });
  clear.onclick = (ev) => { ev.preventDefault(); input.value = ''; runSearch(); input.focus(); };
  // A category tab clicked during a search goes back to the categories at that tab.
  nav.addEventListener('click', () => { if (input.value) { input.value = ''; clear.hidden = true; showCategories(); } }, true);
  scroll.prepend(results);

  pop.append(search, nav, scroll);
  _emojiBuilt = true;
  refreshRecentRow();

  scroll.addEventListener('scroll', () => {
    closeToneMenu();
    if (pinnedTab || nav.classList.contains('searching')) return;
    let activeId = null;
    for (const [id, sec] of Object.entries(sections)) {
      if (sec.style.display === 'none') continue;
      if (secTop(sec) - scroll.scrollTop <= 12) activeId = id;
    }
    if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2) {      // at the very bottom the last sections cannot reach the top
      const vis = Object.keys(sections).filter((id) => sections[id].style.display !== 'none');
      if (secTop(sections[vis[vis.length - 1]]) < scroll.scrollTop + scroll.clientHeight - 24) activeId = vis[vis.length - 1];
    }
    setActiveTab(activeId || firstVisibleTab());
  });
  // Scrolling by hand (wheel, touch, drag, keys) hands control back to the scroll position.
  for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown']) scroll.addEventListener(ev, () => { pinnedTab = null; }, { passive: true });
  setActiveTab(firstVisibleTab());
}

function refreshRecentRow() {
  if (!_emojiBuilt) return;
  const recentSec = document.querySelector('.emoji-section[data-cat="recent"]');
  if (!recentSec) return;
  const grid = recentSec.querySelector('.emoji-grid');
  grid.innerHTML = '';
  const recents = loadRecentEmoji();
  const recentTab = document.querySelector('.emoji-nav-btn[data-cat="recent"]');
  if (recentTab) recentTab.style.display = recents.length ? '' : 'none';
  if (!recents.length) {
    recentSec.style.display = 'none';
    return;
  }
  recentSec.style.display = '';
  for (const e of recents) {
    const b = el('button', { className: 'emoji', type: 'button', 'aria-label': e });
    if (EMOJI_TONES[e]) { b.addEventListener('mouseenter', () => showTip(b, t('emoji.tonesHint'))); b.addEventListener('mouseleave', hideTip); }
    b.append(emojiImg(e, 28));
    wireEmojiButton(b, e);
    grid.append(b);
  }
}

function getClockFormat() { return localStorage.getItem('anyonechat.clockFormat') || '12'; }
function formatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: getClockFormat() !== '24' }); }
function formatBytes(n) { if (n == null) return ''; if (n < 1024) return n + ' B'; if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB'; if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB'; return (n / 1024 ** 3).toFixed(1) + ' GB'; }

const DL_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

// A picture, recording or video is saved with the file ending of what it really is: the name is the sender's to choose, and a picture
// named "holiday.jpg.exe" must not land in Downloads as a program. Anything that isn't one of the media types the app plays gets .bin.
const MEDIA_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/webm': '.webm',
  'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/wav': '.wav', 'audio/x-wav': '.wav' };
function mediaSaveName(name, kind, type) {
  if (!['image', 'video', 'audio', 'voice'].includes(kind)) return name;
  const ext = MEDIA_EXT[String(type || '').split(';')[0].trim().toLowerCase()] || '.bin';
  const stem = String(name || kind).replace(/\.[^.]{1,10}$/, '') || kind;
  return stem + ext;
}
async function downloadMedia(msgId, filename, kind = 'file') {
  const blob = sessionBlobs.get(msgId);
  if (!blob) { toast(t('dl.notAvailable')); return; }
  filename = mediaSaveName(filename, kind, blob.type);
  try {
    if (window.electron?.saveFile) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const saved = await window.electron.saveFile(filename || 'download', bytes);
      toast(t('dl.saved', { path: saved }));
    } else {
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(blob), download: filename || 'file',
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 500);
    }
  } catch (e) { console.warn('[download]', e?.message || e); toast(t('dl.failed')); }
}
function dlBtn(msgId, filename, kind = 'file') {
  const b = el('button', { className: 'media-dl-btn', type: 'button', title: t('dl.save'), innerHTML: DL_ICON });
  b.onclick = e => { e.stopPropagation(); downloadMedia(msgId, filename, kind); };
  return b;
}
function toast(msg, ms = 3200) { const node = $('#toast'); node.textContent = msg; node.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => node.classList.remove('show'), ms); }

// "Test connection" for one contact (conversation menu): asks the backend where the way to them breaks (POST /api/contact-test, which
// returns codes only) and shows each step with a plain sentence about what to do. The wording is all here, in the person's language.
function openContactTest(c) {
  $('#ctest-overlay')?.remove();
  const overlay = el('div', { id: 'ctest-overlay', className: 'confirm-overlay' });
  const dialog = el('div', { className: 'confirm-dialog ctest-dialog', role: 'dialog' });
  dialog.setAttribute('aria-modal', 'true');
  const title = el('h3', { id: 'ctest-title', className: 'ctest-title', textContent: t('ctest.title', { name: c.petname }) });
  dialog.setAttribute('aria-labelledby', 'ctest-title');
  const rows = el('div', { className: 'ctest-rows' });
  rows.setAttribute('aria-live', 'polite');
  const verdict = el('p', { className: 'ctest-verdict' });
  const again = el('button', { type: 'button', className: 'confirm-cancel', textContent: t('ctest.again') });
  const close = el('button', { type: 'button', className: 'confirm-cancel ctest-close', textContent: t('nav.close') });
  dialog.append(title, rows, verdict, el('div', { className: 'confirm-actions' }, again, close));
  overlay.append(dialog);
  document.body.append(overlay);

  let gone = false, token = 0;
  const shut = () => { gone = true; document.removeEventListener('keydown', onKey, true); overlay.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); shut(); } };
  document.addEventListener('keydown', onKey, true);
  close.onclick = shut;
  overlay.onclick = (e) => { if (e.target === overlay) shut(); };

  const GLYPH = { ok: '\u2713', fail: '\u2717', wait: '\u2026', warn: '!', skip: '\u2013', info: '\u00b7' };
  const row = (state, label, value) => {
    const g = el('span', { className: 'ctest-glyph', textContent: GLYPH[state] || GLYPH.info });
    g.setAttribute('aria-hidden', 'true');
    rows.append(el('div', { className: 'ctest-row ' + state }, g, el('span', { className: 'ctest-label', textContent: label }), el('span', { className: 'ctest-value', textContent: value })));
  };
  const show = (r) => {
    rows.textContent = '';
    row(r.own.state, t('ctest.own'), r.own.state === 'ok' ? t('ctest.own.ok', { n: r.own.introPoints ?? '?' }) : r.own.state === 'warn' ? t('ctest.own.hidden') : r.own.state === 'wait' ? t('ctest.own.wait') : t('ctest.own.fail'));
    row(r.find.state === 'unknown' ? 'warn' : r.find.state, t('ctest.find'), t('ctest.find.' + r.find.state));
    if (r.reach.state === 'refused') row('warn', t('ctest.reach'), t('ctest.reach.refused', { n: r.reach.status }));
    else if (r.reach.state === 'fail' && r.find.state === 'fail') row('skip', t('ctest.reach'), t('ctest.reach.skip'));
    else row(r.reach.state, t('ctest.reach'), t('ctest.reach.' + r.reach.state));
    row(r.clock.state === 'unknown' ? 'skip' : r.clock.state, t('ctest.clock'), r.clock.state === 'warn' ? t('ctest.clock.warn', { m: Math.max(1, Math.round(Math.abs(r.clock.skewSec) / 60)) }) : t('ctest.clock.' + r.clock.state));
    row('info', t('ctest.queue'), String(r.queue.count));
    // All is well: the sentence about waiting messages only when some are waiting (they were just sent on).
    verdict.textContent = t('ctest.v.' + (r.verdict === 'ok' && r.queue.count > 0 ? 'ok-waiting' : r.verdict));
    verdict.className = 'ctest-verdict ' + (r.verdict === 'ok' ? 'ok' : 'warn');
  };
  const run = async () => {
    const mine = ++token;
    again.disabled = true;
    rows.textContent = '';
    verdict.className = 'ctest-verdict';
    verdict.textContent = t('ctest.running');
    try {
      const res = await fetch('/api/contact-test/' + encodeURIComponent(c.address), { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.verdict) throw new Error(data.error || 'failed');
      if (!gone && mine === token) show(data);
    } catch {
      if (!gone && mine === token) { rows.textContent = ''; verdict.className = 'ctest-verdict warn'; verdict.textContent = t('ctest.fail'); }
    } finally { if (!gone && mine === token) { again.disabled = false; } }
  };
  again.onclick = run;
  setTimeout(() => close.focus(), 50);
  run();
}

function askConfirm(message, okLabel) {
  return new Promise(resolve => {
    let overlay = $('#confirm-overlay');
    if (!overlay) {
      overlay = el('div', { id: 'confirm-overlay', className: 'confirm-overlay' });
      overlay.innerHTML = `
        <div class="confirm-dialog" role="dialog" aria-modal="true">
          <p class="confirm-msg"></p>
          <div class="confirm-actions">
            <button type="button" class="confirm-cancel"></button>
            <button type="button" class="confirm-ok danger"></button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
    }
    overlay.querySelector('.confirm-msg').textContent = message;
    overlay.querySelector('.confirm-ok').textContent = okLabel || t('nav.delete');
    overlay.querySelector('.confirm-cancel').textContent = t('nav.cancel');
    overlay.hidden = false;
    const cleanup = (val) => {
      overlay.hidden = true;
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup(false);
      if (e.key === 'Enter')  cleanup(true);
    };
    overlay.querySelector('.confirm-ok').onclick     = () => cleanup(true);
    overlay.querySelector('.confirm-cancel').onclick = () => cleanup(false);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    document.addEventListener('keydown', onKey);
    setTimeout(() => overlay.querySelector('.confirm-cancel').focus(), 50);
  });
}

function wireComposer() {
  const input    = $('#msg-input');
  const voiceBtn = $('#voice-btn');

  const doSend = async () => {
    const v = input.value; if (!v.trim()) return;
    input.value = '';
    try { await sendText(v); } catch (e) { toast(errorText(e, 'err.send')); }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });

  input.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items || [];
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          try { await sendBlob(blob, 'image', 'pasted-image.png'); }
          catch (err) { toast(errorText(err, 'err.send')); }
        }
        return;
      }
    }
  });

  $('#emoji-btn').onclick = () => {
    hideTip();
    const pop = $('#emoji-pop');
    pop.classList.toggle('open');
    if (pop.classList.contains('open')) setTimeout(() => pop.querySelector('.emoji-search input')?.focus(), 0);
  };
  document.addEventListener('click', e => { if (!e.target.closest('#emoji-btn') && !e.target.closest('#emoji-pop')) { $('#emoji-pop').classList.remove('open'); } });

  $('#file-btn').onclick = () => {
    if (directTextOnly()) { toast(textOnlyError(contactByAddress(selected)).message, 5000); return; }
    $('#file-input').click();
  };
  $('#file-input').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const kind = f.type.startsWith('image/') ? 'image'
               : f.type.startsWith('audio/') ? 'audio'
               : f.type.startsWith('video/') ? 'video'
               : 'file';
    try { await sendBlob(f, kind, f.name); }
    catch (err) { toast(errorText(err, 'err.send')); }
  };
  voiceBtn.onclick = e => toggleVoice(e.currentTarget);
  // In-page bubbles instead of native titles (an OS tooltip is a separate window on Linux). While recording the button sends the message.
  const tipOn = (b, text) => { b.addEventListener('mouseenter', () => showTip(b, text())); b.addEventListener('mouseleave', hideTip); b.addEventListener('click', hideTip); };
  const lockedTip = () => (directTextOnly() ? t('compose.textOnly', { name: contactByAddress(selected)?.petname || '' }) : null);
  tipOn(voiceBtn, () => lockedTip() || (voiceBtn.classList.contains('recording') ? t('rec.send') : t('compose.voice')));
  tipOn($('#file-btn'), () => lockedTip() || t('compose.attach'));
  tipOn($('#rec-cancel'), () => t('rec.cancel'));
  const syncVoiceLabel = () => voiceBtn.setAttribute('aria-label', voiceBtn.classList.contains('recording') ? t('rec.send') : t('compose.voice'));
  new MutationObserver(syncVoiceLabel).observe(voiceBtn, { attributes: true, attributeFilter: ['class'] });

  const convBody = $('#conv-body');
  const convPane = $('#conv');
  if (convBody) {
    let dragDepth = 0;
    const setActive = (v) => (convPane || convBody).classList.toggle('dragging', v);
    convBody.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; setActive(true); });
    convBody.addEventListener('dragover',  (e) => { e.preventDefault(); });
    convBody.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; setActive(false); } });
    convBody.addEventListener('drop', async (e) => {
      e.preventDefault(); dragDepth = 0; setActive(false);
      const f = e.dataTransfer?.files?.[0]; if (!f) return;
      const kind = f.type.startsWith('image/') ? 'image'
                 : f.type.startsWith('audio/') ? 'audio'
                 : f.type.startsWith('video/') ? 'video'
                 : 'file';
      try { await sendBlob(f, kind, f.name); }
      catch (err) { toast(errorText(err, 'err.send')); }
    });
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      if (selected || selectedGroup) { e.preventDefault(); openSearchOverlay(); }
    } else if (e.key === 'Escape') {
      closeSearchOverlay();
    }
  });
}

function openSearchOverlay() {
  let overlay = document.getElementById('search-overlay');
  if (!overlay) {
    overlay = el('div', { id: 'search-overlay' });
    overlay.innerHTML = `
      <div class="search-bar">
        <input type="text" id="search-input" placeholder="${t('search.placeholder')}" />
        <span id="search-info"></span>
        <button id="search-close" type="button">✕</button>
      </div>`;
    document.body.append(overlay);
  }
  overlay.hidden = false;
  const inp = $('#search-input');
  inp.value = ''; inp.focus();
  inp.oninput = () => {
    const q = inp.value.trim().toLowerCase();
    document.querySelectorAll('.bubble').forEach(b => b.classList.remove('search-match'));
    const info = $('#search-info');
    if (!q) { info.textContent = ''; return; }
    let matches = 0;
    document.querySelectorAll('.bubble').forEach(b => {
      const txt = messageText(b).toLowerCase();
      if (txt.includes(q)) { b.classList.add('search-match'); matches++; }
    });
    info.textContent = matches + ' match' + (matches === 1 ? '' : 'es');
    const first = document.querySelector('.bubble.search-match');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  inp.onkeydown = (e) => { if (e.key === 'Escape') closeSearchOverlay(); };
  $('#search-close').onclick = closeSearchOverlay;
}
function closeSearchOverlay() {
  const ov = document.getElementById('search-overlay');
  if (ov) ov.hidden = true;
  document.querySelectorAll('.bubble').forEach(b => b.classList.remove('search-match'));
}
// Add contact, optionally filled in (from a group's member list): the address is set, the suggested name can be changed.
function openAddContact(prefill) {
  const dialog = $('#add-dialog');
  $('#add-status').textContent = '';
  if (prefill) { $('#in-address').value = prefill.address || ''; $('#in-petname').value = prefill.petname || ''; }
  dialog.showModal();
  const name = $('#in-petname'); name.focus(); if (prefill) name.select();
}
function wireAddContact() {
  const dialog = $('#add-dialog');
  $('#add-contact-btn').onclick = () => openAddContact();
  $('#requests-btn').onclick = () => openRequestPanel();
  $('#add-cancel').onclick = () => dialog.close();
  $('#add-confirm').onclick = async e => {
    e.preventDefault();
    const petname = $('#in-petname').value.trim(), address = $('#in-address').value.trim();
    if (!petname || !address) return;
    $('#add-confirm').disabled = true; $('#add-status').classList.remove('ok'); $('#add-status').textContent = t('contacts.adding');
    try { await addContact(petname, address); dialog.close(); $('#in-petname').value = ''; $('#in-address').value = ''; $('#add-status').textContent = ''; toast(t('toast.contactAdded')); }
    catch (err) { $('#add-status').textContent = err && err.i18n ? err.message : t('toast.contactFail'); }
    finally { $('#add-confirm').disabled = false; }
  };
}

function wireAvatar() {
  $('#avatar-input').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (f.size > MAX_PICTURE_FILE) { toast(t('toast.imageTooBig', { mb: MAX_PICTURE_FILE / 1048576 })); return; }
    try {
      myAvatar = await resizeImageToDataURL(f);
      prefs.avatar = myAvatar; savePrefs();
      await fetch('/api/identity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ecdhPub: ikPub, ratchetPub: spk.pub, avatar: myAvatar }),
      });
      renderIdentityCard();
      fetch('/api/profile/broadcast', { method: 'POST' }).catch(() => {});
      toast(t('toast.picSaved'));
    } catch (err) { toast(t('toast.bioFail')); }
  };
}

function formatUptime(s) {
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

let circuitMapHook = null;      // set by initLogPanel: opens the network map on one contact's circuit
function initLogPanel() {
  const btn      = $('#logs-btn');
  const panel    = $('#log-panel');
  const close    = $('#log-close');
  const body     = $('#log-body');
  const stats    = $('#log-stats');
  const hsHealth = $('#hs-health');
  const meter    = $('#bw-meter');
  const cirBody  = $('#circuits-body');
  const globeBody = $('#globe-body');
  const tabs     = Array.from(panel.querySelectorAll('.log-tab'));
  const nodes    = Array.from(panel.querySelectorAll('.lrn'));
  const wires    = Array.from(panel.querySelectorAll('.lrw'));
  let timer     = null;
  let activeTab = 'status';
  let lastTraffic = null;
  let userCircuitIds = new Set();
  let _hsHealthCache = null;
  let globeCtl = null;
  let globeMounting = false;      // guard against double-mount on rapid tab clicks

  const globeReset = $('#globe-reset');
  if (globeReset) {
    globeReset.addEventListener('click', () => { if (globeCtl) globeCtl.resetView(); });
  }

  let panelIsOpen = false;          // set at once by open()/closePanel(), unlike the 'open' class (next frame, for the slide-in)
  async function showGlobe() {
    const stage    = $('#globe-stage');
    const loading  = $('#globe-loading');
    const fallback = $('#globe-fallback');
    if (globeCtl) { globeCtl.resume(); startCircuitPoll(); return; }
    if (globeMounting || !stage) return;
    globeMounting = true;
    if (loading)  { loading.textContent = t('relaymap.loading'); loading.hidden = false; }
    if (fallback) fallback.hidden = true;
    const clearLoading = () => { if (loading) loading.hidden = true; };
    try {
      globeCtl = await mountRelayGlobe(stage, {
        onReady: clearLoading,
        onError: () => {
          clearLoading();
          if (fallback) { fallback.hidden = false; fallback.textContent = t('relaymap.loadFailed'); }
        },
      });
      // The panel may have closed while it loaded. Not the 'open' class: it lands a frame after opening, and a globe that loaded
      // within that frame (opened from a conversation's Circuit map button) was paused with no circuit shown until reopened.
      if (activeTab !== 'map' || !panelIsOpen) globeCtl.pause();
      else startCircuitPoll();
    } catch (err) {
      clearLoading();
      if (fallback) {
        fallback.hidden = false;
        fallback.textContent = (err && err.message === 'webgl-unavailable')
          ? t('relaymap.unavailable')
          : t('relaymap.loadFailed');
      }
    } finally {
      globeMounting = false;
    }
  }
  function hideGlobe() { if (globeCtl) globeCtl.pause(); stopCircuitPoll(); }

  let circuitType  = 'socks';
  let circuitTimer = null;
  const segSocks = $('#seg-socks');
  const segHs    = $('#seg-hs');
  const globeCap = $('#globe-caption');

  // The map's circuit. "Hidden" shows the live-checked circuit that carries your messages to one contact: the one you opened it from,
  // or one you pick (the most recently used by default). Nothing is shown when there is none, never a different circuit.
  let focusContact = null;          // { address, name } when opened from a conversation
  let pickedContact = '';           // contact chosen in the list of the Hidden view ('' = the most recent)
  const focusBar   = $('#globe-focus'), focusTitle = $('#globe-focus-title'), contactSel = $('#globe-contact'), focusAll = $('#globe-focus-all');
  const globeNote  = $('#globe-note'), globeSeg = document.querySelector('.globe-seg');
  let _circuitSig = '';
  let _contactSig = '';
  function applyFocusUI() {
    const hs = circuitType === 'hs';
    if (globeSeg) globeSeg.hidden = !!focusContact;
    if (focusBar) focusBar.hidden = !hs;
    if (focusTitle) { focusTitle.hidden = !focusContact; focusTitle.textContent = focusContact ? t('relaymap.hsFocus', { name: focusContact.name || shortAddr(focusContact.address) }) : ''; }
    if (focusAll) focusAll.hidden = !focusContact;
    if (contactSel) contactSel.hidden = !!focusContact;
    if (globeNote) { globeNote.hidden = !hs; globeNote.textContent = hs ? t('relaymap.hsNote') : ''; }
  }
  function fillContactList(list) {
    if (!contactSel) return;
    const sig = JSON.stringify(list.map((c) => [c.address, c.name])) + '|' + pickedContact;
    if (sig === _contactSig) return;
    _contactSig = sig;
    contactSel.innerHTML = '';
    for (const c of list) contactSel.append(el('option', { value: c.address, textContent: c.name || shortAddr(c.address) }));
    if (!list.length) contactSel.append(el('option', { value: '', textContent: '—' }));
    contactSel.value = list.some((c) => c.address === pickedContact) ? pickedContact : (list[0]?.address || '');
  }
  let _circuitSeq = 0;
  async function loadCircuit() {
    if (!globeCtl) return;
    const seq = ++_circuitSeq;      // a slower, older answer must never overwrite a newer one (type or contact switched meanwhile)
    let data;
    const who = focusContact ? focusContact.address : (circuitType === 'hs' ? pickedContact : '');
    try {
      const r = await fetch('/api/circuit/geo?type=' + circuitType + (who ? '&contact=' + encodeURIComponent(who) : '') + (circuitType === 'socks' && userCircuitIds.size ? '&user=' + [...userCircuitIds].join(',') : ''));
      if (!r.ok) return;            // the control port didn't answer this time: keep what is drawn rather than claim there is no circuit
      data = await r.json();
    } catch { return; }
    if (!globeCtl || seq !== _circuitSeq) return;
    if (circuitType === 'hs' && !focusContact) {
      fillContactList(Array.isArray(data.contacts) ? data.contacts : []);
      if (pickedContact && data.status === 'none') { pickedContact = ''; _circuitSig = ''; }   // the chosen one is gone: go back to the most recent
    }
    const hops = (data && Array.isArray(data.hops)) ? data.hops : [];
    // Everything the drawing and the caption depend on: a change in any of it (the country database becoming ready, the reason there
    // is no circuit, the contact's name, relays that couldn't be placed) must redraw, not only a different circuit.
    // On a call to this contact (a route we opened): said above the map and under it.
    const shownAddr = (focusContact && focusContact.address) || data.contact || '';
    const inCall = circuitType === 'hs' && !!data.circuitId && typeof data.callTo === 'string' && !!shownAddr && data.callTo.toLowerCase() === shownAddr.toLowerCase();
    if (focusTitle && focusContact) focusTitle.textContent = t('relaymap.hsFocus', { name: focusContact.name || shortAddr(focusContact.address) }) + (inCall ? ' · ' + t('relaymap.inCall') : '');
    const sig = [circuitType, data.circuitId || '', data.status || '', data.reason || '', data.dbReady === false ? 0 : 1, data.unknown || 0,
      data.name || '', data.contact || '', inCall ? 1 : 0, hops.map(h => h.country + h.nickname + h.role).join(',')].join('|');
    if (sig === _circuitSig) return;
    _circuitSig = sig;
    globeCtl.setCircuit(hops);
    if (!globeCap) return;
    const nm = (focusContact && (focusContact.name || shortAddr(focusContact.address))) || data.name || '';
    if (hops.length || data.circuitId) {
      // Until the country database is ready no relay can be placed: say so, but still name the circuit and follow its changes.
      const locating = !hops.length && data.dbReady === false;
      const parts = [locating ? t('relaymap.locating') : hops.map(h => h.country || '??').join(' → ')];
      if (data.circuitId) parts.push(t('relaymap.circuit') + ' ' + data.circuitId);
      if (data.unknown > 0 && !locating) parts.push(t('relaymap.unlocated', { n: data.unknown }));
      if (data.status === 'idle') parts.push(t('relaymap.idle'));
      if (inCall) parts.push(t('relaymap.voiceCall'));
      globeCap.textContent = parts.filter(Boolean).join('  ·  ');
    } else if (circuitType === 'hs') {
      globeCap.textContent = data.reason === 'never' || data.reason === 'unknown-contact' || !data.reason
        ? (focusContact ? t('relaymap.hsNever', { name: nm }) : t('relaymap.hsNone'))
        : t('relaymap.hsGone', { name: nm });
    } else globeCap.textContent = t('relaymap.noCircuit');
  }
  let _trafficHooked = false;
  function startCircuitPoll() {
    loadCircuit();
    if (circuitTimer) clearInterval(circuitTimer);
    circuitTimer = setInterval(() => { if (activeTab === 'map' && globeCtl && panelIsOpen) loadCircuit(); }, 2500);
    if (!_trafficHooked) {
      _trafficHooked = true;
      document.addEventListener('anon:traffic', () => {
        if (!panel.classList.contains('open')) return;
        if (activeTab === 'map' && globeCtl) setTimeout(loadCircuit, 700);
        if (activeTab === 'circuits') setTimeout(renderCircuits, 700);
      });
    }
  }
  function stopCircuitPoll() {
    if (circuitTimer) { clearInterval(circuitTimer); circuitTimer = null; }
  }
  function selectCircuitType(type) {
    if ((type !== 'socks' && type !== 'hs') || type === circuitType) return;
    circuitType = type;
    if (segSocks) segSocks.classList.toggle('on', type === 'socks');
    if (segHs)    segHs.classList.toggle('on', type === 'hs');
    _circuitSig = '';
    applyFocusUI();
    loadCircuit();
  }
  if (contactSel) contactSel.addEventListener('change', () => { pickedContact = contactSel.value; _circuitSig = ''; loadCircuit(); });
  if (focusAll) focusAll.addEventListener('click', () => { focusContact = null; _circuitSig = ''; applyFocusUI(); loadCircuit(); });
  applyFocusUI();
  // Called by the "Circuit map" button in a conversation: open the map on that contact's circuit.
  circuitMapHook = (address, name) => {
    focusContact = { address, name };
    circuitType = 'hs';
    if (segSocks) segSocks.classList.remove('on');
    if (segHs)    segHs.classList.add('on');
    _circuitSig = '';
    applyFocusUI();
    if (!panel.classList.contains('open')) open();
    switchTab('map');
    loadCircuit();
  };
  if (segSocks) segSocks.addEventListener('click', () => selectCircuitType('socks'));
  if (segHs)    segHs.addEventListener('click', () => selectCircuitType('hs'));

  function switchTab(name) {
    activeTab = name;
    tabs.forEach(t => t.classList.toggle('on', t.dataset.tab === name));
    const onMap = name === 'map';
    stats.hidden    = onMap;
    meter.hidden    = onMap;
    hsHealth.hidden = onMap;
    body.hidden     = name !== 'status';
    cirBody.hidden  = name !== 'circuits';
    globeBody.hidden = !onMap;
    if      (onMap)             showGlobe();
    else  { hideGlobe(); poll(); }
    netBar.hidden = name !== 'circuits';
    if (name !== 'circuits') panel.classList.remove('circuits-focus');
    if (name === 'circuits') refreshNet(); else closeExit();
  }
  tabs.forEach(t => t.onclick = () => switchTab(t.dataset.tab));

  function open() {
    panelIsOpen = true;
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add('open'));
    btn.classList.add('on');
    if (activeTab === 'map') showGlobe();
    poll();
    clearInterval(timer);                        // two quick clicks open it twice before the 'open' class lands: never two timers
    timer = setInterval(poll, 3000);
  }
  function closePanel() {
    panelIsOpen = false;
    panel.classList.remove('open');
    btn.classList.remove('on');
    clearInterval(timer); timer = null;
    focusContact = null; _circuitSig = ''; applyFocusUI();
    hideGlobe();
    closeExit();
    setTimeout(() => { if (!panel.classList.contains('open')) panel.hidden = true; }, 250);   // not if it was opened again meanwhile
  }

  btn.onclick    = () => panel.classList.contains('open') ? closePanel() : open();
  close.onclick  = closePanel;
  // Lives outside #circuits-body, which is rebuilt on every poll, so an open
  // dropdown is never torn down under the user's cursor.
  const netBar     = $('#net-toolbar');
  const exitBtn    = $('#exit-btn');
  const exitPop    = $('#exit-pop');
  const exitSearch = $('#exit-search');
  const exitList   = $('#exit-list');
  const exitSub    = $('#exit-sub');
  const portSw     = $('#dyn-port-sw');
  const portSub    = $('#port-sub');
  const socksLine  = $('#net-socks');
  const net = { ready: false, phase: 'starting', progress: null, total: 0, selected: null, applied: false, error: null, countries: [],
                socksPort: 9050, dynamicPort: true, busy: false };
  let exitHi = -1;
  const PREFERRED_PORT = 9050;

  const regionNames = {};
  function countryName(code) {
    const l = getLang() === 'zh' ? 'zh-CN' : getLang();
    try { return (regionNames[l] ||= new Intl.DisplayNames([l], { type: 'region' })).of(code) || code; }
    catch { return code; }
  }
  function flagEl(cc) {
    const wrap = el('span', { className: 'exit-flag' });
    if (!cc) { wrap.append(emojiImg('\u{1F310}', 18)); return wrap; }
    const img = el('img', { src: flagSrc(cc), alt: '', draggable: false });
    img.onerror = () => { wrap.textContent = cc; };
    wrap.append(img);
    return wrap;
  }

  function renderNet() {
    const sel = net.selected;
    const selCount = sel ? (net.countries.find(c => c.code === sel) || {}).count : null;
    exitBtn.replaceChildren(
      flagEl(sel),
      el('span', { className: 'exit-label', textContent: sel
        ? `${sel} – ${countryName(sel)}${selCount ? ` (${selCount})` : ''}` : t('exit.global') }),
      el('span', { className: 'exit-chev', textContent: '▾' }));
    exitSub.className = 'net-sub';
    if (net.busy)                       exitSub.textContent = t('exit.applying');
    else if (!net.ready)                exitSub.textContent = net.phase === 'starting'
      ? t('exit.starting', { pct: net.progress != null ? net.progress + '%' : '' }).trim()
      : net.phase === 'database' ? t('exit.database') : t('exit.loading');
    else if (!sel)                      exitSub.textContent = t('exit.subAuto');
    else if (net.error === 'no_exits') { exitSub.textContent = t('exit.unavailable', { name: countryName(sel) }); exitSub.classList.add('warn'); }
    else if (!net.applied)              exitSub.textContent = t('exit.applying');
    else                                exitSub.textContent = t('exit.relays', { n: selCount || 0 });
    portSw.setAttribute('aria-checked', String(net.dynamicPort));
    portSub.textContent = t('port.desc', { port: PREFERRED_PORT });
    socksLine.textContent = t('port.socks', { addr: '127.0.0.1:' + net.socksPort });
  }

  function exitOptions() {
    const q = exitSearch.value.trim().toLowerCase();
    const total = net.total;
    const opts = [];
    const globalLabel = t('exit.global');
    if (!q || globalLabel.toLowerCase().includes(q)) opts.push({ code: null, label: globalLabel, count: total });
    for (const c of net.countries) {
      const label = `${c.code} – ${countryName(c.code)}`;
      if (!q || label.toLowerCase().includes(q)) opts.push({ code: c.code, label, count: c.count });
    }
    return opts;
  }
  let exitOpts = [];
  function renderExitList() {
    exitOpts = exitOptions();
    exitList.replaceChildren();
    if (!exitOpts.length) { exitList.append(el('div', { className: 'exit-empty', textContent: t('exit.noMatch') })); return; }
    exitOpts.forEach((o, i) => {
      const row = el('button', { type: 'button', role: 'option',
        className: 'exit-opt' + (o.code === net.selected ? ' sel' : '') + (i === exitHi ? ' hi' : '') });
      row.setAttribute('aria-selected', String(o.code === net.selected));
      row.append(flagEl(o.code), el('span', { className: 'exit-label', textContent: o.label }));
      if (o.count) row.append(el('span', { className: 'exit-count', textContent: String(o.count) }));
      row.onclick = () => chooseExit(o.code);
      exitList.append(row);
    });
  }

  async function refreshNet() {
    try {
      const [c, n] = await Promise.all([
        fetch('/api/exit/countries').then(r => r.ok ? r.json() : Promise.reject(new Error('exit'))),
        fetch('/api/network').then(r => r.json()),
      ]);
      Object.assign(net, { ready: c.ready, phase: c.phase, progress: c.progress, total: c.total || 0, selected: c.selected, applied: c.applied, error: c.error,
        countries: c.countries || [], socksPort: n.socksPort, dynamicPort: n.dynamicPort });
    } catch {}
    renderNet();
    if (!exitPop.hidden) renderExitList();
  }

  function openExit() {
    exitPop.hidden = false;
    exitBtn.setAttribute('aria-expanded', 'true');
    exitSearch.value = ''; exitHi = -1;
    renderExitList();
    exitSearch.focus();
    refreshNet();
    document.addEventListener('mousedown', outsideExit, true);
  }
  function closeExit() {
    if (exitPop.hidden) return;
    exitPop.hidden = true;
    exitBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', outsideExit, true);
  }
  function outsideExit(e) { if (!exitPop.contains(e.target) && !exitBtn.contains(e.target)) closeExit(); }
  exitBtn.onclick = () => (exitPop.hidden ? openExit() : closeExit());
  exitSearch.oninput = () => { exitHi = -1; renderExitList(); };
  exitSearch.onkeydown = (e) => {
    if (e.key === 'Escape') { closeExit(); exitBtn.focus(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!exitOpts.length) return;
      exitHi = (exitHi + (e.key === 'ArrowDown' ? 1 : -1) + exitOpts.length) % exitOpts.length;
      renderExitList();
      const row = exitList.children[exitHi]; if (row) row.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && exitOpts.length) {
      e.preventDefault();
      chooseExit(exitOpts[exitHi >= 0 ? exitHi : 0].code);
    }
  };

  async function chooseExit(code) {
    closeExit();
    if (code === net.selected) return;
    net.busy = true; renderNet();
    try {
      const r = await fetch('/api/exit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: code }) });
      if (!r.ok) throw new Error('exit');
    } catch { toast(t('exit.setFail')); }
    finally { net.busy = false; await refreshNet(); poll(); }
  }

  portSw.onclick = async () => {
    const next = !net.dynamicPort;
    portSw.disabled = true;
    try {
      const r = await fetch('/api/network/dynamic-port', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }) });
      if (!r.ok) throw new Error('port');
      net.dynamicPort = next;
      toast(t('port.restart'));
    } catch { toast(t('port.setFail')); }
    finally { portSw.disabled = false; renderNet(); }
  };

  const newCircBtn = $('#new-circuit-btn');
  const newCircLabel = newCircBtn.querySelector('.net-btn-label');
  newCircBtn.onclick = async () => {
    if (newCircBtn.disabled) return;
    newCircBtn.disabled = true;
    newCircLabel.textContent = t('nav.newCircuit') + '…';
    try {
      const resp = await fetch('/api/circuit/renew', { method: 'POST' });
      const r = await resp.json().catch(() => ({}));
      if (resp.ok && r.ok && r.id) {
        userCircuitIds.clear();
        userCircuitIds.add(String(r.id));
        toast(t('circuits.newCircuit', { id: r.id }));
      } else {
        toast(t('circuits.controlFail'));
      }
    } catch { toast(t('circuits.controlFail')); }
    finally {
      newCircLabel.textContent = t('nav.newCircuit');
      renderCircuits(true);
      setTimeout(() => renderCircuits(true), 800);
      setTimeout(() => { newCircBtn.disabled = false; }, 1000);
    }
  };

  function fmtBw(kb) {
    if (!kb) return '—';
    if (kb >= 1024) return (kb / 1024).toFixed(1) + ' MB/s';
    return Math.round(kb) + ' KB/s';
  }
  function fmtRate(bps) {
    if (!bps) return '0 B/s';
    if (bps >= 1e6) return (bps / 1e6).toFixed(2) + ' MB/s';
    if (bps >= 1e3) return (bps / 1e3).toFixed(1) + ' KB/s';
    return Math.round(bps) + ' B/s';
  }
  function fmtBytes(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + ' KB';
    return n + ' B';
  }
  function shortFp(fp) { return fp ? fp.slice(0, 8) : ''; }
  const LAST_HOP_ROLE = {
    HS_CLIENT_REND: 'rend',   HS_SERVICE_REND: 'rend',
    HS_CLIENT_INTRO: 'intro', HS_SERVICE_INTRO: 'intro',
    HS_CLIENT_HSDIR: 'hsdir', HS_SERVICE_HSDIR: 'hsdir',
  };
  function relayRole(circuit, idx) {
    const n = circuit.relays.length;
    if (idx === 0) return 'guard';
    if (idx < n - 1 || circuit.state !== 'BUILT') return 'relay';
    return LAST_HOP_ROLE[circuit.purpose] || (/^HS_/.test(circuit.purpose || '') ? 'relay' : 'exit');
  }
  function renderHops(c) {
    const hops = el('div', { className: 'hops' });
    c.relays.forEach((r, i) => {
      const hop = el('div', { className: 'hop' });
      const dot = el('span', { className: 'hop-dot' });
      const meta = el('div', { className: 'hop-meta' });
      const nameRow = el('div', { className: 'hop-name-row' });
      const role = relayRole(c, i);
      nameRow.append(
        el('span', { className: 'hop-name', textContent: r.nickname || shortFp(r.fingerprint) }),
        el('span', { className: 'hop-role', textContent: t('circuits.role.' + role), title: t('circuits.roleTip.' + role) }),
      );
      const detail = el('div', { className: 'hop-detail' });
      if (r.ip)        detail.append(el('span', { className: 'hop-ip', textContent: r.ip }));
      if (r.bandwidth) detail.append(el('span', { className: 'hop-bw', textContent: '~' + fmtBw(r.bandwidth), title: t('circuits.bwTip') }));
      meta.append(nameRow, detail);
      if (r.flags && r.flags.length) {
        const chips = el('div', { className: 'hop-flags' });
        for (const f of r.flags) chips.append(el('span', { className: 'hop-flag f-' + f, textContent: f, title: tip('circuits.flagTip.' + f) }));
        meta.append(chips);
      }
      hop.append(dot, meta);
      hops.append(hop);
      if (i < c.relays.length - 1) hops.append(el('div', { className: 'hop-link' }));
    });
    return hops;
  }

  const GENERAL_PURPOSES = ['GENERAL', 'CONFLUX_LINKED', 'CONFLUX_UNLINKED', 'CONTROLLER'];
  function circuitState(c) {
    const st = c.state;
    if (st === 'BUILT')  return { text: t('circuits.stateBuilt'),  cls: 'ok' };
    if (st === 'FAILED') return { text: t('circuits.stateFailed'), cls: 'bad' };
    if (st === 'CLOSED') return { text: t('circuits.stateClosed'), cls: 'pending' };
    if (st === 'LAUNCHED' || st === 'EXTENDED' || st === 'GUARD_WAIT') {
      const n = Math.min((c.relays || []).length, 3);
      const general = GENERAL_PURPOSES.includes(c.purpose) && !c.hsState;
      return { cls: 'pending', text: (general && st === 'EXTENDED' && n > 0)
        ? t('circuits.stateBuildingOf', { n, total: 3 }) : t('circuits.stateBuilding') };
    }
    return { text: st, cls: 'pending' };
  }

  // Focus mode hides everything above the circuit list. It only applies while circuits exist on the Circuits tab, so the controls can't stay hidden with no way back.
  let circuitsFocus = false;
  function applyCircuitsFocus(hasCircuits) {
    panel.classList.toggle('circuits-focus', circuitsFocus && hasCircuits && activeTab === 'circuits');
  }

  function tip(key) { const v = t(key); return v === key ? '' : v; }
  const PORT_NAMES = { 80: 'HTTP', 443: 'HTTPS', 8080: 'HTTP', 8443: 'HTTPS', 53: 'DNS', 853: 'DNS over TLS', 22: 'SSH', 21: 'FTP',
    25: 'SMTP', 465: 'SMTP', 587: 'SMTP', 110: 'POP3', 995: 'POP3', 143: 'IMAP', 993: 'IMAP', 5222: 'XMPP', 6667: 'IRC', 6697: 'IRC' };
  function portService(target) {
    const m = /:(\d{1,5})$/.exec(target || '');
    return m && PORT_NAMES[m[1]] ? ` (${PORT_NAMES[m[1]]})` : '';
  }

  // Refreshed every 3 s and after any action. Answers can come back out of order (a slow poll after a "Close"), so only the newest
  // request draws; a failed one keeps the last list instead of blanking it; and nothing is redrawn when nothing changed, so the
  // scroll position and an open tooltip survive the refresh.
  // When the network's answer is slow (it can take several seconds on Windows), a poll every 3 s used to replace the request before it
  // returned, so a click on Show/Hide changed nothing on screen until a request got through; a second click then undid the first. Now a
  // routine poll waits for the one in flight, and a click redraws at once from the last answer.
  let _cirSeq = 0, _cirSig = '', _cirShown = false, _cirLast = null, _cirInFlight = 0;
  async function renderCircuits(force = false) {
    if (!force && _cirInFlight) return;
    const seq = ++_cirSeq;
    let d = null;
    _cirInFlight++;
    // Given up after 15 s, so one answer that never comes can't stop the refreshes (they wait for the one in flight).
    const ac = new AbortController(), giveUp = setTimeout(() => ac.abort(), 15000);
    try { const r = await fetch('/api/circuits', { signal: ac.signal }); d = await r.json(); if (!r.ok || !Array.isArray(d.circuits)) d = null; }
    catch { d = null; }
    finally { clearTimeout(giveUp); _cirInFlight--; }
    if (seq !== _cirSeq) return;
    if (!d) { if (!_cirShown) cirBody.textContent = t('circuits.controlFail'); return; }
    _cirLast = d;
    drawCircuits(d, force);
  }
  function drawCircuits(d, force) {
    const all = d.circuits;
    const callTo = typeof d.callTo === 'string' ? d.callTo.toLowerCase() : null;     // the contact we're calling, on a route we opened
    const carriesCall = (c) => !!callTo && c.inUse && (c.streams || []).some((x) => String(x.target || '').toLowerCase().startsWith(callTo + ':'));
    const sig = JSON.stringify([getLang(), circuitsFocus, callTo, [...userCircuitIds], all.map((c) => [c.id, c.state, c.purpose, c.hsState, c.inUse,
      (c.streams || []).map((x) => x.state + x.target), c.relays.map((r) => [r.fingerprint, r.nickname, r.ip, r.bandwidth, (r.flags || []).join()])]),
      typeof contacts !== 'undefined' ? contacts.map((c) => c.address + c.petname) : []]);
    if (!force && sig === _cirSig) return;
    _cirSig = sig;
    _cirShown = true;
    const keepScroll = cirBody.scrollTop;
    hideTip();
    cirBody.innerHTML = '';

    const isUserBuilt = (c) => userCircuitIds.has(String(c.id));
    const userBuilt = all.filter(isUserBuilt);
    const liveOthers = all.filter(c => !isUserBuilt(c) && c.inUse);
    liveOthers.sort((a, b) => Number(b.id) - Number(a.id));

    const head = el('div', { className: 'circuits-head' });
    const total = userBuilt.length + liveOthers.length;
    head.append(el('span', { className: 'circuits-count', textContent: t('circuits.active', { n: total }) }));
    if (total) {
      const tog = el('button', { type: 'button', className: 'circuits-toggle',
        title: circuitsFocus ? t('circuits.unfocusTip') : t('circuits.focusTip') });
      tog.setAttribute('aria-pressed', String(circuitsFocus));
      tog.append(el('span', { textContent: circuitsFocus ? t('circuits.hide') : t('circuits.show') }),
                 el('span', { className: 'circuits-chev', textContent: circuitsFocus ? '▴' : '▾' }));
      tog.onclick = () => { circuitsFocus = !circuitsFocus; closeExit(); if (_cirLast) drawCircuits(_cirLast, true); renderCircuits(true); };
      head.append(tog);
    }
    if (!total) circuitsFocus = false;
    applyCircuitsFocus(total > 0);
    cirBody.append(head);
    cirBody.append(el('div', { className: 'circuits-about', textContent: t('circuits.about') }));

    const show = [...userBuilt, ...liveOthers];
    if (!show.length) {
      cirBody.append(el('div', { className: 'circuits-empty',
        textContent: t('circuits.empty') }));
      return;
    }

    for (const c of show) {
      const card = el('div', { className: 'circuit-card'
        + (isUserBuilt(c) ? ' user-built' : '')
        + (c.inUse ? ' live' : '') });
      const hdr  = el('div', { className: 'circuit-head' });
      hdr.append(
        el('span', { className: 'circuit-id', textContent: '#' + c.id }),
        el('span', { className: 'circuit-state ' + circuitState(c).cls, textContent: circuitState(c).text, title: t('circuits.stateTip') }),
        el('span', { className: 'circuit-purpose', textContent: (c.purpose || '').replace(/_/g, ' ').toLowerCase(), title: tip('circuits.purposeTip.' + c.purpose) }),
      );
      if (c.inUse) {
        const live = el('span', { className: 'circuit-live', title: t('circuits.liveTip') });
        live.append(el('span', { className: 'live-dot' }),
                    el('span', { textContent: t('circuits.live') + ' · ' + c.streams.length + ' ' + (c.streams.length === 1 ? t('circuits.streamSingle') : t('circuits.streamPlural')) }));
        hdr.append(live);
      }
      if (isUserBuilt(c)) hdr.append(el('span', { className: 'circuit-mine', textContent: t('circuits.yours'), title: t('circuits.yoursTip') }));
      const callName = carriesCall(c) ? (contactByAddress(callTo)?.petname || shortAddr(callTo)) : null;
      if (callName) hdr.append(el('span', { className: 'circuit-mine circuit-call', textContent: t('circuits.callBadge'), title: t('circuits.callBadgeTip', { name: callName }) }));
      const closeBtn = el('button', { className: 'circuit-close', type: 'button', title: t('circuits.closeBtn'), textContent: '✕' });
      closeBtn.onclick = async () => {
        closeBtn.disabled = true;
        try { await fetch('/api/circuit/' + c.id, { method: 'DELETE' }); }
        catch {}
        userCircuitIds.delete(String(c.id));
        renderCircuits(true);
      };
      hdr.append(closeBtn);
      card.append(hdr);
      card.append(renderHops(c));

      if (c.inUse && c.streams.length) {
        const sList = el('div', { className: 'stream-list' });
        const targets = Array.from(new Set(c.streams.map(s => s.target).filter(Boolean))).slice(0, 3);
        for (const tgt of targets) {
          const addrMatch = tgt.match(/^([a-z2-7]{56}\.anyone)/i);
          let label = tgt, lock = false;
          if (addrMatch && typeof contacts !== 'undefined' && Array.isArray(contacts)) {
            const known = contacts.find(c => c.address === addrMatch[1].toLowerCase());
            lock = true;
            if (known) label = ' → ' + known.petname;
            else label = ' → ' + shortAddr(addrMatch[1]);
            if (callTo && addrMatch[1].toLowerCase() === callTo) label += ' · ' + t('relaymap.voiceCall');
          }
          sList.append(el('span', { className: 'stream-target',
            title: addrMatch ? t('circuits.hsDestTip') : t('circuits.destTip', { target: tgt, service: portService(tgt) }) },
            ...(lock ? [emojiImg('🔒', 12), label] : [label])));
        }
        if (c.streams.length > targets.length) {
          sList.append(el('span', { className: 'stream-target dim',
            textContent: t('circuits.more', { n: c.streams.length - targets.length }),
            title: t('circuits.moreTip', { n: c.streams.length - targets.length }) }));
        }
        card.append(sList);
      }

      cirBody.append(card);
    }
    cirBody.scrollTop = keepScroll;
  }

  async function refreshHeader() {
    try {
      const t = await fetch('/api/traffic').then(r => r.json());
      if (lastTraffic) {
        const dt = (t.ts - lastTraffic.ts) / 1000;
        if (dt > 0) {
          const inRate  = Math.max(0, (t.read    - lastTraffic.read)    / dt);
          const outRate = Math.max(0, (t.written - lastTraffic.written) / dt);
          meter.innerHTML = '';
          meter.append(
            el('span', { className: 'bw-arrow', textContent: '↓' }),
            el('span', { className: 'bw-val',   textContent: fmtRate(inRate) }),
            el('span', { className: 'bw-total', textContent: fmtBytes(t.read) }),
            el('span', { className: 'bw-sep' }),
            el('span', { className: 'bw-arrow', textContent: '↑' }),
            el('span', { className: 'bw-val',   textContent: fmtRate(outRate) }),
            el('span', { className: 'bw-total', textContent: fmtBytes(t.written) }),
          );
        }
      }
      lastTraffic = t;
    } catch {}

    let d;
    try { d = await fetch('/api/logs').then(r => r.json()); } catch { return; }

    stats.innerHTML = '';
    const pct = d.bootstrap || 0;
    for (const [label, value, dim] of [
      ['Address',    d.address ? shortAddr(d.address) : 'publishing…', !d.address],
      ['Uptime',     formatUptime(d.uptime || 0), true],
      ['Bootstrap',  pct + '%', pct < 100],
    ]) {
      const s = el('div', { className: 'log-stat' });
      s.append(
        el('span', { className: 'log-stat-key', textContent: label }),
        el('span', { className: 'log-stat-val' + (dim ? ' dim' : ''), textContent: value })
      );
      stats.append(s);
    }

    const now = Date.now();
    if (!_hsHealthCache || now - _hsHealthCache.ts > 15000) {
      try {
        const h = await fetch('/api/hs/health').then(r => r.json());
        _hsHealthCache = { ts: now, data: h };
      } catch {}
    }
    if (hsHealth && _hsHealthCache && _hsHealthCache.data) {
      const h = _hsHealthCache.data;
      const detailMap = {
        'reachable':          ['ok',   t('hs.reachable')],
        'published-no-intro': ['warn', t('hs.publishedNoIntro')],
        'not-published':      ['warn', t('hs.notPublished')],
        'establishing':       ['warn', t('hs.establishing')],
        'no-address':         ['warn', t('hs.noAddress')],
        'unknown':            ['warn', t('settings.checking')],
      };
      const [dot, label] = detailMap[h.detail] || detailMap.unknown;
      let extra = '';
      if (h.detail === 'reachable' && h.introPoints != null) {
        extra = '  •  ' + (t('hs.introPoints')) + ': ' + h.introPoints;
      }
      // Whether our own address can be found through the network (the backend's self-test, lib/selftest.js): the line above is only what the
      // network program says about itself.
      const selfState = (h.selfTest && h.selfTest.state) || 'idle';
      const [selfDot, selfLabel] = selfState === 'findable' ? ['ok', t('hs.self.yes')] : selfState === 'not-findable' ? ['warn', t('hs.self.no')]
        : selfState === 'checking' ? ['idle', t('hs.self.checking')] : selfState === 'unknown' ? ['idle', t('hs.self.unknown')] : ['idle', t('hs.self.idle')];
      hsHealth.innerHTML = '';
      hsHealth.append(
        el('span', { className: 'hs-health-key', textContent: t('hs.service') }),
        el('span', { className: 'hs-dot ' + dot }),
        el('span', { className: 'hs-health-label', textContent: label + extra }),
        el('span', { className: 'hs-health-key hs-health-key2', textContent: t('hs.self') }),
        el('span', { className: 'hs-dot ' + selfDot }),
        el('span', { className: 'hs-health-label', textContent: selfLabel })
      );
    }

    const active = pct >= 100 ? 3 : pct >= 60 ? 2 : pct > 0 ? 1 : 0;
    nodes.forEach((n, i) => {
      n.classList.toggle('on', i < active);
      n.classList.toggle('pulse', pct >= 100);
    });
    wires.forEach((w, i) => w.classList.toggle('on', i < active - 1));

    if (activeTab !== 'status') return;
    const lines = (d.lines || []).filter(line => !/New control connection opened from 127\.0\.0\.1/.test(line));
    body.textContent = '';
    for (const line of lines) {
      const span = el('span');
      span.textContent = line + '\n';
      if (/\[AnonChat\]/.test(line))                span.className = /delivered after|can be found again|network is ready/.test(line) ? 'lb-boot' : 'lb-warn';   // why messages wait (lib/deliverylog.js)
      else if (/Bootstrapped/i.test(line))         span.className = 'lb-boot';
      else if (/\[warn\]/i.test(line))             span.className = 'lb-warn';
      else if (/\[err\]|error/i.test(line))        span.className = 'lb-err';
      else if (/\[notice\]/i.test(line))           span.className = 'lb-notice';
      body.append(span);
    }
    body.scrollTop = body.scrollHeight;
  }

  async function poll() {
    refreshHeader();
    if (activeTab === 'circuits') {
      renderCircuits();
      if (!net.ready || (net.selected && !net.applied)) refreshNet();
    }
  }
}

let _zoomTimer = null;
function showAvatarZoom(address, avatarUrl, name) {
  const overlay = $('#avatar-zoom');
  const inner   = $('#avatar-zoom-inner');
  inner.style.cssText = '';                     // the image viewer leaves its own sizing here: start from the default centred box
  inner.innerHTML = '';
  inner.style.setProperty('--zoom', '180px');
  inner.append(renderAvatarEl(address, avatarUrl, 180, '', name));
  if (typeof avatarUrl === 'string' && avatarUrl) {   // enlarge only as far as the picture stays sharp
    const probe = new Image(); probe.src = avatarUrl;
    probe.decode().then(() => inner.style.setProperty('--zoom', Math.round(Math.min(320, Math.max(180, probe.naturalWidth * 1.1))) + 'px')).catch(() => {});
  }
  overlay.hidden = false;
  clearTimeout(_zoomTimer);
  _zoomTimer = setTimeout(() => { overlay.hidden = true; }, 3000);
  overlay.onclick = () => { clearTimeout(_zoomTimer); overlay.hidden = true; };
}

// Saved data the backend couldn't read (damaged, or encrypted with a key this computer no longer has). Shown instead of the app, which
// would otherwise start empty; nothing is changed or deleted.
async function storeReadable() {
  let w = null;
  try { w = await fetch('/api/whoami').then((r) => r.json()); } catch { return true; }
  if (!w || w.storeOk !== false) return true;
  const screen = $('#pin-screen');
  const inner = screen.querySelector('.pin-inner');
  inner.innerHTML = '';
  inner.classList.add('store-error');
  const why = { BAD_SEAL: 'store.why.badSeal', NO_KEY: 'store.why.noKey', NOT_ENCRYPTED: 'store.why.notEncrypted' };
  const describe = (list) => (list || []).map((p) => t(why[p.reason] || 'store.why.damaged', { file: p.file })).join('\n');
  const details = el('pre', { className: 'store-error-details', hidden: true, textContent: describe(w.storeProblems) });
  const again = el('button', { type: 'button', className: 'btn primary', textContent: t('store.retry') });
  const more = el('button', { type: 'button', className: 'btn', textContent: t('store.details') });
  more.onclick = () => { details.hidden = !details.hidden; };
  again.onclick = async () => {
    again.disabled = true;
    try { const h = await fetch('/api/store/recheck', { method: 'POST' }).then((r) => r.json()); if (h.ok) { location.reload(); return; } details.textContent = describe(h.problems); }
    catch {}
    again.disabled = false;
  };
  const actions = el('div', { className: 'store-error-actions' }); actions.append(more, again);
  inner.append(
    el('img', { className: 'pin-logo', src: '/app-icon.png', alt: '', width: 56, height: 56 }),
    el('h1', { className: 'store-error-title', textContent: t('store.title') }),
    el('p', { className: 'store-error-text', textContent: t('store.text') }),
    actions, details,
  );
  return false;
}

async function init() {
  initLang();
  if (!(await storeReadable())) return;
  try { await fields.open(); } catch (e) { console.error('[storage] database unavailable', e); }
  const isNewUser = await initPinScreen();

  await loadEncryptedState();
  if (pendingRestore) { await finishRestore(pendingRestore); return; }

  initLang();
  renderIdentityCard(); buildEmoji(); wireComposer(); wireAddContact(); wireAvatar(); initAppearance(); initSound();
  connectWS(); pollNet();
  initLogPanel(); wireNewGroup(); wireJoinGroup(); wireJumpLatest();
  await ensureIdentity(); await refreshWhoami(); await loadContacts(); await loadGroups(); renderConversation();
  if (!myAddress) pollWhoamiUntilReady();
  await ensurePrekeys();
  if (localStorage.getItem(RESTORED_FLAG)) resyncAfterRestore();
  if (_corruptStateCount > 0) {
    toast(t('enc.corrupt', { n: _corruptStateCount }), 8000);
  }
  poll();
  setInterval(poll, 20000);
  setInterval(refreshWhoami, 15000);
  setInterval(ensurePrekeys, 60000);
  rotateSpkIfDue().catch(() => {});
  setInterval(() => { rotateSpkIfDue().catch(() => {}); }, 6 * 3600 * 1000);
  // Group members whose keys couldn't be fetched yet (offline, say): try again, so their messages can be checked and read.
  setInterval(() => { prefetchPeers(); }, 60000);
  checkFreeSpace(); setInterval(checkFreeSpace, 5 * 60 * 1000);
  refreshReadReceiptSetting();

  const warmGlobe = () => { try { warmUpRelayGlobe(); } catch {} };
  if ('requestIdleCallback' in window) requestIdleCallback(warmGlobe, { timeout: 3000 });
  else setTimeout(warmGlobe, 1500);

  const clearOpenThreadUnread = () => {
    if (!document.hasFocus() || document.visibilityState !== 'visible') return;
    const open = selectedGroup ? ('grp:' + selectedGroup) : selected;
    if (open && unreadContacts.has(open)) {
      unreadContacts.delete(open);
      renderContacts(); renderGroups();
    }
  };
  window.addEventListener('focus', clearOpenThreadUnread);
  document.addEventListener('visibilitychange', clearOpenThreadUnread);

  if (isNewUser) {
    const nudge = async () => {
      if (myAddress) { highlightShareAddress(); return; }
      setTimeout(nudge, 1500);
    };
    setTimeout(nudge, 1000);
  }
}

function showWelcome() {
  return new Promise(resolve => {
    if (document.getElementById('welcome-overlay')) { resolve(); return; }
    const overlay = el('div', { id: 'welcome-overlay', className: 'welcome-overlay' });
    const card = el('div', { className: 'welcome-card' });

    card.append(el('img', { className: 'welcome-mark', src: '/app-icon.png', alt: 'AnonChat', width: 64, height: 64 }));
    const title = el('h2', { className: 'welcome-title' });
    {                                                    // same wordmark as everywhere else: "Anon" in the accent colour
      const [before, after = ''] = (t('welcome.title')).split('AnonChat');
      title.append(before, el('b', { className: 'welcome-brand', textContent: 'Anon' }), 'Chat' + after);
    }
    card.append(title);
    card.append(el('p', { className: 'welcome-p', textContent: t('welcome.intro1') }));
    card.append(el('p', { className: 'welcome-p', textContent: t('welcome.intro2') }));

    card.append(el('div', { className: 'welcome-remember', textContent: t('welcome.rememberTitle') }));
    const ul = el('ul', { className: 'welcome-list' });
    for (const k of ['welcome.r1', 'welcome.r2', 'welcome.r3', 'welcome.r4']) {
      ul.append(el('li', { textContent: t(k) }));
    }
    card.append(ul);
    card.append(el('p', { className: 'welcome-foot', textContent: t('welcome.footer') }));

    const cta = el('button', { className: 'welcome-cta', type: 'button', textContent: t('welcome.cta') });
    cta.onclick = () => { overlay.remove(); resolve(); };
    card.append(cta);
    // Restore from a backup: desktop app only (finishing it restarts the app with the restored address).
    if (window.electron?.relaunch) {
      const restore = el('button', { className: 'welcome-restore', type: 'button', innerHTML: RESTORE_ICON });
      restore.append(el('span', { textContent: t('backup.restoreLink') }));
      restore.onclick = async () => {
        const payload = await openRestoreDialog({ fresh: true });
        if (payload) { pendingRestore = payload; overlay.remove(); resolve(); }
      };
      card.append(restore);
    }
    card.append(el('div', { className: 'welcome-powered', textContent: t('welcome.poweredBy') }));
    card.append(el('img', { className: 'welcome-anyone', src: '/anyone-logo.png', alt: 'Anyone', width: 98, height: 26, draggable: false }));

    overlay.append(languagePill(() => { overlay.remove(); showWelcome().then(resolve); }), card);
    document.body.append(overlay);
    // Restarted by a restore from Settings: the same file opens straight away (only its passphrase is asked again).
    if (!showWelcome._checkedPending && window.electron?.pendingRestore) {
      showWelcome._checkedPending = true;
      window.electron.pendingRestore().then(async (file) => {
        if (!file || !document.body.contains(overlay)) return;
        const payload = await openRestoreDialog({ fresh: true, file: { name: file.name, data: file.data, path: file.path } });
        if (payload) { pendingRestore = payload; overlay.remove(); resolve(); }
      }).catch(() => {});
    }
  });
}

// The language button on the welcome screen: a small pill (globe, the language in its own name) with the ten languages. The same
// setting as Settings → Language; choosing one redraws the welcome screen in it and is kept for the PIN screen and the app.
function languagePill(onChange) {
  const wrap = el('div', { className: 'lang-pill-wrap' });
  const cur = LANGS.find((l) => l.code === getLang()) || LANGS[0];
  const btn = el('button', { type: 'button', className: 'lang-pill', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', title: t('settings.language') });
  btn.innerHTML = GLOBE_ICON;
  btn.append(el('span', { textContent: cur.label }), el('span', { className: 'lang-chev', innerHTML: CHEVRON_ICON }));
  const menu = el('div', { className: 'lang-menu', role: 'listbox', hidden: true, 'aria-label': t('settings.language') });
  for (const l of LANGS) {
    const opt = el('button', { type: 'button', role: 'option', className: 'lang-opt' + (l.code === cur.code ? ' on' : ''), 'aria-selected': String(l.code === cur.code) });
    opt.lang = l.code === 'zh' ? 'zh-CN' : l.code;
    opt.append(el('span', { textContent: l.label }), el('span', { className: 'lang-code', textContent: (l.code === cur.code ? '\u2713 ' : '') + l.code.toUpperCase() }));
    opt.onclick = () => {
      close();
      if (l.code === getLang()) return;
      setLang(l.code);
      initLang();                                  // the PIN screen behind and the desktop app's own dialogs follow
      onChange();
    };
    menu.append(opt);
  }
  const onDoc = (e) => { if (!wrap.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { close(); btn.focus(); } };
  function open() { menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); btn.classList.add('open'); document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey); (menu.querySelector('.on') || menu.firstChild).focus(); }
  function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('open'); document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); }
  btn.onclick = () => (menu.hidden ? open() : close());
  wrap.append(btn, menu);
  return wrap;
}
init();

// TTL presets in seconds. 0 = off (no expiry).
const TTL_PRESETS = [0, 30, 300, 3600, 86400, 604800].map((secs) => ({ secs, get label() { return t('ttl.p.' + secs); } }));
function restoreTtls() {
  threadTtl.clear();
  for (const [key, secs] of Object.entries(prefs.ttl || {})) if (Number(secs) > 0) threadTtl.set(key, Number(secs));
}

async function deriveSafetyNumber(myPub, theirPub) {
  if (!myPub || !theirPub) return null;
  const sorted = [myPub, theirPub].sort();
  const enc = new TextEncoder().encode(sorted[0] + '|' + sorted[1]);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc));
  const hex = Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const trimmed = hex.slice(0, 60);
  const groups = [];
  for (let i = 0; i < trimmed.length; i += 5) groups.push(trimmed.slice(i, i + 5));
  return groups.join(' ');
}

async function openSafetyDialog(contact, onVerified) {
  const sn = await deriveSafetyNumber(ikPub, contact.ecdhPub);
  let overlay = document.getElementById('safety-overlay');
  if (!overlay) {
    overlay = el('div', { id: 'safety-overlay', className: 'confirm-overlay' });
    document.body.append(overlay);
  }
  overlay.innerHTML = '';
  overlay.hidden = false;

  const dialog = el('div', { className: 'safety-dialog' });
  dialog.append(el('h3', { textContent: t('safety.dialogTitle', { name: contact.petname }) }));
  dialog.append(el('p',  { className: 'safety-desc',
    textContent: t('safety.desc', { name: contact.petname }) }));

  const numEl = el('div', { className: 'safety-num', textContent: sn || '—' });
  dialog.append(numEl);

  // Warn loudly if a stored previous key differs from the contact's current key.
  const storedKey = prefs.verified[contact.address] || null;
  if (storedKey && storedKey !== contact.ecdhPub) {
    const warn = el('div', { className: 'safety-warn' });
    warn.append(
      el('strong', {}, emojiImg('⚠', 16), ' ' + t('safety.changed')),
      el('p', { textContent: t('safety.changedDesc', { name: contact.petname }) }),
    );
    dialog.append(warn);
  }

  const actions = el('div', { className: 'confirm-actions' });
  const closeBtn = el('button', { className: 'confirm-cancel', type: 'button', textContent: t('nav.close') });
  closeBtn.onclick = () => { overlay.hidden = true; };

  const isVerified = !!storedKey && storedKey === contact.ecdhPub;
  if (isVerified) {
    const verified = el('div', { className: 'safety-verified',
      innerHTML: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' });
    verified.append(el('span', { textContent: t('safety.verified') }));
    actions.append(closeBtn, verified);
  } else {
    const markBtn = el('button', { className: 'confirm-ok', type: 'button', textContent: t('safety.markVerified') });
    markBtn.onclick = () => {
      prefs.verified[contact.address] = contact.ecdhPub || ''; savePrefs();
      toast(t('safety.markedVerified'));
      if (onVerified) onVerified();
      overlay.hidden = true;
    };
    actions.append(closeBtn, markBtn);
  }
  dialog.append(actions);

  overlay.append(dialog);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.hidden = true; };
}

async function openGroupManage(g) {
  try {
    if (!g) { toast(t('toast.failed')); return; }
    if (!Array.isArray(g.members)) g.members = [];
    if (typeof g.description !== 'string') g.description = '';

    let overlay = document.getElementById('grp-manage-overlay');
    if (!overlay) {
      overlay = el('div', { id: 'grp-manage-overlay', className: 'confirm-overlay' });
      document.body.append(overlay);
    }
    overlay.innerHTML = '';
    overlay.hidden = false;
    const myAddr = myAddress || '';
    // Only the recorded admin (the creator) may edit the picture and description and see the invite code.
    const adminAddr = g.adminAddr || g.createdBy || (g.members[0] && g.members[0].address) || '';
    const isAdmin = !!myAddr && adminAddr === myAddr;

  const dialog = el('div', { className: 'grp-manage-dialog' });
  dialog.append(el('h3', { textContent: g.name }));

  const descLabel = el('label', { className: 'grp-field-label', textContent: t('groups.description') });
  const descInput = el('textarea', { className: 'grp-desc-input', value: g.description || '', placeholder: t('groups.descPlaceholder'), maxLength: 280 });
  descInput.disabled = !isAdmin;

  const avatarSection = el('div', { className: 'grp-avatar-section' });
  const paintPicture = () => {
    avatarSection.innerHTML = '';
    avatarSection.append(groupPictureControl({
      picture: g.avatar, seed: g.id, name: g.name, size: 64, editable: isAdmin,
      onPick: async (dataUrl) => {
        g.avatar = dataUrl;
        paintPicture();
        await saveGroup(g);
        renderGroups(); renderGroupConv();
        try { await deliverToGroup(g, encodeFrame('group-update', groupInfoUpdate(g), new Uint8Array(0))); } catch {}
        toast(t('groups.picSaved'));
      },
    }));
    if (isAdmin) avatarSection.append(el('div', { className: 'grp-pic-hint', textContent: t('groups.picHint') }));
  };
  paintPicture();
  dialog.append(avatarSection, descLabel, descInput);

  dialog.append(el('label', { className: 'grp-field-label', textContent: t('groups.membersCount', { n: g.members.length }) }));
  const memberList = el('div', { className: 'grp-member-list' });
  for (const m of g.members) {
    const row = el('div', { className: 'grp-member-row' });
    const mine = m.address === myAddr;
    const asContact = mine ? null : contactByAddress(m.address);
    row.append(el('span', { className: 'grp-member-name', textContent: mine ? t('react.you') : (asContact?.petname || m.petname) }));
    row.append(el('span', { className: 'grp-member-addr', textContent: shortAddr(m.address), title: m.address }));
    if (adminAddr === m.address) row.append(el('span', { className: 'grp-admin-badge', textContent: t('groups.admin') }));
    // Someone in the group you haven't added: one click opens Add contact with the address filled in and the group's name for them suggested.
    if (!mine && !asContact) {
      const add = el('button', { type: 'button', className: 'grp-add-contact', textContent: t('contacts.add') });
      add.onclick = () => { overlay.hidden = true; openAddContact({ address: m.address, petname: m.petname }); };
      row.append(add);
    }
    if (isAdmin && m.address !== myAddr && g.members.length > 2) {
      const rm = el('button', { type: 'button', className: 'grp-rm-btn', title: t('groups.removeMember'), textContent: '✕' });
      rm.onclick = async () => {
        if (!(await askConfirm(t('groups.removeConfirm', { name: m.petname })))) return;
        g.members = g.members.filter(x => x.address !== m.address);
        // They can't come back on their own: the code they may have kept stops working, and their address is refused until added again.
        g.removed = [...(g.removed || []).filter((a) => a !== m.address), m.address].slice(-200);
        g.joinKey = newJoinKey();
        await saveGroup(g);
        const meta = { grp: g.id, action: 'remove', removed: m.address };
        const frame = encodeFrame('group-update', meta, new Uint8Array(0));
        // The removed member is told too, so their app stops writing to the group (queued if they're offline).
        { const h = keyHolder(m.address); if (h) deliver(h, frame, { queueOnly: true }).catch(() => {}); }
        try {
          await deliverToGroup(g, frame);
          await syncRoster(g);
        } catch {}
        prunePeers();
        overlay.hidden = true; renderGroups(); renderGroupConv();
      };
      row.append(rm);
    }
    memberList.append(row);
  }
  dialog.append(memberList);

  if (isAdmin) {
    const memberAddrs = new Set(g.members.map(m => m.address));
    const candidates = contacts.filter(c => !memberAddrs.has(c.address));
    if (candidates.length) {
      const addLabel = el('label', { className: 'grp-field-label', textContent: t('groups.addMember') });
      const addSel = el('select', { className: 'grp-add-select' });
      addSel.append(el('option', { value: '', textContent: t('groups.pickContact') }));
      for (const c of candidates) addSel.append(el('option', { value: c.address, textContent: c.petname }));
      const addBtn = el('button', { type: 'button', className: 'confirm-ok', textContent: t('nav.add') });
      addBtn.onclick = async () => {
        const addr = addSel.value;
        if (!addr) return;
        const c = contacts.find(c => c.address === addr); if (!c) return;
        const existingMembers = g.members.slice();
        g.members.push({ address: c.address, petname: c.petname });
        if (g.removed) g.removed = g.removed.filter((a) => a !== c.address);
        await saveGroup(g);
        try {
          const updMeta = { grp: g.id, action: 'add', added: { address: c.address, petname: c.petname } };
          await deliverToGroup({ ...g, members: existingMembers }, encodeFrame('group-update', updMeta, new Uint8Array(0)));
          await syncRoster(g);           // the newcomer's invite, and the full list for everyone else
        } catch {}
        overlay.hidden = true; renderGroups(); renderGroupConv();
      };
      const addRow = el('div', { className: 'grp-add-row' });
      addRow.append(addSel, addBtn);
      dialog.append(addLabel, addRow);
    }
  }

  if (isAdmin) {
    const codeLabel = el('label', { className: 'grp-field-label', textContent: t('groups.inviteCode') });
    if (!g.joinKey) { g.joinKey = newJoinKey(); saveGroup(g).catch(() => {}); }
    const code = btoa(JSON.stringify({ id: g.id, name: g.name, by: myAddr, k: g.joinKey })).replace(/=+$/, '');
    const codeWrap = el('div', { className: 'grp-invite-wrap' });
    const codeBox = el('input', { className: 'grp-invite-code', readOnly: true, value: code, spellcheck: false });
    const copyIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    const okIcon   = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    const copyBtn = el('button', { type: 'button', className: 'grp-invite-copy', title: t('groups.copyCode'), innerHTML: copyIcon });
    const doCopy = async () => {
      try { await navigator.clipboard.writeText(code); }
      catch { codeBox.select(); document.execCommand('copy'); }
      copyBtn.classList.add('copied'); copyBtn.innerHTML = okIcon;
      toast(t('groups.codeCopied'));
      setTimeout(() => { copyBtn.classList.remove('copied'); copyBtn.innerHTML = copyIcon; }, 1600);
    };
    copyBtn.onclick = doCopy;
    codeBox.onclick = () => codeBox.select();
    codeWrap.append(codeBox, copyBtn);
    dialog.append(codeLabel, codeWrap);
  }

  const actions = el('div', { className: 'confirm-actions' });
  const cancel = el('button', { className: 'confirm-cancel', type: 'button', textContent: t('nav.close') });
  cancel.onclick = () => { overlay.hidden = true; };
  actions.append(cancel);
  if (isAdmin) {
    const save = el('button', { className: 'confirm-ok', type: 'button', textContent: t('nav.save') });
    save.onclick = async () => {
      g.description = descInput.value.trim().slice(0, 280);
      await saveGroup(g);
      try {
        const meta = groupInfoUpdate(g);
        await deliverToGroup(g, encodeFrame('group-update', meta, new Uint8Array(0)));
      } catch {}
      overlay.hidden = true; renderGroups(); renderGroupConv();
    };
    actions.append(save);
  }
  dialog.append(actions);

  overlay.append(dialog);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.hidden = true; };
  } catch (err) {
    console.error('openGroupManage failed:', err);
    toast(t('toast.failed'));
    const ov = document.getElementById('grp-manage-overlay');
    if (ov) ov.hidden = true;
  }
}

// The last step before erasing: typing the confirmation word, so it can't happen with a stray click.
function openEraseDialog() {
  let overlay = document.getElementById('erase-overlay');
  if (!overlay) { overlay = el('div', { id: 'erase-overlay', className: 'confirm-overlay' }); document.body.append(overlay); }
  overlay.innerHTML = ''; overlay.hidden = false;
  const word = t('erase.word');
  const dialog = el('div', { className: 'confirm-dialog erase-dialog', role: 'dialog', 'aria-modal': 'true' });
  dialog.append(el('p', { className: 'confirm-msg', textContent: t('erase.confirmTitle') }));
  const lead = el('p', { className: 'set-desc' });
  lead.append(document.createTextNode(t('erase.confirmLead', { address: shortAddr(myAddress || '') }) + ' '));
  lead.append(document.createTextNode(t('erase.typeWord') + ' '), el('b', { textContent: word }));
  dialog.append(lead);
  const input = el('input', { className: 'erase-input', type: 'text', autocomplete: 'off', spellcheck: false, 'aria-label': t('erase.typeWord') + ' ' + word });
  dialog.append(input);
  const actions = el('div', { className: 'confirm-actions' });
  const cancel = el('button', { className: 'confirm-cancel', type: 'button', textContent: t('nav.cancel') });
  const ok = el('button', { className: 'confirm-ok danger', type: 'button', textContent: t('erase.go'), disabled: true });
  const close = () => { overlay.hidden = true; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  input.oninput = () => { ok.disabled = input.value.trim().toLocaleUpperCase() !== word.toLocaleUpperCase(); };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !ok.disabled) ok.click(); };
  cancel.onclick = close;
  ok.onclick = async () => {
    ok.disabled = true; cancel.disabled = true; input.disabled = true;
    ok.textContent = t('erase.working');
    let done = false;
    try { done = await window.electron.eraseEverything({ title: t('erase.confirmTitle'), detail: t('erase.desc'), ok: t('erase.go'), cancel: t('nav.cancel') }); }
    catch { toast(t('toast.failed')); }
    if (!done) { ok.textContent = t('erase.go'); ok.disabled = false; cancel.disabled = false; input.disabled = false; }
  };
  actions.append(cancel, ok);
  dialog.append(actions);
  overlay.append(dialog);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  setTimeout(() => input.focus(), 30);
}

function openChangePinDialog() {
  let overlay = document.getElementById('changepin-overlay');
  if (!overlay) {
    overlay = el('div', { id: 'changepin-overlay', className: 'confirm-overlay' });
    document.body.append(overlay);
  }
  overlay.innerHTML = '';
  overlay.hidden = false;

  const dialog = el('div', { className: 'changepin-dialog' });
  dialog.append(el('h3', { textContent: t('settings.pinBtn') }));
  dialog.append(el('p', { className: 'set-desc', textContent: t('settings.pinDesc') }));

  const oldPin  = el('input', { type: 'password', inputMode: 'numeric', autocomplete: 'off', placeholder: t('settings.curPin'),  className: 'set-input' });
  const newPin  = el('input', { type: 'password', inputMode: 'numeric', autocomplete: 'off', placeholder: t('settings.newPin'),  className: 'set-input' });
  const newPin2 = el('input', { type: 'password', inputMode: 'numeric', autocomplete: 'off', placeholder: t('settings.repeatPin'), className: 'set-input' });
  const stack = el('div', { className: 'set-stack', style: 'max-width:none' });
  stack.append(oldPin, newPin, newPin2);
  dialog.append(stack);

  const err = el('p', { className: 'changepin-err', textContent: '' });
  dialog.append(err);

  const actions = el('div', { className: 'confirm-actions' });
  const cancel = el('button', { type: 'button', className: 'confirm-cancel', textContent: t('nav.cancel') });
  const save   = el('button', { type: 'button', className: 'confirm-ok', textContent: t('settings.pinBtn') });
  cancel.onclick = () => { overlay.hidden = true; };
  save.onclick = async () => {
    err.textContent = '';
    if (!oldPin.value) { err.textContent = t('settings.curPinNeeded'); return; }
    if (newPin.value.length < PIN_LEN) { err.textContent = t('settings.pinTooShort'); return; }
    if (newPin.value !== newPin2.value) { err.textContent = t('settings.pinMismatch'); return; }
    if (newPin.value === oldPin.value)  { err.textContent = t('settings.pinSame'); return; }
    save.disabled = cancel.disabled = true;
    save.textContent = t('settings.pinSaving');
    try {
      await changePin(oldPin.value, newPin.value);
      overlay.hidden = true;
      toast(t('settings.pinChanged'));
    } catch (e) {
      err.textContent = errorText(e);
      save.disabled = cancel.disabled = false;
      save.textContent = t('settings.pinBtn');
    }
  };
  actions.append(cancel, save);
  dialog.append(actions);

  overlay.append(dialog);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.hidden = true; };
  setTimeout(() => oldPin.focus(), 50);
}

// Settings → Security: what protects the data on this computer, in plain words.
function securityCard() {
  const vaultNames = { windows: t('sec.vault.windows'), keychain: t('sec.vault.keychain'), gnome: t('sec.vault.gnome'), kwallet: t('sec.vault.kwallet'), keyring: t('sec.vault.keyring') };
  const on = !!securityInfo;
  const card = el('div', { className: 'sec-card' + (on ? '' : ' weak') });
  const icon = el('div', { className: 'sec-icon', innerHTML: on
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' });
  const body = el('div', { className: 'sec-body' });
  body.append(el('div', { className: 'sec-title', textContent: on ? t('sec.on') : t('sec.off') }),
    el('div', { className: 'set-desc', textContent: on ? t('sec.onDesc') : t('sec.offDesc') }));
  if (on) {
    const kv = el('div', { className: 'sec-kv' });
    const passMode = securityInfo.mode === 'passphrase';
    kv.append(el('span', { textContent: t('sec.keptBy') }), el('b', { textContent: passMode ? t('sec.keptPass') : (vaultNames[securityInfo.vault] || vaultNames.keyring) }),
      el('span', { textContent: t('sec.unlockWith') }), el('b', { textContent: passMode ? t('sec.unlockPass') : t('sec.unlockPin') }));
    body.append(kv);
  }
  card.append(icon, body);
  return card;
}

// A rough strength score 0–4 for a passphrase: length first, then variety. Long and plain beats short and clever.
function passphraseScore(p) {
  if (!p) return 0;
  if (/^(.)\1+$/.test(p) || /^(?:0123456789|1234567890|abcdefghijkl|qwertyuiop)/i.test(p)) return 0;
  let score = p.length >= 20 ? 3 : p.length >= 16 ? 2 : p.length >= 12 ? 1 : 0;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  const words = p.trim().split(/[\s\-_.]+/).filter((w) => w.length >= 3).length;
  if (score && (classes >= 3 || words >= 4)) score++;
  return Math.min(4, score);
}
// Settings → Use a passphrase / Change passphrase.
// The passphrase fields, shared by Settings and the first-launch screen: the passphrase twice, a strength meter, the warning and the
// "no recovery" acknowledgement. onReady(bool) says whether it can be used.
function passphraseFields(onReady, opts = {}) {
  const min = opts.min || securityInfo?.minPassphrase || 12;
  const field = (ph) => {
    const wrap = el('div', { className: 'pass-field' });
    const input = el('input', { type: 'password', autocomplete: 'new-password', spellcheck: false, className: 'set-input', placeholder: ph });
    const show = el('button', { type: 'button', className: 'pass-show', textContent: t('sec.show') });
    show.onclick = () => { const v = input.type === 'password'; input.type = v ? 'text' : 'password'; show.textContent = v ? t('sec.hide') : t('sec.show'); };
    wrap.append(input, show);
    return [wrap, input];
  };
  const [w1, p1] = field(t('sec.newPass'));
  const meter = el('div', { className: 'pass-meter' }); for (let i = 0; i < 4; i++) meter.append(el('i'));
  const strength = el('div', { className: 'pass-strength' });
  const [w2, p2] = field(t('sec.repeatPass'));
  const warn = el('div', { className: 'pass-warn', textContent: opts.warn || t('sec.passWarn') });
  const ack = el('label', { className: 'pass-ack' });
  const cb = el('input', { type: 'checkbox' });
  ack.append(cb, el('span', { textContent: opts.ack || t('sec.passAck') }));
  const sync = () => {
    const sc = p1.value.length < min ? Math.min(passphraseScore(p1.value), 0) : passphraseScore(p1.value);
    [...meter.children].forEach((b, i) => { b.className = i < sc ? 'on s' + sc : ''; });
    strength.textContent = !p1.value ? t('sec.minChars', { n: min }) : p1.value.length < min ? t('sec.minChars', { n: min }) : t('sec.strength' + sc);
    strength.className = 'pass-strength s' + sc;
    onReady(p1.value.length >= min && sc >= 2 && p2.value === p1.value && cb.checked);
  };
  p1.oninput = p2.oninput = cb.onchange = sync;
  // Enter in the second field submits, like a form.
  return {
    nodes: [w1, meter, strength, w2, warn, ack], sync,
    value: () => p1.value,
    clear: () => { p1.value = p2.value = ''; cb.checked = false; sync(); },
    focus: () => p1.focus(),
    onEnter: (fn) => { p2.onkeydown = (e) => { if (e.key === 'Enter') fn(); }; },
  };
}

function openPassphraseDialog() {
  let overlay = document.getElementById('pass-overlay');
  if (!overlay) { overlay = el('div', { id: 'pass-overlay', className: 'confirm-overlay' }); document.body.append(overlay); }
  overlay.innerHTML = ''; overlay.hidden = false;
  const changing = securityInfo?.mode === 'passphrase';
  const dialog = el('div', { className: 'changepin-dialog pass-dialog', role: 'dialog', 'aria-modal': 'true' });
  dialog.append(el('h3', { textContent: changing ? t('sec.changePassTitle') : t('sec.passTitle') }), el('p', { className: 'set-desc', textContent: t('sec.passLead') }));
  // The one in use now comes first: the passphrase when changing it (checked by the desktop app), the PIN when leaving it (checked here).
  const cur = currentSecretField(changing ? 'pass' : 'pin');
  const err = el('p', { className: 'changepin-err' });
  const actions = el('div', { className: 'confirm-actions' });
  const cancel = el('button', { type: 'button', className: 'confirm-cancel', textContent: t('nav.cancel') });
  const save = el('button', { type: 'button', className: 'confirm-ok', textContent: changing ? t('sec.savePass') : t('sec.usePassBtn'), disabled: true });
  let ready = false;
  const sync = () => { save.disabled = !ready || !cur.value(); };
  const pf = passphraseFields((r) => { ready = r; sync(); });
  cur.onInput(() => { cur.error(''); sync(); });
  pf.sync();
  cancel.onclick = () => { overlay.hidden = true; };
  save.onclick = async () => {
    if (save.disabled) return;
    err.textContent = ''; cur.error('');
    save.disabled = cancel.disabled = true;
    save.textContent = t('sec.saving');
    const again = () => { cancel.disabled = false; save.textContent = changing ? t('sec.savePass') : t('sec.usePassBtn'); sync(); };
    if (!changing) {
      try { await verifyKey(await keyForPin(cur.value(), localStorage.getItem(PIN_SALT_KEY))); }
      catch { cur.error(t('pin.incorrect')); cur.clear(); again(); return; }
    }
    try {
      const r = await window.electron.setPassphrase(pf.value(), changing ? cur.value() : undefined);
      if (r && (r.error === 'wrong' || r.error === 'locked')) {
        cur.error(r.error === 'locked' ? t('pin.tooMany', { n: r.wait || 30 }) : t('backup.passCheckWrong')); cur.clear(); again(); return;
      }
      if (!r || !r.ok) throw new Error(r?.error || 'failed');
      securityInfo.mode = 'passphrase';
      await storageToDeviceOnly();
      pf.clear(); cur.clear();
      overlay.hidden = true;
      toast(changing ? t('sec.passChanged') : t('sec.passOn'), 6000);
    } catch {
      err.textContent = t('toast.failed');
      again();
    }
  };
  pf.onEnter(() => save.onclick());
  actions.append(cancel, save);
  dialog.append(...cur.nodes, el('hr', { className: 'pass-sep' }), ...pf.nodes, err, actions);
  overlay.append(dialog);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.hidden = true; };
  setTimeout(() => cur.focus(), 50);
}
// The passphrase or PIN in use now, asked before either is changed: a label, the field (with Show for a passphrase) and its own error line.
function currentSecretField(kind) {
  const label = el('label', { className: 'grp-field-label', textContent: kind === 'pin' ? t('settings.curPin') : t('sec.curPass') });
  const input = kind === 'pin'
    ? el('input', { type: 'password', inputMode: 'numeric', autocomplete: 'off', maxLength: PIN_LEN, className: 'set-input cur-secret', 'aria-label': t('settings.curPin') })
    : el('input', { type: 'password', autocomplete: 'off', spellcheck: false, className: 'set-input cur-secret', 'aria-label': t('sec.curPass') });
  const err = el('p', { className: 'changepin-err cur-secret-err' });
  let field = input;
  if (kind !== 'pin') {
    field = el('div', { className: 'pass-field' });
    const show = el('button', { type: 'button', className: 'pass-show', textContent: t('sec.show') });
    show.onclick = () => { const v = input.type === 'password'; input.type = v ? 'text' : 'password'; show.textContent = v ? t('sec.hide') : t('sec.show'); };
    field.append(input, show);
  }
  return {
    nodes: [label, field, err],
    value: () => input.value,
    clear: () => { input.value = ''; },
    focus: () => input.focus(),
    error: (text) => { err.textContent = text; },
    onInput: (fn) => { input.addEventListener('input', () => { if (kind === 'pin') input.value = input.value.replace(/\D/g, '').slice(0, PIN_LEN); fn(); }); },
  };
}
// Settings → Use the PIN instead (leaving passphrase mode): choose a PIN, then the key goes back to the system's vault.
function openUsePinDialog() {
  let overlay = document.getElementById('usepin-overlay');
  if (!overlay) { overlay = el('div', { id: 'usepin-overlay', className: 'confirm-overlay' }); document.body.append(overlay); }
  overlay.innerHTML = ''; overlay.hidden = false;
  const dialog = el('div', { className: 'changepin-dialog', role: 'dialog', 'aria-modal': 'true' });
  dialog.append(el('h3', { textContent: t('sec.usePinTitle') }), el('p', { className: 'set-desc', textContent: t('sec.usePinLead') }));
  const cur = currentSecretField('pass');           // the passphrase in use now, checked by the desktop app before anything changes
  cur.onInput(() => cur.error(''));
  const a = el('input', { type: 'password', inputMode: 'numeric', autocomplete: 'off', placeholder: t('settings.newPin'), className: 'set-input', maxLength: PIN_LEN });
  const b = el('input', { type: 'password', inputMode: 'numeric', autocomplete: 'off', placeholder: t('settings.repeatPin'), className: 'set-input', maxLength: PIN_LEN });
  const stack = el('div', { className: 'set-stack', style: 'max-width:none' }); stack.append(a, b);
  const err = el('p', { className: 'changepin-err' });
  const actions = el('div', { className: 'confirm-actions' });
  const cancel = el('button', { type: 'button', className: 'confirm-cancel', textContent: t('nav.cancel') });
  const save = el('button', { type: 'button', className: 'confirm-ok', textContent: t('sec.usePin') });
  cancel.onclick = () => { overlay.hidden = true; };
  save.onclick = async () => {
    err.textContent = '';
    if (!/^\d+$/.test(a.value) || a.value.length !== PIN_LEN) { err.textContent = t('settings.pinTooShort'); return; }
    if (a.value !== b.value) { err.textContent = t('settings.pinMismatch'); return; }
    if (!cur.value()) { cur.error(t('backup.passCheckWrong')); cur.focus(); return; }
    save.disabled = cancel.disabled = true;
    // Checked before the storage is re-keyed to the new PIN, and again by the desktop app when the key moves to the vault.
    const ok = await window.electron.verifyPassphrase(cur.value()).catch(() => null);
    if (!ok || !ok.ok) {
      cur.error(ok && ok.error === 'locked' ? t('pin.tooMany', { n: ok.wait || 30 }) : t('backup.passCheckWrong'));
      cur.clear(); save.disabled = cancel.disabled = false; return;
    }
    try {
      await setNewPin(pinKey, a.value);
      const r = await window.electron.useOsVault(cur.value());
      if (!r || !r.ok) throw new Error(r?.error || 'failed');
      securityInfo.mode = 'os';
      overlay.hidden = true;
      toast(t('sec.pinOn'), 6000);
    } catch { err.textContent = t('toast.failed'); save.disabled = cancel.disabled = false; }
  };
  actions.append(cancel, save);
  dialog.append(...cur.nodes, el('hr', { className: 'pass-sep' }), stack, err, actions);
  overlay.append(dialog);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.hidden = true; };
  setTimeout(() => cur.focus(), 50);
}

// Settings → Storage: what this computer keeps, per chat, and clearing media to make room (the text stays).
function threadLabel(key) {
  if (key.startsWith('grp:')) return groupById(key.slice(4))?.name || t('groups.title');
  return contactByAddress(key)?.petname || (requests[key] ? shortAddr(key) : shortAddr(key));
}
async function paintStorage(box) {
  box.innerHTML = '';
  box.append(el('div', { className: 'set-desc', textContent: t('storage.desc') }));
  const media = await mediaList(null).catch(() => []);
  const perThread = new Map();
  for (const m of media) {
    const key = prefs.names.map[m.thread]; if (!key) continue;
    const x = perThread.get(key) || { bytes: 0, media: 0 }; x.bytes += m.size || 0; x.media++; perThread.set(key, x);
  }
  let msgBytes = 0;
  for (const k of fields.keys()) msgBytes += (fields.get(k) || '').length;
  for (const [addr, t] of threadCache.entries()) { const x = perThread.get(addr) || { bytes: 0, media: 0 }; x.count = t.length; x.bytes += (fields.get(LS.thread(addr)) || '').length; perThread.set(addr, x); }
  const mediaBytes = media.reduce((n, m) => n + (m.size || 0), 0);
  const est = await checkFreeSpace();
  const free = est && est.quota ? Math.max(0, est.quota - est.usage) : null;
  const total = msgBytes + mediaBytes;
  box.append(el('div', { className: 'storage-total', textContent: formatBytes(total) }));
  const bar = el('div', { className: 'storage-bar' });
  const scale = total + (free || 0) || 1;
  bar.append(el('i', { className: 'msgs', style: `width:${Math.max(total ? 1 : 0, msgBytes / scale * 100)}%` }), el('i', { className: 'media', style: `width:${mediaBytes / scale * 100}%` }));
  const legend = el('div', { className: 'storage-legend' });
  legend.append(el('span', { className: 'msgs', textContent: t('storage.messages', { size: formatBytes(msgBytes) }) }),
    el('span', { className: 'media', textContent: t('storage.media', { size: formatBytes(mediaBytes) }) }));
  if (free != null) legend.append(el('span', { className: 'free', textContent: t('storage.free', { size: formatBytes(free) }) }));
  box.append(bar, legend);

  const old = el('div', { className: 'set-opt-row' });
  const oldText = el('div', { style: 'flex:1' });
  oldText.append(el('div', { className: 'set-row-label', textContent: t('storage.oldTitle') }), el('div', { className: 'set-desc', textContent: t('storage.oldDesc') }));
  const oldBtn = el('button', { type: 'button', className: 'set-pill', textContent: t('storage.oldBtn') });
  oldBtn.onclick = async () => {
    const cutoff = Date.now() - 30 * 86400000;
    const list = media.filter((m) => m.ts < cutoff);
    if (!list.length) { toast(t('storage.nothingOld')); return; }
    const size = formatBytes(list.reduce((n, m) => n + (m.size || 0), 0));
    if (!(await askConfirm(t('storage.oldConfirm', { n: list.length, size }), t('storage.clear')))) return;
    const r = await clearMedia({ olderThan: cutoff });
    toast(t('storage.clearedToast', { size: formatBytes(r.bytes) }));
    paintStorage(box);
  };
  old.append(oldText, oldBtn);
  box.append(old);

  const rows = [...perThread.entries()].filter(([, x]) => x.bytes > 0).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8);
  const list = el('div', { className: 'storage-list' });
  for (const [key, x] of rows) {
    const row = el('div', { className: 'storage-row' });
    const name = threadLabel(key);
    const av = key.startsWith('grp:') ? renderAvatarEl(key.slice(4), groupById(key.slice(4))?.avatar || null, 30, 'sm', name) : renderAvatarEl(key, contactByAddress(key)?.avatar || null, 30, 'sm', name);
    const txt = el('div', { className: 'storage-row-text' });
    txt.append(el('b', { textContent: name }), el('small', { textContent: t('storage.rowInfo', { size: formatBytes(x.bytes), n: x.count || 0 }) }));
    row.append(av, txt);
    if (x.media) {
      const b = el('button', { type: 'button', className: 'set-pill', textContent: t('storage.clearChat') });
      b.onclick = async () => {
        if (!(await askConfirm(t('storage.chatConfirm', { name }), t('storage.clear')))) return;
        const r = await clearMedia({ thread: key });
        toast(t('storage.clearedToast', { size: formatBytes(r.bytes) }));
        paintStorage(box);
      };
      row.append(b);
    }
    list.append(row);
  }
  if (rows.length) box.append(list, el('div', { className: 'set-desc', style: 'margin-top:8px', textContent: t('storage.clearNote') }));
}

// ---- Backup and restore (public/backup.js, docs/BACKUP-FORMAT.md) ----
const RESTORED_FLAG = 'anyonechat.restored';

async function getJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }

// Settings → Backup → Create backup: the PIN first (when there is one), then a passphrase for the file, then it is saved.
function openCreateBackupDialog() {
  let overlay = document.getElementById('backup-overlay');
  if (!overlay) { overlay = el('div', { id: 'backup-overlay', className: 'confirm-overlay' }); document.body.append(overlay); }
  overlay.innerHTML = ''; overlay.hidden = false;
  const dialog = el('div', { className: 'changepin-dialog pass-dialog backup-dialog', role: 'dialog', 'aria-modal': 'true' });
  overlay.append(dialog);
  const close = () => { overlay.hidden = true; overlay.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  const hasPin = storageKdf() !== 'device' && !!localStorage.getItem(PIN_SALT_KEY);
  // Passphrase mode has no PIN in the window: the passphrase that opens AnonChat is checked by the desktop app instead.
  const needsPass = !hasPin && storageKdf() === 'device' && !!window.electron?.verifyPassphrase;
  const steps = (n) => { const b = el('div', { className: 'backup-steps' }); for (let i = 0; i < 2; i++) b.append(el('i', { className: i < n ? 'on' : '' })); return b; };

  function askPin() {
    dialog.innerHTML = '';
    dialog.append(el('h3', { textContent: t('backup.createTitle') }), steps(1), el('p', { className: 'set-desc', textContent: t('backup.pinLead') }));
    const input = el('input', { type: 'password', inputMode: 'numeric', autocomplete: 'off', maxLength: PIN_LEN, className: 'set-input backup-pin', placeholder: t('backup.pinPlaceholder'), 'aria-label': t('backup.pinPlaceholder') });
    const err = el('p', { className: 'changepin-err' });
    const actions = el('div', { className: 'confirm-actions' });
    const cancel = el('button', { type: 'button', className: 'confirm-cancel', textContent: t('nav.cancel') });
    const go = el('button', { type: 'button', className: 'confirm-ok', textContent: t('backup.continue'), disabled: true });
    input.oninput = () => { input.value = input.value.replace(/\D/g, '').slice(0, PIN_LEN); go.disabled = input.value.length !== PIN_LEN; err.textContent = ''; };
    input.onkeydown = (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); };
    cancel.onclick = close;
    go.onclick = async () => {
      go.disabled = true;
      try { await verifyKey(await keyForPin(input.value, localStorage.getItem(PIN_SALT_KEY))); input.value = ''; askPassphrase(); }
      catch { err.textContent = t('pin.incorrect'); input.value = ''; input.focus(); }
    };
    actions.append(cancel, go);
    dialog.append(input, err, actions);
    setTimeout(() => input.focus(), 30);
  }

  function askOwnPassphrase() {
    dialog.innerHTML = '';
    dialog.append(el('h3', { textContent: t('backup.createTitle') }), steps(1), el('p', { className: 'set-desc', textContent: t('backup.passCheckLead') }));
    const wrap = el('div', { className: 'pass-field' });
    const input = el('input', { type: 'password', autocomplete: 'off', spellcheck: false, className: 'set-input backup-own-pass', placeholder: t('sec.pass'), 'aria-label': t('sec.pass') });
    const show = el('button', { type: 'button', className: 'pass-show', textContent: t('sec.show') });
    show.onclick = () => { const v = input.type === 'password'; input.type = v ? 'text' : 'password'; show.textContent = v ? t('sec.hide') : t('sec.show'); };
    wrap.append(input, show);
    const err = el('p', { className: 'changepin-err' });
    const actions = el('div', { className: 'confirm-actions' });
    const cancel = el('button', { type: 'button', className: 'confirm-cancel', textContent: t('nav.cancel') });
    const go = el('button', { type: 'button', className: 'confirm-ok', textContent: t('backup.continue'), disabled: true });
    input.oninput = () => { go.disabled = !input.value; err.textContent = ''; };
    input.onkeydown = (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); };
    cancel.onclick = close;
    go.onclick = async () => {
      go.disabled = true;
      let r = null;
      try { r = await window.electron.verifyPassphrase(input.value); } catch {}
      if (r && r.ok) { input.value = ''; askPassphrase(); return; }
      err.textContent = r && r.error === 'locked' ? t('pin.tooMany', { n: r.wait || 30 }) : t('backup.passCheckWrong');
      input.value = ''; input.focus();
    };
    actions.append(cancel, go);
    dialog.append(wrap, err, actions);
    setTimeout(() => input.focus(), 30);
  }

  function askPassphrase() {
    dialog.innerHTML = '';
    dialog.append(el('h3', { textContent: t('backup.createTitle') }), steps(2));
    const inc = el('ul', { className: 'backup-includes' });
    const yes = (text) => el('li', { className: 'y', textContent: text });
    inc.append(yes(t('backup.incAddress', { address: shortAddr(myAddress || '') })), yes(t('backup.incIdentity')), yes(t('backup.incLists')),
      el('li', { className: 'n', textContent: t('backup.incNot') }));
    dialog.append(inc, el('p', { className: 'backup-sub', textContent: t('backup.passLead') }));
    const err = el('p', { className: 'changepin-err' });
    const actions = el('div', { className: 'confirm-actions' });
    const cancel = el('button', { type: 'button', className: 'confirm-cancel', textContent: t('nav.cancel') });
    const save = el('button', { type: 'button', className: 'confirm-ok', textContent: t('backup.save'), disabled: true });
    const pf = passphraseFields((ready) => { save.disabled = !ready; }, { min: Backup.MIN_PASSPHRASE, warn: t('backup.passWarn'), ack: t('backup.passAck') });
    cancel.onclick = close;
    save.onclick = async () => {
      if (save.disabled) return;
      save.disabled = cancel.disabled = true; save.textContent = t('backup.saving'); err.textContent = '';
      try {
        const [hs, contactsList, peersList, groupsList, blocked, settings] = await Promise.all([
          getJson('/api/backup/hs'), getJson('/api/contacts'), getJson('/api/peers'), getJson('/api/groups'), getJson('/api/blocked'), getJson('/api/settings')]);
        if (!myAddress || hs.hostname !== myAddress) throw new Error('address not ready');
        const payload = Backup.buildPayload({
          address: hs.hostname, hs,
          identity: { ikPriv: ikPrivJwk, ikPub, spk, ikSig },
          contacts: contactsList, peers: peersList, groups: groupsList, blocked, settings,
          profile: { avatar: prefs.avatar || null, bio: prefs.bio || null },
          prefs: { pinned: prefs.pinned || [], verified: prefs.verified || {}, ttl: prefs.ttl || {}, offlineTtl: prefs.offlineTtl || {} },
        });
        const bytes = await Backup.encryptBackup(payload, pf.value());
        pf.clear();
        const name = Backup.backupFileName();
        let where = name;
        if (window.electron?.saveFile) where = await window.electron.saveFile(name, bytes);
        else {
          const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
          const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        }
        close();
        toast(t('backup.saved', { path: where }), 8000);
      } catch (e) {
        console.error('[backup] failed', e && e.message);
        err.textContent = t('backup.failed');
        save.textContent = t('backup.save'); cancel.disabled = false; pf.sync();
      }
    };
    pf.onEnter(() => save.click());
    actions.append(cancel, save);
    dialog.append(...pf.nodes, err, actions);
    pf.sync();
    setTimeout(() => pf.focus(), 30);
  }

  if (hasPin) askPin(); else if (needsPass) askOwnPassphrase(); else askPassphrase();
}

// Restore, step 1 (both ways in): choose the file, type its passphrase; nothing changes yet, the file is only opened and checked.
// fresh: on the welcome screen of a new install; resolves with the opened backup (or null), and the restore finishes after a PIN or
// passphrase has been chosen. Otherwise (Settings): step 2 confirms, then the desktop app erases this computer and restarts into step 1.
function openRestoreDialog({ fresh = false, file = null } = {}) {
  return new Promise((resolve) => {
    let overlay = document.getElementById('restore-overlay');
    if (!overlay) { overlay = el('div', { id: 'restore-overlay', className: 'confirm-overlay restore-overlay' }); document.body.append(overlay); }
    overlay.innerHTML = ''; overlay.hidden = false;
    const dialog = el('div', { className: 'changepin-dialog pass-dialog backup-dialog', role: 'dialog', 'aria-modal': 'true' });
    overlay.append(dialog);
    let done = false;
    const finish = (v) => { if (done) return; done = true; overlay.hidden = true; overlay.innerHTML = ''; document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape' && !busy) finish(null); };
    document.addEventListener('keydown', onKey);
    overlay.onclick = (e) => { if (e.target === overlay && !busy) finish(null); };
    let busy = false;
    let chosen = file;            // { name, data: Uint8Array, path }
    const steps = (n) => { const b = el('div', { className: 'backup-steps' }); for (let i = 0; i < (fresh ? 1 : 2); i++) b.append(el('i', { className: i < n ? 'on' : '' })); return b; };

    function stepOne() {
      dialog.innerHTML = '';
      dialog.append(el('h3', { textContent: t('backup.restoreTitle') }), steps(1));
      const picker = el('input', { type: 'file', accept: Backup.FILE_EXT + ',application/json', hidden: true });
      const fileRow = el('button', { type: 'button', className: 'backup-file', innerHTML: BACKUP_FILE_ICON });
      const fileName = el('span', { textContent: chosen ? chosen.name : t('backup.chooseFile') });
      fileRow.append(fileName);
      fileRow.onclick = () => picker.click();
      picker.onchange = async () => {
        const f = picker.files && picker.files[0];
        if (!f) return;
        if (f.size > Backup.MAX_FILE_BYTES) { err.textContent = t('backup.err.notBackup'); return; }
        chosen = { name: f.name, data: new Uint8Array(await f.arrayBuffer()) };
        fileName.textContent = f.name; err.textContent = ''; sync(); pass.focus();
      };
      const wrap = el('div', { className: 'pass-field' });
      const pass = el('input', { type: 'password', autocomplete: 'off', spellcheck: false, className: 'set-input', placeholder: t('backup.passPlaceholder'), 'aria-label': t('backup.passPlaceholder') });
      const show = el('button', { type: 'button', className: 'pass-show', textContent: t('sec.show') });
      show.onclick = () => { const v = pass.type === 'password'; pass.type = v ? 'text' : 'password'; show.textContent = v ? t('sec.hide') : t('sec.show'); };
      wrap.append(pass, show);
      const err = el('p', { className: 'changepin-err' });
      const info = el('div', { className: 'backup-opened', hidden: true });
      const actions = el('div', { className: 'confirm-actions' });
      const cancel = el('button', { type: 'button', className: 'confirm-cancel', textContent: t('nav.cancel') });
      const go = el('button', { type: 'button', className: 'confirm-ok', textContent: t('backup.open'), disabled: true });
      let opened = null;
      const sync = () => { go.disabled = busy || !chosen || (!opened && !pass.value); };
      pass.oninput = () => { opened = null; info.hidden = true; go.textContent = t('backup.open'); err.textContent = ''; sync(); };
      pass.onkeydown = (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); };
      cancel.onclick = () => finish(null);
      go.onclick = async () => {
        if (opened) { if (fresh) finish(opened); else stepTwo(opened); return; }
        busy = true; sync(); go.textContent = t('backup.opening'); err.textContent = '';
        try {
          opened = await Backup.decryptBackup(chosen.data, pass.value);
          pass.value = '';
          info.innerHTML = '';
          info.append(el('div', { className: 'ok', textContent: '✓ ' + t('backup.openedAddr', { address: shortAddr(opened.address) }) }),
            el('div', { textContent: t('backup.openedInfo', { contacts: opened.contacts.length, groups: opened.groups.length, date: new Date(opened.createdAt || Date.now()).toLocaleDateString(getLang()) }) }));
          if (fresh) info.append(el('div', { className: 'muted', textContent: t('backup.freshNext') }));
          info.hidden = false;
          go.textContent = t('backup.continue');
        } catch (e) {
          const code = { not_backup: 'backup.err.notBackup', too_new: 'backup.err.tooNew', wrong_passphrase: 'backup.err.wrongPass', invalid: 'backup.err.invalid' }[e && e.code] || 'backup.err.invalid';
          err.textContent = t(code);
          go.textContent = t('backup.open');
        }
        busy = false; sync();
      };
      actions.append(cancel, go);
      dialog.append(fileRow, picker, wrap, info, err, actions);
      sync();
      setTimeout(() => (chosen ? pass : fileRow).focus(), 30);
    }

    function stepTwo(opened) {
      dialog.innerHTML = '';
      dialog.append(el('h3', { textContent: t('backup.replaceTitle') }), steps(2));
      dialog.append(el('div', { className: 'backup-danger', textContent: t('backup.replaceLead', { current: shortAddr(myAddress || ''), restored: shortAddr(opened.address) }) }));
      dialog.append(el('div', { className: 'backup-warn', textContent: t('backup.oneComputer') }));
      dialog.append(el('p', { className: 'set-desc', textContent: t('backup.restartNote') }));
      const ack = el('label', { className: 'pass-ack' });
      const cb = el('input', { type: 'checkbox' });
      ack.append(cb, el('span', { textContent: t('backup.replaceAck') }));
      const word = t('backup.word');
      const lead = el('p', { className: 'set-desc' });
      lead.append(document.createTextNode(t('erase.typeWord') + ' '), el('b', { textContent: word }));
      const input = el('input', { className: 'erase-input', type: 'text', autocomplete: 'off', spellcheck: false, 'aria-label': t('erase.typeWord') + ' ' + word });
      const err = el('p', { className: 'changepin-err' });
      const actions = el('div', { className: 'confirm-actions' });
      const cancel = el('button', { type: 'button', className: 'confirm-cancel', textContent: t('nav.cancel') });
      const go = el('button', { type: 'button', className: 'confirm-ok danger', textContent: t('backup.go'), disabled: true });
      const sync = () => { go.disabled = busy || !cb.checked || input.value.trim().toLocaleUpperCase() !== word.toLocaleUpperCase(); };
      cb.onchange = input.oninput = sync;
      input.onkeydown = (e) => { if (e.key === 'Enter' && !go.disabled) go.click(); };
      cancel.onclick = () => finish(null);
      go.onclick = async () => {
        busy = true; sync(); cancel.disabled = true; go.textContent = t('backup.working'); err.textContent = '';
        let r = null;
        try { r = await window.electron.eraseForRestore(chosen.data, { title: t('backup.replaceTitle'), detail: t('backup.nativeDetail'), ok: t('backup.go'), cancel: t('nav.cancel') }); }
        catch { r = { error: 'failed' }; }
        if (r && r.ok) return;                       // the app is closing and restarting
        busy = false; cancel.disabled = false; go.textContent = t('backup.go'); sync();
        if (r && r.error === 'file') err.textContent = t('backup.err.file');
        else if (!r || r.error !== 'cancelled') err.textContent = t('toast.failed');
      };
      actions.append(cancel, go);
      dialog.append(ack, lead, input, err, actions);
      setTimeout(() => cb.focus(), 30);
    }

    stepOne();
  });
}

// A backup opened on the welcome screen, after the PIN or passphrase was chosen: the keys go into this window's (now protected)
// storage, the lists and the hidden-service key to the backend, and the app restarts so the network publishes the restored address.
async function finishRestore(p) {
  const screen = el('div', { className: 'welcome-overlay restore-finish' });
  const msg = el('p', { className: 'welcome-p', textContent: t('backup.finishing') });
  screen.append(el('div', { className: 'welcome-card' }, el('img', { className: 'welcome-mark', src: '/app-icon.png', alt: '', width: 64, height: 64 }), msg));
  document.body.append(screen);
  try {
    ikPrivJwk = p.identity.ikPriv; ikPub = p.identity.ikPub; spk = p.identity.spk; ikSig = p.identity.ikSig;
    const pr = p.prefs || {};
    prefs.avatar = p.profile?.avatar || null; prefs.bio = p.profile?.bio || null;
    if (Array.isArray(pr.pinned)) prefs.pinned = pr.pinned.filter((x) => typeof x === 'string');
    for (const k of ['verified', 'ttl', 'offlineTtl']) if (pr[k] && typeof pr[k] === 'object' && !Array.isArray(pr[k])) prefs[k] = pr[k];
    savePrefs();
    await pinSaveKeys(pinKey);                 // always the restored keys, even if something saved fresh ones earlier
    await ensureIdentity();
    const r = await fetch('/api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hs: p.hs, contacts: p.contacts, peers: p.peers, groups: p.groups, blocked: p.blocked, settings: p.settings }) });
    if (!r.ok) throw new Error('restore ' + r.status);
    localStorage.setItem(RESTORED_FLAG, '1');
    await Promise.allSettled([...persistQueues.values()]);
    msg.textContent = t('backup.restarting');
    pendingRestore = null;
    await window.electron.relaunch();
  } catch (e) {
    console.error('[restore] could not finish', e && e.message);
    msg.textContent = t('backup.finishFailed');
  }
}

// After the restart that ends a restore: every contact and group member gets a new session from us (their app accepts it from our
// pinned identity key), so both sides can write again at once.
function resyncAfterRestore() {
  localStorage.removeItem(RESTORED_FLAG);
  const seen = new Set();
  for (const h of [...contacts, ...peers]) { if (seen.has(h.address)) continue; seen.add(h.address); offerNewSession(h.address, true); }
  // The member lists came from the backup: anyone who joined or left since (or while this app was being restored) is missing from them.
  // Each group's admin is asked for the current list, a moment after the new sessions above have gone out.
  setTimeout(() => {
    for (const g of groups) {
      const admin = g.adminAddr || g.createdBy || (g.members[0] && g.members[0].address);
      if (!admin || admin === myAddress || g.removedMe) continue;
      const holder = keyHolder(admin);
      if (holder) deliver(holder, encodeFrame('group-update', { grp: g.id, action: 'roster' }, new Uint8Array(0))).catch(() => {});
    }
  }, 3000);
  toast(t('backup.restoredToast'), 8000);
}

function openSettingsDialog(focus) {
  let overlay = document.getElementById('settings-overlay');
  if (!overlay) {
    overlay = el('div', { id: 'settings-overlay', className: 'confirm-overlay' });
    document.body.append(overlay);
  }
  overlay.innerHTML = '';
  overlay.hidden = false;

  const dialog = el('div', { className: 'settings-dialog' });
  dialog.append(el('h3', { textContent: t('settings.title') }));

  dialog.append(el('h4', { className: 'set-title', textContent: t('sec.title') }));
  dialog.append(securityCard());
  const secRow = (label, desc, btnText, onClick) => {
    const row = el('div', { className: 'set-opt-row' });
    const text = el('div', { style: 'flex:1' });
    text.append(el('div', { className: 'set-row-label', textContent: label }), el('div', { className: 'set-desc', textContent: desc }));
    const b = el('button', { type: 'button', className: 'set-pill', textContent: btnText });
    b.onclick = () => { overlay.hidden = true; onClick(); };
    row.append(text, b);
    dialog.append(row);
  };
  const passMode = securityInfo?.mode === 'passphrase';
  if (!passMode) secRow(t('sec.pin'), t('sec.pinDesc'), t('settings.pinBtn'), () => openChangePinDialog());
  if (securityInfo && !passMode) secRow(t('sec.pass'), t('sec.passDesc'), t('sec.usePass'), () => openPassphraseDialog());
  if (passMode) {
    secRow(t('sec.pass'), t('sec.passOnDesc'), t('sec.changePass'), () => openPassphraseDialog());
    if (securityInfo.vault) secRow(t('sec.pin'), t('sec.backToPinDesc'), t('sec.usePin'), () => openUsePinDialog());
  }

  dialog.append(el('h4', { className: 'set-title', style: 'margin-top:24px', textContent: t('settings.appearance') }));

  const themeRow = el('div', { className: 'set-opt-row' });
  themeRow.append(el('span', { className: 'set-row-label', textContent: t('settings.theme') }));
  const isLight = () => document.documentElement.classList.contains('light');
  const themeBtn = el('button', { type: 'button', className: 'set-pill' });
  const syncThemeBtn = () => { themeBtn.textContent = isLight() ? (t('theme.light')) : (t('theme.dark')); };
  syncThemeBtn();
  themeBtn.onclick = () => {
    const light = document.documentElement.classList.toggle('light');
    localStorage.setItem('anyonechat.theme', light ? 'light' : 'dark');
    syncThemeBtn();
  };
  themeRow.append(themeBtn);
  dialog.append(themeRow);

  const sizeRow = el('div', { className: 'set-opt-row' });
  sizeRow.append(el('span', { className: 'set-row-label', textContent: t('settings.chatSize') }));
  const sizeSel = el('select', { className: 'set-select', 'aria-label': t('settings.chatSize') });
  const SIZE_LABELS = {
    small:  t('size.small'),
    medium: t('size.medium'),
    large:  t('size.large'),
    xlarge: t('size.xlarge'),
  };
  for (const name of CHATSIZE_OPTIONS) {
    const opt = el('option', { value: name, textContent: SIZE_LABELS[name] });
    if (getChatSize() === name) opt.selected = true;
    sizeSel.append(opt);
  }
  sizeSel.onchange = () => {
    localStorage.setItem('anyonechat.chatsize', sizeSel.value);
    applyChatSize(sizeSel.value);
  };
  sizeRow.append(sizeSel);
  dialog.append(sizeRow);

  const clockRow = el('div', { className: 'set-opt-row' });
  clockRow.append(el('span', { className: 'set-row-label', textContent: t('settings.clock') }));
  const clockBtn = el('button', { type: 'button', className: 'set-pill' });
  const syncClockBtn = () => { clockBtn.textContent = getClockFormat() === '24' ? (t('clock.24h')) : (t('clock.12h')); };
  syncClockBtn();
  clockBtn.onclick = () => {
    const next = getClockFormat() === '24' ? '12' : '24';
    localStorage.setItem('anyonechat.clockFormat', next);
    syncClockBtn();
    renderConversation();
  };
  clockRow.append(clockBtn);
  dialog.append(clockRow);

  const langRow = el('div', { className: 'set-opt-row' });
  langRow.append(el('span', { className: 'set-row-label', textContent: t('settings.language') }));
  const langSel = el('select', { className: 'set-select', 'aria-label': t('settings.language') });
  for (const { code, label } of LANGS) {
    const opt = el('option', { value: code, textContent: label });
    if (code === getLang()) opt.selected = true;
    langSel.append(opt);
  }
  langSel.onchange = () => {
    setLang(langSel.value);
    applyI18n();
    renderIdentityCard(); renderContacts(); renderConversation();
    if (typeof initLang === 'function') initLang();
    openSettingsDialog();
  };
  langRow.append(langSel);
  dialog.append(langRow);

  // Notifications: on by default, showing only the name. The browser asks for permission when they are switched on here.
  {
    dialog.append(el('h4', { className: 'set-title', style: 'margin-top:24px', textContent: t('settings.notifications') }));
    const row = el('div', { className: 'set-opt-row' });
    const label = el('div', { style: 'flex:1' });
    label.append(el('div', { className: 'set-row-label', textContent: t('settings.desktopNotif') }), el('div', { className: 'set-desc', textContent: t('settings.desktopNotifDesc') }));
    const toggle = el('button', { type: 'button', className: 'set-toggle', id: 'notif-toggle' });
    const showRow = el('div', { className: 'set-opt-row' });
    const showLabel = el('div', { style: 'flex:1' });
    showLabel.append(el('div', { className: 'set-row-label', textContent: t('settings.notifShow') }), el('div', { className: 'set-desc', textContent: t('settings.notifShowDesc') }));
    const sel = el('select', { className: 'set-select', id: 'notif-show', 'aria-label': t('settings.notifShow') });
    for (const v of NOTIFY_SHOW) sel.append(el('option', { value: v, textContent: t('notif.show.' + v) }));
    sel.value = notifyShow();
    sel.onchange = () => { try { localStorage.setItem('anyonechat.notifyShow', sel.value); } catch {} };
    const sync = () => {
      const on = notifyOn();
      toggle.textContent = on ? t('toggle.on') : t('toggle.off');
      toggle.className = 'set-toggle' + (on ? ' on' : '');
      sel.disabled = !on;
    };
    toggle.onclick = async () => {
      const on = !notifyOn();
      try { localStorage.setItem('anyonechat.notify', on ? 'on' : 'off'); } catch {}
      if (on && !window.electron?.notify && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
        try { await Notification.requestPermission(); } catch {}
      }
      sync();
    };
    sync();
    row.append(label, toggle); showRow.append(showLabel, sel);
    dialog.append(row, showRow);
  }

  // Both toggles default to OFF: a privacy-first app shouldn't broadcast presence or read state without an explicit opt-in.
  dialog.append(el('h4', { className: 'set-title', style: 'margin-top:24px', textContent: t('settings.privacy') }));

  const buildToggleRow = (field, labelKey, descKey, onSaved) => {
    const row = el('div', { className: 'set-opt-row' });
    const label = el('div', { style: 'flex:1' });
    label.append(
      el('div', { className: 'set-row-label', textContent: t(labelKey) }),
      el('div', { className: 'set-desc',      textContent: t(descKey) }),
    );
    const toggle = el('button', { type: 'button', className: 'set-toggle' });
    let enabled = false;
    const sync = () => {
      toggle.textContent = enabled ? (t('toggle.on')) : (t('toggle.off'));
      toggle.className   = 'set-toggle' + (enabled ? ' on' : '');
    };
    fetch('/api/settings').then(r => r.json()).then(s => { enabled = !!s[field]; sync(); }).catch(sync);
    toggle.onclick = async () => {
      enabled = !enabled;
      sync();
      try {
        await fetch('/api/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [field]: enabled }),
        });
        if (onSaved) onSaved(enabled);
      } catch {
        enabled = !enabled; sync();
      }
    };
    row.append(label, toggle);
    dialog.append(row);
  };

  buildToggleRow('readReceipts', 'settings.readReceipts', 'settings.readReceiptsDesc', (v) => { _readReceiptsEnabled = v; });
  buildToggleRow('acceptRequests', 'settings.requests', 'settings.requestsDesc');

  {                                  // blocked senders, with a way back
    const row = el('div', { className: 'set-opt-row set-blocked' });
    const label = el('div', { style: 'flex:1' });
    label.append(el('div', { className: 'set-row-label', textContent: t('settings.blocked') }));
    const listEl = el('div', { className: 'blocked-list' });
    label.append(listEl);
    const paint = (list) => {
      listEl.innerHTML = '';
      if (!list.length) { listEl.append(el('div', { className: 'set-desc', textContent: t('settings.blockedNone') })); return; }
      for (const addr of list) {
        const item = el('div', { className: 'blocked-item' });
        const un = el('button', { type: 'button', className: 'set-pill', textContent: t('settings.unblock') });
        un.onclick = async () => {
          un.disabled = true;
          try {
            await fetch('/api/blocked', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: addr }) });
            paint(list.filter((a) => a !== addr));
          } catch { un.disabled = false; }
        };
        item.append(el('span', { className: 'blocked-addr', textContent: shortAddr(addr), title: addr }), un);
        listEl.append(item);
      }
    };
    fetch('/api/blocked').then((r) => r.json()).then((l) => paint(Array.isArray(l) ? l : [])).catch(() => paint([]));
    row.append(label);
    dialog.append(row);
  }

  {                                  // incoming voice calls: on by default (only contacts can ring you); kept on this device
    const row = el('div', { className: 'set-opt-row' });
    const label = el('div', { style: 'flex:1' });
    label.append(el('div', { className: 'set-row-label', textContent: t('settings.calls') }), el('div', { className: 'set-desc', textContent: t('settings.callsDesc') }));
    const toggle = el('button', { type: 'button', className: 'set-toggle' });
    const sync = () => { const on = !callsOff(); toggle.textContent = on ? (t('toggle.on')) : (t('toggle.off')); toggle.className = 'set-toggle' + (on ? ' on' : ''); };
    toggle.onclick = () => { try { if (callsOff()) localStorage.removeItem(CALLS_OFF_KEY); else localStorage.setItem(CALLS_OFF_KEY, '1'); } catch {} sync(); };
    sync(); row.append(label, toggle); dialog.append(row);
  }

  dialog.append(el('h4', { className: 'set-title', style: 'margin-top:24px', textContent: t('storage.title') }));
  const storageBox = el('div', { id: 'storage-section' });
  dialog.append(storageBox);
  paintStorage(storageBox).then(() => { if (focus === 'storage') storageBox.scrollIntoView({ block: 'start', behavior: 'smooth' }); });

  dialog.append(el('h4', { className: 'set-title', style: 'margin-top:24px', textContent: t('settings.updates') }));
  const updRow = el('div', { className: 'set-opt-row' });
  const updInfo = el('div', { style: 'flex:1' });
  const updVersion = el('div', { className: 'set-row-label', textContent: t('update.version', { v: '' }).trim() });
  updInfo.append(updVersion, el('div', { className: 'set-desc', textContent: t('update.hint') }));
  const updBtn = el('button', { type: 'button', className: 'set-pill', textContent: t('update.check') });
  updRow.append(updInfo, updBtn);
  const updOut = el('div', { className: 'upd-result', hidden: true, role: 'status' });
  dialog.append(updRow, updOut);

  fetch('/api/version').then(r => r.json())
    .then(v => { updVersion.textContent = t('update.version', { v: 'v' + v.version }); })
    .catch(() => {});

  const showUpdate = (kind, ...nodes) => {
    updOut.hidden = false;
    updOut.className = 'upd-result ' + kind;
    updOut.replaceChildren(...nodes);
    updOut.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const line = (text, cls = '') => el('p', { className: 'upd-line ' + cls, textContent: text });

  const runUpdateCheck = async () => {
    updBtn.disabled = true;
    updBtn.textContent = t('update.checking');
    showUpdate('busy', line(t('update.checking')));
    try {
      const resp = await fetch('/api/update/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (resp.status === 429) { showUpdate('warn', line(t('update.tooFast'))); return; }
      if (resp.status === 501) { showUpdate('warn', line(t('update.notConfigured'))); return; }
      const r = await resp.json().catch(() => ({}));
      if (!resp.ok) { showUpdate('err', line(t('update.failed'))); return; }
      if (r.updateAvailable) {
        // The link is shown, never opened: opening it would connect from the
        // system browser, outside the Anyone network.
        const url = el('code', { className: 'upd-url', textContent: r.url });
        const copyBtn = el('button', { type: 'button', className: 'set-pill', textContent: t('update.copy') });
        copyBtn.onclick = async () => {
          try { await navigator.clipboard.writeText(r.url); toast(t('update.copied')); } catch {}
        };
        showUpdate('ok',
          line(t('update.available', { latest: 'v' + r.latest }), 'strong'),
          url, copyBtn,
          line(t('update.linkHint'), 'muted'),
          line(t('update.verify'), 'muted'));
      } else if (r.latest === null) {
        showUpdate('ok', line(t('update.noReleases')));
      } else {
        showUpdate('ok', line(t('update.upToDate')));
      }
    } catch {
      showUpdate('err', line(t('update.failed')));
    } finally {
      updBtn.disabled = false;
      updBtn.textContent = t('update.check');
    }
  };
  updBtn.onclick = () => runUpdateCheck();

  // Backup: anywhere; Restore needs the desktop app (it erases this computer and restarts).
  {
    dialog.append(el('h4', { className: 'set-title', style: 'margin-top:24px', textContent: t('backup.title') }));
    const row = (labelKey, descKey, btnText, cls, run) => {
      const r = el('div', { className: 'set-opt-row' });
      const label = el('div', { style: 'flex:1' });
      label.append(el('div', { className: 'set-row-label', textContent: t(labelKey) }), el('div', { className: 'set-desc', textContent: t(descKey) }));
      const b = el('button', { type: 'button', className: cls, textContent: btnText });
      b.onclick = () => { overlay.hidden = true; run(); };
      r.append(label, b); dialog.append(r);
    };
    row('backup.createLabel', 'backup.createDesc', t('backup.createBtn'), 'btn', openCreateBackupDialog);
    if (window.electron?.eraseForRestore) row('backup.restoreLabel', 'backup.restoreDesc', t('backup.restoreBtn'), 'btn req-block', () => openRestoreDialog({ fresh: false }));
  }

  // Erase everything: desktop app only (in a browser tab the page can't remove the browser's own storage, nor the backend's folder).
  if (window.electron?.eraseEverything) {
    const box = el('div', { className: 'erase-box' });
    box.append(
      el('div', { className: 'erase-title', textContent: t('erase.title') }),
      el('div', { className: 'set-desc', textContent: t('erase.desc') }),
    );
    const go = el('button', { type: 'button', className: 'btn req-block erase-btn', textContent: t('erase.button') });
    go.onclick = () => { overlay.hidden = true; openEraseDialog(); };
    box.append(go);
    dialog.append(box);
  }

  const closeRow = el('div', { className: 'confirm-actions' });
  const close = el('button', { className: 'confirm-cancel', type: 'button', textContent: t('nav.close') });
  close.onclick = () => { overlay.hidden = true; };
  const about = el('button', { className: 'about-link', type: 'button', textContent: t('settings.about') });
  about.onclick = () => openAboutDialog();
  closeRow.append(about, close);
  dialog.append(closeRow);

  overlay.append(dialog);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.hidden = true; };
  // Escape closes Settings, unless something opened on top of it (a confirmation, About, a menu) is the one being closed.
  if (!overlay._escBound) {
    overlay._escBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || overlay.hidden) return;
      const onTop = [...document.querySelectorAll('.confirm-overlay, .about-overlay, dialog[open]')].some((o) => o !== overlay && !o.hidden && o.getClientRects().length);
      if (onTop || document.getElementById('ctx-menu')) return;
      overlay.hidden = true;
    });
  }
}

const ABOUT_PROJECT_URL = 'https://github.com/xmranonp/AnonChat';
const ABOUT_XMR_ADDRESS = '86AJBT6p4Xf6dCEXRqoduk5YPMdvGzbazB2rz8eXzypoDraS5Cgjq5qARCop7WVgsPBxZ4CpSgpHqiZPBaaSiPhb1SGKe35';

// The project link is shown as text with a Copy button: opening it would connect from the system browser, outside the Anyone network.
function openAboutDialog() {
  let overlay = document.getElementById('about-overlay');
  if (!overlay) {
    overlay = el('div', { id: 'about-overlay', className: 'confirm-overlay about-overlay' });
    document.body.append(overlay);
  }
  overlay.innerHTML = '';
  overlay.hidden = false;

  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  function close() { overlay.hidden = true; document.removeEventListener('keydown', onKey, true); }
  document.addEventListener('keydown', onKey, true);

  const dialog = el('div', { className: 'about-dialog', role: 'dialog' });
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'about-title');

  const version = el('div', { className: 'about-version' });
  dialog.append(el('div', { className: 'about-head' },
    el('img', { className: 'about-mark', src: '/app-icon.png', alt: '', width: 40, height: 40 }),
    el('div', {}, el('h3', { id: 'about-title', textContent: t('about.title') }), version)));
  fetch('/api/version').then(r => r.json())
    .then(v => { if (v.version) version.textContent = t('about.version', { v: v.version }); })
    .catch(() => {});

  const para  = (key) => el('p', { className: 'about-p', textContent: t(key) });
  const heading = (key) => el('h4', { className: 'about-h', textContent: t(key) });
  const copyRow = (label, value, toastKey) => {
    const btn = el('button', { type: 'button', className: 'set-pill', textContent: t('groups.copyCode') });
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(value); toast(t(toastKey)); } catch {}
    };
    return el('div', { className: 'about-copy' },
      el('div', { className: 'about-copy-label', textContent: label }),
      el('div', { className: 'about-copy-row' }, el('code', { className: 'about-code', textContent: value }), btn));
  };

  dialog.append(para('about.intro'));
  dialog.append(heading('about.communityTitle'), para('about.community'));
  dialog.append(heading('about.noticeTitle'), para('about.notice'));
  dialog.append(heading('about.supportTitle'), para('about.support'),
    copyRow('Monero (XMR)', ABOUT_XMR_ADDRESS, 'about.copiedAddr'),
    copyRow(t('about.project'), ABOUT_PROJECT_URL, 'update.copied'));
  dialog.append(el('p', { className: 'about-fine' }, t('about.license'), el('br'), t('about.trademark')));

  const closeBtn = el('button', { className: 'confirm-cancel', type: 'button', textContent: t('nav.close') });
  closeBtn.onclick = close;
  dialog.append(el('div', { className: 'confirm-actions about-foot' }, closeBtn));

  overlay.append(dialog);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  closeBtn.focus({ preventScroll: true });
  dialog.scrollTop = 0;
}

(function addSettingsButton() {
  document.addEventListener('DOMContentLoaded', () => {
    const ctrls = document.querySelector('.brand-controls');
    if (!ctrls || document.getElementById('settings-btn')) return;
    const btn = el('button', { id: 'settings-btn', className: 'ctl-btn', type: 'button', title: t('settings.btnTitle'),
      innerHTML: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8L4.2 7a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>' });
    btn.onclick = openSettingsDialog;
    ctrls.append(btn);
  });
})();
