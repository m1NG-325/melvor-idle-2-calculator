const path = require('node:path');
const { createHash } = require('node:crypto');
const { inflateRawSync } = require('node:zlib');

const gameAssembly = 'GamesByMalcs.Melvor2';
const runtimeFolder = assembly => 'data_' + assembly + '_windows_x86_64';
const gameAssemblyPath = game => path.join(game, runtimeFolder(gameAssembly), gameAssembly + '.dll');
const runtimeSize = 11803536;
const priorLocalizedSize = 11793408;
const localizedSize = 11794432;
const currentRuntime = 'ad27d7141953bb76927f9e74992d629106455c7c017f3d0138ac8268ccf9796c';
const priorLocalizedRuntime = 'be3448992183315f9be43e2a91fdf3902a48bba5aaf58de8ae26aafd9596bb4b';
const localizedRuntime = '4a879988d738cfd907c13f6b9af4d57d95ab29822db640c5e9355a7dd5fcaf69';
const queueRuntimes = new Map([
  ['0a5a9fff320aaaff781816dee0eee938d61d14982ba7f4523dd8ca31d95f27a9', 11732368],
  [currentRuntime, runtimeSize],
  [priorLocalizedRuntime, priorLocalizedSize],
  [localizedRuntime, localizedSize]
]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const localizableRuntimes = new Map([[runtimeSize, currentRuntime], [priorLocalizedSize, priorLocalizedRuntime]]);
function needsRuntimeLocalization(original) {
  const hash = localizableRuntimes.get(original.length);
  return !!hash && digest(original) === hash;
}

function localizeRuntime(original) {
  if (!needsRuntimeLocalization(original)) return undefined;
  const previous = original.length === runtimeSize
    ? applyRuntimeDelta(original, require('./vendor/game-runtime-zh-26886380.json').data,
      currentRuntime, priorLocalizedRuntime, priorLocalizedSize)
    : original;
  return applyRuntimeDelta(previous, require('./vendor/game-runtime-zh-duration-26886380.json').data,
    priorLocalizedRuntime, localizedRuntime, localizedSize);
}

function applyRuntimeDelta(original, encoded, fromHash, targetHash, targetSize) {
  const delta = Buffer.from(encoded, 'base64');
  function assert(valid) { if (!valid) throw new Error('runtime-patch-invalid'); }
  assert(delta.toString('ascii', 0, 8) === 'M2ZHDP01' &&
    delta.readBigUInt64LE(8) === BigInt(original.length) && delta.readBigUInt64LE(16) === BigInt(targetSize) &&
    delta.toString('hex', 24, 56) === fromHash && delta.toString('hex', 56, 88) === targetHash &&
    delta.readBigUInt64LE(88) === BigInt(delta.length - 96));
  const changes = inflateRawSync(delta.subarray(96), { maxOutputLength: 2 * targetSize });
  const target = Buffer.alloc(targetSize);
  let position = 0, written = 0;
  while (position < changes.length) {
    const operation = changes[position++];
    if (operation === 255) {
      assert(position === changes.length && written === target.length && digest(target) === targetHash);
      return target;
    }
    if (operation === 0) {
      const offset = Number(changes.readBigUInt64LE(position));
      const length = Number(changes.readBigUInt64LE(position + 8));
      position += 16;
      assert(length > 0 && offset + length <= original.length && written + length <= target.length);
      original.copy(target, written, offset, offset + length);
      written += length;
    } else if (operation === 1) {
      const length = changes.readUInt32LE(position);
      position += 4;
      assert(length > 0 && position + length <= changes.length && written + length <= target.length);
      changes.copy(target, written, position, position + length);
      position += length;
      written += length;
    } else if (operation === 2) {
      // A modified source range stores the byte differences modulo 256.
      const offset = Number(changes.readBigUInt64LE(position));
      const length = changes.readUInt32LE(position + 8);
      position += 12;
      assert(length > 0 && offset + length <= original.length && position + length <= changes.length &&
        written + length <= target.length);
      for (let index = 0; index < length; index++) {
        target[written + index] = (original[offset + index] + changes[position + index]) & 255;
      }
      position += length;
      written += length;
    } else assert(false);
  }
  throw new Error('runtime-patch-invalid');
}

module.exports = { gameAssembly, runtimeFolder, gameAssemblyPath, queueRuntimes, needsRuntimeLocalization, localizeRuntime };
