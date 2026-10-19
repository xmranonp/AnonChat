// Deterministic gradient avatar generated from an address and name.

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const GOLDEN = 137.508;

const PALETTES = [
  [210, 250],
  [160, 200],
  [280, 320],
  [30,  60],
  [170, 210],
  [320,  10],
  [240, 190],
  [90, 140],
  [0,   40],
  [260, 300],
  [180, 220],
  [40,  80],
];

export function fingerprintSVG(address, size = 40, name = '') {
  const seed = fnv1a(address || 'unknown');

  const [h1base, h2base] = PALETTES[seed % PALETTES.length];
  const nudge = (seed >> 8) % 20 - 10;
  const h1 = (h1base + nudge + 360) % 360;
  const h2 = (h2base + nudge + 360) % 360;

  const l1 = 58 + (seed >> 16) % 12;
  const l2 = 38 + (seed >> 20) % 10;
  const s  = 62 + (seed >> 24) % 18;

  const c1 = `hsl(${h1},${s}%,${l1}%)`;
  const c2 = `hsl(${h2},${s}%,${l2}%)`;

  // Escape the letter: a petname starting with < > or & would otherwise inject markup.
  const rawLetter = (Array.from(String((name ? name : address) || '?'))[0] || '?').toUpperCase();   // a whole character (an emoji is two code units)
  const letter = rawLetter.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  const r  = Math.round(size * 0.22);
  const fs = Math.round(size * 0.46);
  const id = `av${seed % 999983}`;

  const cr = Math.round(size * 0.5);

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="avatar">
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="100%" stop-color="${c2}"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${r}" fill="url(#${id})"/>
  <circle cx="${size * 0.72}" cy="${size * 0.28}" r="${cr}" fill="white" opacity="0.08"/>
  <text x="${size / 2}" y="${size / 2}"
        text-anchor="middle" dominant-baseline="central"
        fill="rgba(255,255,255,0.93)"
        font-size="${fs}" font-weight="700"
        font-family="Inter, system-ui, sans-serif">${letter}</text>
</svg>`;
}

export function shortAddr(address) {
  if (!address) return 'unknown';
  return address.length <= 22 ? address : `${address.slice(0, 10)}…${address.slice(-9)}`;
}
