'use strict';

// Manual update check against the project's GitHub releases. It only reports; it never downloads or installs.

const REPO_RE    = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;
const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseRepo(url) {
  const m = REPO_RE.exec(String(url || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

function parseVersion(v) {
  const m = VERSION_RE.exec(String(v || '').trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)], pre: m[4] || '' };
}

function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

async function checkForUpdate({ current, repoUrl, http }) {
  const repo = parseRepo(repoUrl);
  if (!repo) throw new Error('no release source configured');
  const releasesPage = `https://github.com/${repo.owner}/${repo.repo}/releases`;
  const api = `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`;

  const res = await http.get(api, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AnonChat-update-check' },
    validateStatus: (s) => s === 200 || s === 404,
    maxRedirects: 2,             // GitHub redirects a renamed repository; peers' requests allow none (server.js onion())
  });
  if (res.status === 404) {
    return { current, latest: null, updateAvailable: false, url: releasesPage };
  }

  const tag = res.data && res.data.tag_name;
  if (typeof tag !== 'string' || !parseVersion(tag)) throw new Error('unexpected response');
  const latest = tag.replace(/^v/, '');
  const htmlUrl = String((res.data && res.data.html_url) || '');
  const url = htmlUrl.startsWith(releasesPage + '/') ? htmlUrl : releasesPage;
  const cmp = compareVersions(latest, current);
  return {
    current,
    latest,
    updateAvailable: cmp === 1,
    url,
    publishedAt: typeof res.data.published_at === 'string' ? res.data.published_at : null,
  };
}

module.exports = { parseRepo, compareVersions, checkForUpdate };
