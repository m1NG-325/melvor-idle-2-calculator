const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');

const VERSION = '0.7.2';
const RELEASES_URL = 'https://github.com/m1NG-325/melvor-idle-2-calculator/releases';
const LATEST_RELEASE = RELEASES_URL + '/latest';

function compareVersions(left, right) {
  const parts = version => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  const a = parts(left);
  const b = parts(right);
  if (!a || !b) throw new Error('invalid-release-tag');
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function checkForUpdate() {
  return new Promise(resolve => {
    const request = https.get(LATEST_RELEASE, {
      headers: { 'User-Agent': 'melvor-idle-2-calculator/' + VERSION }
    }, response => {
      response.resume();
      try {
        const release = new URL(response.headers.location ?? '', LATEST_RELEASE);
        const tag = release.href.startsWith(RELEASES_URL + '/tag/') && release.pathname.split('/').pop();
        if (!(response.statusCode >= 300 && response.statusCode < 400 && tag)) {
          resolve({ state: 'unavailable', reason: 'http-' + response.statusCode });
          return;
        }
        resolve({ state: compareVersions(tag, VERSION) > 0 ? 'available' : 'current', latest: tag.replace(/^v/, '') });
      } catch {
        resolve({ state: 'unavailable', reason: 'invalid-release' });
      }
    });
    const timer = setTimeout(() => request.destroy(new Error('timeout')), 5000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', error => resolve({
      state: 'unavailable', reason: error.message === 'timeout' ? 'timeout' : 'connection-error'
    }));
  });
}

function createLog(root = __dirname) {
  const limit = 128 * 1024;
  let file;
  for (const directory of [root, os.tmpdir()]) {
    try {
      const candidate = path.join(directory, 'Melvor-Idle-2-Calculator.log');
      if (fs.existsSync(candidate) && fs.statSync(candidate).size >= limit) {
        fs.renameSync(candidate, candidate + '.previous');
      }
      fs.appendFileSync(candidate, '');
      file = candidate;
      break;
    } catch { /* Try the next writable location. */ }
  }
  const entries = [];
  return {
    file,
    record(event, details = {}) {
      const line = JSON.stringify({ time: new Date().toISOString(), version: VERSION, event, ...details }) + '\n';
      if (entries.length === 500) entries.shift();
      entries.push(line);
      if (!file) return;
      try {
        if (fs.statSync(file).size >= limit) fs.renameSync(file, file + '.previous');
        fs.appendFileSync(file, line);
      } catch { /* Keep downloads available even if writing to disk fails. */ }
    },
    download() { return entries.join(''); }
  };
}

module.exports = { VERSION, RELEASES_URL, compareVersions, checkForUpdate, createLog };
