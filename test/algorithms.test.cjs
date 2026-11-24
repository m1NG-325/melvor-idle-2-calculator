const test = require('node:test');
const assert = require('node:assert/strict');
const { rank, actionModifiers, projectHourlyProduction, productionCycle } = require('../rank.js');
const { indexProduction, planProduction, compareProduction, productionTimedQueueSteps } = require('../production.js');
const { suggestionMatches } = require('../choices.js');
const { combatFoodProjection, combatSupplyEstimate, combatAttackAverage, estimateCombatEffects } = require('../combat-model.js');
const { estimateCombat, measuredCombatRate, combatExperiencePlan, forecastCombatExperience, combineDungeonSupply } = require('../combat.js');
const { calculateShoppingList } = require('../shop.js');
const { levelFor, xpGoalProgress } = require('../xp-progress.js');
const { makeQuestGuide } = require('../quest-catalog.cjs');

const profile = { levels: { Crafting: 1, Cooking: 11, Farming: 1 }, stock: { ore: 10 },
  currencies: {}, date: '2026-11-21T00:00:00Z' };
const recipe = { id: 'Crafting:test', skill: 'Crafting', kind: 'Artisan', recipe: 'test',
  cash: 0, seconds: 360, steps: 1, baseXp: 7, requirementGroups: [], rewards: [['bar', 1, 1]],
  costs: [['ore', 2], ['ore', 3]], currencyCosts: [] };
const items = { bar: { price: 30 }, ore: { price: 2 } };
const catalog = actions => ({ items, actions, xpActions: actions });
const options = { hours: 1, metric: 'xp', sell: true };

test('item lookup excludes junk only at fishing locations with a guaranteed base catch', () => {
  const spots = [
    { Id: 'Guaranteed', DisplayName: 'Guaranteed', FishChance: 1 },
    { Id: 'Ordinary', DisplayName: 'Ordinary', FishChance: 0.8 }
  ].map(row => ({ ...row, JunkItem: 'MelvorBase:Junk',
    RandomProducts: [{ Item: 'MelvorBase:Fish', Weight: 1 }],
    SpecialProducts: [{ Item: 'MelvorBase:Trinket', Chance: 0.01 }] }));
  const { sources } = makeQuestGuide({
    Objects: { FishingRecipe: spots, Item: ['Fish', 'Junk', 'Trinket'].map(Id => ({ Id })) },
    EntityConfig: { 'MelvorBase:Fishing': { Recipes: spots.map(({ Id }) => ({ Id: 'MelvorBase:' + Id })) } }
  });
  assert.deepEqual(sources.Junk.map(where => where.actionId), ['Fishing:Ordinary']);
  assert.equal(sources.Fish.length, 2);
  assert.equal(sources.Trinket.length, 2);
});

test('hourly XP mode includes recipes with no materials while respecting skill requirements', () => {
  const locked = { ...recipe, id: 'Crafting:locked', requirementGroups: [[{ type: 'Level', skill: 'Crafting', level: 5 }]] };
  const actor = { ...profile, stock: {}, keep: ['ore'] };
  const data = catalog([recipe, locked]);
  assert.deepEqual(rank(data, actor, options), []);
  const rows = rank(data, actor, { ...options, ignoreStock: true });
  assert.deepEqual(rows.map(row => row.action.id), [recipe.id]);
  assert.equal(rows[0].activeXpPerHour, 70);
  assert.equal(rows[0].stockLimit, '');
  assert.deepEqual(actor.stock, {});
  assert.deepEqual(rank(data, actor, { ...options, metric: 'net', ignoreStock: true }), []);
});

test('a two-hit special changes average damage, hit count and turn delay', () => {
  const actor = { min: 4, max: 4, hp: 40, chance: .5, immunity: 0 };
  const result = combatAttackAverage([{ chance: .5, avoidable: false, hits: [
    { count: 2, interval: 200, damage: [{ type: 'MaxHit', factor: 1 }] }
  ] }], actor, actor, value => value);
  assert.equal(result.damage, 5);
  assert.equal(result.hits, 1.25);
  assert.equal(result.delay, 100);
  assert.equal(result.maxDamage, 8);
});

test('area poison is limited by proc intervals, stacks and encounter length', () => {
  const player = { min: 1, max: 10, hp: 100, chance: 1 };
  const enemy = { min: 1, max: 8, hp: 100, chance: .5 };
  const poison = { type: 'DamageOverTime', ProcInterval: 1000, ProcCount: 4, MaxStacks: 2, DefaultStacksToAdd: 1,
    DamagePerProc: { Character: 'Source', Formula: { Type: 'MelvorBase:MaxHit', Data: { Percent: .1 } } } };
  const triggers = [{ magnitude: 1, row: { Character: { Component: 'Player' }, Chance: 1, Modifier: {
    AppliesTo: 'Self', Trigger: { Type: 'MelvorBase:OnAttack', Data: { Type: 'OnAttack' } },
    Effect: { Data: { Effect: 'MelvorBase:Poison' } }
  } } }];
  const short = estimateCombatEffects({ Poison: poison }, triggers, null, null, player, enemy, 1000, 2000, 1000);
  const long = estimateCombatEffects({ Poison: poison }, triggers, null, null, player, enemy, 1000, 2000, 20000);
  assert.equal(short.playerDamagePerMs, 0);
  assert.equal(long.playerDamagePerMs, .002);
  assert.equal(long.enemyDamagePerMs, 0);
  const immune = estimateCombatEffects({ Poison: poison }, triggers, null, null, player, enemy, 1000, 2000, 20000,
    (side, stat, effect) => Number(side === 'Player' && stat === 'AvoidanceChance' && effect === 'Poison'));
  assert.equal(immune.playerDamagePerMs, 0);
  triggers[0].row.Modifier.Trigger.Data.Type = 'OnFirstHit';
  const misses = estimateCombatEffects({ Poison: poison }, triggers, null, null, { ...player, chance: 0 }, enemy,
    1000, 2000, 20000);
  assert.equal(misses.playerDamagePerMs, 0);
});

test('lantern charges count enemy hits in either eligible area', () => {
  const rule = { kind: 'charged', events: [{ Type: 'MelvorBase:CharacterDefended', Data: {
    Component: { Component: 'Player' }, WasHit: true, Conditions: [
      { Type: 'MelvorBase:CombatInArea', Data: { Category: 'MelvorBase:DarkAreas' } },
      { Type: 'MelvorBase:CombatInArea', Data: { IsOr: true, Area: 'MelvorBase:MurkwoodLair' } }
    ]
  } }] };
  const context = { character: { combat: {} }, killsPerHour: 100,
    attributes: { attacksPerKill: 2, interval: 1000, enemy: { turnsPerKill: 3, chance: .5 } } };
  const rateIn = area => combatSupplyEstimate(rule, 'SteelLanternLit', { ...context, area });
  assert.equal(rateIn({ category: 'DarkAreas' }), 150);
  assert.equal(rateIn({ id: 'MurkwoodLair' }), 150);
  assert.equal(rateIn({ category: 'GreenAreas' }), 0);
});

test('shared action totals use all material costs and keep window and active-hour rates distinct', () => {
  const data = catalog([recipe]);
  const [row] = rank(data, profile, options);
  assert.equal(row.cycles, 2);
  assert.equal(row.activeHours, .2);
  assert.equal(row.xp, 14);
  assert.equal(row.xpPerHour, 14);
  assert.equal(row.activeXpPerHour, 70);
  assert.equal(row.payout, 60);
  assert.equal(row.net, 40);
  assert.equal(row.inputs[0].quantity, 10);
  assert.equal(row.planXp(7).hours, .1);
  assert.equal(row.planXp(21).reaches, false);
  const production = projectHourlyProduction(recipe, profile, data);
  assert.equal(production.timeForItems('bar', 2), .2);
  assert.equal(production.timeForItems('bar', 3), null);
  assert.deepEqual(rank(data, profile, { ...options, hours: Infinity }), []);
});

test('cooking difficulty applies to XP and items while stock funds attempts', () => {
  const cooking = { ...recipe, kind: 'Cooking', skill: 'Cooking', seconds: 3, baseXp: 4, difficulty: 72,
    costs: [['ore', 1]] };
  const data = catalog([cooking]);
  const [row] = rank(data, profile, options);
  assert.equal(row.cycles, 10);
  assert.equal(row.cooking.success, 80 / 141);
  assert.ok(Math.abs(row.xp - 10 * 4 * 80 / 141) < 1e-9);
  assert.equal(row.planXp(4).hours, 6 / 3600);
  assert.equal(projectHourlyProduction(cooking, profile, data).timeForItems('bar', 1), 6 / 3600);
});

test('a fish-to-cooking chain uses the catch rate and cooking success without repeating finite charges', () => {
  const fishing = { ...recipe, id: 'Fishing:pool', kind: 'Fishing', skill: 'Fishing',
    recipe: 'pool', minSeconds: 3, maxSeconds: 3, fishChance: 1, fish: [['ore', 1, 1]],
    special: [['bycatch', 1, .1]], costs: [], rewards: [] };
  const cooking = { ...recipe, id: 'Cooking:fish', kind: 'Cooking', skill: 'Cooking',
    seconds: 3, difficulty: 91, costs: [['ore', 1]] };
  const data = { ...catalog([fishing, cooking]), items: { ...items, bycatch: { price: 1 },
    charge: { cookingCharges: { triggers: [{}], modifiers: [] } } } };
  const character = { ...profile, levels: { ...profile.levels, Fishing: 1 },
    cookingCharges: [{ item: 'charge', quantity: 1 }] };
  const index = indexProduction(data);
  assert.ok(index.producers.has('bycatch'));
  const result = planProduction(data, character, index, 'bar', 12 / 3600, false, productionCycle)
    .find(plan => plan.item === 'bar');
  assert.deepEqual(result.steps.map(step => step.action.kind), ['Fishing', 'Cooking']);
  assert.equal(result.quantity, 1);
  assert.equal(result.seconds, 12);
  assert.equal(result.net, 30);
});

test('instant item upgrades consume each ingredient and do not spend production time', () => {
  const mine = { ...recipe, id: 'Crafting:ore', costs: [], rewards: [['ore', 1, 1]], seconds: 60 };
  const upgrade = { id: 'ItemUpgrade:bar', kind: 'ItemUpgrade', costs: [['ore', 2]],
    currencyCosts: [], rewards: [['bar', 1, 1]], requirementGroups: [] };
  const data = { ...catalog([mine]), itemUpgrades: [upgrade] };
  const index = indexProduction(data);
  const result = planProduction(data, { ...profile, stock: {} }, index, 'bar', 1 / 15, false, productionCycle)
    .find(plan => plan.item === 'bar');
  assert.equal(result.quantity, 2);
  assert.deepEqual(result.steps.map(({ seconds }) => seconds), [240, 0]);
  assert.equal(result.net, 60);
});

test('a nested recipe cannot spend an ingredient reserved for its parent', () => {
  const fast = { ...recipe, id: 'Crafting:fast', costs: [['ore', 1]], rewards: [['part', 1, 1]], seconds: 1 };
  const safe = { ...fast, id: 'Crafting:safe', costs: [['gem', 1]], seconds: 2 };
  const finish = { ...recipe, id: 'Crafting:finish', costs: [['part', 1], ['ore', 1]], seconds: 1 };
  const data = { ...catalog([fast, safe, finish]), items: { ...items, part: { price: 1 }, gem: { price: 2 } } };
  const result = planProduction(data, { ...profile, stock: { ore: 1, gem: 1 } }, indexProduction(data),
    'bar', 5 / 3600, true, productionCycle).find(row => row.item === 'bar');
  assert.deepEqual(result.steps.map(step => step.action.id), [safe.id, finish.id]);
  assert.equal(result.quantity, 1);
});

test('quantity plans meet the target in whole batches and choose the faster producer', () => {
  const mine = { ...recipe, id: 'Crafting:ore', costs: [], rewards: [['ore', 1, 1]], seconds: 2 };
  const fast = { ...recipe, id: 'Crafting:fast', costs: [['ore', 2]], rewards: [['bar', 2, 1]], seconds: 3 };
  const slow = { ...fast, id: 'Crafting:slow', costs: [], seconds: 30 };
  const data = catalog([mine, fast, slow]);
  const index = indexProduction(data);
  const goals = stock => planProduction(data, { ...profile, stock: { ore: 2, bar: 100 } }, index,
    'bar', 1 / 3600, stock, productionCycle, { targetQuantity: 3 });
  const [fromStock] = goals(true);
  assert.equal(fromStock.quantity, 4);
  assert.equal(fromStock.seconds, 10);
  assert.deepEqual(fromStock.steps.map(step => [step.action.id, step.cycles]), [[mine.id, 2], [fast.id, 2]]);
  assert.equal(fromStock.bankUsed.get('ore'), 2);
  assert.equal(goals(false)[0].seconds, 14);
  assert.deepEqual(goals(true).map(plan => plan.item), ['bar']);
});

test('quantity plans combine partial sources for intermediates and finished goods', () => {
  const first = { ...recipe, id: 'first', costs: [['ore', 1]], rewards: [['part', 1, 1]], seconds: 1 };
  const second = { ...first, id: 'second', costs: [['gem', 1]], seconds: 2 };
  const finish = { ...recipe, id: 'finish', costs: [['part', 1]], rewards: [['bar', 1, 1]], seconds: 1 };
  const data = { ...catalog([first, second, finish]), items: { ...items, part: { price: 1 }, gem: { price: 2 } } };
  const actor = { ...profile, stock: { ore: 2, gem: 2 } };
  const plan = target => planProduction(data, actor, indexProduction(data), target, 1, true, productionCycle,
    { targetQuantity: 4 })[0];
  assert.deepEqual(plan('bar').steps.map(row => [row.action.id, row.cycles]), [['first', 2], ['second', 2], ['finish', 4]]);
  assert.equal(plan('part').quantity, 4);
  assert.equal(plan('bar').seconds, 10);
});

test('quantity planning tries complementary batches even when either producer can finish on its own', () => {
  const large = { ...recipe, id: 'large', costs: [], rewards: [['bar', 6, 1]], seconds: 10 };
  const small = { ...recipe, id: 'small', costs: [], rewards: [['bar', 4, 1]], seconds: 8 };
  const data = catalog([large, small]);
  const [plan] = planProduction(data, profile, indexProduction(data), 'bar', 1, false, productionCycle, { targetQuantity: 10 });
  assert.equal(plan.seconds, 18);
  assert.equal(plan.quantity, 10);
  assert.deepEqual(plan.steps.map(step => step.cycles), [1, 1]);
});

test('independent integer batches search interior combinations for the fastest quantity plan', () => {
  const first = { ...recipe, id: 'batch-41', costs: [], rewards: [['bar', 41, 1]], seconds: 41 };
  const second = { ...recipe, id: 'batch-42', costs: [], rewards: [['bar', 42, 1]], seconds: 42 };
  const data = catalog([first, second]);
  const [plan] = planProduction(data, profile, indexProduction(data), 'bar', 1, false, productionCycle, { targetQuantity: 1773 });
  assert.equal(plan.seconds, 1773);
  assert.equal(plan.quantity, 1773);
  assert.deepEqual(Object.fromEntries(plan.steps.map(step => [step.action.id, step.cycles])), { 'batch-41': 33, 'batch-42': 10 });
});

test('time-based production queues use whole-minute timers within the requested duration', () => {
  const step = (id, seconds) => ({ action: { id }, seconds });
  assert.deepEqual(productionTimedQueueSteps({
    seconds: 28800, budgetSeconds: 28800, steps: [step('fish', 28800)]
  }), [{ key: 'fish', minutes: 480 }]);
  assert.deepEqual(productionTimedQueueSteps({
    seconds: 660, budgetSeconds: 660, steps: [step('mine', 60), step('smelt', 600)]
  }), [{ key: 'mine', minutes: 1 }, { key: 'smelt', minutes: 10 }]);
  assert.deepEqual(productionTimedQueueSteps({
    seconds: 175, budgetSeconds: 180, steps: [step('mine', 95), step('smelt', 80)]
  }), [{ key: 'mine', minutes: 2 }, { key: 'smelt', minutes: 1 }]);
  assert.deepEqual(productionTimedQueueSteps({
    seconds: 60, budgetSeconds: 60, steps: [step('mine', 20), step('smelt', 40)]
  }), []);
  assert.deepEqual(productionTimedQueueSteps({
    seconds: 144, budgetSeconds: 180, steps: [step('mine', 12), step('smelt', 132)]
  }), [{ key: 'mine', minutes: 1 }, { key: 'smelt', minutes: 1 }]);
});

test('quantity buffers use the selected product rather than random byproducts or skill type', () => {
  const fish = { ...recipe, skill: 'Fishing', kind: 'Fishing', minSeconds: 3, maxSeconds: 3,
    costs: [], rewards: [], fishChance: 1, fish: [['ore', 1, 1, 1, 1]], special: [['byproduct', 1, 0.1]] };
  const craft = { ...recipe, id: 'Crafting:bar', costs: [['ore', 1]], seconds: 1 };
  const actor = { ...profile, levels: { ...profile.levels, Fishing: 10 } };
  const plan = action => {
    const data = { ...catalog([action, craft]), items: { ...items, byproduct: { price: 1 } } };
    return planProduction(data, actor, indexProduction(data), 'bar', 1, false, productionCycle,
      { targetQuantity: 10, reservePercent: 20 })[0];
  };
  assert.deepEqual(plan(fish).steps.map(step => step.cycles), [10, 10]);
  assert.deepEqual(plan({ ...fish, fishChance: 0.5 }).steps.map(step => step.cycles), [24, 10]);
  assert.deepEqual(plan({ ...fish, fish: [['ore', 2, 1, 1, 3]] }).steps.map(step => step.cycles), [6, 10]);
});

test('Astral Offerings use the recipe requirement tier and replace crafting products', () => {
  const offering = { ...recipe, skill: 'Beastcrafting', offeringLevel: 79, modeProducts: ['gift', 'rareGift'] };
  const data = { ...catalog([offering]), astralOfferings: { requirements: [], rewards: [
    { id: 'gift', quantity: 1, min: 1, max: 79 }, { id: 'rareGift', quantity: 1, min: 80, max: 99 }
  ] } };
  const actor = { ...profile, levels: { Beastcrafting: 99 }, astralOfferings: true };
  const [row] = rank(data, actor, options);
  assert.deepEqual(row.drops.map(({ id, quantity }) => [id, quantity]), [['gift', 2]]);
});

test('a bonfire contributes only before its saved duration expires', () => {
  const action = { ...recipe, seconds: 60, costs: [] };
  const data = { ...catalog([action]), bonfires: { Oak: [{ stat: 'PercentXPGained', value: .1 }] } };
  const actor = { ...profile, bonfire: { id: 'Oak', seconds: 60 } };
  const [row] = rank(data, actor, { ...options, hours: 3 / 60 });
  assert.ok(Math.abs(row.xp - 21.7) < 1e-8);
  assert.deepEqual(row.inputs, []);
});

test('ranching counts the current herd production and food spent during the selected window', () => {
  const action = { id: 'Ranching:CurrentHerd', kind: 'Ranching', skill: 'Ranching', requirementGroups: [] };
  const data = { ...catalog([action]), xpSkillData: { ranchAnimals: {
    hen: { baseXp: 7, baseVariant: 'adult', variants: [], products: [['bar', 2, 1]], foods: [['ore', 1]] }
  }, ranchVariants: {}, ranchUpgrades: {} } };
  const actor = { ...profile, levels: { Ranching: 10 }, xpSkillState: { Ranching: {
    maintenance: {}, production: { state: 2, interval: 1800, first: 1800 },
    food: { state: 2, interval: 1800, first: 900 }, lands: [{ id: 'plot', animals: [{
      type: 'hen', variant: 'adult', hunger: 1, safety: 1, satisfaction: 1, lifeSeconds: 86400, variantSeconds: 0
    }] }]
  } } };
  const [row] = rank(data, actor, { ...options, metric: 'net' });
  assert.equal(row.cycles, 2);
  assert.equal(row.sales, 120);
  assert.equal(row.materialCost, 4);
  assert.equal(row.net, 116);
});

test('herblore can use firemaking products and pays preparation once per batch', () => {
  const burn = { ...recipe, id: 'Firemaking:burn', kind: 'Firemaking', skill: 'Firemaking',
    seconds: 1, costs: [], rewards: [], events: [{ item: 'ore', quantity: 1, chance: 1, requirements: [] }] };
  const brew = { ...recipe, id: 'Herblore:brew', kind: 'Herblore', skill: 'Herblore', costs: [['ore', 1]],
    phases: ['Preparing', 'Heating', 'Stirring', 'Bottling'].map(phase => ({ phase, seconds: 1 })) };
  const data = { ...catalog([burn]), xpActions: [burn, brew] };
  const character = { ...profile, levels: { ...profile.levels, Firemaking: 1, Herblore: 1 } };
  const index = indexProduction(data);
  const produce = seconds => planProduction(data, character, index, 'bar', seconds / 3600, false, productionCycle)
    .find(plan => plan.item === 'bar');
  assert.deepEqual(produce(27).steps.map(step => [step.action.kind, step.seconds]), [['Firemaking', 10], ['Herblore', 13]]);
  assert.equal(produce(27).quantity, 10);
  assert.equal(produce(28).quantity, 11);
});

test('the unlocked Sacrificial Anvil pays gold instead of releasing smithing products', () => {
  const smelt = { ...recipe, id: 'Smithing:bar', recipe: 'bar', skill: 'Smithing',
    seconds: 3, steps: 2, baseXp: 100, costs: [['ore', 1]] };
  const craft = { ...recipe, id: 'Crafting:tool', recipe: 'tool', seconds: 2, costs: [['bar', 1]], rewards: [['tool', 1, 1]] };
  const data = { ...catalog([smelt, craft]), items: { ...items, tool: { price: 100 }, trophy: { price: 20 } },
    sacrificialAnvil: { requirements: [{ type: 'AstrologyMajorNodeUnlocked', node: 'IridanMajor1' }],
      xpWeight: 49999, xpMultiplier: 1.1, saleWeight: 49999, saleMultiplier: 1.1, collectableWeight: 2,
      collectables: [{ id: 'trophy', quantity: 1, weight: 1 }] } };
  const saved = { ...profile, characterId: 'saved', levels: { ...profile.levels, Smithing: 1 },
    sacrificialAnvil: true, astrologyNodes: ['IridanMajor1'] };
  const off = { ...saved, sacrificialAnvil: false };
  const locked = { ...saved, astrologyNodes: [] };
  const gp = 30 * 1.049999;
  const normal = productionCycle(smelt, off, data);
  assert.equal(normal.drops[0].id, 'bar');
  assert.deepEqual(productionCycle(smelt, locked, data).drops, normal.drops);
  const sacrifice = productionCycle(smelt, saved, data);
  assert.ok(Math.abs(sacrifice.direct - gp) < 1e-10);
  assert.ok(Math.abs(sacrifice.xp - 104.9999) < 1e-10);
  assert.deepEqual(sacrifice.drops.map(({ id, quantity }) => ({ id, quantity })), [{ id: 'trophy', quantity: .00004 }]);
  assert.deepEqual(sacrifice.sacrifice.items, [{ id: 'bar', quantity: 1 }]);
  const [idle] = rank(data, saved, { hours: 12 / 3600, sell: false, metric: 'net' });
  assert.ok(Math.abs(idle.net - (gp - 2) * 2) < 1e-10);
  assert.equal(idle.sales, 0);
  assert.equal(idle.planXp(200).hours, 12 / 3600);

  const index = indexProduction(data);
  const plan = (item, character) => planProduction(data, character, index, item, 12 / 3600, true, productionCycle)
    .find(row => row.item === item);
  const bar = plan('bar', saved);
  assert.equal(bar.sacrifice.quantity, 2);
  assert.equal(bar.sales, 0);
  assert.equal(bar.net, idle.net);
  assert.ok(plan('tool', off).steps.length);
  assert.equal(plan('tool', saved).steps, undefined);
  assert.ok(plan('tool', { ...saved, stock: { ...saved.stock, bar: 1 } }).steps.length);
});

test('preservation never makes an incomplete batch usable', () => {
  const costly = { ...recipe, costs: [['ore', 10]] };
  const data = catalog([costly]);
  const saved = { ...profile, stock: { ore: 10 },
    equipped: { Crafting: ['preserver'] } };
  const withTool = { ...data, items: { ...items, preserver: { modifiers: [{ stat: 'PreservationChance', value: .5 }] } } };
  assert.equal(rank(withTool, saved, options)[0].cycles, 1);
  assert.equal(rank(withTool, { ...saved, stock: { ore: 15 } }, options)[0].cycles, 2);
  assert.equal(rank(withTool, { ...saved, stock: { ore: 9 } }, options).length, 0);
});

test('skill training projects a finite boost and reverts after the equipped stock is spent', () => {
  const art = { ...recipe, costs: [], steps: 2, seconds: 30, baseXp: 10 };
  const charge = { modifiers: [{ stat: 'PercentXPGained', skill: 'Crafting', value: 1 }],
    events: [{ type: 'ArtisanPerformStep', skill: 'Crafting', chance: 1, minSteps: 2 }] };
  const data = { ...catalog([art]), items: { ...items, potion: { price: 3, skillCharges: charge } } };
  const saved = { ...profile, skillToolbelt: { Crafting: [{ id: 'potion', quantity: 4 }] } };
  const [row] = rank(data, saved, options);
  assert.equal(row.cycles, 60);
  assert.equal(row.xp, 620);
  assert.deepEqual(row.skillCharges, [{ id: 'potion', quantity: 4 }]);
  assert.equal(row.materialCost, 12);
  assert.equal(row.planXp(50).hours, 3 / 60);
});

test('Agility uses obstacle attempts to spend charges and applies later course rates to remaining XP', () => {
  const action = { ...recipe, id: 'Agility:course', skill: 'Agility', kind: 'Agility', costs: [], baseXp: 10,
    obstacleData: [{ id: 'jump', technique: 'Jumping', difficulty: 2, ms: 1000 }] };
  const charge = { modifiers: [{ stat: 'FlatObstacleDifficulty', skill: 'Agility', technique: 'Jumping', value: -2 }],
    events: [{ type: 'AgilityObstacleAttempted', skill: 'Agility', chance: 1 }] };
  const data = { ...catalog([action]), items: { ...items, sheet: { skillCharges: charge } },
    xpSkillData: { agilityTechniques: [{ id: 'Jumping', cap: 40, bonuses: [] }] } };
  const saved = { ...profile, levels: { ...profile.levels, Agility: 1 },
    skillToolbelt: { Agility: [{ id: 'sheet', quantity: 10 }] } };
  const [boosted] = rank(data, saved, { ...options, hours: 30 / 3600 });
  const [base] = rank(data, { ...saved, skillToolbelt: {} }, { ...options, hours: 30 / 3600 });
  assert.equal(boosted.skillCharges[0].quantity, 10);
  assert.ok(boosted.planXp(50).hours < base.planXp(50).hours);
  const laterCycle = boosted.planXp(150).hours - boosted.planXp(140).hours;
  assert.ok(Math.abs(laterCycle * 3600 - base.seconds) < 1e-9);
});

test('the fastest upgrade and highest session XP can come from different actions', () => {
  const quick = { ...recipe, id: 'Crafting:quick', costs: [['rareOre', 1]], seconds: 60, baseXp: 20 };
  const steady = { ...recipe, id: 'Crafting:steady', costs: [], baseXp: 12 };
  const [bestSession, other] = rank(catalog([quick, steady]), { ...profile, stock: { rareOre: 1 } }, options);
  assert.equal(bestSession.action.id, steady.id);
  assert.equal(other.action.id, quick.id);
  assert.ok(other.planXp(10).hours < bestSession.planXp(10).hours);
});

test('keeping fishing specials changes the sale proceeds without changing drops', () => {
  const fish = { ...recipe, skill: 'Fishing', kind: 'Fishing', minSeconds: 360, maxSeconds: 360, costs: [],
    rewards: [], fishChance: 1, fish: [['bar', 1, 1]], special: [['ore', 1, 1]] };
  const saved = { ...profile, levels: { ...profile.levels, Fishing: 1 } };
  const data = catalog([fish]);
  const [sell] = rank(data, saved, { ...options, sellSpecial: true });
  const [keep] = rank(data, saved, { ...options, sellSpecial: false });
  assert.equal(sell.payout - keep.payout, 20);
  assert.deepEqual(sell.drops.map(row => [row.id, row.quantity]).sort(), keep.drops.map(row => [row.id, row.quantity]).sort());
});

test('only matching modifier scopes stack together', () => {
  const make = (value, scope) => ({ stat: 'Bonus', value, ...scope });
  const data = { items: { tool: { modifiers: [make(1), make(2, { item: 'ore' }),
    make(4, { event: 'event' }), make(8, { item: 'ore', event: 'event' }),
    make(16, { item: 'different' })] } } };
  const mod = actionModifiers(recipe, { equipped: { Crafting: ['tool'] } }, data);
  assert.equal(mod('Bonus'), 1);
  assert.equal(mod('Bonus', 'ore'), 3);
  assert.equal(mod('Bonus', undefined, 'event'), 5);
  assert.equal(mod('Bonus', 'ore', 'event'), 15);
});

test('an OR alternative cannot skip an independent preceding unlock requirement', () => {
  const level = (skill, level, or = false) => ({ type: 'Level', skill, level, or });
  const locked = { ...recipe, requirementGroups: [[level('Crafting', 2), level('Farming', 2), level('Cooking', 10, true)]] };
  assert.equal(projectHourlyProduction(locked, profile, catalog([locked])).locked, true);
  assert.equal(rank(catalog([locked]), { ...profile, levels: { ...profile.levels, Crafting: 2 } }, options).length, 1);
});

test('failed farming replant does not take automation stock from the next plot', () => {
  const farm = { ...recipe, id: 'Farming:test', skill: 'Farming', kind: 'Farming', category: 'plots',
    costs: [['seed', 1]], farm: { automation: [], autoItems: [['fuel', 1]], autoCurrencies: [], regrows: 0 } };
  const crops = ['first', 'second'].map((id, index) => ({
    id, seconds: index + 1, crop: 'test', selected: 'test', autoHarvest: true, autoPlant: true
  }));
  const data = { ...catalog([farm]), xpSkillData: { farmingPlots: { first: 'plots', second: 'plots' } } };
  const [row] = rank(data, { ...profile, stock: { fuel: 2 }, xpSkillState: { Farming: crops } }, options);
  assert.equal(row.xp, 14);
  assert.equal(row.passive.limit, 'seed');
});

test('automatic harvest alone does not plant an empty farming plot', () => {
  const farm = { ...recipe, id: 'Farming:test', skill: 'Farming', kind: 'Farming', category: 'plots',
    costs: [['seed', 1]], farm: { automation: [], autoItems: [['fuel', 1]], autoCurrencies: [], regrows: 0 } };
  const plot = { id: 'first', state: 1, selected: 'test', autoHarvest: true, autoPlant: false };
  const data = { ...catalog([farm]), xpSkillData: { farmingPlots: { first: 'plots' } } };
  const saved = { ...profile, stock: { fuel: 2, seed: 1 }, xpSkillState: { Farming: [plot] } };
  assert.equal(rank(data, saved, options)[0].xp, 0);
  plot.autoPlant = true;
  assert.equal(rank(data, saved, options)[0].xp, 7);
  saved.stock.fuel = 1;
  assert.equal(rank(data, saved, options)[0].xp, 0);
});

test('farm rates consider unlocked crops for an occupied plot and report switch time', () => {
  const first = { ...recipe, id: 'Farming:first', recipe: 'first', skill: 'Farming', kind: 'Farming', category: 'plots',
    costs: [['seed', 1]], farm: { automation: [], autoItems: [], autoCurrencies: [], regrows: 0 } };
  const next = { ...first, id: 'Farming:next', recipe: 'next', baseXp: first.baseXp * 2 };
  const data = { ...catalog([first, next]), xpSkillData: { farmingPlots: { plot: 'plots', locked: 'plots' } } };
  const plot = { id: 'plot', crop: 'first', seconds: 300, state: 2, autoHarvest: false };
  const saved = { ...profile, stock: {}, xpSkillState: { Farming: [plot, { id: 'locked', state: 0 }] } };
  const [result] = rank(data, saved, { ...options, ignoreStock: true });
  assert.equal(result.action.id, next.id);
  assert.equal(result.passive.plots, 1);
  assert.equal(result.passive.switchWait, 300);
  assert.equal(result.xpPerHour, 140);
});

test('different crops share the same farming supplies in harvest order regardless of catalogue order', () => {
  const first = { ...recipe, id: 'Farming:first', recipe: 'first', skill: 'Farming', kind: 'Farming', category: 'plots',
    costs: [], farm: { automation: [], autoItems: [['fuel', 1]], autoCurrencies: [], regrows: 0 } };
  const later = { ...first, id: 'Farming:later', recipe: 'later' };
  const plots = [later, first].map((crop, index) => ({
    id: crop.recipe, crop: crop.recipe, seconds: 2 - index, autoHarvest: true
  }));
  const data = { ...catalog([later, first]), xpSkillData: { farmingPlots: { first: 'plots', later: 'plots' } } };
  const stock = { fuel: 1 };
  const rows = rank(data, { ...profile, stock, xpSkillState: { Farming: plots } }, options);
  assert.deepEqual(rows.map(row => [row.action.recipe, row.xp]), [['first', 7], ['later', 0]]);
  assert.equal(rows[1].passive.limit, 'fuel');
  assert.equal(stock.fuel, 1);
});

test('farming automation switches to the selected crop after a final harvest', () => {
  const first = { ...recipe, id: 'Farming:first', recipe: 'first', skill: 'Farming', kind: 'Farming', category: 'plots',
    costs: [], farm: { automation: [], autoItems: [['fuel', 1]], autoCurrencies: [], regrows: 0 } };
  const later = { ...first, id: 'Farming:later', recipe: 'later', costs: [['seed', 1]] };
  const plot = { id: 'plot', crop: 'first', selected: 'later', seconds: 1, autoHarvest: true, autoPlant: true };
  const data = { ...catalog([later, first]), xpSkillData: { farmingPlots: { plot: 'plots' } } };
  const rows = rank(data, { ...profile, stock: { fuel: 3, seed: 1 }, xpSkillState: { Farming: [plot] } }, options);
  assert.deepEqual(rows.map(row => [row.action.recipe, row.xp]), [['first', 7], ['later', 7]]);
  assert.equal(rows[1].passive.events[0].at, 361);
});

test('combat XP forecasts extend past the initial window and honor limited ammunition', () => {
  const target = { id: 'enemy', gold: 0, drops: [], levels: { Hitpoints: 4 } };
  const options = {
    character: {},
    attributes: { stanceId: 'slash', interval: 30000 },
    model: { stances: { slash: { xpPerDamage: { Attack: .5 } } } },
    killsPerHour: 1,
    supplies: []
  };
  const goals = new Map([['Attack', 600]]);
  const forecast = supplies => forecastCombatExperience(target, {}, { ...options, supplies }, goals, () => () => 0);
  const unlimited = forecast([]);
  assert.equal(unlimited.plan.timeForGoal('Attack', 600), 30);
  const limited = forecast([{ id: 'arrows', perHour: 1, available: 26 }]);
  assert.equal(limited.estimate.limit, 'arrows');
  assert.equal(limited.plan.total('Attack'), 520);
  assert.equal(limited.plan.timeForGoal('Attack', 600), null);
});

test('unfinished combat grants hit and prayer XP, while kill rewards and Slayer wait for the kill', () => {
  const target = { id: 'enemy', gold: 10, drops: [], levels: { Hitpoints: 4 },
    stats: { Stats: [{ Stat: 'MelvorBase:Armour', Value: 5 }] } };
  const character = { slayerTasks: [{ monster: 'enemy', remaining: 1 }] };
  const attributes = { stanceId: 'slash', interval: 5000, respawn: 10000, prayerXpPerKill: 20, hitsPerKill: 10 };
  const model = { stances: { slash: { xpPerDamage: { Attack: .4 } } } };
  const scenario = seconds => {
    const estimate = estimateCombat(target, {}, { hours: seconds / 3600, killsPerHour: 60, supplies: [] });
    return { estimate, plan: combatExperiencePlan(character, attributes, target, estimate, model, () => () => 0) };
  };
  assert.equal(scenario(14).plan.total('Attack'), 0);
  const { estimate, plan } = scenario(30);
  assert.equal(estimate.kills, 0);
  assert.equal(estimate.direct, 0);
  assert.equal(plan.total('Attack'), 6.4);
  assert.equal(plan.total('Prayer'), 8);
  assert.equal(plan.total('Slayer'), 0);
  assert.ok(Math.abs(plan.timeForGoal('Attack', 6) * 3600 - 30) < .002);
  assert.equal(plan.timeForGoal('Attack', 7), null);
  assert.ok(Math.abs(plan.projectedTimeForGoal('Attack', 7) * 3600 - 35) < .002);
  assert.ok(Math.abs(plan.projectedTimeForGoal('Slayer', 9) * 3600 - 60) < .002);
  assert.equal(plan.projectedTimeForGoal('Slayer', 10), null);
  assert.equal(plan.projectedTimeForGoal('Magic', 1), null);
  assert.equal(scenario(60).plan.total('Attack'), 24);
  assert.equal(scenario(60).plan.completedFights('Attack', 1.5), 36);
  assert.equal(scenario(60).plan.completedFights('Slayer', 3), 9);
  assert.equal(scenario(90).plan.total('Attack'), 30.4);
  assert.equal(scenario(120).plan.total('Slayer'), 9);
});

test('combat uses the last full or partial meal and caps charged food to available stock', () => {
  const projection = combatFoodProjection({ healing: 20 }, 'food', { character: {}, model: { foodUpgrades: {} },
    killsPerHour: 10, attributes: { maxHp: 100, interval: 1000, attacksPerKill: 1,
      enemy: { turnsPerKill: 1, damagePerTurn: 10 } } });
  assert.equal(projection.hoursAtStock(0), .75);
  assert.equal(projection.hoursAtStock(2), 1.15);
  assert.equal(projection.hoursAtStock(3), 1.35);
  assert.equal(projection.neededAt(.74), 0);
  assert.equal(projection.neededAt(.75), 3);
  const plan = estimateCombat({ gold: 10, drops: [] }, { food: { price: 2 } },
    { hours: 2, killsPerHour: 10, supplies: [{ id: 'food', projection, available: 2 }] });
  assert.equal(plan.kills, 11);
  assert.equal(plan.activeHours, 1.15);
  assert.equal(plan.costs[0].quantity, 2);
  assert.equal(plan.net, 106);
});

test('combat without usable food stops at the health reserve', () => {
  const target = { gold: 10, drops: [] };
  const attributes = { maxHp: 100, currentHp: 50, enemy: { maxHit: 10, turnsPerKill: 1, damagePerTurn: 10 } };
  const settings = { hours: 1, killsPerHour: 60, attributes };
  for (const supplies of [[], [{ id: 'food', food: true, available: 0, perHour: 300 }]]) {
    const result = estimateCombat(target, {}, { ...settings, supplies });
    assert.equal(result.limit, 'Hitpoints');
    assert.equal(result.activeHours, 4 / 60);
    assert.equal(result.kills, 4);
    assert.equal(result.net, 40);
  }
  assert.equal(estimateCombat(target, {}, { ...settings,
    supplies: [{ id: 'food', food: true, available: 100, perHour: 50 }] }).kills, 60);
});

test('combat continues after an optional boost expires and preserves kill progress and XP', () => {
  const target = { id: 'enemy', gold: 10, drops: [], levels: { Hitpoints: 4 } };
  const main = { stanceId: 'slash', interval: 1000, prayerXpPerKill: 6, hitsPerKill: 30 };
  const model = { stances: { slash: { xpPerDamage: { Attack: .4 } } } };
  const saved = { slayerTasks: [{ monster: 'enemy', remaining: 3 }] };
  const estimate = estimateCombat(target, { boost: { price: 1 } }, { hours: 1, killsPerHour: 120, attributes: main,
    supplies: [{ id: 'boost', available: 1, perHour: 80, optional: true }],
    nextStage: () => ({ killsPerHour: 60, attributes: { ...main, prayerXpPerKill: 0 }, supplies: [] }) });
  assert.equal(estimate.activeHours, 1);
  assert.equal(estimate.kills, 60);
  assert.equal(estimate.net, 599);
  assert.deepEqual(estimate.expired, [['boost', 1 / 80]]);
  const xp = combatExperiencePlan(saved, main, target, estimate, model, () => () => 0);
  assert.equal(xp.total('Prayer'), 9);
  assert.equal(xp.total('Slayer'), 27);
  assert.ok(xp.total('Attack') > 960);
});

test('the grain mill validates and consumes a full batch on every completion', () => {
  const mill = { ...recipe, kind: 'GrainMill', skill: 'Farming' };
  const data = catalog([mill]);
  data.items = { ...items, tool: { modifiers: [{ stat: 'PreservationChance', value: 1 }] } };
  const [row] = rank(data, { ...profile, equipped: { Farming: ['tool'] },
    xpSkillState: { GrainMill: { active: true, recipe: 'test', stock: { ore: 5 } } } }, options);
  assert.equal(row.xp, 7);
  assert.equal(row.passive.limit, 'ore');
  assert.equal(row.planXp(28).reaches, false);
});

test('Slayer charges apply only to the matching target and stop at task completion', () => {
  const rule = { kind: 'charged', events: [{ Type: 'MelvorBase:CharacterFightStarted',
    Data: { Conditions: [{ Type: 'MelvorBase:FightingSlayerTask', Data: {} }] } }] };
  const context = { target: { id: 'enemy' }, attributes: {}, killsPerHour: 10,
    character: { combat: {}, slayerTasks: [{ monster: 'enemy', remaining: 5 }] } };
  const plan = combatSupplyEstimate(rule, 'charge', context);
  assert.equal(plan.neededAt(2), 5);
  assert.equal(plan.hoursAtStock(3), .3);
  assert.equal(plan.hoursAtStock(5), Infinity);
  assert.equal(combatSupplyEstimate(rule, 'charge', { ...context, target: { id: 'other' } }), 0);
});

test('dungeon supply projections preserve task-only consumption across different waves', () => {
  const task = { id: 'charge', projection: { neededAt: hours => Math.min(10 * hours, 5) } };
  const ordinary = { id: 'charge', perHour: 2 };
  const projection = combineDungeonSupply([{ entry: task, fraction: .5 }, { entry: ordinary, fraction: .5 }], 4);
  assert.equal(projection.neededAt(2), 7);
  assert.equal(projection.neededAt(4), 9);
  assert.equal(projection.hoursAtStock(9), Infinity);
  assert.ok(Math.abs(projection.hoursAtStock(7) - 2) < 1e-8);
});

test('rune and ammunition costs respect preservation and optional imbuement', () => {
  const context = { killsPerHour: 60, character: { combat: { spell: 'spell', imbuement: 'imbuement' } },
    attributes: { attacksPerKill: 4, interval: 2000, ammoType: 'arrows', ammoPreservation: .5,
      usesSpells: true, imbuementReady: true, spellSupplies: {
        spell: { preserve: .25, runes: [{ id: 'main', quantity: 2 }] },
        imbuement: { preserve: .5, runes: [{ id: 'optional', quantity: 1 }] }
      } } };
  assert.equal(combatSupplyEstimate({ kind: 'ammo', ammoType: 'arrows' }, 'arrow', context), 120);
  assert.equal(combatSupplyEstimate({ kind: 'rune' }, 'main', context), 360);
  const extra = combatSupplyEstimate({ kind: 'rune' }, 'optional', context);
  assert.equal(extra.neededAt(1), 120);
  assert.equal(extra.hoursAtStock(20), 20 / 120);
  assert.equal(extra.optional, true);
});

test('combat save samples are invalidated by changed combat levels or permanent bonuses', () => {
  const snapshot = (kills, milliseconds, levels = {}, purchases = {}) => ({ levels, purchases, combat: {
    equipment: [], toolbelt: [], encounter: { area: 'area', enemy: 'enemy' },
    totals: { deaths: 0, kills: { enemy: kills }, milliseconds }
  } });
  const before = snapshot(0, 0);
  assert.equal(measuredCombatRate(before, snapshot(10, 120000)).perHour, 300);
  assert.equal(measuredCombatRate(before, snapshot(10, 120000, { Attack: 2 })), null);
  assert.equal(measuredCombatRate(before, snapshot(10, 120000, {}, { upgrade: 1 })), null);
});

test('a partly bought shop upgrade stays visible when filtering to pending purchases', () => {
  const upgrade = { id: 'upgrade', group: 'group', target: 3, requirements: [{ type: 'Level', skill: 'Crafting', level: 99 }],
    costs: [{ type: 'item', id: 'ore', quantity: 7 }] };
  const shop = { upgrades: [upgrade] };
  const character = { ...profile, shopShowLocked: false, purchases: { upgrade: 1 } };
  const pending = calculateShoppingList(shop, items, new Set(['group']), character, 'visible', 'pending');
  assert.equal(pending.resources[0].total, 14);
  assert.equal(pending.resources[0].shortage, 4);
  const both = calculateShoppingList(shop, items, new Set(['group']), character, 'visible', 'both');
  assert.equal(both.resources[0].spent, 7);
});

test('level and target XP use the same threshold', () => {
  assert.equal(levelFor(82), 1);
  assert.equal(levelFor(83), 2);
  const goal = xpGoalProgress(1, 80, 2);
  assert.equal(goal.remaining, 3);
});

test('production chains compare raw materials, bars and equipment within one time budget', () => {
  const gather = (id, seconds, reward, perHit) => ({ ...recipe, id, skill: 'Mining', kind: 'Mining',
    cash: 0, seconds, costs: [], ore: [reward, perHit, 1], rewards: [] });
  const smith = (id, costs, reward) => ({ ...recipe, id, skill: 'Smithing', seconds: 10, costs,
    rewards: [[reward, 1, 1]] });
  const actions = [gather('slowCoal', 10, 'coal', 1), gather('fastCoal', 10, 'coal', 2),
    gather('ore', 10, 'ore', 1), smith('bar', [['ore', 1], ['coal', 2]], 'bar'),
    smith('sword', [['bar', 2]], 'sword')];
  const data = { actions, items: { ore: { price: 3 }, coal: { price: 2 }, bar: { price: 10 }, sword: { price: 30 } } };
  const character = { levels: { Mining: 1, Smithing: 1 }, stock: { ore: 2, coal: 4 }, currencies: {} };
  const index = indexProduction(data);
  const plans = planProduction(data, character, index, 'bar', 70 / 3600, false, productionCycle);
  const sword = plans.find(p => p.item === 'sword');
  assert.equal(sword.quantity, 1);
  assert.equal(sword.net, 30);
  assert.equal(sword.seconds, 70);
  assert.deepEqual(sword.steps.map(s => s.action.id), ['ore', 'fastCoal', 'bar', 'sword']);
  assert.equal(plans.find(p => p.item === 'ore').quantity, 7);
  assert.equal(plans.find(p => p.item === 'bar').quantity, 2);
  const bank = planProduction(data, character, index, 'sword', 30 / 3600, true, productionCycle).find(p => p.item === 'sword');
  assert.equal(bank.materials, 14);
  assert.equal(bank.net, 16);
  assert.deepEqual([...bank.bankUsed], [['ore', 2], ['coal', 4]]);
  assert.deepEqual(character.stock, { ore: 2, coal: 4 });
  const locked = { ...character, keep: ['ore'] };
  assert.equal(planProduction(data, locked, index, 'sword', 30 / 3600, true, productionCycle)
    .find(p => p.item === 'sword').steps, undefined);
});

test('production chains cannot spend one stack twice in different branches', () => {
  const actions = [
    { ...recipe, id: 'part', costs: [['ore', 1]], rewards: [['part', 1, 1]] },
    { ...recipe, id: 'final', costs: [['ore', 1], ['part', 1]], rewards: [['final', 1, 1]] }
  ];
  const data = { actions, items: { ore: { price: 2 }, part: { price: 3 }, final: { price: 10 } } };
  const index = indexProduction(data);
  const run = stock => planProduction(data, { ...profile, stock }, index, 'final', 1, true, productionCycle)
    .find(plan => plan.item === 'final');
  assert.equal(run({ ore: 1 }).steps, undefined);
  assert.equal(run({ ore: 2 }).net, 6);
});

test('automatic production recommendations compare across unrelated recipe families', () => {
  const actions = [
    { ...recipe, id: 'bar', costs: [['ore', 1]], rewards: [['bar', 1, 1]] },
    { ...recipe, id: 'jewel', costs: [['gem', 1]], rewards: [['jewel', 1, 1]] }
  ];
  const data = { actions, items: { ore: { price: 2 }, gem: { price: 3 }, bar: { price: 8 }, jewel: { price: 20 } } };
  const index = indexProduction(data);
  const saved = { ...profile, stock: { ore: 1, gem: 1 } };
  assert.equal(planProduction(data, saved, index, '', 1, true, productionCycle)[0].item, 'jewel');
  assert.equal(planProduction(data, saved, index, 'bar', 1, true, productionCycle)[0].item, 'bar');
});

test('comparison evaluates only selected items from the same original inventory', () => {
  const smith = (id, level, price) => ({
    action: { ...recipe, id, costs: [['ore', 2]], rewards: [[id, 1, 1]],
      requirementGroups: [[{ type: 'Level', skill: 'Crafting', level }]] },
    item: { price }
  });
  const [bar, sword, locked, unselected] = [
    smith('bar', 1, 15), smith('sword', 1, 30), smith('locked', 99, 100), smith('unselected', 1, 500)
  ];
  const all = [bar, sword, locked, unselected];
  const data = { actions: all.map(x => x.action), items: {
    ore: { price: 2 }, ...Object.fromEntries(all.map(x => [x.action.id, x.item]))
  } };
  const saved = { ...profile, stock: { ore: 2 } };
  const compared = compareProduction(data, saved, indexProduction(data),
    ['bar', 'locked', 'sword', 'bar'], 1, true, productionCycle);
  assert.deepEqual(compared.map(r => [r.item, r.net, r.preview]), [
    ['sword', 26, false], ['bar', 11, false], ['locked', 960, true]
  ]);
  assert.ok(compared.every(r => r.bankUsed.get('ore') === 2));
  assert.equal(compared[2].externalCost, 36);
  assert.equal(saved.stock.ore, 2);
});

test('a slower, cheaper material route wins when it yields more net GP', () => {
  const action = (id, seconds, costs, result) => ({ ...recipe, id, recipe: id, seconds, costs,
    rewards: [[result, 1, 1]] });
  const fast = action('fast', 1, [['gem', 1]], 'part');
  const slow = action('slow', 2, [], 'part');
  const final = action('final', 30, [['part', 1]], 'final');
  const data = { actions: [fast, slow, final], items: { gem: { price: 9 }, part: { price: 9 }, final: { price: 10 } } };
  const index = indexProduction(data);
  const saved = { ...profile, stock: { gem: 120 } };
  const plan = planProduction(data, saved, index, 'final', 1, true, productionCycle).find(row => row.item === 'final');
  assert.deepEqual(plan.steps.map(step => step.action.id), ['slow', 'final']);
  assert.equal(plan.net, 1120);
  assert.equal(plan.seconds, 3584);
});

test('mixing two sources can beat either source alone within the same deadline', () => {
  const action = (id, seconds, costs, result) => ({ ...recipe, id, recipe: id, seconds, costs, rewards: [[result, 1, 1]] });
  const data = { actions: [action('fast', 1, [['gem', 1]], 'part'), action('free', 2, [], 'part'),
    action('final', 8, [['part', 1]], 'final')], items: { gem: { price: 9 }, part: { price: 9 }, final: { price: 100 } } };
  const saved = { ...profile, stock: { gem: 100 } };
  const plan = planProduction(data, saved, indexProduction(data), 'final', 100 / 3600, true, productionCycle)
    .find(row => row.item === 'final');
  assert.equal(plan.net, 1010);
  assert.equal(plan.seconds, 100);
  assert.deepEqual(plan.steps.map(row => [row.action.id, row.cycles]), [['free', 1], ['fast', 10], ['final', 11]]);
});

test('the highest net production can stop at the bank threshold in short and long sessions', () => {
  const gather = { ...recipe, id: 'gather', seconds: 1, costs: [], currencyCosts: [['GoldPieces', 100]],
    rewards: [['ore', 1, 1]] };
  const finish = { ...recipe, id: 'finish', seconds: 1, costs: [['ore', 1]], rewards: [['bar', 1, 1]] };
  const data = { actions: [gather, finish], items: { ore: { price: 1 }, bar: { price: 20 } } };
  const saved = { ...profile, currencies: { GoldPieces: 200000 } };
  for (const seconds of [100, 1000]) {
    const result = planProduction(data, saved, indexProduction(data), 'bar', seconds / 3600, true, productionCycle)
      .find(row => row.item === 'bar');
    assert.equal(result.net, 190);
    assert.deepEqual(result.steps.map(step => [step.action.id, step.cycles]), [['finish', 10]]);
  }
});

test('byproduct sales only include leftover generation and respect kept items across comparison', () => {
  const gather = { ...recipe, id: 'gather', recipe: 'gather', seconds: 2, costs: [],
    rewards: [['ore', 2, 1], ['stone', 1, 1]] };
  const final = { ...recipe, id: 'final', recipe: 'final', seconds: 8, costs: [['ore', 1]], rewards: [['bar', 1, 1]] };
  const data = { actions: [gather, final], items: { ore: { price: 3 }, stone: { price: 5 }, bar: { price: 20 } } };
  const index = indexProduction(data);
  const saved = { ...profile, stock: { unrelated: 99, stone: 99 } };
  const run = options => compareProduction(data, saved, index, ['bar'], 10 / 3600, true, productionCycle, [], options)[0];
  assert.equal(run({}).net, 20);
  const sell = run({ sellByproducts: true });
  assert.equal(sell.net, 28);
  assert.deepEqual(sell.byproducts, [{ id: 'ore', quantity: 1, value: 3 }, { id: 'stone', quantity: 1, value: 5 }]);
  assert.equal(run({ sellByproducts: true, keptItems: new Set(['stone']) }).net, 23);
});

test('externally supplied preview materials are not resold as unused production', () => {
  const final = { ...recipe, id: 'bar', seconds: 1, costs: [['ore', 1]] };
  const data = { actions: [final], items: { bar: { price: 20 }, ore: { price: 3 },
    tool: { modifiers: [{ stat: 'PreservationChance', value: 1, skill: 'Crafting' }] } } };
  const saved = { ...profile, equipped: { Crafting: ['tool'] }, stock: {} };
  const [preview] = planProduction(data, saved, indexProduction(data), 'bar', 1 / 3600, false,
    productionCycle, { preview: true, sellByproducts: true });
  assert.equal(preview.externalCost, 3);
  assert.equal(preview.net, 17);
  assert.deepEqual(preview.byproducts, []);
});

test('production search matches names across languages and prioritizes exact matches', () => {
  const make = (value, aliases) => ({ value, dataset: { searchAliases: aliases.join('\n') } });
  const sword = make('Rune Sword', ['Rune Sword', 'RuneSword', '符文剑', '符文劍']);
  const bar = make('Runite Bar', ['Runite Bar', 'RuniteBar', '符文锭', '符文錠', 'MelvorBase:RuniteBar']);
  const axe = make('Runite Battleaxe', ['Runite Battleaxe', 'RuniteBattleaxe', '符文战斧']);
  for (const query of ['符文锭', '符文錠', 'runite bar', 'Ｒｕｎｉｔｅ　Ｂａｒ', 'MelvorBase:RuniteBar']) {
    assert.deepEqual(suggestionMatches([sword, axe, bar], query), [bar]);
  }
  assert.deepEqual(suggestionMatches([sword, axe, bar], 'runite'), [axe, bar]);
  assert.deepEqual(suggestionMatches([sword, axe, bar], '不存在'), []);
});

test('the production picker can list and search past the generic 40-suggestion limit', () => {
  const options = Array.from({ length: 100 }, (_, index) => ({
    value: 'Bar ' + index, dataset: { searchAliases: 'Bar ' + index }
  }));
  assert.equal(suggestionMatches(options, '').length, 40);
  assert.equal(suggestionMatches(options, '', Infinity).length, 100);
  assert.equal(suggestionMatches(options, 'bar', Infinity).at(-1), options[99]);
});

test('a locked target has its own conditional chain and external costs without replacing it with a raw item', () => {
  const gather = { ...recipe, id: 'mine', skill: 'Mining', kind: 'Mining', costs: [],
    ore: ['ore', 1, 1], rewards: [] };
  const final = { ...recipe, id: 'gem', costs: [['ore', 1], ['binder', 1]], rewards: [['gem', 1, 1]],
    requirementGroups: [[{ type: 'Level', skill: 'Crafting', level: 32 }]] };
  const source = { ...recipe, id: 'get-binder', kind: 'Hunting', skill: 'Hunting', rewards: [['binder', 1, 1]],
    requirementGroups: [[{ type: 'Level', skill: 'Hunting', level: 55 }]] };
  const data = { actions: [gather, final], xpActions: [source],
    items: { ore: { price: 2 }, binder: { price: 3 }, gem: { price: 10 } } };
  const index = indexProduction(data);
  const saved = { ...profile, levels: { ...profile.levels, Mining: 1 } };
  const normal = planProduction(data, saved, index, 'gem', .2, false, productionCycle);
  assert.equal(normal[0].item, 'ore');
  assert.equal(normal.find(plan => plan.item === 'gem').steps, undefined);
  const [preview] = planProduction(data, saved, index, 'gem', .2, false, productionCycle, { preview: true });
  assert.equal(preview.item, 'gem');
  assert.equal(preview.net, 7);
  assert.equal(preview.externalCost, 3);
  assert.deepEqual(preview.steps.map(step => step.action.id), ['mine', 'get-binder', 'gem']);
  assert.deepEqual(preview.steps[1].restrictions.map(r => r.type), ['external', 'requirement']);
  assert.equal(preview.steps[1].restrictions[1].clause[0].level, 55);
  assert.equal(preview.steps[2].restrictions[0].clause[0].level, 32);
  const [limited] = planProduction(data, saved, index, 'gem', .1, false, productionCycle, { preview: true });
  assert.equal(limited.quantity, 1);
  assert.equal(limited.seconds, 720);
  assert.ok(limited.steps.at(-1).restrictions.some(r => r.type === 'time'));
});
