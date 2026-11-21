'use strict';
// Copies of a message already received (design: "Duplicates"). Every copy of a message has the same ciphertext, whether it came directly
// or (later) from a mailbox peer, so (sender, SHA-256 of the ciphertext) identifies it. Remembered for 9 days, across restarts, in one
// sealed file per day (data/dupes/<YYYY-MM-DD>), so a copy that arrives after a restart is not stored and shown a second time.
// Until 1.0.10 this was a set in memory for 24 hours, lost at every restart.
//
// The day's file is rewritten when a message is accepted (as the message's own file is written then), so a copy is recognised even
// after the app was stopped hard a moment later. A day holds a few hundred messages at most in normal use; the inbox limits bound it.
// Every dependency is passed in, so this is testable without the real data folder or clock.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY = 24 * 60 * 60 * 1000;

function create({ dir, seal = (b) => b, open = (b) => b, now = () => Date.now(), keepDays = 9, maxPerDay = 200000, flushMs = 0 } = {}) {
  const days = new Map();          // 'YYYY-MM-DD' -> Set of hex digests
  const dirty = new Set();
  let loaded = false, timer = null;
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  const key = (from, ct) => crypto.createHash('sha256').update(String(from)).update('\n').update(String(ct)).digest('hex');
  const oldestKept = () => dayOf(now() - (keepDays - 1) * DAY);

  function load() {
    if (loaded) return;
    loaded = true;
    let names = [];
    try { names = fs.readdirSync(dir); } catch {}
    const oldest = oldestKept();
    for (const n of names) {
      const p = path.join(dir, n);
      if (n.endsWith('.tmp')) { try { fs.unlinkSync(p); } catch {} continue; }
      if (!/^\d{4}-\d\d-\d\d$/.test(n)) continue;
      if (n < oldest) { try { fs.unlinkSync(p); } catch {} continue; }
      try {
        const list = JSON.parse(open(fs.readFileSync(p), 'dupes').toString('utf8'));
        if (Array.isArray(list)) {
          const set = days.get(n) || new Set();          // merged: copies recorded before the load stay
          for (const x of list) if (typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)) set.add(x);
          days.set(n, set);
        }
      } catch (e) {
        if (e && e.code === 'NO_KEY') { loaded = false; return; }          // the data key isn't given yet: read later, nothing set aside
        // A damaged file costs only its day's memory of copies: set aside, not fatal.
        console.error('[dupes] a day file could not be read and was set aside:', n);
        try { fs.renameSync(p, p + '.damaged'); } catch {}
      }
    }
  }
  function prune() {
    const oldest = oldestKept();
    for (const d of [...days.keys()]) if (d < oldest) { days.delete(d); dirty.delete(d); try { fs.unlinkSync(path.join(dir, d)); } catch {} }
  }
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty.size) return;
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
    for (const d of [...dirty]) {
      const set = days.get(d); if (!set) { dirty.delete(d); continue; }
      const p = path.join(dir, d), tmp = p + '.' + process.pid + '.tmp';
      try {
        fs.writeFileSync(tmp, seal(Buffer.from(JSON.stringify([...set])), 'dupes'), { mode: 0o600 });
        fs.renameSync(tmp, p);
        dirty.delete(d);
      } catch (e) { try { fs.unlinkSync(tmp); } catch {} console.error('[dupes] could not save:', e.message); }
    }
  }
  function later() { if (!flushMs) return flush(); if (!timer) { timer = setTimeout(flush, flushMs); if (timer.unref) timer.unref(); } }

  return {
    // Seen within the last 9 days?
    has(from, ct) {
      load();
      const k = key(from, ct);
      for (const set of days.values()) if (set.has(k)) return true;
      return false;
    },
    // Records it; true if it was seen already (then nothing changes).
    add(from, ct) {
      load();
      const k = key(from, ct);
      for (const set of days.values()) if (set.has(k)) return true;
      const d = dayOf(now());
      if (!days.has(d)) { days.set(d, new Set()); prune(); }
      const set = days.get(d);
      if (set.size < maxPerDay) { set.add(k); dirty.add(d); later(); }          // beyond the cap (a flood): the inbox limits still apply
      return false;
    },
    flush,
    size: () => { load(); let n = 0; for (const s of days.values()) n += s.size; return n; },
    days: () => { load(); return [...days.keys()].sort(); },
  };
}

module.exports = { create };
