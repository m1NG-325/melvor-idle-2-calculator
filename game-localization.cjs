const fs = require('node:fs');
const files = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pipeline } = require('node:stream/promises');
const { readBasePackageBytes, readPackedFile, withGamePack, basePackagePath, originalBasePackagePath } = require('./game-data.cjs');
const correctedFormatSources = require('./vendor/own-game-format-fixes.json');
const runtimeTexts = require('./vendor/own-game-runtime-texts.json');
const { gameAssemblyPath, needsRuntimeLocalization, localizeRuntime } = require('./game-runtime.cjs');

// The current Steam build registers only en_GB in project.binary.
const localePath = 'Locale/en_GB.po';
const marker = /^# Calculator-zh-CN (?:r\d+ )?[a-f0-9]{32}\r?\n/m;
const currentMarker = /^# Calculator-zh-CN r6 [a-f0-9]{32}\r?\n/;
const cookingDifficultyTemplates = [
  '[color=#E9DFC1]Your [color=#FFD16D]Proficiency[/color]: 0[/color]',
  '[color=#E9DFC1]Your [color=#FFD16D]Proficiency[/color]: {0:N0}[/color]',
  '[color=#E9DFC1]Product [color=#FFD16D]Difficulty[/color]: 0[/color]',
  '[color=#E9DFC1]Product [color=#FFD16D]Difficulty[/color]: {0:N0}[/color]',
  '[color=#E9DFC1]Success Chance: 0.00%[/color]',
  '[color=#E9DFC1]Success Chance: {0:p2}[/color]'
];
const displayFields = new Set([
  'TemplateString', 'Singular', 'Plural', 'Description', 'DisplayName', 'DisplayNameShort', 'Subtitle', 'Backstory',
  'BackstoryBBCode', 'CompletedDescription', 'DialogueText', 'CustomRewards', 'CustomDescription', 'ResistanceName',
  'ResistanceNameShort', 'SightingText', 'Observation', 'UnlockText', 'OverridePlantTerminology',
  'OverrideHarvestTerminology', 'OverrideIngredientError'
]);
const variables = value => [...value.matchAll(/\{([\w.]+)(?=[:,}])/g)].map(match => match[1]).sort().join('|');

function translatedText(key, dictionary) {
  const translation = Object.hasOwn(dictionary, key) ? dictionary[key] : undefined;
  const format = Object.hasOwn(correctedFormatSources, key) ? correctedFormatSources[key] : key;
  return translation && variables(format) === variables(translation) ? translation : undefined;
}

function poText(entry, field) {
  const match = entry.match(new RegExp('^' + field + ' ("[^\\n]*")(?:\\r?\\n("[^\\n]*"(?:\\r?\\n"[^\\n]*")*))?', 'm'));
  if (!match) return '';
  return JSON.parse(match[1]) + (match[2]?.split(/\r?\n/).map(line => JSON.parse(line)).join('') ?? '');
}

function translateLocale(original, dictionary, id, additional = runtimeTexts) {
  let count = 0;
  const existing = new Set();
  const locale = original.replace(marker, '').split(/(\r?\n(?:[ \t]*\r?\n)+)/).map(entry => {
    try {
      const key = poText(entry, 'msgid');
      if (!key) return entry;
      existing.add(JSON.stringify([poText(entry, 'msgctxt'), key]));
      const translation = translatedText(key, dictionary);
      if (!translation || /^#,.*\bfuzzy\b/m.test(entry)) return entry;
      const plural = translatedText(poText(entry, 'msgid_plural'), dictionary);
      const result = entry.replace(/^(msgstr(?:\[(\d+)\])?) "[^\n]*"(?:(?:\r?\n)"[^\n]*")*/gm,
        (_, field, index) => field + ' ' + JSON.stringify(index && index !== '0' && plural ? plural : translation));
      if (result !== entry) count++;
      return result;
    } catch {
      return entry;
    }
  }).join('');
  const extra = [];
  for (const [key, plural, context] of additional) {
    const identity = JSON.stringify([context, key]);
    const translation = translatedText(key, dictionary);
    if (!translation || existing.has(identity)) continue;
    existing.add(identity);
    const fields = context ? ['msgctxt ' + JSON.stringify(context)] : [];
    fields.push('msgid ' + JSON.stringify(key));
    if (plural) {
      fields.push('msgid_plural ' + JSON.stringify(plural), 'msgstr[0] ' + JSON.stringify(translation),
        'msgstr[1] ' + JSON.stringify(translatedText(plural, dictionary) ?? translation));
    } else fields.push('msgstr ' + JSON.stringify(translation));
    extra.push(fields.join('\n'));
  }
  return { bytes: Buffer.from('# Calculator-zh-CN r6 ' + id + '\n' + locale + '\n\n' + extra.join('\n\n') + '\n'),
    count: count + extra.length };
}

function translateCookingDifficultyScene(source, dictionary) {
  if (source.toString('ascii', 0, 4) !== 'RSRC') return null;
  const bytes = Buffer.from(source);
  let count = 0;
  // The label formats its numeric value before Godot's automatic translation.
  // Rewrite only complete, same-length scene strings so resource offsets stay valid.
  for (const key of cookingDifficultyTemplates) {
    const text = translatedText(key, dictionary);
    if (!text) continue;
    const original = Buffer.from(key);
    const localized = Buffer.from(text);
    if (original.length !== localized.length) continue;
    const offset = source.indexOf(original);
    if (offset < 8 || source[offset + original.length] !== 0 ||
        source.readUInt32LE(offset - 8) !== 5 || source.readUInt32LE(offset - 4) !== original.length + 1) continue;
    localized.copy(bytes, offset);
    count++;
  }
  return count ? { bytes, count } : null;
}

function translateBasePackage(bytes, dictionary) {
  const source = bytes.toString('utf8');
  const tokens = /"(?:[^"\\]|\\.)*"/gs;
  const directValue = /\s*:\s*("(?:[^"\\]|\\.)*")/ys;
  const chunks = [];
  let cursor = 0;
  let count = 0;
  for (const token of source.matchAll(tokens)) {
    if (!displayFields.has(token[0].slice(1, -1))) continue;
    directValue.lastIndex = token.index + token[0].length;
    const match = directValue.exec(source);
    if (!match) continue;
    const key = JSON.parse(match[1]);
    const translation = translatedText(key, dictionary);
    if (!translation || translation === key) continue;
    const end = directValue.lastIndex;
    chunks.push(source.slice(cursor, end - match[1].length), JSON.stringify(translation));
    cursor = end;
    count++;
  }
  chunks.push(source.slice(cursor));
  return { bytes: Buffer.from(chunks.join('')), count };
}

async function stageLocalizedExe(exe, destination, replacements) {
  const layout = withGamePack(exe, pack => {
    const { entries, directory, directoryStart, directoryEntriesEnd, read, size, peOffset, packSection, packOffset, packEnd, dataStart } = pack;
    const optionalHeader = peOffset + 24;
    const header = read(optionalHeader, 152);
    const certificateOffset = header.readUInt32LE(144);
    const certificateSize = header.readUInt32LE(148);
    const oldFooter = read(packEnd - 12, 12);
    if (header.readUInt16LE(0) !== 0x20b ||
        oldFooter.toString('ascii', 8) !== 'GDPC' || oldFooter.readBigUInt64LE() !== BigInt(packEnd - 12 - packOffset) ||
        (packEnd !== size && (certificateOffset !== packEnd || certificateOffset + certificateSize !== size))) {
      throw new Error('unsupported');
    }
    const originalBaseEntry = entries.get(basePackagePath);
    if (originalBaseEntry === undefined) throw new Error('unsupported');
    const extraEntries = [];
    if (!entries.has(originalBasePackagePath)) {
      const name = Buffer.from(originalBasePackagePath);
      const nameLength = Math.ceil((name.length + 1) / 4) * 4;
      const alias = Buffer.alloc(4 + nameLength + 36);
      alias.writeUInt32LE(nameLength);
      name.copy(alias, 4);
      directory.copy(alias, 4 + nameLength, originalBaseEntry, originalBaseEntry + 36);
      directory.writeUInt32LE(directory.readUInt32LE(0) + 1);
      extraEntries.push(alias);
    }
    let newDirectoryStart = directoryStart;
    const chunks = [];
    for (const [name, bytes] of replacements) {
      const entry = entries.get(name);
      if (entry === undefined || directory.readUInt32LE(entry + 32) !== 0) throw new Error('unsupported');
      const padding = Buffer.alloc((16 - bytes.length % 16) % 16);
      directory.writeBigUInt64LE(BigInt(newDirectoryStart - dataStart), entry);
      directory.writeBigUInt64LE(BigInt(bytes.length), entry + 8);
      crypto.createHash('md5').update(bytes).digest().copy(directory, entry + 16);
      chunks.push(bytes, padding);
      newDirectoryStart += bytes.length + padding.length;
    }
    const packSize = newDirectoryStart + directory.length + extraEntries.reduce((total, entry) => total + entry.length, 0) - packOffset;
    const footer = Buffer.alloc(12);
    footer.writeBigUInt64LE(BigInt(packSize));
    footer.write('GDPC', 8);
    const sectionSize = Buffer.alloc(4);
    sectionSize.writeUInt32LE(packSize + footer.length);
    const directoryOffset = Buffer.alloc(8);
    directoryOffset.writeBigUInt64LE(BigInt(newDirectoryStart - packOffset));
    return { directoryStart, chunks: [...chunks, directory.subarray(0, directoryEntriesEnd), ...extraEntries,
      directory.subarray(directoryEntriesEnd), footer], patches: [
      [optionalHeader + 64, Buffer.alloc(4)],   // PE checksum
      [optionalHeader + 144, Buffer.alloc(8)], // Original Authenticode signature only covers the unmodified EXE
      [packSection + 16, sectionSize],
      [packOffset + 32, directoryOffset]
    ] };
  });
  await pipeline(fs.createReadStream(exe, { end: layout.directoryStart - 1 }), fs.createWriteStream(destination, { flags: 'wx' }));
  const handle = await files.open(destination, 'r+');
  try {
    let position = layout.directoryStart;
    for (const bytes of layout.chunks) {
      if ((await handle.write(bytes, 0, bytes.length, position)).bytesWritten !== bytes.length) throw new Error('incomplete-write');
      position += bytes.length;
    }
    for (const [offset, bytes] of layout.patches) {
      if ((await handle.write(bytes, 0, bytes.length, offset)).bytesWritten !== bytes.length) throw new Error('incomplete-write');
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (const [name, bytes] of replacements) {
    if (!readPackedFile(destination, name).equals(bytes)) throw new Error('verification-failed');
  }
}

async function gameIsOpen() {
  const { stdout } = await promisify(execFile)('tasklist.exe', [
    '/FI', 'IMAGENAME eq Melvor2.exe', '/FO', 'CSV', '/NH'
  ], { windowsHide: true, timeout: 5000 });
  return /^"Melvor2\.exe"/im.test(stdout);
}

function createGameLocalization(exe, log, isOpen = gameIsOpen) {
  let busy = false;
  const getLocale = () => readPackedFile(exe, localePath).toString('utf8');
  const assembly = gameAssemblyPath(path.dirname(exe));
  function status() {
    if (busy) return 'busy';
    try {
      const locale = getLocale();
      if (currentMarker.test(locale) && !needsRuntimeLocalization(fs.readFileSync(assembly))) return 'installed';
      return marker.test(locale) ? 'outdated' : 'available';
    } catch {
      return 'unsupported';
    }
  }

  async function install() {
    if (busy) return { state: 'busy' };
    busy = true;
    let temporary;
    let runtimeStage;
    let runtimeRollback;
    const unchanged = (before, now) =>
      before.ino === now.ino && before.size === now.size && before.mtimeMs === now.mtimeMs;
    try {
      if (await isOpen()) return { state: 'game-open' };
      const before = await files.stat(exe);
      const original = getLocale();
      const runtimeBefore = await files.stat(assembly);
      const originalRuntime = await files.readFile(assembly);
      const runtime = localizeRuntime(originalRuntime);
      if (currentMarker.test(original) && !runtime) return { state: 'installed' };
      const id = crypto.randomBytes(16).toString('hex');
      const dictionary = require('./vendor/own-game-zh.json');
      const locale = translateLocale(original, dictionary, id);
      const originalData = readBasePackageBytes(exe);
      const data = translateBasePackage(originalData, dictionary);
      if (!locale.count && !data.count) return { state: 'unsupported' };
      temporary = path.join(path.dirname(exe), '.calculator-zh-stage-' + id + '.tmp');
      const replacements = [[localePath, locale.bytes], [basePackagePath, data.bytes]];
      const cookingScene = withGamePack(exe, ({ entries }) =>
        [...entries.keys()].find(name => name.endsWith('-cooking_difficulty_view.scn')));
      const cooking = cookingScene && translateCookingDifficultyScene(readPackedFile(exe, cookingScene), dictionary);
      if (cooking) replacements.push([cookingScene, cooking.bytes]);
      await stageLocalizedExe(exe, temporary, replacements);
      if (runtime) {
        runtimeStage = assembly + '.' + id + '.tmp';
        runtimeRollback = assembly + '.' + id + '.rollback.tmp';
        await files.writeFile(runtimeStage, runtime, { flag: 'wx', flush: true });
        await files.writeFile(runtimeRollback, originalRuntime, { flag: 'wx', flush: true });
      }
      if (await isOpen()) return { state: 'game-open' };
      const [now, runtimeNow] = await Promise.all([files.stat(exe), files.stat(assembly)]);
      if (!unchanged(before, now) || !unchanged(runtimeBefore, runtimeNow)) throw new Error('game-changed');
      if (runtimeStage) await files.rename(runtimeStage, assembly);
      try {
        await files.rename(temporary, exe);
      } catch (error) {
        if (runtimeRollback) {
          try {
            await files.rename(runtimeRollback, assembly);
          } catch {
            log.record('game_localization_rollback_failed');
          }
        }
        throw error;
      }
      log.record('game_localization_installed', { messages: locale.count, dataFields: data.count, runtime: !!runtime });
      return { state: 'installed', count: locale.count + data.count + (cooking?.count ?? 0) };
    } catch (error) {
      log.record('game_localization_failed', { code: error.code ?? error.message });
      if (error.code === 'ENOSPC') return { state: 'no-space' };
      return { state: error.message === 'unsupported' ? 'unsupported' : 'failed' };
    } finally {
      if (temporary) await files.rm(temporary, { force: true }).catch(() => {});
      if (runtimeStage) await files.rm(runtimeStage, { force: true }).catch(() => {});
      if (runtimeRollback) await files.rm(runtimeRollback, { force: true }).catch(() => {});
      busy = false;
    }
  }

  return { status, install };
}

module.exports = { createGameLocalization, translateLocale, translateBasePackage, translateCookingDifficultyScene };
