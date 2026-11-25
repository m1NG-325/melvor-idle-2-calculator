const fs = require('node:fs');
const path = require('node:path');
const { readPackage, readPackedFile } = require('./game-data.cjs');
const { makeCatalog } = require('./catalog.cjs');
const { makeShopCatalog } = require('./shop-catalog.cjs');
const bundledChineseNames = require('./vendor/game-names-zh.json');

function originalPackage(game, build) {
  const backups = path.join(game, 'Melvor2_简体中文', 'backups');
  if (!fs.existsSync(backups)) return null;
  for (const entry of fs.readdirSync(backups, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(build + '-')) continue;
    try {
      return readPackage(path.join(backups, entry.name, 'Melvor2.exe.original'));
    } catch {
      // Labels are optional. A backup must never prevent loading the installed game.
    }
  }
  return null;
}

const hasChinese = text => /\p{Script=Han}/u.test(text ?? '');
const displayText = value => typeof value === 'string' ? value : value?.Singular ?? value?.Message;

function readChineseNames(executable, locale = 'zh_CN') {
  const source = readPackedFile(executable, 'Locale/' + locale + '.po').toString('utf8');
  const names = new Map();
  for (const entry of source.split(/\r?\n\s*\r?\n/)) {
    if (/^#,.*\bfuzzy\b/m.test(entry)) continue;
    const fields = {};
    let key;
    for (const line of entry.split(/\r?\n/)) {
      const field = /^(msgctxt|msgid|msgid_plural|msgstr(?:\[\d+\])?)\s+(".*")$/.exec(line);
      const continuation = /^(".*")$/.exec(line);
      try {
        if (field) {
          key = field[1];
          fields[key] = JSON.parse(field[2]);
        } else if (key && continuation) {
          fields[key] += JSON.parse(continuation[1]);
        }
      } catch {
        key = null;
      }
    }
    const { msgid, msgctxt } = fields;
    const name = fields.msgstr || fields['msgstr[0]'];
    if (!msgid || !hasChinese(name)) continue;
    const priority = (entry.includes('Data/Packages/MelvorBase.json') ? 3 : 0) +
      (!msgctxt ? 2 : msgctxt === 'PluralName' ? 1 : 0);
    if (priority > (names.get(msgid)?.priority ?? -1)) names.set(msgid, { name, priority });
  }
  return names;
}

function addGameLabels(game, build, catalog, shop, useAlternate = true, executable = path.join(game, 'Melvor2.exe')) {
  const chinese = hasChinese(catalog.items.NormalLog?.name);
  let alternate;
  if (useAlternate && chinese) {
    try {
      alternate = originalPackage(game, build);
    } catch {
      // The installed package is enough to run without backup access.
    }
  } else if (useAlternate) {
    const translated = path.join(game, 'Melvor2_简体中文', 'prototype', 'Data', 'Packages', 'MelvorBase.json');
    try {
      if (fs.existsSync(translated)) alternate = JSON.parse(fs.readFileSync(translated, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      // The original data remains usable without a translation file.
    }
  }
  const alternatives = {};
  if (alternate) {
    try {
      const otherCatalog = makeCatalog(alternate);
      if (hasChinese(otherCatalog.items.NormalLog?.name) !== chinese) {
        alternatives.catalog = otherCatalog;
        alternatives.shop = makeShopCatalog(alternate);
      }
    } catch {
      // Only names are taken from the optional second package.
    }
  }
  let chineseNames;
  try {
    chineseNames = readChineseNames(executable);
  } catch {
    // Some game builds omit the Chinese locale. Keep the names that are available.
  }
  function officialChinese(original) {
    const translatedName = name => chineseNames?.get(name)?.name ??
      (Object.hasOwn(bundledChineseNames, name) ? bundledChineseNames[name] : undefined);
    const exact = translatedName(original);
    if (exact || !original?.includes(' · ')) return exact;
    const parts = original.split(' · ');
    const translated = parts.map(part => hasChinese(part) ? part : translatedName(part));
    if (translated.some(Boolean)) return translated.filter(Boolean).join(' · ');
  }
  const label = (source, alternate, id) => {
    const original = displayText(source);
    const translated = displayText(alternate);
    const names = {};
    if (hasChinese(original)) {
      names.zh = original;
      names.en = translated && !hasChinese(translated) ? translated : humanize(id);
    } else {
      names.en = original;
      const localized = hasChinese(translated) ? translated : officialChinese(original);
      if (localized) names.zh = localized;
    }
    return names;
  };
  const otherActions = new Map((alternatives.catalog?.xpActions ?? []).map(action => [action.id, action]));
  for (const [id, item] of Object.entries(catalog.items)) {
    item.names = label(item.name, alternatives.catalog?.items[id]?.name, id);
  }
  for (const action of new Set([...catalog.actions, ...catalog.xpActions])) {
    const other = otherActions.get(action.id);
    action.names ??= label(action.name, other?.name, action.recipe);
    if (action.area) action.areaNames = label(action.area, other?.area, action.location ?? action.category);
  }
  const otherEnemies = new Map((alternatives.catalog?.combatTargets ?? []).map(enemy => [enemy.id, enemy.name]));
  const otherAreas = new Map((alternatives.catalog?.combatTargets ?? []).flatMap(enemy =>
    enemy.areas.map(area => [area.id, area.name])
  ));
  for (const enemy of catalog.combatTargets) {
    enemy.names = label(enemy.name, otherEnemies.get(enemy.id), enemy.id);
    for (const area of enemy.areas) area.names = label(area.name, otherAreas.get(area.id), area.id);
  }
  const otherDungeons = new Map((alternatives.catalog?.combatDungeons ?? []).map(row => [row.id, row.name]));
  for (const dungeon of catalog.combatDungeons ?? []) {
    dungeon.names = label(dungeon.name, otherDungeons.get(dungeon.id), dungeon.id.slice('Dungeon:'.length));
  }
  for (const key of ['combatSlots', 'combatSpells', 'statisticSubjects']) {
    for (const [id, record] of Object.entries(catalog[key])) {
      record.names = label(record.name, alternatives.catalog?.[key]?.[id]?.name, id);
    }
  }
  for (const key of ['weaponTypes', 'stances', 'styles', 'attributes', 'names', 'prayers']) {
    for (const [id, record] of Object.entries(catalog.combatModel[key])) {
      record.names = label(record.name, alternatives.catalog?.combatModel?.[key]?.[id]?.name, id);
    }
  }
  const otherGroups = new Map((alternatives.shop?.groups ?? []).map(group => [group.id, group.name]));
  for (const group of shop.groups) group.names = label(group.name, otherGroups.get(group.id), group.id);
  const skillShop = catalog.skillShop;
  skillShop.group.names = label(skillShop.group.name, otherGroups.get(skillShop.group.id), skillShop.group.id);
  for (const [id, section] of Object.entries(skillShop.sections)) {
    section.names = label(section.name, alternatives.catalog?.skillShop?.sections?.[id]?.name, id);
  }
  const otherUpgrades = new Map([
    ...(alternatives.shop?.upgrades ?? []), ...(alternatives.shop?.referenceUpgrades ?? [])
  ].map(upgrade => [upgrade.id, upgrade]));
  const alternateNames = new Map(['ShopPurchase', 'Dungeon', 'SlayerMaster', 'Quest'].flatMap(type =>
    (alternate?.Objects?.[type] ?? []).map(entry => [entry.Id, entry.DisplayName])
  ));
  for (const upgrade of [...shop.upgrades, ...shop.referenceUpgrades]) {
    const other = otherUpgrades.get(upgrade.id);
    upgrade.names = label(upgrade.name, other?.name, upgrade.id);
    upgrade.sectionNames = label(upgrade.section, other?.section, upgrade.sectionId);
    for (const gate of [...upgrade.requirements, ...upgrade.displayRequirements.flat()]) {
      if (gate.name) gate.names = label(gate.name, alternatives.shop ? alternateNames.get(gate.id) : null, gate.id);
    }
  }
  shop.currencyLabels = Object.fromEntries(Object.entries(shop.currencies).map(([id, name]) => [
    id, label(name, alternatives.shop?.currencies[id], id)
  ]));
  const otherGuide = alternatives.catalog?.questGuide;
  const otherQuests = new Map((otherGuide?.quests ?? []).map(quest => [quest.id, quest.name]));
  for (const quest of catalog.questGuide.quests) quest.names = label(quest.name, otherQuests.get(quest.id), quest.id);
  for (const [ref, record] of Object.entries(catalog.questGuide.names)) {
    record.names = label(record.name, otherGuide?.names[ref]?.name, ref.slice(ref.indexOf(':') + 1));
  }
  const englishByChinese = new Map();
  const addReverseLabels = names => {
    for (const [english, { name }] of names ?? []) {
      if (!hasChinese(english) && !englishByChinese.has(name)) englishByChinese.set(name, english);
    }
  };
  addReverseLabels(chineseNames);
  if (chinese && !alternatives.catalog) {
    try {
      addReverseLabels(readChineseNames(executable, 'en_GB'));
    } catch {
      // Some builds have only one locale in the package.
    }
  }
  for (const [id, record] of Object.entries(catalog.itemDetailLabels ?? {})) {
    const name = displayText(record.name);
    const alternateName = displayText(alternatives.catalog?.itemDetailLabels?.[id]?.name);
    const other = alternateName ?? englishByChinese.get(name);
    if (id.startsWith('skill:')) record.names = { zh: name, en: id.slice(6) };
    else {
      const neutral = id.startsWith('modifier:') && !/[\p{L}]/u.test(name?.replace(/\{[^{}]*\}/g, '') ?? '');
      record.names = hasChinese(name) ? { zh: name, en: other && !hasChinese(other) ? other : englishByChinese.get(name) } :
        { en: other && !hasChinese(other) ? other : name,
          zh: neutral ? name : hasChinese(other) ? other : officialChinese(name) };
    }
  }
}

function humanize(id) {
  return id?.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}

module.exports = { addGameLabels };
