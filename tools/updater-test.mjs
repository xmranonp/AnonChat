// Unit tests for lib/updater.js. HTTP is stubbed; no network.
import { createRequire } from 'node:module';
const { parseRepo, compareVersions, checkForUpdate } = createRequire(import.meta.url)('../lib/updater.js');

let passed = 0, failed = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passed++ : (failed++, console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};
const stub = (status, data) => ({ get: async () => ({ status, data }) });
const REPO = 'git+https://github.com/example-org/example-app.git';

eq('repo .git url', parseRepo(REPO), { owner: 'example-org', repo: 'example-app' });
eq('repo plain url', parseRepo('https://github.com/a/b'), { owner: 'a', repo: 'b' });
eq('repo invalid', parseRepo('https://example.com/a/b'), null);

eq('newer patch', compareVersions('1.0.1', '1.0.0'), 1);
eq('older minor', compareVersions('1.1.0', '1.2.0'), -1);
eq('equal with v prefix', compareVersions('v1.2.3', '1.2.3'), 0);
eq('10 > 9 numerically', compareVersions('1.10.0', '1.9.0'), 1);
eq('prerelease < release', compareVersions('2.0.0-rc.1', '2.0.0'), -1);
eq('garbage', compareVersions('latest', '1.0.0'), null);

const page = 'https://github.com/example-org/example-app/releases';
eq('update available', await checkForUpdate({ current: '1.0.0', repoUrl: REPO,
  http: stub(200, { tag_name: 'v1.1.0', html_url: page + '/tag/v1.1.0', published_at: '2026-10-01T00:00:00Z' }) }),
  { current: '1.0.0', latest: '1.1.0', updateAvailable: true, url: page + '/tag/v1.1.0', publishedAt: '2026-10-01T00:00:00Z' });
eq('up to date', (await checkForUpdate({ current: '1.1.0', repoUrl: REPO,
  http: stub(200, { tag_name: 'v1.1.0', html_url: page + '/tag/v1.1.0' }) })).updateAvailable, false);
eq('foreign link is replaced', (await checkForUpdate({ current: '1.0.0', repoUrl: REPO,
  http: stub(200, { tag_name: 'v1.1.0', html_url: 'https://evil.example/x' }) })).url, page);
eq('no releases yet', await checkForUpdate({ current: '1.0.0', repoUrl: REPO, http: stub(404, {}) }),
  { current: '1.0.0', latest: null, updateAvailable: false, url: page });
let threw = false;
try { await checkForUpdate({ current: '1.0.0', repoUrl: REPO, http: stub(200, { tag_name: 'nightly' }) }); } catch { threw = true; }
eq('bad tag rejected', threw, true);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
