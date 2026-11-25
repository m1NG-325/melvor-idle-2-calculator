const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { brotliCompressSync } = require('node:zlib');
const { readCharacterStatistics, readProfile } = require('../saves.cjs');
const { statisticUnit } = require('../statistics.js');

const int = value => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(value);
  return bytes;
};
const double = value => {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value);
  return bytes;
};
const string = value => Buffer.concat([Buffer.from([Buffer.byteLength(value)]), Buffer.from(value)]);
const regions = entries => Buffer.concat([int(entries.length), ...entries.flatMap(([key, bytes]) =>
  [string(key), int(bytes.length), bytes])]);
const dictionary = (...entries) => Buffer.concat([int(entries.length), ...entries.flatMap(([key, value]) =>
  [double(value), string(key)])]);

test('bank tabs with and without an icon keep subsequent stacks and locked items aligned', () => {
  const { parseProfile } = require('../save-parser.cjs');
  for (const version of [31, 32]) {
    const tab = (id, icon) => Buffer.concat([
      Buffer.alloc(14), int(1), int(7), Buffer.from([0, 0]), string(id),
      string('Materials'), int(1), Buffer.from([1, 0]), string('MelvorBase:Ore'),
      ...(version === 32 ? [Buffer.from([Number(Boolean(icon))]), ...(icon ? [string(icon)] : [])] : [])
    ]);
    const bank = Buffer.concat([int(0), int(2), tab('MelvorBase:CopperOre', 'MelvorBase:Tinderbox'),
      tab('MelvorBase:CoalOre'), int(1), string('MelvorBase:CoalOre')]);
    const data = Buffer.concat([
      int(version), Buffer.alloc(16), string('Test'), Buffer.alloc(34),
      regions([
        ['MelvorBase:Bank', regions([['Inventory', bank]])],
        ['MelvorBase:Woodcutting', regions([['Experience', double(0)]])]
      ])
    ]);
    const { stock, keep } = parseProfile(data, '', { Woodcutting: true });
    assert.deepEqual({ ...stock }, { CopperOre: 7, CoalOre: 7 });
    assert.deepEqual(keep, ['CoalOre']);
  }
});

test('a two-handed weapon slot reference does not become a second equipped item', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'melvor-two-handed-'));
  const file = path.join(directory, 'character.sav');
  const header = Buffer.concat([int(31), Buffer.alloc(16), string('Test'), Buffer.alloc(34)]);
  const equipment = (id, quantity) => Buffer.concat([int(quantity), Buffer.from([0, 1]), string(id)]);
  const tool = Buffer.concat([int(3), Buffer.from([1]), string('MelvorBase:Tool')]);
  try {
    fs.writeFileSync(file, brotliCompressSync(Buffer.concat([header, regions([
      ['MelvorBase:Bank', regions([['Inventory', Buffer.alloc(12)]])],
      ['MelvorBase:Woodcutting', regions([
        ['Experience', double(0)],
        ['Toolbelt', regions([
          ['MelvorBase:SkillPotion', Buffer.concat([int(0), Buffer.from([1]), string('MelvorBase:EmptyPotion')])],
          ['MelvorBase:SkillTool', Buffer.concat([int(0), Buffer.from([1]), string('MelvorBase:Axe')])]
        ])]
      ])],
      ['MelvorBase:Combat', regions([
        ['Equipment', regions([
          ['MelvorBase:Weapon', equipment('MelvorBase:Steel2HSword', 1)],
          ['MelvorBase:Offhand', equipment('MelvorBase:Steel2HSword', -1)],
          ['MelvorBase:Ammo', equipment('MelvorBase:IronArrow', 0)]
        ])],
        ['Toolbelt', regions([['MelvorBase:Tool1', tool]])]
      ])]
    ])])));
    const { combat, equipped } = readProfile(file, { Woodcutting: true }, [], {}, [], undefined,
      { EmptyPotion: { skillTool: { consumable: true } } });
    assert.deepEqual(combat.equipment, [
      { slot: 'Weapon', id: 'Steel2HSword', quantity: 1 },
      { slot: 'Ammo', id: 'IronArrow', quantity: 0 }
    ]);
    assert.deepEqual(combat.toolbelt, [{ slot: 'Tool1', id: 'Tool', quantity: 3 }]);
    assert.deepEqual(equipped.Woodcutting, ['Axe']);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

test('character statistics retain all storage groups when one metric cannot be read', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'melvor-statistics-'));
  const file = path.join(directory, 'character.sav');
  const id = Buffer.alloc(16, 0x42);
  const header = Buffer.concat([int(31), id, string('Test character'), Buffer.alloc(34)]);
  const statistics = Buffer.concat([
    regions([['MelvorBase:CombatTimeSpentFighting', double(360000)], ['Mod:Unrecognized', Buffer.alloc(1)]]),
    regions([['MelvorBase:CombatItemGained', dictionary(['MelvorBase:Bones', 14])]]),
    regions([['MelvorBase:CombatCurrencyGained', dictionary(['MelvorBase:GoldPieces', 80])]]),
    regions([['MelvorBase:CombatEnemyKilled', dictionary(['MelvorBase:Goblin', 14])]])
  ]);
  try {
    fs.writeFileSync(file, brotliCompressSync(Buffer.concat([header,
      regions([['MelvorBase:Combat', regions([['Statistics', statistics]])]])])));
    const result = readCharacterStatistics(file);
    assert.equal(result.characterId, id.toString('hex'));
    assert.deepEqual(result.unavailable, []);
    assert.deepEqual(result.sections, [{
      id: 'Combat', unavailable: ['Mod:Unrecognized'], statistics: [
        { id: 'CombatTimeSpentFighting', kind: 'value', value: 360000 },
        { id: 'CombatItemGained', kind: 'item', rows: [{ id: 'Bones', value: 14 }] },
        { id: 'CombatCurrencyGained', kind: 'currency', rows: [{ id: 'GoldPieces', value: 80 }] },
        { id: 'CombatEnemyKilled', kind: 'subject', rows: [{ id: 'Goblin', value: 14 }] }
      ]
    }]);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

test('statistics distinguish duration units from counts and creation dates', () => {
  assert.equal(statisticUnit('CharacterStatistics', 'CharacterCreationDate'), 'date');
  assert.equal(statisticUnit('CharacterStatistics', 'OfflinePlaytime'), 'milliseconds');
  assert.equal(statisticUnit('Combat', 'CombatTimeSpentFighting'), 'milliseconds');
  assert.equal(statisticUnit('Ranching', 'RanchingAnimalTimeSpentAliveStatistic'), 'hours');
  assert.equal(statisticUnit('Combat', 'CombatEnemyKilled'), 'number');
});
