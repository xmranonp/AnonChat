// Writes SHA256SUMS.txt for the built release artifacts, verifiable with `sha256sum -c`.
// Usage: node tools/release-checksums.mjs [dir]   (default: desktop/dist/)

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const dir = process.argv[2] || join(process.cwd(), 'desktop', 'dist');

const RELEASE_EXT = /\.(deb|rpm|pacman|exe|dmg|zip|tar\.gz|blockmap)$/i;

let files;
try {
  files = readdirSync(dir)
    .filter(f => RELEASE_EXT.test(f))
    .filter(f => statSync(join(dir, f)).isFile())
    .sort();
} catch (e) {
  console.error(`Cannot read ${dir}: ${e.message}`);
  console.error('Build first (e.g. npm run build / build:pacman / build:rpm / build:win), then re-run.');
  process.exit(1);
}

if (files.length === 0) {
  console.error(`No release artifacts found in ${dir}. Build first.`);
  process.exit(1);
}

const lines = [];
for (const f of files) {
  const hash = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  lines.push(`${hash}  ${basename(f)}`);
  console.log(`${hash}  ${f}`);
}

const outPath = join(dir, 'SHA256SUMS.txt');
writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`\nWrote ${outPath} (${files.length} file${files.length === 1 ? '' : 's'}).`);
console.log('Verify with:  sha256sum -c SHA256SUMS.txt   (Linux)');
