'use strict';

// Hashcash-style proof of work for /api/inbox: each delivery costs the sender CPU, which rotating IPs or identities can't avoid.

const crypto = require('crypto');

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_BITS     = parseInt(process.env.POW_BITS || '18', 10);

let current  = null;
let previous = null;

function rotate() {
  previous = current;
  current  = { value: crypto.randomBytes(16).toString('hex'), expiresAt: Date.now() + CHALLENGE_TTL_MS };
}
rotate();

function currentChallenge() {
  if (!current || Date.now() > current.expiresAt) rotate();
  return { challenge: current.value, bits: DEFAULT_BITS, expiresAt: current.expiresAt };
}

function isValidChallenge(c) {
  if (typeof c !== 'string') return false;
  if (current  && c === current.value)  return true;
  // accept the previous one for ~2 min of overlap after rotation
  if (previous && c === previous.value && Date.now() - previous.expiresAt < 2 * 60 * 1000) return true;
  return false;
}

function leadingZeroBits(buf) {
  let bits = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) { bits += 8; continue; }
    let b = buf[i];
    while ((b & 0x80) === 0) { bits++; b <<= 1; }
    break;
  }
  return bits;
}

function verifyProof({ challenge, from, ct, nonce, bits = DEFAULT_BITS }) {
  if (!isValidChallenge(challenge)) return false;
  if (typeof nonce !== 'string' || nonce.length > 64) return false;
  const h = crypto.createHash('sha256');
  h.update(challenge);
  h.update('|');
  h.update(String(from));
  h.update('|');
  h.update(String(ct));
  h.update('|');
  h.update(nonce);
  return leadingZeroBits(h.digest()) >= bits;
}

// Hashcash solver: finds a nonce so that SHA-256(challenge|from|ct|nonce) has at least `bits` leading zero bits.
// The fixed part (challenge|from|ct|) is hashed once and the hash state copied for each attempt, so the cost no longer grows with the
// message size: a 2 MB voice message takes about as long as a one-line text (previously minutes). Same proof format as before.
function solve({ challenge, from, ct, bits, maxAttempts = 50_000_000 }) {
  checkBits(bits);
  const base = crypto.createHash('sha256');
  base.update(challenge); base.update('|');
  base.update(String(from)); base.update('|');
  base.update(String(ct)); base.update('|');
  for (let i = 0; i < maxAttempts; i++) {
    const nonce = i.toString(36);
    const h = base.copy();
    h.update(nonce);
    if (leadingZeroBits(h.digest()) >= bits) return nonce;
  }
  throw new Error(`PoW solver gave up after ${maxAttempts} attempts at ${bits} bits`);
}

// The difficulty comes from the recipient's answer, so it is theirs to choose: any address we write to could ask for a puzzle that
// takes forever (it would be retried with every try of the message, for as long as it waits). Our own nodes ask for DEFAULT_BITS; a
// little room above that is accepted, anything more is refused at once (about 8 s of work at 22 bits, against about half a second at 18).
const MAX_SOLVE_BITS = 22;
function checkBits(bits) {
  if (!Number.isInteger(bits) || bits < 1 || bits > MAX_SOLVE_BITS) throw new Error(`proof of work refused: ${bits} bits asked, at most ${MAX_SOLVE_BITS}`);
}

// The same, on a worker thread, so the backend keeps serving the window and receiving messages while it works.
const WORKER_SRC = `
const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
function lz(buf) { let b = 0; for (let i = 0; i < buf.length; i++) { if (buf[i] === 0) { b += 8; continue; } let x = buf[i]; while ((x & 0x80) === 0) { b++; x <<= 1; } break; } return b; }
const { challenge, from, ct, bits, maxAttempts } = workerData;
const base = crypto.createHash('sha256');
base.update(challenge); base.update('|'); base.update(String(from)); base.update('|'); base.update(String(ct)); base.update('|');
let found = null;
for (let i = 0; i < maxAttempts; i++) { const n = i.toString(36); const h = base.copy(); h.update(n); if (lz(h.digest()) >= bits) { found = n; break; } }
parentPort.postMessage(found);
`;
function solveAsync({ challenge, from, ct, bits, maxAttempts = 50_000_000 }) {
  try { checkBits(bits); } catch (e) { return Promise.reject(e); }
  if (typeof challenge !== 'string' || !challenge || challenge.length > 128) return Promise.reject(new Error('proof of work refused: bad challenge'));
  let Worker;
  try { ({ Worker } = require('worker_threads')); } catch { return Promise.resolve().then(() => solve({ challenge, from, ct, bits, maxAttempts })); }
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER_SRC, { eval: true, workerData: { challenge, from: String(from), ct: String(ct), bits, maxAttempts } });
    w.once('message', (nonce) => { nonce ? resolve(nonce) : reject(new Error(`PoW solver gave up after ${maxAttempts} attempts at ${bits} bits`)); w.terminate(); });
    w.once('error', reject);
  });
}

module.exports = { currentChallenge, verifyProof, solve, solveAsync, MAX_SOLVE_BITS, _internals: { leadingZeroBits, isValidChallenge, DEFAULT_BITS } };
