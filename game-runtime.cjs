const path = require('node:path');
const { createHash } = require('node:crypto');
const { inflateRawSync } = require('node:zlib');

const gameAssembly = 'GamesByMalcs.Melvor2';
const runtimeFolder = assembly => 'data_' + assembly + '_windows_x86_64';
const gameAssemblyPath = game => path.join(game, runtimeFolder(gameAssembly), gameAssembly + '.dll');
const runtimeSize = 11803536;
const localizedSize = 11793408;
const currentRuntime = 'ad27d7141953bb76927f9e74992d629106455c7c017f3d0138ac8268ccf9796c';
const localizedRuntime = 'be3448992183315f9be43e2a91fdf3902a48bba5aaf58de8ae26aafd9596bb4b';
const queueRuntimes = new Map([
  ['0a5a9fff320aaaff781816dee0eee938d61d14982ba7f4523dd8ca31d95f27a9', 11732368],
  [currentRuntime, runtimeSize],
  [localizedRuntime, localizedSize]
]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const needsRuntimeLocalization = original => original.length === runtimeSize && digest(original) === currentRuntime;

function localizeRuntime(original) {
  if (!needsRuntimeLocalization(original)) return undefined;
  const delta = Buffer.from(require('./vendor/game-runtime-zh-26886380.json').data, 'base64');
  function assert(valid) { if (!valid) throw new Error('runtime-patch-invalid'); }
  assert(delta.toString('ascii', 0, 8) === 'M2ZHDP01' &&
    delta.readBigUInt64LE(8) === BigInt(runtimeSize) && delta.readBigUInt64LE(16) === BigInt(localizedSize) &&
    delta.toString('hex', 24, 56) === currentRuntime && delta.toString('hex', 56, 88) === localizedRuntime &&
    delta.readBigUInt64LE(88) === BigInt(delta.length - 96));
  const changes = inflateRawSync(delta.subarray(96), { maxOutputLength: 4 * 1024 * 1024 });
  const target = Buffer.alloc(localizedSize);
  let position = 0, written = 0;
  while (position < changes.length) {
    const operation = changes[position++];
    if (operation === 255) {
      assert(position === changes.length && written === target.length && digest(target) === localizedRuntime);
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
    } else assert(false);
  }
  throw new Error('runtime-patch-invalid');
}

module.exports = { gameAssembly, runtimeFolder, gameAssemblyPath, queueRuntimes, needsRuntimeLocalization, localizeRuntime };
