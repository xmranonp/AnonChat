// call.js — voice calls over the Anyone network.
//
// How a call works
//   1. Signalling (invite / accept / decline / cancel / end) travels as ordinary end-to-end encrypted chat messages, so the other
//      side is authenticated by the same ratchet as a text. The invite and the accept carry a fresh ephemeral P-256 key.
//   2. From the two ephemeral keys both sides derive the call keys (ECDH + HKDF, one key per direction). Nothing is stored.
//   3. The audio then flows over ONE WebSocket per call: browser -> local backend (loopback) -> SOCKS proxy -> the other node's hidden
//      service. The backend sees only ciphertext. There is no WebRTC, no STUN/TURN, no UDP and no connection to any clearnet host.
//   4. Audio is Opus (WebCodecs), constant bit rate, in fixed-size padded frames, sent at a constant rate even while muted, so the
//      stream does not reveal when you speak. Every frame is AES-GCM sealed with a counter nonce and rejected if it is replayed.
//   5. The receiver keeps an adaptive jitter buffer: Anyone circuits add delay and jitter, so playout is smoothed and, when the
//      network stalls and then delivers a burst, the backlog is skipped instead of letting the delay grow.

const FRAME_MS = 40, FR = FRAME_MS / 1000;
// Playout cushion (s). Routes through the Anyone network stall for a few hundred milliseconds now and then and deliver the audio in a
// burst afterwards; a thin cushion turns every stall into a dropout, and skipping the burst makes a second one. So: start with a
// cushion that rides out a usual stall, grow it quickly when one gets through, shrink it only after a long quiet spell, and skip a
// backlog only when the delay would otherwise stick for good.
// A call crosses six relays plus the rendezvous point, so 2 to 3 seconds from mouth to ear is the aim: about a second of network,
// and a cushion of 1.2 s (up to 2.2 s while the route keeps stalling) to ride out its pauses without a gap.
const TARGET_START = 1.2, TARGET_MIN = 1.0, TARGET_MAX = 2.2, TARGET_STEP_UP = 0.25, TARGET_STEP_DOWN = 0.05;
const SKIP_OVER = 2.0, QUIET_S = 45, FADE_S = 0.004;
const T_AUDIO = 1, T_PING = 2, T_PONG = 3, T_BYE = 4;
const RING_TIMEOUT_MS = 45_000;
const CONNECT_TIMEOUT_MS = 120_000;
const PAD = 32, MIN_PLAIN = 128;

const te = new TextEncoder();
const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let f = 0; for (const x of a) { o.set(x, f); f += x.length; } return o; };
const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g).map((h) => parseInt(h, 16)));
const b64e = (u) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s); };
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const ID_RE = /^[0-9a-f]{32}$/;

export function callsSupported() {
  return typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined' && typeof EncodedAudioChunk !== 'undefined'
    && typeof MediaStreamTrackProcessor !== 'undefined' && typeof AudioContext !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia && typeof WebSocket !== 'undefined';
}

// ---------------------------------------------------------------- crypto
async function newKeyPair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { priv: kp.privateKey, pub: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)) };
}
async function deriveKeys(priv, theirPub, idBytes, callerPub, calleePub, role) {
  if (!(theirPub instanceof Uint8Array) || theirPub.length !== 65 || theirPub[0] !== 4) throw new Error('bad call key');
  const their = await crypto.subtle.importKey('raw', theirPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);   // rejects points not on the curve
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: their }, priv, 256);
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const info = concat(te.encode('AnonChat voice call v1'), callerPub, calleePub);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: idBytes, info }, base, 512));
  const mk = (b) => crypto.subtle.importKey('raw', b, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const [c2e, e2c] = [await mk(bits.slice(0, 32)), await mk(bits.slice(32))];
  bits.fill(0);
  return role === 'caller' ? { send: c2e, recv: e2c } : { send: e2c, recv: c2e };
}
// Wire format of a sealed frame: [type:1][seq:8][AES-GCM ciphertext+tag]. Nonce = 4 zero bytes + seq; AAD = call id + type + seq.
async function seal(key, idBytes, type, seq, plain) {
  const head = new Uint8Array(9); head[0] = type; new DataView(head.buffer).setBigUint64(1, BigInt(seq));
  const iv = new Uint8Array(12); iv.set(head.subarray(1), 4);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: concat(idBytes, head), tagLength: 128 }, key, plain));
  return concat(head, ct);
}
async function unseal(key, idBytes, data) {
  if (data.length < 9 + 16) return null;
  const head = data.subarray(0, 9);
  const iv = new Uint8Array(12); iv.set(head.subarray(1), 4);
  try {
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: concat(idBytes, head), tagLength: 128 }, key, data.subarray(9)));
    return { type: head[0], seq: Number(new DataView(head.buffer, head.byteOffset, 9).getBigUint64(1)), plain: pt };
  } catch { return null; }
}
function padAudio(idx, opus) {
  const n = Math.max(MIN_PLAIN, Math.ceil((6 + opus.length) / PAD) * PAD);
  const out = new Uint8Array(n); const dv = new DataView(out.buffer);
  dv.setUint32(0, idx); dv.setUint16(4, opus.length); out.set(opus, 6);
  return out;
}
function unpadAudio(plain) {
  if (plain.length < 6) return null;
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const len = dv.getUint16(4);
  if (len === 0 || 6 + len > plain.length) return null;
  return { idx: dv.getUint32(0), opus: plain.subarray(6, 6 + len) };
}

// ---------------------------------------------------------------- audio
class AudioPath {
  constructor() {
    this.ctx = null; this.encoder = null; this.decoder = null; this.reader = null;
    this.muted = false; this.txIdx = 0; this.onPacket = null; this.stopped = false;
    this.base = null; this.target = TARGET_START; this.underruns = 0; this.skipped = 0; this.lastUnder = 0; this.lastGood = 0;
    this.level = 0; this.rx = 0; this.tx = 0; this.peak = 0;
  }
  async start(stream, onPacket) {
    this.onPacket = onPacket;
    this.stream = stream;
    stream.getAudioTracks().forEach((x) => { x.enabled = !this.muted; });
    const ctx = this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    // Capture: whatever the microphone gives is resampled to 48 kHz mono here, so the encoder always sees the same format.
    const src = ctx.createMediaStreamSource(stream);
    this.micGain = ctx.createGain(); this.micGain.gain.value = this.muted ? 0 : 1;
    const dest = ctx.createMediaStreamDestination(); dest.channelCount = 1; dest.channelCountMode = 'explicit'; dest.channelInterpretation = 'speakers';
    src.connect(this.micGain).connect(dest);
    // Playback: decoded frames are scheduled on this gain node, and heard through an ordinary audio player in the page (as a voice
    // message is). Chromium's echo cancellation takes what its audio players play as the sound to remove from the microphone; audio
    // sent straight to the speakers from here was not always included (Linux in particular), so the other side heard themselves.
    this.out = ctx.createGain(); this.out.gain.value = 1;
    this.an = ctx.createAnalyser(); this.an.fftSize = 512; this.out.connect(this.an);
    try {
      const sink = ctx.createMediaStreamDestination();
      this.out.connect(sink);
      const player = this.player = new Audio();
      player.autoplay = true; player.srcObject = sink.stream;
      await player.play();
    } catch {
      // The page couldn't start an audio player: play directly rather than stay silent.
      try { if (this.player) { this.player.srcObject = null; this.player = null; } } catch {}
      this.out.connect(ctx.destination);
    }
    this.anBuf = new Uint8Array(this.an.fftSize);

    const cfg = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 24000, bitrateMode: 'constant',
                  opus: { frameDuration: FRAME_MS * 1000, application: 'voip', signal: 'voice', complexity: 6, usedtx: false, useinbandfec: false } };
    this.encoder = new AudioEncoder({
      output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); if (!this.stopped) { this.tx++; this.onPacket(this.txIdx++, b); } },
      error: () => {},
    });
    try { this.encoder.configure(cfg); }
    catch { delete cfg.bitrateMode; this.encoder.configure(cfg); }
    this.decoder = new AudioDecoder({ output: (ad) => this._play(ad), error: () => {} });
    this.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });

    const track = dest.stream.getAudioTracks()[0];
    this.reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done || this.stopped) break;
          try { if (this.encoder.state === 'configured') this.encoder.encode(value); } finally { value.close(); }
        }
      } catch {}
    })();
  }
  // Muted twice over: the microphone track itself is switched off (silence from the source) AND the gain stage is closed.
  setMuted(m) {
    this.muted = !!m;
    try { this.stream?.getAudioTracks().forEach((x) => { x.enabled = !this.muted; }); } catch {}
    if (this.micGain) {
      const g = this.micGain.gain, now = this.ctx ? this.ctx.currentTime : 0;
      try { g.cancelScheduledValues(now); g.setValueAtTime(this.muted ? 0 : 1, now); } catch {}
      g.value = this.muted ? 0 : 1;
    }
  }
  feed(idx, opus) {
    if (this.stopped || !this.decoder || this.decoder.state !== 'configured') return;
    this.rx++;
    try { this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: idx * FRAME_MS * 1000, data: opus })); } catch {}
  }
  _play(ad) {
    try {
      const ctx = this.ctx; if (!ctx || this.stopped) return;
      const idx = Math.round(ad.timestamp / (FRAME_MS * 1000)), n = ad.numberOfFrames;
      const buf = ctx.createBuffer(1, n, ad.sampleRate); const tmp = new Float32Array(n);
      ad.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' }); buf.copyToChannel(tmp, 0);
      const now = ctx.currentTime;
      if (this.base === null) this.base = now + this.target - idx * FR;
      let t = this.base + idx * FR, jump = false;
      if (t < now + 0.005) {                       // late: the network stalled. Replay from "now" and keep a bigger cushion next time.
        this.underruns++; this.lastUnder = now; this.target = Math.min(TARGET_MAX, this.target + TARGET_STEP_UP);
        const shift = now + this.target - t; this.base += shift; t += shift; jump = true;   // re-buffer with a full cushion
      } else if (t > now + this.target + SKIP_OVER) {   // far ahead: a long stall's backlog. Skip it so the delay does not stick.
        const shift = t - (now + this.target); this.base -= shift; t -= shift; this.skipped++; jump = true;
      } else if (now - this.lastUnder > QUIET_S && this.target > TARGET_MIN && now - this.lastGood > QUIET_S) {
        this.target = Math.max(TARGET_MIN, this.target - TARGET_STEP_DOWN); this.lastGood = now;   // a long quiet spell: shrink slowly
      }
      // After a jump, or when the frame before it never came, start softly: a hard edge in the waveform is heard as a click.
      if (jump || (this.lastT != null && Math.abs(t - this.lastT - FR) > 0.002)) {
        const k = Math.min(n, Math.round(FADE_S * ad.sampleRate)); const ch = buf.getChannelData(0);
        for (let i = 0; i < k; i++) ch[i] *= i / k;
      }
      const s = ctx.createBufferSource(); s.buffer = buf; s.connect(this.out); s.start(t); this.lastT = t;
    } finally { ad.close(); }
  }
  remoteLevel() {
    if (!this.an) return 0;
    this.an.getByteTimeDomainData(this.anBuf);
    let sum = 0; for (const v of this.anBuf) { const d = (v - 128) / 128; sum += d * d; }
    const lv = Math.sqrt(sum / this.anBuf.length); if (lv > this.peak) this.peak = lv; return lv;
  }
  stop() {
    this.stopped = true;
    try { this.reader?.cancel(); } catch {}
    try { if (this.encoder && this.encoder.state !== 'closed') this.encoder.close(); } catch {}
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch {}
    try { if (this.player) { this.player.pause(); this.player.srcObject = null; } } catch {}
    this.player = null;
    try { this.ctx?.close(); } catch {}
    this.ctx = null;
  }
}

// ---------------------------------------------------------------- ring tones (synthesised, no files)
class Tones {
  constructor() { this.ctx = null; this.timer = null; }
  start(kind) {
    this.stop();
    try { this.ctx = new AudioContext(); } catch { return; }
    const play = () => {
      const c = this.ctx; if (!c) return;
      const t0 = c.currentTime + 0.02;
      const notes = kind === 'incoming' ? [[0, 0.22, 659], [0.26, 0.22, 784], [0.7, 0.22, 659], [0.96, 0.22, 784]] : [[0, 0.9, 440]];
      for (const [at, dur, f] of notes) {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'sine'; o.frequency.value = f; o.connect(g).connect(c.destination);
        g.gain.setValueAtTime(0, t0 + at); g.gain.linearRampToValueAtTime(0.09, t0 + at + 0.03);
        g.gain.setValueAtTime(0.09, t0 + at + dur - 0.05); g.gain.linearRampToValueAtTime(0, t0 + at + dur);
        o.start(t0 + at); o.stop(t0 + at + dur + 0.02);
      }
    };
    play(); this.timer = setInterval(play, kind === 'incoming' ? 2600 : 3200);
  }
  stop() { clearInterval(this.timer); this.timer = null; try { this.ctx?.close(); } catch {} this.ctx = null; }
}

// ---------------------------------------------------------------- the controller
const ICON = {
  phone: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  hang:  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="transform:rotate(135deg)"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  mic:   '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>',
  micOff:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>',
  lock:  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
};
export const CALL_ICON = ICON.phone;

export function createCalls(h) {
  // h: { t, el, findContact(addr), sendSignal(contact, meta), avatar(addr, avatarData, size, cls, name), log(addr, dir, text), toast(msg),
  //      viewing(addr) -> is that chat open, openChat(addr), tip(button, text), callsOff?(), ring?(), ringing?(addr | null) }
  const { t, el } = h;
  const tones = new Tones();
  let cur = null;                 // the one call in progress
  const inviteLog = new Map();    // contact -> recent invite times
  let card = null, tick = 0;

  const wsUrl = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/call-ws';
  const nameOf = (c) => c?.petname || c?.name || (c?.address ? c.address.slice(0, 8) + '…' : '?');
  const fmtDur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  // ---- the call bar: docked in the chat window, just under the conversation header
  function ensureCard() {
    if (card) return card;
    card = document.getElementById('call-dock');
    if (!card) { card = el('div', { id: 'call-dock' }); document.body.prepend(card); }
    card.hidden = true; card.setAttribute('aria-live', 'polite');
    return card;
  }
  function btn(cls, icon, label, onclick, withText) {
    const b = el('button', { type: 'button', className: 'call-btn ' + cls, innerHTML: icon });
    b.setAttribute('aria-label', label);
    if (withText) b.append(el('span', { className: 'call-btn-text', textContent: label }));
    else h.tip?.(b, label);
    b.onclick = (e) => { e.stopPropagation(); onclick(); };
    return b;
  }
  const viewing = () => !!cur && !!h.viewing?.(cur.contact.address);
  // Tells the window who is ringing us right now (their contact card is shaded), or null once it is answered, declined or missed.
  let _ringing = null;
  function reportRinging() {
    const who = cur && cur.role === 'callee' && cur.state === 'incoming' ? cur.contact.address : null;
    if (who !== _ringing) { _ringing = who; h.ringing?.(who); }
  }
  function render() {
    reportRinging();
    const c = ensureCard();
    if (!cur) { c.hidden = true; c.innerHTML = ''; c.className = ''; clearInterval(tick); tick = 0; return; }
    // Full bar in the call's own conversation (and whenever it rings); a slim strip while you read another chat.
    const mini = cur.state !== 'incoming' && cur.state !== 'ended' && !viewing();
    cur.mini = mini;
    c.hidden = false; c.innerHTML = '';
    c.className = 'call-dock ' + (mini ? 'mini' : 'full') + ' st-' + cur.state;
    const contact = cur.contact;
    const av = el('div', { className: 'call-av' });
    av.append(h.avatar(contact.address, contact.avatar || null, mini ? 22 : 38, '', nameOf(contact)));
    cur.avEl = av;
    const info = el('div', { className: 'call-info' });
    const name = el('div', { className: 'call-name', textContent: nameOf(contact) });
    cur.statusEl = el('span', { className: 'call-status' });
    cur.qEl = el('span', { className: 'call-q' });
    const lock = el('span', { className: 'call-lock', innerHTML: ICON.lock }); lock.setAttribute('aria-label', t('call.e2e')); h.tip?.(lock, t('call.e2e'));
    const line = el('div', { className: 'call-line' }); cur.mutedEl = el('span', { className: 'call-muted', textContent: t('call.muted') }); cur.mutedEl.hidden = !cur.muted;
    line.append(cur.statusEl, cur.qEl, cur.mutedEl, lock);
    info.append(name, line);
    const acts = el('div', { className: 'call-actions' });
    if (cur.state === 'ended') {
      // nothing to press: the bar closes by itself
    } else if (cur.state === 'incoming') {
      acts.append(btn('decline', ICON.hang, t('call.decline'), () => decline(), true), btn('accept', ICON.phone, t('call.accept'), () => accept(), true));
    } else {
      cur.muteBtn = btn('mute' + (cur.muted ? ' on' : ''), cur.muted ? ICON.micOff : ICON.mic, t(cur.muted ? 'call.unmute' : 'call.mute'), toggleMute);
      cur.muteBtn.setAttribute('aria-pressed', String(!!cur.muted));
      acts.append(cur.muteBtn);
      acts.append(btn('decline', ICON.hang, t('call.hangup'), () => hangup(), !mini));
    }
    c.append(av, info, acts);
    c.onclick = mini ? () => h.openChat?.(contact.address) : null;
    c.style.cursor = mini ? 'pointer' : '';
    paintStatus();
    if (!tick) tick = setInterval(paintStatus, 500);
  }
  // Mute is changed in place: the bar is not rebuilt, so a press can never be lost to a redraw and the tooltip stays put.
  const hideTipSoon = () => { try { document.getElementById('ctx-tip')?.remove(); } catch {} };
  function toggleMute() {
    const c = cur; if (!c) return;
    c.muted = !c.muted; c.media?.setMuted(c.muted);
    c.stream?.getAudioTracks().forEach((x) => { x.enabled = !c.muted; });
    const b = c.muteBtn; if (!b) return;
    const label = t(c.muted ? 'call.unmute' : 'call.mute');
    b.classList.toggle('on', c.muted); b.setAttribute('aria-pressed', String(c.muted)); b.setAttribute('aria-label', label);
    b.innerHTML = c.muted ? ICON.micOff : ICON.mic;
    b._tipText = label; hideTipSoon(); if (c.mutedEl) c.mutedEl.hidden = !c.muted;
    paintStatus();
  }
  function paintStatus() {
    if (!cur || !cur.statusEl) return;
    const s = cur.state;
    let text = '';
    if (s === 'calling') text = t('call.calling');
    else if (s === 'ringing') text = t('call.ringing');
    else if (s === 'incoming') text = t('call.incoming');
    else if (s === 'connecting') text = t('call.connecting');
    else if (s === 'reconnecting') text = t('call.reconnecting');
    else if (s === 'active') text = fmtDur(Date.now() - cur.t0);
    else if (s === 'ended') text = cur.endText || '';
    cur.statusEl.textContent = text;
    cur.statusEl.className = 'call-status ' + s;
    if (cur.qEl) {
      if (s === 'active' && cur.rtt != null && !cur.mini) {
        const delay = (cur.rtt / 2 + (cur.media?.target || TARGET_START) * 1000) / 1000;
        cur.qEl.textContent = '· ' + t('call.delay') + ' ' + delay.toFixed(1) + ' s';
        cur.qEl.className = 'call-q ' + (delay < 3.2 ? 'good' : delay < 4.5 ? 'ok' : 'bad');   // 2–3 s is what a call through six relays is set for
      } else cur.qEl.textContent = '';
    }
    if (cur.avEl && cur.media && s === 'active') cur.avEl.classList.toggle('speaking', cur.media.remoteLevel() > 0.02);
  }

  // ---- ending
  function finish(text, logText, logDir) {
    const c = cur; if (!c || c.state === 'ended') return;
    c.state = 'ended'; c.endText = text;
    clearTimeout(c.ringTimer); clearTimeout(c.connTimer); clearInterval(c.pingTimer);
    tones.stop();
    const ws = c.ws; setTimeout(() => { try { ws?.close(); } catch {} }, c.closeDelay || 0);   // a hang-up lets its last frame out first
    c.media?.stop();
    c.stream?.getTracks().forEach((x) => x.stop());
    if (logText) h.log(c.contact.address, logDir || 'in', logText);
    render();
    setTimeout(() => { if (cur === c) { cur = null; render(); } }, 2200);
  }
  function sendSig(meta) { return h.sendSignal(cur ? cur.contact : meta._contact, meta).catch(() => {}); }

  // ---- outgoing
  async function start(contact) {
    if (cur) { h.toast(t('call.busyOther')); return; }
    if (!callsSupported()) { h.toast(t('call.unsupported')); return; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      h.toast(e?.name === 'NotAllowedError' ? t('mic.denied') : e?.name === 'NotFoundError' ? t('mic.notFound') : t('mic.error')); return;
    }
    if (cur) { stream.getTracks().forEach((x) => x.stop()); return; }
    const id = hex(crypto.getRandomValues(new Uint8Array(16)));
    const keys = await newKeyPair();
    cur = { id, idBytes: unhex(id), contact, role: 'caller', state: 'calling', stream, keys, muted: false, seqOut: 0, lastIn: -1, rtt: null, t0: 0 };
    render(); tones.start('outgoing');
    const c = cur;
    c.ringTimer = setTimeout(() => {
      if (cur !== c || c.state === 'active') return;
      h.sendSignal(contact, { op: 'cancel', id }).catch(() => {});
      finish(t('call.noAnswer'), t('call.log.noAnswer'), 'out');
    }, RING_TIMEOUT_MS);
    try {
      await h.sendSignal(contact, { op: 'invite', id, epk: b64e(keys.pub) });
      if (cur === c && c.state === 'calling') { c.state = 'ringing'; paintStatus(); }
    } catch {
      if (cur === c) finish(t('call.unreachable'), t('call.log.noAnswer'), 'out');
    }
  }

  // ---- incoming
  function onInvite(from, m) {
    const contact = h.findContact(from);
    if (!contact || typeof m.id !== 'string' || !ID_RE.test(m.id) || typeof m.epk !== 'string') return;   // only contacts can call
    const reply = (op, reason) => h.sendSignal(contact, { op, id: m.id, reason }).catch(() => {});
    const now = Date.now(), recent = (inviteLog.get(from) || []).filter((x) => now - x < 60_000); recent.push(now); inviteLog.set(from, recent);
    if (recent.length > 4) return;                  // a contact ringing again and again is ignored, not answered
    if (h.callsOff?.()) return reply('decline', 'declined');
    if (cur) return (cur.id === m.id ? undefined : reply('decline', 'busy'));
    let peerPub; try { peerPub = b64d(m.epk); } catch { return; }
    if (peerPub.length !== 65) return;
    cur = { id: m.id, idBytes: unhex(m.id), contact, role: 'callee', state: 'incoming', peerPub, muted: false, seqOut: 0, lastIn: -1, rtt: null, t0: 0 };
    const c = cur;
    render(); tones.start('incoming'); h.ring?.(from);
    c.ringTimer = setTimeout(() => { if (cur === c && c.state === 'incoming') finish(t('call.missed'), t('call.log.missed'), 'in'); }, RING_TIMEOUT_MS + 5000);
  }
  async function accept() {
    const c = cur; if (!c || c.state !== 'incoming') return;
    tones.stop(); clearTimeout(c.ringTimer);
    if (!callsSupported()) { reply(c, 'decline', 'declined'); finish(t('call.unsupported')); return; }
    try {
      c.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      reply(c, 'decline', 'declined');
      finish(e?.name === 'NotAllowedError' ? t('mic.denied') : t('mic.notFound'), t('call.log.declined'), 'in'); return;
    }
    if (cur !== c) { c.stream.getTracks().forEach((x) => x.stop()); return; }
    c.state = 'connecting'; render();
    try {
      c.keys = await newKeyPair();
      c.crypto = await deriveKeys(c.keys.priv, c.peerPub, c.idBytes, c.peerPub, c.keys.pub, 'callee');
    } catch { reply(c, 'decline', 'declined'); finish(t('call.failed')); return; }
    openLocal(c, () => {
      c.ws.send(JSON.stringify({ op: 'expect', id: c.id, peer: c.contact.address }));
    }, () => {                                   // the backend is ready for the caller's connection: now accept
      h.sendSignal(c.contact, { op: 'accept', id: c.id, epk: b64e(c.keys.pub) }).catch(() => { if (cur === c) finish(t('call.failed')); });
    });
    c.connTimer = setTimeout(() => { if (cur === c && c.state !== 'active') { finish(t('call.failed'), t('call.log.noAnswer'), 'in'); } }, CONNECT_TIMEOUT_MS);
  }
  function reply(c, op, reason) { return h.sendSignal(c.contact, { op, id: c.id, reason }).catch(() => {}); }
  function decline() {
    const c = cur; if (!c || c.state !== 'incoming') return;
    reply(c, 'decline', 'declined');
    finish(t('call.declinedBy'), t('call.log.declined'), 'in');
  }

  // ---- signalling from the other side (already authenticated by the ratchet)
  async function onSignal(from, m) {
    if (!m || typeof m !== 'object' || typeof m.op !== 'string') return;
    if (m.op === 'invite') return onInvite(from, m);
    const c = cur;
    if (!c || c.id !== m.id || c.contact.address !== from) return;
    if (m.op === 'accept' && c.role === 'caller' && (c.state === 'calling' || c.state === 'ringing')) {
      let peerPub; try { peerPub = b64d(String(m.epk)); } catch { return; }
      clearTimeout(c.ringTimer); tones.stop();
      c.state = 'connecting'; render();
      try { c.crypto = await deriveKeys(c.keys.priv, peerPub, c.idBytes, c.keys.pub, peerPub, 'caller'); }
      catch { finish(t('call.failed')); return; }
      if (cur !== c) return;
      openLocal(c, () => { c.ws.send(JSON.stringify({ op: 'dial', id: c.id, peer: c.contact.address })); }, null);
      c.connTimer = setTimeout(() => { if (cur === c && c.state !== 'active') finish(t('call.unreachable'), t('call.log.noAnswer'), 'out'); }, CONNECT_TIMEOUT_MS);
    } else if (m.op === 'decline' && c.role === 'caller' && c.state !== 'active') {
      finish(m.reason === 'busy' ? t('call.busy') : t('call.declinedBy'), t('call.log.declinedOut'), 'out');
    } else if (m.op === 'cancel' && c.role === 'callee' && c.state === 'incoming') {
      finish(t('call.missed'), t('call.log.missed'), 'in');
    } else if (m.op === 'end') {
      endedByPeer(c);
    }
  }
  function endedByPeer(c) {
    if (cur !== c || c.state === 'ended') return;
    if (c.state === 'active' || c.state === 'reconnecting') finish(t('call.ended'), t('call.log.done', { t: fmtDur(Date.now() - c.t0) }), c.role === 'caller' ? 'out' : 'in');
    else finish(t('call.ended'));
  }

  // ---- the audio link (browser <-> local backend)
  function openLocal(c, onOpen, onReady) {
    let ws;
    try { ws = new WebSocket(wsUrl()); } catch { finish(t('call.failed')); return; }
    ws.binaryType = 'arraybuffer';
    c.ws = ws;
    let chain = Promise.resolve();
    ws.onopen = () => onOpen();
    ws.onmessage = (ev) => {
      if (cur !== c) return;
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.op === 'ready') onReady?.();
        else if (m.op === 'open') linkUp(c);
        else if (m.op === 'reconnecting') { if (c.state === 'active') { c.state = 'reconnecting'; paintStatus(); } }
        else if (m.op === 'closed') {
          if (m.reason === 'remote-closed' && (c.state === 'active' || c.state === 'reconnecting')) endedByPeer(c);
          else if (c.state === 'active' || c.state === 'reconnecting') finish(t('call.lost'), t('call.log.done', { t: fmtDur(Date.now() - c.t0) }), c.role === 'caller' ? 'out' : 'in');
          else if (c.state !== 'ended') finish(m.reason === 'unreachable' ? t('call.unreachable') : t('call.failed'), c.role === 'caller' ? t('call.log.noAnswer') : null, 'out');
        } else if (m.op === 'error') finish(m.reason === 'busy' ? t('call.busyOther') : t('call.failed'));
        return;
      }
      const data = new Uint8Array(ev.data);
      chain = chain.then(() => onFrame(c, data)).catch(() => {});
    };
    ws.onclose = () => { if (cur === c && c.state !== 'ended' && c.state !== 'incoming') finish(t('call.failed')); };
    ws.onerror = () => {};
  }
  async function linkUp(c) {
    if (c.state === 'reconnecting') { c.state = 'active'; paintStatus(); return; }
    if (c.state !== 'connecting') return;
    clearTimeout(c.connTimer);
    c.media = new AudioPath(); c.media.setMuted(c.muted);
    try {
      await c.media.start(c.stream, (idx, opus) => sendFrame(c, T_AUDIO, padAudio(idx, opus)));
    } catch { finish(t('call.failed')); return; }
    if (cur !== c) return;
    c.state = 'active'; c.t0 = Date.now(); tones.stop(); render();
    c.pingTimer = setInterval(() => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, performance.now()); sendFrame(c, T_PING, b); }, 2000);
  }
  let sendChains = new WeakMap();
  function sendFrame(c, type, plain) {
    if (!c.ws || c.ws.readyState !== 1 || !c.crypto) return Promise.resolve();
    const seq = c.seqOut++;
    const prev = sendChains.get(c) || Promise.resolve();
    const next = prev.then(async () => {
      const f = await seal(c.crypto.send, c.idBytes, type, seq, plain);
      if (c.ws && c.ws.readyState === 1 && c.ws.bufferedAmount < 32768) c.ws.send(f);      // never queue live audio
    }).catch(() => {});
    sendChains.set(c, next);
    return next;
  }
  async function onFrame(c, data) {
    if (cur !== c || !c.crypto || c.state === 'ended') return;
    const r = await unseal(c.crypto.recv, c.idBytes, data);
    if (!r || r.seq <= c.lastIn) return;                // forged, damaged or replayed
    c.lastIn = r.seq;
    if (r.type === T_AUDIO) { const a = unpadAudio(r.plain); if (a && c.media) c.media.feed(a.idx, a.opus); }
    else if (r.type === T_PING) sendFrame(c, T_PONG, r.plain.slice(0, 8));
    else if (r.type === T_PONG && r.plain.length >= 8) { const t0 = new DataView(r.plain.buffer, r.plain.byteOffset, 8).getFloat64(0); const rtt = performance.now() - t0; if (rtt >= 0 && rtt < 60000) c.rtt = c.rtt == null ? rtt : c.rtt * 0.7 + rtt * 0.3; }
    else if (r.type === T_BYE) endedByPeer(c);
  }

  // ---- hang up
  function hangup() {
    const c = cur; if (!c) return;
    if (c.state === 'active' || c.state === 'reconnecting') {
      sendFrame(c, T_BYE, new Uint8Array(8));
      h.sendSignal(c.contact, { op: 'end', id: c.id }).catch(() => {});
      const dur = fmtDur(Date.now() - c.t0);
      c.closeDelay = 400;
      finish(t('call.ended'), t('call.log.done', { t: dur }), c.role === 'caller' ? 'out' : 'in');
    } else if (c.state === 'incoming') decline();
    else {
      h.sendSignal(c.contact, { op: 'cancel', id: c.id }).catch(() => {});
      try { c.ws?.send(JSON.stringify({ op: 'hangup' })); } catch {}
      finish(t('call.cancelled'), t('call.log.cancelled'), 'out');
    }
  }

  // Diagnostics for the call in progress (also used by the tests).
  const stats = () => cur ? { state: cur.state, rtt: cur.rtt, delay: cur.media?.target ?? null, underruns: cur.media?.underruns ?? 0, skipped: cur.media?.skipped ?? 0,
    tx: cur.media?.tx ?? 0, rx: cur.media?.rx ?? 0, peak: cur.media?.peak ?? 0, level: cur.media?.remoteLevel() ?? 0, muted: cur.muted,
    ahead: cur.media?.ctx && cur.media.lastT ? cur.media.lastT - cur.media.ctx.currentTime : null } : null;
  const micEnabled = () => cur?.stream ? cur.stream.getAudioTracks().some((x) => x.enabled) : null;
  return { micEnabled, start, onSignal, active: () => !!cur, hangup, stats, rerender: () => { if (cur && (cur.mini !== (cur.state !== 'incoming' && cur.state !== 'ended' && !viewing()))) render(); } };
}

// Exposed for the tests only.
export const __test = { newKeyPair, deriveKeys, seal, unseal, padAudio, unpadAudio, unhex, hex };
