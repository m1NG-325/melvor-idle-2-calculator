const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { Script } = require('node:vm');
const { promisify } = require('node:util');
const { findSteamGame, getBuild, readPackage } = require('./game-data.cjs');
const { makeCatalog } = require('./catalog.cjs');
const { makeShopCatalog } = require('./shop-catalog.cjs');
const { addGameLabels } = require('./game-labels.cjs');
const { findSaves, readHeader, readProfile, readCharacterStatistics } = require('./saves.cjs');
const { VERSION, RELEASES_URL, checkForUpdate, createLog } = require('./runtime.cjs');
const { installUpdate, installedUpdates } = require('./updater.cjs');
const { createActionRunner } = require('./action-runner.cjs');
const { bridgeBuild, createGameBridge, directQueueSkills, hasBridgeAssembly } = require('./game-bridge.cjs');
const preferencesLimit = 512 * 1024;
const invalidSelectedSave = '无法读取选中的存档。请选择有效的 Melvor Idle 2 存档。';

async function chooseSaveFile() {
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    try {
      $dialog.Filter = 'Melvor Idle 2 (*.sav)|*.sav'
      $dialog.CheckFileExists = $true
      $dialog.RestoreDirectory = $true
      if ($dialog.ShowDialog($owner) -eq [Windows.Forms.DialogResult]::OK) {
        [Console]::WriteLine($dialog.FileName)
      }
    } finally {
      $dialog.Dispose()
      $owner.Dispose()
    }
  `;
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(executable,
    ['-NoLogo', '-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, maxBuffer: 128 * 1024 });
  return stdout.trim();
}

function writeLocalJson(file, data) {
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(data), { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

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
    writeLocalJson(preferencesFile, data);
    response.writeHead(204).end();
  } catch {
    log.record('settings_write_failed');
    json(response, {}, 422);
  }
}

async function launch({ root = __dirname, args = process.argv.slice(2), updateNotice, pickSave = chooseSaveFile } = {}) {
  const log = createLog(root);
  const preferencesFile = path.join(root, 'calculator-settings.json');
  const selectedSaveFile = path.join(root, 'calculator-selected-save.json');
  let selectedSave;
  try {
    const record = JSON.parse(fs.readFileSync(selectedSaveFile, 'utf8'));
    if (typeof record.file === 'string' && path.isAbsolute(record.file) && /\.sav$/i.test(record.file) &&
        typeof record.name === 'string' && /^[a-f0-9]{32}$/.test(record.characterId)) selectedSave = record;
  } catch { /* The user has not saved a file selection. */ }
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
  addGameLabels(game, catalog.build, catalog, shop, !standalone, standalone ? source : path.join(game, 'Melvor2.exe'));
  const constellations = catalog.xpActions.filter(action => action.kind === 'Astrology');
  const loadSaveProfile = file => readProfile(file, catalog.xpSkills, shop.levelSkills, catalog.mastery, constellations,
    (component, skill) => log.record('save_component_unreadable', { component, skill }), catalog.items);
  log.record('game_data_loaded', { build: /^\d+$/.test(catalog.build) ? catalog.build : 'unknown',
    gpActions: catalog.actions.length, xpActions: catalog.xpActions.length, source: catalog.dataSource, checksumMismatch });
  const assets = {
    '': ['text/html', 'index.html'],
    'app.css': ['text/css', 'app.css'],
    'rank.js': ['text/javascript', 'rank.js'],
    'production.js': ['text/javascript', 'production.js'],
    'action-queue.js': ['text/javascript', 'action-queue.js'],
    'statistics.js': ['text/javascript', 'statistics.js'],
    'experience.js': ['text/javascript', 'experience.js'],
    'xp-progress.js': ['text/javascript', 'xp-progress.js'],
    'combat.js': ['text/javascript', 'combat.js'],
    'combat-model.js': ['text/javascript', 'combat-model.js'],
    'combat-training.js': ['text/javascript', 'combat-training.js'],
    'skill-training.js': ['text/javascript', 'skill-training.js'],
    'preferences.js': ['text/javascript', 'preferences.js'],
    'choices.js': ['text/javascript', 'choices.js'],
    'shop.js': ['text/javascript', 'shop.js'],
    'quests.js': ['text/javascript', 'quests.js'],
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
  const directTargets = new Map(catalog.xpActions.filter(action => directQueueSkills.includes(action.skill))
    .map(action => [action.id, { skill: action.skill, target: 'MelvorBase:' + action.recipe, items: action.outputItems,
      materials: action.costs?.map(([id]) => id), crafting: ['Artisan', 'Cooking', 'Firemaking'].includes(action.kind) }]));
  const gameBridge = process.platform === 'win32' && [bridgeBuild, '未知'].includes(catalog.build) &&
    (!standalone || path.basename(source).toLowerCase() === 'melvor2.exe') &&
    hasBridgeAssembly()
    ? createGameBridge(game, catalog.build) : undefined;
  const actionRunner = gameBridge && createActionRunner(gameBridge, directTargets);
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
      setTimeout(() => {
        actionRunner?.cancel();
        server.close();
      }, 120000).unref();
    }).catch(error => {
      const detail = /^[a-z0-9_-]{1,50}$/i.test(error.code ?? error.message) ? error.code ?? error.message : 'installer-error';
      log.record('update_failed', { phase: installation?.phase, code: detail });
      report({ phase: 'failed' });
    });
  }
  let saves = [];
  let savesByCharacter = new Map();
  let savePickerOpen = false;
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
    if (route.startsWith('action-runner/')) {
      if (!actionRunner) return json(response, { state: 'unavailable' });
      if (route === 'action-runner/status' && request.method === 'GET') {
        return json(response, actionRunner.status());
      }
      if (request.method !== 'POST' || request.headers.origin !== 'http://' + host ||
          request.headers['x-calculator-action-runner'] !== '1') return json(response, { state: 'failed' }, 403);
      void (async () => {
        try {
          if (route === 'action-runner/cancel') actionRunner.cancel();
          else if (route === 'action-runner/start') {
            const chunks = [];
            let length = 0;
            for await (const chunk of request) {
              length += chunk.length;
              if (length > preferencesLimit) return json(response, { state: 'invalid-queue' }, 413);
              chunks.push(chunk);
            }
            const { steps, character, characterId, repeat } = JSON.parse(Buffer.concat(chunks).toString());
            if (typeof characterId !== 'string' || !/^[a-f0-9]{32}$/i.test(characterId)) {
              return json(response, { state: 'invalid-queue' }, 400);
            }
            actionRunner.start(steps, character, repeat, characterId);
          } else return json(response, { state: 'failed' }, 404);
          return json(response, actionRunner.status());
        } catch (error) {
          const state = ['busy', 'invalid-queue'].includes(error.message) ? error.message :
            error.name === 'AbortError' ? 'cancelled' : 'failed';
          return json(response, { state }, 409);
        }
      })();
      return;
    }
    if (route === 'preferences' && request.method === 'POST') return void writePreferences(request, response, json, preferencesFile, log);
    if (route === 'saves/choose' || route === 'saves/forget') {
      if (request.method !== 'POST' || request.headers.origin !== 'http://' + host ||
          request.headers['x-calculator-save-picker'] !== '1') return json(response, {}, 403);
      if (savePickerOpen) return json(response, { error: '存档选择窗口已打开。' }, 409);
      if (route === 'saves/forget') {
        try {
          fs.rmSync(selectedSaveFile, { force: true });
          if (selectedSave) savesByCharacter.delete(selectedSave.characterId);
          selectedSave = undefined;
          return json(response, {});
        } catch {
          return json(response, { error: '无法保存手动存档设置。' }, 422);
        }
      }
      savePickerOpen = true;
      void (async () => {
        try {
          const file = await pickSave();
          if (!file) return json(response, {});
          let profile;
          try {
            if (!path.isAbsolute(file) || !/\.sav$/i.test(file) || !fs.statSync(file).isFile()) throw Error();
            profile = loadSaveProfile(file);
          } catch {
            return json(response, { error: invalidSelectedSave }, 422);
          }
          const { name, characterId } = profile;
          try {
            writeLocalJson(selectedSaveFile, { file, name, characterId });
          } catch {
            return json(response, { error: '无法保存手动存档设置。' }, 422);
          }
          selectedSave = { file, name, characterId };
          return json(response, { characterId });
        } catch {
          return json(response, { error: '无法打开存档选择窗口。' }, 422);
        } finally {
          savePickerOpen = false;
        }
      })();
      return;
    }
    if (route === 'update/install' && request.method === 'POST') {
      if (request.headers.origin !== 'http://' + host || request.headers['x-calculator-update'] !== 'install') {
        return json(response, {}, 403);
      }
      if (!canInstall || update.state !== 'available' ||
          (installation && installation.phase !== 'failed')) return json(response, {}, 409);
      beginUpdate();
      return json(response, installation ?? { phase: 'downloading' }, 202);
    }
    const profileRenderError = /^diagnostics\/profile-render\/(settings|idle|shop|experience|combat|production|queue|statistics|quests)\/(TypeError|RangeError|ReferenceError|SyntaxError|Error)$/.exec(route);
    if (profileRenderError && request.method === 'POST') {
      if (loggedClientErrors++ < 20) log.record('profile_render_error', { section: profileRenderError[1], kind: profileRenderError[2] });
      response.writeHead(204).end();
      return;
    }
    const browserError = /^diagnostics\/client-error(?:\/(language|rank|production|action-queue|statistics|ui|shop|quests|experience|xp-progress|combat|combat-model|combat-training|skill-training|preferences|choices)\.js\/(\d{1,6}))?$/.exec(route);
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
        try {
          saves = findSaves();
        } catch (error) {
          if (!selectedSave) throw error;
          saves = [];
          log.record('save_scan_failed');
        }
        savesByCharacter = new Map();
        if (selectedSave) savesByCharacter.set(selectedSave.characterId, selectedSave.file);
        log.record('saves_scanned', { count: saves.length });
        const discovered = saves.map((file, index) => {
          try {
            const { name, characterId } = readHeader(fs.readFileSync(file));
            if (savesByCharacter.has(characterId)) return null;
            savesByCharacter.set(characterId, file);
            return { index, name, characterId };
          } catch {
            log.record('save_header_unreadable');
            return { index, unknown: true };
          }
        }).filter(Boolean);
        if (selectedSave) {
          const { name, characterId } = selectedSave;
          discovered.unshift({ name, characterId, manuallySelected: true });
        }
        return json(response, discovered);
      }
      const statisticsCharacter = /^statistics\/character\/([a-f0-9]{32})$/.exec(route)?.[1];
      if (statisticsCharacter) {
        const file = savesByCharacter.get(statisticsCharacter);
        if (!file) return json(response, { error: '角色存档已变化，请重新读取存档。' }, 404);
        const data = readCharacterStatistics(file);
        if (data.characterId !== statisticsCharacter) return json(response, { error: '角色存档已变化，请重新读取存档。' }, 409);
        return json(response, data);
      }
      const character = /^profile\/character\/([a-f0-9]{32})$/.exec(route)?.[1];
      const legacyProfile = /^profile\/(\d+)$/.exec(route)?.[1];
      const saveFile = character ? savesByCharacter.get(character) : saves[Number(legacyProfile)];
      if (saveFile) {
        const data = loadSaveProfile(saveFile);
        if (character && data.characterId !== character) return json(response, { error: '角色存档已变化，请重新读取存档。' }, 409);
        log.record('profile_loaded');
        return json(response, data);
      }
      if (character) return json(response, { error: '角色存档已变化，请重新读取存档。' }, 404);
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
      const endpoint = route.startsWith('profile/') ? 'profile' : route.startsWith('statistics/character/') ? 'statistics' : Object.hasOwn(assets, route) ? 'asset' :
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
      resolve({ url, close: () => new Promise(done => {
        actionRunner?.cancel();
        server.close(done);
      }) });
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
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          '$ErrorActionPreference = "Stop"; Start-Process -FilePath $env:MELVOR_CALCULATOR_URL'], {
          env: { ...process.env, MELVOR_CALCULATOR_URL: url },
          windowsHide: true,
          stdio: 'ignore'
        });
        const showAddress = () => console.log('请在浏览器中打开上方地址。 / Open the address above in a browser.');
        child.once('error', showAddress);
        child.once('exit', code => { if (code !== 0) showAddress(); });
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
