const fs = require('node:fs');
const path = require('node:path');
const { brotliDecompressSync, constants } = require('node:zlib');
const { parseHeader, parseProfile, parseCharacterStatistics, MAX_SAVE_BYTES } = require('./save-parser.cjs');

function decompress(bytes) {
  // Version 31 saves flush the Brotli stream before its final marker.
  return brotliDecompressSync(bytes, { finishFlush: constants.BROTLI_OPERATION_FLUSH, maxOutputLength: MAX_SAVE_BYTES });
}

function readHeader(bytes) {
  return parseHeader(decompress(bytes));
}

function readProfile(file, ...options) {
  const data = decompress(fs.readFileSync(file));
  return parseProfile(data, fs.statSync(file).mtime.toISOString(), ...options);
}

function readCharacterStatistics(file) {
  const data = decompress(fs.readFileSync(file));
  return parseCharacterStatistics(data, fs.statSync(file).mtime.toISOString());
}

function findSaves() {
  const gameSaves = path.join(process.env.APPDATA || '', 'Games By Malcs', 'Melvor Idle 2');
  const steam = path.join(gameSaves, 'steam');
  const entries = directory => {
    try { return fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error.code)) return [];
      throw error;
    }
  };
  const directories = [path.join(gameSaves, 'saves'), ...entries(steam)
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => path.join(steam, entry.name, 'saves'))];
  const discovered = [];
  for (const directory of directories) for (const entry of entries(directory)) {
    if ((!entry.isFile() && !entry.isSymbolicLink()) || !/^save_.*\.sav$/i.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) discovered.push({ file, modified: stat.mtimeMs });
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return discovered.sort((a, b) => b.modified - a.modified).map(row => row.file);
}

module.exports = { findSaves, readProfile, readHeader, readCharacterStatistics };
