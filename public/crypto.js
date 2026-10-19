// Small shared crypto primitives used by ratchet.js and app.js.

export const b64 = {
  enc(buf) {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  },
  dec(str) {
    const bin = atob(str);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  },
};

export const text = {
  toBytes: (s) => new TextEncoder().encode(s),
  fromBytes: (b) => new TextDecoder().decode(b),
};
