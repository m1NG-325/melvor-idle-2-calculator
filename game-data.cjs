const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { GOLD, localId } = require('./game-ids.cjs');

function findSteamGame() {
  const query = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], {
    encoding: 'utf8', windowsHide: true
  });
  const registryPath = query.stdout?.match(/^\s*SteamPath\s+REG_SZ\s+(.+)$/mi)?.[1].trim();
  const libraries = new Set([registryPath, ...[process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter(Boolean).map(directory => path.join(directory, 'Steam'))].filter(Boolean));
  for (const library of [...libraries]) {
    const libraryFile = path.join(library, 'steamapps', 'libraryfolders.vdf');
    if (!fs.existsSync(libraryFile)) continue;
    for (const match of fs.readFileSync(libraryFile, 'utf8').matchAll(/^\s*"path"\s+"([^"]+)"/gmi)) {
      libraries.add(match[1].replace(/\\\\/g, '\\'));
    }
  }
  for (const library of libraries) {
    const steamApps = path.join(library, 'steamapps');
    const manifest = path.join(steamApps, 'appmanifest_3218350.acf');
    const name = fs.existsSync(manifest)
      ? fs.readFileSync(manifest, 'utf8').match(/"installdir"\s+"([^"]+)"/)?.[1] : null;
    const game = path.join(steamApps, 'common', name ?? 'Melvor Idle 2');
    if (fs.existsSync(path.join(game, 'Melvor2.exe'))) return game;
  }
  throw new Error('未找到 Melvor Idle 2。请将含 Melvor2.exe 的游戏文件夹拖到 Start-GP-Calculator.cmd 上。');
}

function readPackedFile(executable, resourcePath, { onChecksumMismatch } = {}) {
  const handle = fs.openSync(executable, 'r');
  const size = fs.fstatSync(handle).size;
  function read(offset, length) {
    if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > size) {
      throw new Error('游戏数据区偏移无效');
    }
    const buffer = Buffer.alloc(length);
    if (fs.readSync(handle, buffer, 0, length, offset) !== length) throw new Error('游戏数据读取不完整');
    return buffer;
  }
  const u64 = (buffer, offset) => Number(buffer.readBigUInt64LE(offset));

  try {
    const dos = read(0, 64);
    const peOffset = dos.readUInt32LE(60);
    const pe = read(peOffset, 24);
    if (dos.toString('ascii', 0, 2) !== 'MZ' || pe.readUInt32LE(0) !== 0x4550) {
      throw new Error('无法识别 Melvor2.exe');
    }
    const sectionCount = pe.readUInt16LE(6);
    const sections = read(peOffset + 24 + pe.readUInt16LE(20), sectionCount * 40);
    let packOffset;
    let packEnd;
    for (let entry = 0; entry < sections.length; entry += 40) {
      if (sections.toString('ascii', entry, entry + 8).replace(/\0+$/, '') === 'pck') {
        packOffset = sections.readUInt32LE(entry + 20);
        packEnd = packOffset + sections.readUInt32LE(entry + 16);
        break;
      }
    }
    if (packOffset === undefined) throw new Error('没有找到内嵌 Godot 数据包');
    const header = read(packOffset, 40);
    if (header.toString('ascii', 0, 4) !== 'GDPC' || header.readUInt32LE(4) !== 4 ||
        header.readUInt32LE(20) !== 2) throw new Error('暂不支持这个游戏数据包版本');
    const dataStart = packOffset + u64(header, 24);
    const directoryStart = packOffset + u64(header, 32);
    const directoryLength = packEnd - directoryStart - 12;
    if (dataStart < packOffset + 40 || dataStart > directoryStart ||
        directoryLength < 4 || directoryLength > 32 * 1024 * 1024) throw new Error('游戏数据目录无效');
    const directory = read(directoryStart, directoryLength);
    const count = directory.readUInt32LE(0);
    let cursor = 4;
    for (let entry = 0; entry < count; entry++) {
      const nameLength = directory.readUInt32LE(cursor);
      cursor += 4;
      if (nameLength < 1 || cursor + nameLength + 36 > directory.length) throw new Error('游戏数据目录不完整');
      const name = directory.toString('utf8', cursor, cursor + nameLength).replace(/\0+$/, '');
      cursor += nameLength;
      if (name.replace(/^res:\/\//, '') === resourcePath) {
        const offset = dataStart + u64(directory, cursor);
        const length = u64(directory, cursor + 8);
        if (offset < dataStart || offset + length > directoryStart || length > 64 * 1024 * 1024 ||
            directory.readUInt32LE(cursor + 32) !== 0) throw new Error('物品与配方数据区无效');
        const bytes = read(offset, length);
        const digest = crypto.createHash('md5').update(bytes).digest();
        const matched = digest.equals(directory.subarray(cursor + 16, cursor + 32));
        if (!matched && !onChecksumMismatch) throw new Error('物品与配方数据校验失败');
        if (!matched) onChecksumMismatch();
        return bytes;
      }
      cursor += 36;
    }
    throw new Error('数据包内找不到 ' + path.posix.basename(resourcePath));
  } finally {
    fs.closeSync(handle);
  }
}

function readPackage(executable, options) {
  const bytes = readPackedFile(executable, 'Data/Packages/MelvorBase.json', options);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function getBuild(gameDirectory) {
  const manifest = path.resolve(gameDirectory, '..', '..', 'appmanifest_3218350.acf');
  return fs.existsSync(manifest)
    ? fs.readFileSync(manifest, 'utf8').match(/"buildid"\s+"(\d+)"/)?.[1] ?? '未知'
    : '未知';
}

module.exports = { findSteamGame, GOLD, getBuild, localId, readPackage, readPackedFile };
