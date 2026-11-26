const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({});
for (const script of ['rank.js', 'combat-model.js', 'combat-training.js', 'skill-training.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', script), 'utf8'), context);
}
const { trainingEquipment, trainingRequirementsMet, trainingCraftRecipes, trainingCraftPlan, bestTrainingWithCrafts, stableCombatTraining } =
  vm.runInContext('({ trainingEquipment, trainingRequirementsMet, trainingCraftRecipes, trainingCraftPlan, bestTrainingWithCrafts, stableCombatTraining })', context);
const level = (skill, required, or = false) => ({ type: 'Level', skill, level: required, or });

test('save refresh keeps a viable combat recommendation across near ties', () => {
  const previous = { goalHours: 65 / 60 };
  const nearTie = { goalHours: (64 + 32 / 60) / 60 };
  const faster = { goalHours: 63 / 60 };
  assert.equal(stableCombatTraining(nearTie, previous), previous);
  assert.equal(stableCombatTraining(faster, previous), faster);
  assert.equal(stableCombatTraining(nearTie, null), nearTie);
  assert.equal(stableCombatTraining(nearTie, { goalHours: null, xp: 100 }), nearTie);
  assert.equal(stableCombatTraining({ goalHours: null, xp: 100 }, previous), previous);
});

test('combat area gates use the Agility technique XP curve', () => {
  const requirements = [[{ type: 'AgilityTechniqueLevel', technique: 'Climbing', level: 40 }]];
  const catalog = { xpSkillData: { agilityTechniques: [{ id: 'Climbing', cap: 40 }] } };
  const actor = xp => ({ xpSkillState: { Agility: { Climbing: xp } } });
  assert.equal(trainingRequirementsMet(requirements, actor(38000), 'Melee', catalog), false);
  assert.equal(trainingRequirementsMet(requirements, actor(1e9), 'Melee', catalog), true);
});

test('combat recommendations use owned, equippable gear and respect hand and slot conflicts', () => {
  const item = (slotType, occupies = [], requirements = []) => ({ slotType, occupies, requirements });
  const combatModel = {
    equipmentSlots: [
      { id: 'Weapon', type: 'Weapon', requirements: [] },
      { id: 'Offhand', type: 'Offhand', requirements: [] },
      { id: 'Ammo', type: 'Ammo', requirements: [] },
      { id: 'RingSlot1', type: 'Ring', requirements: [] },
      { id: 'RingSlot2', type: 'Ring', requirements: [level('Crafting', 40)] }
    ],
    items: {
      DefaultWeapon: item('Weapon'), sword: item('Weapon'), shield: item('Offhand'),
      greatsword: item('Weapon', ['Offhand'], [level('Attack', 10)]),
      locked: item('Weapon', [], [level('Attack', 30)]), unowned: item('Weapon'),
      arrows: item('Ammo'), ring: item('Ring')
    }
  };
  const character = {
    stock: { greatsword: 1, locked: 1, ring: 1, arrows: 40 },
    levels: { Attack: 12, Crafting: 39 },
    combat: { equipment: [
      { slot: 'Weapon', id: 'sword', quantity: 1 },
      { slot: 'Offhand', id: 'shield', quantity: 1 },
      { slot: 'Ammo', id: 'arrows', quantity: 20 }
    ] }
  };
  const { options, equip } = trainingEquipment({ combatModel }, character);
  const weapons = options.get('Weapon');
  assert.equal(weapons.some(row => row.id === 'locked' || row.id === 'unowned'), false);
  assert.equal(options.has('RingSlot2'), false);
  assert.equal(options.get('Ammo')[0].quantity, 60);
  const wield = equip(character.combat.equipment, 'Weapon', weapons.find(row => row.id === 'greatsword'));
  assert.ok(wield.find(row => row.id === 'greatsword'));
  assert.equal(wield.some(row => row.slot === 'Offhand'), false);
  assert.equal(equip(wield, 'Offhand', options.get('Offhand')[0]), null);
  assert.equal(character.combat.equipment.length, 3);
});

test('throwing weapons supply their own ammunition and charged gear uses the owned stack', () => {
  const hammer = {
    slotType: 'Weapon', stackable: true, occupies: ['Offhand', 'Ammo'], ammoType: 'ThrowingHammers', requirements: [],
    weapon: { RequiredAmmoType: 'ThrowingHammers' }
  };
  const lantern = { slotType: 'Offhand', stackable: true, occupies: [], requirements: [] };
  const ammo = { slotType: 'Ammo', stackable: true, ammoType: 'Bolts', requirements: [] };
  const crossbow = { slotType: 'Weapon', occupies: [], requirements: [], weapon: { RequiredAmmoType: 'Bolts' } };
  const model = { items: { hammer, lantern, ammo, crossbow },
    equipmentSlots: ['Weapon', 'Offhand', 'Ammo'].map(id => ({ id, type: id, requirements: [] })) };
  const character = { levels: {}, stock: { hammer: 12, lantern: 15, ammo: 20, crossbow: 1 },
    combat: { equipment: [{ slot: 'Weapon', id: 'hammer', quantity: 8 }] } };
  const { options, equip } = trainingEquipment({ combatModel: model }, character);
  const ammoChoices = vm.runInContext('trainingAmmoChoices', context);
  const thrown = options.get('Weapon').find(row => row.id === 'hammer');
  assert.equal(thrown.quantity, 20);
  assert.equal(options.get('Offhand')[0].quantity, 15);
  assert.equal(ammoChoices(thrown, model, options)[0], null);
  assert.equal(ammoChoices({ id: 'crossbow' }, model, options)[0].id, 'ammo');
  assert.equal(equip([thrown], 'Ammo', options.get('Ammo')[0]), null);
});

test('an already equipped two-handed sword is owned even if a running server sends its offhand marker', () => {
  const sword = 'Steel2HSword';
  const weapon = { slot: 'Weapon', id: sword, quantity: 1 };
  const character = { stock: { SteelBar: 4 }, levels: {}, combat: { equipment: [
    weapon, { slot: 'Offhand', id: sword, quantity: -1 }
  ] } };
  const recipes = new Map([[sword, [{ action: { costs: [['SteelBar', 4]] }, quantity: 1 }]]]);
  const combatModel = { equipmentSlots: [{ id: 'Weapon', type: 'Weapon', requirements: [] }],
    items: { [sword]: { slotType: 'Weapon', requirements: [], occupies: ['Offhand'] } } };
  const available = trainingEquipment({ combatModel }, character);
  assert.equal(available.owned[sword], 1);
  assert.equal(available.options.get('Weapon')[0].id, sword);
  assert.equal(trainingCraftPlan([weapon], character, available.owned, recipes).crafts.length, 0);
});

test('combat recommendations exclude blocked areas and preserve requirement alternatives', () => {
  const character = {
    combat: { equipment: [], toolbelt: [{ id: 'lamp' }] }, levels: { Attack: 15, Slayer: 20 },
    questProgress: { done: { status: 3 }, active: { status: 1 } }, dungeonCompletions: { cave: 5 }
  };
  assert.equal(trainingRequirementsMet([[{ type: 'QuestComplete', quest: 'done' }, level('Attack', 40),
    level('Slayer', 20, true)], [{ type: 'DungeonStatistic', statisticTarget: 'cave', statisticValue: 5 }]], character), true);
  assert.equal(trainingRequirementsMet([[{ type: 'QuestComplete', quest: 'active' }, level('Attack', 10)]], character), false);
  assert.equal(trainingRequirementsMet([[{ type: 'ToolbeltItemEquipped', skill: 'Combat', item: 'lamp' }]], character), true);
});

test('craftable gear requires both levels and shares material stock across the whole loadout', () => {
  const item = (slotType, requirements = []) => ({ slotType, requirements, occupies: [] });
  const action = (id, required, costs, quantity = 1) => ({
    id, kind: 'Artisan', skill: 'Smithing', requirementGroups: [[level('Smithing', required)]],
    rewards: [[id, quantity, 1]], costs
  });
  const catalogue = {
    combatModel: {
      items: {
        knife: item('Weapon', [level('Attack', 10)]), gloves: item('Gloves'),
        lockedRecipe: item('Weapon'), lockedGear: item('Weapon', [level('Attack', 30)]),
        arrows: item('Ammo')
      },
      equipmentSlots: ['Weapon', 'Gloves', 'Ammo'].map(id => ({ id, type: id, requirements: [] }))
    },
    actions: [
      action('knife', 10, [['bar', 2]]), action('gloves', 10, [['bar', 2]]),
      action('lockedRecipe', 30, []), action('lockedGear', 10, []), action('arrows', 10, [], 15)
    ]
  };
  const character = { combat: { equipment: [] }, levels: { Smithing: 10, Attack: 10 }, stock: { bar: 3 }, currencies: {} };
  const recipes = trainingCraftRecipes(catalogue, character);
  assert.deepEqual([...recipes.keys()], ['knife', 'gloves']);
  const { options, owned } = trainingEquipment(catalogue, character, recipes);
  const loadout = [options.get('Weapon')[0], options.get('Gloves')[0]];
  const preparation = trainingCraftPlan(loadout, character, owned, recipes);
  assert.equal(preparation.crafts.length, 2);
  assert.equal(preparation.items[0].id, 'bar');
  assert.equal(preparation.items[0].quantity, 4);
  assert.equal(preparation.items[0].missing, 1);
  assert.equal(preparation.crafts[0].itemsNeeded[0].missing, 0);
  assert.equal(preparation.crafts[1].itemsNeeded[0].missing, 1);
  assert.equal(character.stock.bar, 3);
});

test('the expanded equipment recommendation keeps the owned plan unless crafting improves XP', () => {
  const owned = { xp: 7419 };
  assert.equal(bestTrainingWithCrafts(owned, { xp: 7397 }), owned);
  assert.equal(bestTrainingWithCrafts(owned, { xp: 7419 }), owned);
  const faster = { xp: 7600 };
  assert.equal(bestTrainingWithCrafts(owned, faster), faster);
  assert.equal(bestTrainingWithCrafts(null, faster), faster);
});

test('combat training prefers reaching the target sooner over total XP', () => {
  const owned = { xp: 90, goalHours: 0.5 };
  assert.equal(bestTrainingWithCrafts(owned, { xp: 100, goalHours: 1 }), owned);
  const crafted = { xp: 83, goalHours: 0.25 };
  assert.equal(bestTrainingWithCrafts(owned, crafted), crafted);
  assert.equal(bestTrainingWithCrafts({ xp: 82, projectedHours: 0.1 }, crafted), crafted);
});

test('skill training compares unlocked Agility shop equipment and keeps selected actions fixed', () => {
  const solve = vm.runInContext('skillTrainingSearch', context);
  const skill = 'Crafting';
  const action = (id, seconds, xp, rewards = [], costs = [], requirements = []) => ({
    id, recipe: id, skill, kind: 'Artisan', seconds, steps: 1, baseXp: xp, cash: 0,
    requirementGroups: [requirements], rewards, costs, currencyCosts: []
  });
  const tool = (requirements, modifiers) => ({ skillTool: { slotType: 'gloves', requirements }, modifiers });
  const locked = action('lockedRecipe', 10, 5, [['locked', 1, 1]], [], [level(skill, 30)]);
  const offer = (item, required, costs = [], extra = {}) => ({
    id: item, item, quantity: 1, requirementGroups: [[level(skill, required)]], costs, currencyCosts: [], ...extra
  });
  const fast = action('fast', 60, 5);
  const other = action('other', 120, 7);
  const needsShopTool = action('needsShopTool', 1, 100, [], [],
    [{ type: 'ToolbeltItemEquipped', skill, item: 'purchased' }]);
  const catalogue = {
    actions: [locked], xpActions: [fast, other, needsShopTool], equipmentSets: [],
    skillShop: { purchases: [offer('purchased', 10, [['mark', 2]]), offer('locked', 30), offer('soldOut', 10, [], { buyLimit: 1 })] },
    skillToolSlots: { [skill]: [{ id: 'Gloves', type: 'gloves', requirements: [] }] },
    items: {
      saved: tool([], [{ stat: 'PercentXPGained', skill, value: .1 }]),
      owned: tool([], [{ stat: 'PercentInterval', skill, value: -.2 }]),
      purchased: tool([], [{ stat: 'PercentXPGained', skill, value: .5 }]),
      locked: tool([], [{ stat: 'PercentXPGained', skill, value: 1 }]),
      soldOut: tool([], [{ stat: 'PercentXPGained', skill, value: 1.5 }]),
      unavailable: tool([level(skill, 20)], [{ stat: 'PercentXPGained', skill, value: 2 }])
    }
  };
  const character = { levels: { [skill]: 10 }, stock: { mark: 1, owned: 1, unavailable: 1 }, currencies: {}, purchases: { soldOut: 1 },
    equipped: { [skill]: ['saved'] }, skillToolbelt: { [skill]: [{ slot: 'Gloves', id: 'saved', quantity: 1 }] } };
  function result(settings, allowShop) {
    const search = solve(catalogue, character, { skill, hours: 1, goal: { remaining: 12 }, ...settings }, allowShop);
    let step;
    do { step = search.next(); } while (!step.done);
    return step.value;
  }
  const owned = result({}, false);
  const upgrade = result({}, true);
  assert.equal(owned.loadout[0].id, 'owned');
  assert.equal(upgrade.loadout[0].id, 'purchased');
  assert.equal(upgrade.preparation.crafts[0].itemsNeeded[0].missing, 1);
  assert.equal(upgrade.row.action.id, 'fast');
  assert.equal(result({ actionId: 'other' }, true).row.action.id, 'other');
  assert.equal(result({ actionId: 'needsShopTool', ignoreStock: true }, true), null);
  assert.ok(upgrade.target.reaches);
  assert.equal(character.equipped[skill][0], 'saved');
});
