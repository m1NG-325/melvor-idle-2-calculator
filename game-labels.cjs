const fs = require('node:fs');
const path = require('node:path');
const { readPackage } = require('./game-data.cjs');
const { makeCatalog } = require('./catalog.cjs');
const { makeShopCatalog } = require('./shop-catalog.cjs');

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

function addGameLabels(game, build, catalog, shop, useAlternate = true) {
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
  const locale = chinese ? 'zh' : 'en';
  const otherLocale = chinese ? 'en' : 'zh';
  const label = (original, translated, id) => {
    const names = { [locale]: original };
    if (translated) names[otherLocale] = translated;
    else if (chinese && hasChinese(original)) names.en = humanize(id);
    return names;
  };
  const otherActions = new Map((alternatives.catalog?.xpActions ?? []).map(action => [action.id, action]));
  for (const [id, item] of Object.entries(catalog.items)) {
    item.names = label(item.name, alternatives.catalog?.items[id]?.name, id);
  }
  for (const action of new Set([...catalog.actions, ...catalog.xpActions])) {
    const other = otherActions.get(action.id);
    action.names = label(action.name, other?.name, action.recipe);
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
  for (const key of ['combatSlots', 'combatSpells']) {
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
}

function humanize(id) {
  return id?.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}

module.exports = { addGameLabels };
