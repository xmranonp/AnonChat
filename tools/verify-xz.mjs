// Verifies lib/xz.js byte for byte against the system `xz` binary (needs xz-utils). Exits non-zero on any mismatch.

import xzmod from '../lib/xz.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const { decompressXz } = xzmod;
const dir = mkdtempSync(join(tmpdir(), 'xz-'));
const bin = join(dir, 't.bin');

function make(kind, n) {
  if (kind === 'random') return randomBytes(n);
  if (kind === 'zeros')  return Buffer.alloc(n);
  if (kind === 'repeat') return Buffer.from('DE/US/FR/JP/'.repeat(Math.ceil(n / 12)).slice(0, n));
  return Buffer.concat([Buffer.from('X'.repeat(Math.floor(n / 2))), randomBytes(Math.ceil(n / 2))]);
}

let pass = 0, fail = 0;
for (const kind of ['random', 'zeros', 'repeat', 'mixed'])
  for (const n of [0, 1, 100, 5000, 80000, 2_000_000])
    for (const preset of ['-0', '-6', '-9e']) {
      const data = make(kind, n);
      writeFileSync(bin, data);
      execFileSync('xz', ['-zkf', preset, bin]);
      try {
        const out = Buffer.from(decompressXz(readFileSync(bin + '.xz')));
        if (Buffer.compare(out, data) === 0) pass++;
        else { fail++; console.log(`  ✗ ${kind} n=${n} ${preset} — mismatch (${out.length} vs ${data.length})`); }
      } catch (e) { fail++; console.log(`  ✗ ${kind} n=${n} ${preset} — threw: ${e.message}`); }
    }

console.log(fail === 0
  ? `✅ xz: all ${pass} cases match system xz byte-for-byte`
  : `❌ xz: ${fail} of ${pass + fail} cases failed`);
process.exit(fail === 0 ? 0 : 1);
