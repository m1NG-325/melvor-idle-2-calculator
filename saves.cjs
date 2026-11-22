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
  const directories = [path.join(gameSaves, 'saves')];
  if (fs.existsSync(steam)) {
    for (const entry of fs.readdirSync(steam, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(path.join(steam, entry.name, 'saves'));
    }
  }
  return directories.filter(directory => fs.existsSync(directory))
    .flatMap(directory => fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^save_.*\.sav$/i.test(entry.name))
      .map(entry => path.join(directory, entry.name)))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

module.exports = { findSaves, readProfile, readHeader, readCharacterStatistics };
