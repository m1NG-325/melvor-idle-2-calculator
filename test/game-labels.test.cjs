const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('vanilla game labels use the embedded Chinese locale while retaining English names', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'game-labels.cjs'), 'utf8');
  const locale = [
    '#: Data/Packages/MelvorBase.json\nmsgctxt "PluralName"\nmsgid "Adamant Gloves"\nmsgid_plural "Adamant Gloves"\nmsgstr[0] "精金手套"',
    'msgid "Rune Dagger"\nmsgstr ""\n"符文"\n"匕首"',
    'msgid "Coal"\nmsgstr "煤炭"',
    '#, fuzzy\nmsgid "New Item"\nmsgstr "待校对"'
  ].join('\n\n');
  const context = {
    module: { exports: {} },
    require: id => id === './game-data.cjs' ? {
      readPackedFile(executable, member) {
        assert.equal(executable, 'vanilla.exe');
        assert.equal(member, 'Locale/zh_CN.po');
        return Buffer.from(locale);
      }
    } : id.startsWith('node:') ? require(id) : {}
  };
  vm.runInNewContext(source, context);
  const items = {
    Gloves: { name: 'Adamant Gloves' }, Dagger: { name: 'Rune Dagger' }, New: { name: 'New Item' }
  };
  const action = { id: 'Coal', name: 'Coal' };
  const catalog = { items, actions: [action], xpActions: [action], combatTargets: [],
    combatSlots: {}, combatSpells: {}, statisticSubjects: { Dagger: { name: { Singular: 'Rune Dagger' } } },
    combatModel: { weaponTypes: {}, stances: {}, styles: {}, attributes: {}, names: {}, prayers: {} },
    skillShop: { group: { name: 'Shop' }, sections: {} }, questGuide: { quests: [], names: {} } };
  const shop = { groups: [], upgrades: [], referenceUpgrades: [], currencies: {} };

  context.module.exports.addGameLabels('.', 'test', catalog, shop, false, 'vanilla.exe');

  assert.equal(items.Gloves.names.zh, '精金手套');
  assert.equal(items.Gloves.names.en, 'Adamant Gloves');
  assert.equal(items.Dagger.names.zh, '符文匕首');
  assert.equal(items.New.names.zh, undefined);
  assert.equal(action.names.zh, '煤炭');
  assert.equal(catalog.statisticSubjects.Dagger.names.zh, '符文匕首');
});

test('game data without locale resources still gets bundled names for known items', () => {
  const { addGameLabels } = require('../game-labels.cjs');
  const items = { IronOre: { name: 'Iron Ore' }, NormalLog: { name: 'Normal Log' }, ModItem: { name: 'Mod Item' } };
  const action = { id: 'Crafting:Test', name: 'Iron Ore · Mod Prefix' };
  const catalog = { items, actions: [action], xpActions: [action], combatTargets: [],
    combatSlots: {}, combatSpells: {}, statisticSubjects: {},
    combatModel: { weaponTypes: {}, stances: {}, styles: {}, attributes: {}, names: {}, prayers: {} },
    skillShop: { group: { name: 'Shop' }, sections: {} }, questGuide: { quests: [], names: {} } };
  addGameLabels('.', 'test', catalog, { groups: [], upgrades: [], referenceUpgrades: [], currencies: {} }, false, 'no-locale.exe');
  assert.deepEqual(items.IronOre.names, { en: 'Iron Ore', zh: '铁矿石' });
  assert.equal(action.names.zh, '铁矿石');
  assert.equal(items.ModItem.names.zh, undefined);
});
