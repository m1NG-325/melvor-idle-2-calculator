const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { findSteamGame, getBuild, readPackage } = require('./game-data.cjs');
const { makeCatalog } = require('./catalog.cjs');
const { makeShopCatalog } = require('./shop-catalog.cjs');
const { findSaves, readHeader, readProfile } = require('./saves.cjs');

function main() {
  const args = process.argv.slice(2);
  const game = path.resolve(args.find(arg => !arg.startsWith('--')) ?? findSteamGame());
  const data = readPackage(path.join(game, 'Melvor2.exe'));
  const catalog = makeCatalog(data);
  const shop = makeShopCatalog(data);
  catalog.build = getBuild(game);
  const assets = {
    '': ['text/html', 'index.html'],
    'app.css': ['text/css', 'app.css'],
    'rank.js': ['text/javascript', 'rank.js'],
    'experience.js': ['text/javascript', 'experience.js'],
    'shop.js': ['text/javascript', 'shop.js'],
    'ui.js': ['text/javascript', 'ui.js']
  };
  const token = randomBytes(20).toString('hex');
  const prefix = '/' + token + '/';
  const json = (response, body, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  };
  let saves = [];
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const host = '127.0.0.1:' + server.address().port;
    if (request.headers.host !== host || request.method !== 'GET' || !request.url.startsWith(prefix)) {
      json(response, { error: '页面不存在' }, 404);
      return;
    }
    const route = request.url.slice(prefix.length);
    try {
      if (route === 'catalog') return json(response, catalog);
      if (route === 'shop') return json(response, shop);
      if (route === 'saves') {
        saves = findSaves();
        return json(response, saves.map((file, index) => {
          try {
            const { name } = readHeader(fs.readFileSync(file));
            return { index, name };
          } catch {
            return { index, name: '存档 ' + (index + 1) + '（格式未知）' };
          }
        }));
      }
      const profile = route.match(/^profile\/(\d+)$/);
      if (profile && saves[Number(profile[1])]) {
        return json(response, readProfile(saves[Number(profile[1])], catalog.xpSkills, shop.levelSkills, catalog.woodMastery));
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
      json(response, { error: '读取失败。可切换到手动设置。' }, 422);
    }
  });
  server.listen(0, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + server.address().port + prefix;
    console.log('Melvor Idle 2 GP calculator');
    console.log('Steam build: ' + catalog.build + ' | Actions: ' + catalog.actions.length);
    console.log(url);
    console.log('Keep this window open while using the calculator. Press Ctrl+C to exit.');
    if (!args.includes('--no-open')) {
      const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
      child.on('error', () => console.log('Open the address above in a browser.'));
    }
  });
  server.on('error', error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
