const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inflateRawSync } = require('node:zlib');
const { RELEASES_URL, compareVersions } = require('./runtime.cjs');

const repository = new URL(RELEASES_URL).pathname.replace(/\/releases$/, '');
const installationsDir = '.calculator-updates';
const maxArchiveSize = 16 * 1024 * 1024;
const versionPattern = /^\d{1,8}\.\d{1,8}\.\d{1,8}$/;
const directoryPattern = /^v(\d{1,8}\.\d{1,8}\.\d{1,8})-[a-zA-Z0-9]+$/;
const activationFile = '.installed';

async function fetchBytes(url, { size, allowRedirect = false, api = false, progress } = {}) {
  const signal = AbortSignal.timeout(30000);
  for (let hop = 0; hop <= 4; hop++) {
    const allowedHost = api ? url.hostname === 'api.github.com' :
      url.hostname === 'github.com' || (allowRedirect && url.hostname === 'release-assets.githubusercontent.com');
    if (url.protocol !== 'https:' || !allowedHost || url.username || url.password || url.port) throw Error('invalid-download-url');
    const response = await fetch(url, {
      signal, redirect: 'manual', headers: {
        'User-Agent': 'melvor-idle-2-calculator',
        ...(api ? { Accept: 'application/vnd.github+json' } : {})
      }
    });
    if (allowRedirect && response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      await response.body?.cancel();
      url = new URL(response.headers.get('location'), url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw Error('download-http-' + response.status);
    }
    const expected = size ?? Number(response.headers.get('content-length'));
    if (expected > maxArchiveSize) {
      await response.body.cancel();
      throw Error('download-too-large');
    }
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > (size ?? maxArchiveSize)) throw Error('download-too-large');
      chunks.push(chunk);
      progress?.(received, expected || null);
    }
    if (size != null && received !== size) throw Error('invalid-download-size');
    return Buffer.concat(chunks, received);
  }
  throw Error('too-many-redirects');
}

function digestFromAssetPage(html, zipName) {
  const description = 'aria-label="Copy to clipboard digest for ' + zipName + '"';
  const offset = html.indexOf(description);
  if (offset < 0) return null;
  const start = html.lastIndexOf('<clipboard-copy ', offset);
  if (start < 0) return null;
  return /\bvalue="sha256:([a-f0-9]{64})"/i.exec(html.slice(start, html.indexOf('>', offset)))?.[1] ?? null;
}

async function releaseAsset(version) {
  const tag = 'v' + version;
  const name = 'Melvor-Idle-2-Calculator-' + tag + '.zip';
  const url = RELEASES_URL + '/download/' + tag + '/' + name;
  try {
    const api = new URL('https://api.github.com/repos' + repository + '/releases/tags/' + tag);
    const release = JSON.parse(await fetchBytes(api, { api: true }));
    const asset = release.tag_name === tag && !release.draft && !release.prerelease &&
      release.assets?.find(item => item.name === name && item.browser_download_url === url && item.state === 'uploaded');
    const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset?.digest);
    if (digest && Number.isInteger(asset.size) && asset.size > 0 && asset.size <= maxArchiveSize) {
      return { url, digest: digest[1].toLowerCase(), size: asset.size };
    }
  } catch {
    // Public API rate limits can prevent reading the release asset metadata.
  }
  const html = (await fetchBytes(new URL(RELEASES_URL + '/expanded_assets/' + tag))).toString('utf8');
  const digest = digestFromAssetPage(html, name);
  if (!digest) throw Error('missing-release-digest');
  return { url, digest: digest.toLowerCase() };
}

function archiveEntries(zip) {
  // Standard single-disk ZIP central directory. Release archives fit within these limits.
  let end = zip.length - 22;
  const earliest = Math.max(0, end - 65535);
  while (end >= earliest && (zip.readUInt32LE(end) !== 0x06054b50 ||
      end + 22 + zip.readUInt16LE(end + 20) !== zip.length)) end--;
  if (end < earliest) throw Error('invalid-zip-directory');
  const disk = zip.readUInt32LE(end + 4);
  const count = zip.readUInt16LE(end + 10);
  const start = zip.readUInt32LE(end + 16);
  if (disk || count < 1 || count > 400 || zip.readUInt16LE(end + 8) !== count ||
      start + zip.readUInt32LE(end + 12) !== end) throw Error('unsupported-zip-directory');

  let offset = start;
  let expandedSize = 0;
  const seen = new Set();
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50) throw Error('invalid-zip-entry');
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const compressed = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const local = zip.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    offset = nameStart + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    if (offset > end || flags & 1 || ![0, 8].includes(method) || local + 30 > start ||
        zip.readUInt32LE(local) !== 0x04034b50) throw Error('unsupported-zip-entry');

    const raw = zip.subarray(nameStart, nameStart + nameLength);
    const name = raw.toString('utf8').replaceAll('\\', '/');
    const directory = name.endsWith('/');
    const relative = directory ? name.slice(0, -1) : name;
    const segments = relative.split('/');
    const key = relative.toLowerCase();
    if (seen.has(key) || segments.some(segment => !/^[a-z0-9][a-z0-9._-]*$/i.test(segment) || segment.endsWith('.') ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(segment))) throw Error('invalid-zip-path');
    seen.add(key);
    const vendor = key.startsWith('vendor/');
    if (directory) {
      if (size || key !== 'vendor' && !vendor) throw Error('unexpected-zip-directory');
      continue;
    }
    const allowedName = vendor ? /^(LICENSE|NOTICE)$|\.(js|cjs|css|json|md|txt|wasm)$/i.test(segments.at(-1)) :
      segments.length === 1 && /\.(js|cjs|css|html|cmd|md)$/i.test(relative);
    if (!allowedName) throw Error('unexpected-zip-file');
    const localNameStart = local + 30;
    const localNameEnd = localNameStart + zip.readUInt16LE(local + 26);
    const data = localNameEnd + zip.readUInt16LE(local + 28);
    if (data + compressed > start || !raw.equals(zip.subarray(localNameStart, localNameEnd)) ||
        zip.readUInt16LE(local + 8) !== method || (method === 0 && compressed !== size)) throw Error('invalid-zip-data');
    expandedSize += size;
    if (size > maxArchiveSize || expandedSize > 48 * 1024 * 1024) throw Error('expanded-zip-too-large');
    entries.push({ segments, method, size, bytes: zip.subarray(data, data + compressed) });
  }
  if (offset !== end) throw Error('invalid-zip-directory');
  return entries;
}

function extractUpdate(zip, directory) {
  for (const { segments, method, size, bytes } of archiveEntries(zip)) {
    const content = method === 0 ? bytes : inflateRawSync(bytes, { maxOutputLength: size || 1 });
    if (content.length !== size) throw Error('invalid-zip-file-size');
    const target = path.join(directory, ...segments);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { flag: 'wx' });
  }
}

function removeStagingDirectory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) removeStagingDirectory(target);
    else fs.unlinkSync(target);
  }
  fs.rmdirSync(directory);
}

function installedUpdates(root, baseVersion) {
  const directory = path.join(root, installationsDir);
  try {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const match = directoryPattern.exec(entry.name);
      if (!entry.isDirectory() || !match || compareVersions(match[1], baseVersion) <= 0) return [];
      const install = path.join(directory, entry.name);
      return fs.existsSync(path.join(install, activationFile)) ? [{ directory: install, version: match[1] }] : [];
    }).sort((a, b) => compareVersions(b.version, a.version));
  } catch {
    return [];
  }
}

async function installUpdate(root, version, previousVersion, start, report) {
  if (!versionPattern.test(version) || compareVersions(version, previousVersion) <= 0) throw Error('invalid-release-tag');
  report({ phase: 'downloading' });
  const asset = await releaseAsset(version);
  const bytes = await fetchBytes(new URL(asset.url), {
    size: asset.size, allowRedirect: true, progress: (received, total) => report({ phase: 'downloading', received, total })
  });
  report({ phase: 'verifying' });
  if (createHash('sha256').update(bytes).digest('hex') !== asset.digest) throw Error('invalid-release-digest');

  const updates = path.join(root, installationsDir);
  fs.mkdirSync(updates, { recursive: true });
  if (!fs.lstatSync(updates).isDirectory()) throw Error('invalid-updates-directory');
  const directory = fs.mkdtempSync(path.join(updates, 'v' + version + '-'));
  let replacement;
  try {
    extractUpdate(bytes, directory);
    for (const file of ['start.cjs', 'runtime.cjs', 'updater.cjs', 'index.html', 'Start-GP-Calculator.cmd']) {
      if (!fs.statSync(path.join(directory, file)).isFile()) throw Error('incompatible-update');
    }
    const runtime = fs.readFileSync(path.join(directory, 'runtime.cjs'), 'utf8');
    if (/^const VERSION\s*=\s*['"](\d+\.\d+\.\d+)['"]\s*;/m.exec(runtime)?.[1] !== version) {
      throw Error('incompatible-update');
    }
    report({ phase: 'installing' });
    replacement = await start(directory);
    fs.writeFileSync(path.join(directory, activationFile), '', { flag: 'wx' });
    return replacement;
  } catch (error) {
    await replacement?.close();
    try { removeStagingDirectory(directory); } catch { /* Ignore cleanup failures for inactive updates. */ }
    throw error;
  }
}

module.exports = { installedUpdates, installUpdate };
