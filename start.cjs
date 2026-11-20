const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Script } = require('node:vm');
const { findSteamGame, getBuild, readPackage } = require('./game-data.cjs');
const { makeCatalog } = require('./catalog.cjs');
const { makeShopCatalog } = require('./shop-catalog.cjs');
const { addGameLabels } = require('./game-labels.cjs');
const { findSaves, readHeader, readProfile } = require('./saves.cjs');
const { VERSION, RELEASES_URL, checkForUpdate, createLog } = require('./runtime.cjs');
const { installUpdate, installedUpdates } = require('./updater.cjs');
const preferencesLimit = 512 * 1024;

function readPreferences(preferencesFile) {
  try {
    if (fs.statSync(preferencesFile).size > preferencesLimit) return {};
    const data = JSON.parse(fs.readFileSync(preferencesFile, 'utf8'));
    return data?.version === 1 ? data : {};
  } catch {
    return {};
  }
}

async function writePreferences(request, response, json, preferencesFile, log) {
  if (request.headers['content-type'] !== 'application/json') return json(response, {}, 415);
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > preferencesLimit) return json(response, {}, 413);
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data?.version !== 1) return json(response, {}, 400);
    const temporary = preferencesFile + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(data), { flag: 'wx' });
      fs.renameSync(temporary, preferencesFile);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    response.writeHead(204).end();
  } catch {
    log.record('settings_write_failed');
    json(response, {}, 422);
  }
}

async function launch({ root = __dirname, args = process.argv.slice(2), updateNotice } = {}) {
  const log = createLog(root);
  const preferencesFile = path.join(root, 'calculator-settings.json');
  log.record('startup', { node: process.versions.node, platform: process.platform });
  const source = path.resolve(args.find(arg => !arg.startsWith('--')) ?? findSteamGame());
  const standalone = fs.statSync(source).isFile();
  const game = standalone ? path.dirname(source) : source;
  let checksumMismatch = false;
  let catalog;
  let shop;
  try {
    const data = readPackage(standalone ? source : path.join(game, 'Melvor2.exe'), {
      onChecksumMismatch() {
        checksumMismatch = true;
        log.record('game_data_checksum_mismatch');
      }
    });
    catalog = makeCatalog(data);
    shop = makeShopCatalog(data);
    if (checksumMismatch && (!Object.keys(catalog.items).length || !catalog.xpActions.length || !shop.groups.length)) {
      throw new Error('游戏数据缺少必需内容 / Required game data is missing');
    }
  } catch (error) {
    log.record('game_data_load_failed', { phase: catalog ? 'shop' : 'package_or_catalog' });
    console.error('无法读取游戏数据。可将原版 Melvor2.exe 的备份拖到启动器上重试。');
    console.error('Could not load game data. Drag a backup of the original Melvor2.exe onto the launcher to try again.');
    throw error;
  }
  catalog.build = standalone ? '未知' : getBuild(game);
  catalog.dataSource = standalone ? 'selected-file' : 'installed';
  catalog.checksumMismatch = checksumMismatch;
  addGameLabels(game, catalog.build, catalog, shop, !standalone);
  const constellations = catalog.xpActions.filter(action => action.kind === 'Astrology');
  log.record('game_data_loaded', { build: /^\d+$/.test(catalog.build) ? catalog.build : 'unknown',
    gpActions: catalog.actions.length, xpActions: catalog.xpActions.length, source: catalog.dataSource, checksumMismatch });
  const assets = {
    '': ['text/html', 'index.html'],
    'app.css': ['text/css', 'app.css'],
    'rank.js': ['text/javascript', 'rank.js'],
    'experience.js': ['text/javascript', 'experience.js'],
    'xp-progress.js': ['text/javascript', 'xp-progress.js'],
    'combat.js': ['text/javascript', 'combat.js'],
    'combat-model.js': ['text/javascript', 'combat-model.js'],
    'preferences.js': ['text/javascript', 'preferences.js'],
    'choices.js': ['text/javascript', 'choices.js'],
    'shop.js': ['text/javascript', 'shop.js'],
    'ui.js': ['text/javascript', 'ui.js'],
    'language.js': ['text/javascript', 'language.js'],
    'vendor/opencc/cn2t.js': ['text/javascript', 'vendor/opencc/cn2t.js']
  };
  if (updateNotice === 'installed' || root !== __dirname) {
    for (const [type, filename] of Object.values(assets)) {
      const file = path.join(__dirname, filename);
      const source = fs.readFileSync(file, 'utf8');
      if (!source.trim()) throw Error('empty-update-asset');
      if (type === 'text/javascript') new Script(source, { filename });
    }
  }
  const canInstall = process.platform === 'win32' && typeof fetch === 'function';
  let update = { state: 'checking' };
  let installation;
  let loggedClientErrors = 0;
  const token = randomBytes(20).toString('hex');
  const prefix = '/' + token + '/';
  const json = (response, body, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };
  function beginUpdate() {
    const report = progress => { installation = progress; };
    installUpdate(root, update.latest, VERSION, async directory => {
      const replacement = require(path.join(directory, 'start.cjs'));
      return replacement.launch({ root, args: [source, '--no-open'], updateNotice: 'installed' });
    }, report).then(next => {
      log.record('update_installed', { latest: update.latest });
      report({ phase: 'ready', url: next.url });
      setTimeout(() => server.close(), 120000).unref();
    }).catch(error => {
      const detail = /^[a-z0-9_-]{1,50}$/i.test(error.code ?? error.message) ? error.code ?? error.message : 'installer-error';
      log.record('update_failed', { phase: installation?.phase, code: detail });
      report({ phase: 'failed' });
    });
  }
  let saves = [];
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const host = '127.0.0.1:' + server.address().port;
    const pathname = request.url.split('?', 1)[0];
    if (request.headers.host !== host || !pathname.startsWith(prefix)) {
      json(response, { error: '页面不存在' }, 404);
      return;
    }
    const route = pathname.slice(prefix.length);
    if (route === 'preferences' && request.method === 'POST') return void writePreferences(request, response, json, preferencesFile, log);
    if (route === 'update/install' && request.method === 'POST') {
      if (request.headers.origin !== 'http://' + host || request.headers['x-calculator-update'] !== 'install') {
        return json(response, {}, 403);
      }
      if (!canInstall || update.state !== 'available' ||
          (installation && installation.phase !== 'failed')) return json(response, {}, 409);
      beginUpdate();
      return json(response, installation ?? { phase: 'downloading' }, 202);
    }
    const browserError = /^diagnostics\/client-error(?:\/(language|rank|ui|shop|experience|xp-progress|combat|combat-model|preferences|choices)\.js\/(\d{1,6}))?$/.exec(route);
    if (browserError && request.method === 'POST') {
      if (loggedClientErrors++ < 20) log.record('browser_error', {
        script: browserError[1], line: browserError[2] && Number(browserError[2])
      });
      response.writeHead(204).end();
      return;
    }
    if (request.method !== 'GET') return json(response, { error: '页面不存在' }, 404);
    try {
      if (route === 'status') return json(response, { version: VERSION, releases: RELEASES_URL, ...update,
        canInstall, installation, updateNotice });
      if (route === 'preferences') return json(response, readPreferences(preferencesFile));
      if (route === 'diagnostics/log') {
        response.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': 'attachment; filename="Melvor-Idle-2-Calculator.log"'
        });
        return response.end(log.download());
      }
      if (route === 'catalog') return json(response, catalog);
      if (route === 'shop') return json(response, shop);
      if (route === 'saves') {
        saves = findSaves();
        log.record('saves_scanned', { count: saves.length });
        return json(response, saves.map((file, index) => {
          try {
            const { name, characterId } = readHeader(fs.readFileSync(file));
            return { index, name, characterId };
          } catch {
            log.record('save_header_unreadable');
            return { index, unknown: true };
          }
        }));
      }
      const profile = route.match(/^profile\/(\d+)$/);
      if (profile && saves[Number(profile[1])]) {
        const data = readProfile(saves[Number(profile[1])], catalog.xpSkills, shop.levelSkills, catalog.mastery, constellations,
          (component, skill) => log.record('save_component_unreadable', { component, skill }));
        log.record('profile_loaded');
        return json(response, data);
      }
      if (Object.hasOwn(assets, route)) {
        const [type, file] = assets[route];
        const body = fs.readFileSync(path.join(__dirname, file));
        response.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
        response.end(body);
        return;
      }
      json(response, { error: '页面不存在' }, 404);
    } catch (error) {
      console.error(error.message);
      const endpoint = route.startsWith('profile/') ? 'profile' : Object.hasOwn(assets, route) ? 'asset' :
        ['saves', 'shop', 'catalog'].includes(route) ? route : 'other';
      log.record('request_failed', { endpoint, code: /^[A-Z_0-9]+$/.test(error.code ?? '') ? error.code : 'read_error' });
      json(response, { error: '读取失败。可切换到手动设置。' }, 422);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const url = 'http://127.0.0.1:' + server.address().port + prefix;
      console.log('Melvor Idle 2 Calculator v' + VERSION);
      console.log('Steam build: ' + catalog.build + ' | Actions: ' + catalog.actions.length);
      if (checksumMismatch) {
        console.log('已读取校验值不同的游戏数据，收益按读到的配方估算。');
        console.log('Loaded game data with a different checksum. Estimates use the recipes that could be read.');
      }
      console.log(url);
      if (log.file) console.log('运行日志 / Runtime log: ' + log.file);
      console.log('请保留此窗口。按 Ctrl+C 退出。 / Keep this window open. Press Ctrl+C to exit.');
      checkForUpdate().then(result => {
        update = result;
        log.record('update_checked', result);
        if (result.state === 'available') console.log('发现新版本 / Update available: v' + result.latest + ' ' + RELEASES_URL);
      });
      resolve({ url, close: () => new Promise(done => server.close(done)) });
    });
  });
}

async function boot(args) {
  const candidates = [...installedUpdates(__dirname, VERSION).map(({ directory }) => directory), __dirname];
  let updateNotice;
  let lastError;
  for (const directory of candidates) {
    try {
      const start = directory === __dirname ? launch : require(path.join(directory, 'start.cjs')).launch;
      const { url } = await start({ root: __dirname, args, updateNotice });
      if (!args.includes('--no-open')) {
        const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
        child.on('error', () => console.log('Open the address above in a browser.'));
      }
      return;
    } catch (error) {
      lastError = error;
      updateNotice = 'restored';
    }
  }
  console.error(lastError.message);
  const log = createLog();
  log.record('startup_failed', { code: /^[A-Z_0-9]+$/.test(lastError.code ?? '') ? lastError.code : 'startup_error' });
  if (log.file) console.error('运行日志 / Runtime log: ' + log.file);
  process.exitCode = 1;
}

if (require.main === module) void boot(process.argv.slice(2));
module.exports = { launch };
