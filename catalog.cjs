const { GOLD, localId } = require('./game-data.cjs');

const SKILLS = {
  Woodcutting: '伐木', Mining: '采矿', Fishing: '钓鱼', Thieving: '偷窃',
  Smithing: '锻造', Cooking: '烹饪', Crafting: '制作', Fletching: '制箭',
  Runecrafting: '符文锻造', Beastcrafting: '野兽工艺', Firemaking: '生火'
};

const XP_SKILLS = {
  ...SKILLS, Herblore: '草药学', Astrology: '星象学', Agility: '灵巧', Hunting: '狩猎',
  Farming: '农务', Ranching: '畜牧', Attack: '攻击', Strength: '力量', Defence: '防御',
  Hitpoints: '生命值', Ranged: '远程', Magic: '魔法', Prayer: '祝祭', Slayer: '屠杀者'
};

function makeCombatTargets(data, items) {
  const registered = new Set((data.EntityConfig['MelvorBase:Combat']?.Areas ?? []).map(entry => localId(entry.Id)));
  const areasByEnemy = new Map();
  for (const area of data.Objects.CombatArea ?? []) {
    if (!registered.has(area.Id)) continue;
    for (const enemy of area.Enemies ?? []) {
      if (typeof enemy !== 'string') continue;
      const id = localId(enemy);
      if (!areasByEnemy.has(id)) areasByEnemy.set(id, []);
      areasByEnemy.get(id).push({ id: area.Id, name: area.DisplayName, darkness: area.Darkness ?? 0, category: localId(area.Category) });
    }
  }
  const average = entry => (entry.MinQuantity + entry.MaxQuantity) / 2;
  return (data.Objects.Enemy ?? []).filter(enemy => areasByEnemy.has(enemy.Id)).map(enemy => {
    const quantities = new Map();
    function add(entry, probability) {
      const id = localId(entry.Item);
      const quantity = average(entry) * probability;
      if (Object.hasOwn(items, id) && Number.isFinite(quantity) && quantity > 0) {
        quantities.set(id, (quantities.get(id) ?? 0) + quantity);
      }
    }
    for (const entry of enemy.Drops?.FixedItems ?? []) add(entry, 1);
    for (const { Chance, Table } of enemy.Drops?.ItemTables ?? []) {
      if (!Array.isArray(Table)) continue;
      const weight = Table.reduce((sum, entry) => sum + entry.Weight, 0);
      if (weight > 0) for (const entry of Table) add(entry, Chance * entry.Weight / weight);
    }
    const gold = (enemy.Drops?.FixedCurrencies ?? []).reduce((sum, entry) =>
      entry.Currency === GOLD ? sum + average(entry) : sum, 0);
    return { id: enemy.Id, name: enemy.DisplayName, areas: areasByEnemy.get(enemy.Id), gold,
      levels: Object.fromEntries((enemy.Levels ?? []).map(({ Key, Value }) => [localId(Key), Value])),
      stats: enemy.Stats, element: localId(enemy.Element), damageType: localId(enemy.DamageType),
      stances: (enemy.Stances ?? []).map(({ Stance, Weight }) => [localId(Stance), Weight]),
      drops: Array.from(quantities, ([id, perKill]) => ({ id, perKill })) };
  });
}

function persistentModifiers(bonuses) {
  const globalStats = {
    GlobalFlatXpGained: 'FlatXPGained',
    GlobalPercentXpGained: 'PercentXPGained',
    GlobalFlatActionInterval: 'FlatInterval',
    GlobalPercentActionInterval: 'PercentInterval'
  };
  const global = (bonuses?.Global ?? []).filter(row => globalStats[row.StatGroup] && !row.Condition && !row.Scaling)
    .map(row => ({ stat: globalStats[row.StatGroup], value: row.Value }));
  const local = (bonuses?.Component ?? []).filter(row => !row.Condition && !row.FromContext &&
    (!row.Scaling || row.Scaling.Type === 'MelvorBase:Level') &&
    ['Action', 'Experience'].includes(row.LocalContext?.Component?.Component) &&
    Object.keys(row.LocalContext).every(key =>
      row.LocalContext[key] == null ||
        ['Component', 'Recipe', 'Location', 'Category', 'Subcategory', 'Constellation', 'RecipeType', 'Item', 'Event', 'Currency'].includes(key)
    )).map(row => ({
    stat: row.Stat.Name, value: row.Value, skill: localId(row.LocalContext.Component.Entity),
    recipe: localId(row.LocalContext.Recipe), category: localId(row.LocalContext.Category),
    subcategory: localId(row.LocalContext.Subcategory), location: localId(row.LocalContext.Location),
    constellation: localId(row.LocalContext.Constellation), recipeType: localId(row.LocalContext.RecipeType),
    item: localId(row.LocalContext.Item ?? row.LocalContext.Currency), event: localId(row.LocalContext.Event),
    scalesWithLevel: localId(row.Scaling?.Data?.Experience?.Entity)
  }));
  return [...global, ...local];
}

function makeCatalog(data) {
  const objects = data.Objects;
  const items = Object.fromEntries(objects.Item.map(item => {
    const tool = item.Capabilities?.['MelvorBase:Toolbelt'];
    const permanent = tool && !tool.ConsumesOn && !tool.CanEquipQuantity;
    const modifiers = permanent ? persistentModifiers(tool.Bonuses) : [];
    const cookingTriggers = tool?.ConsumesOn?.filter(({ Type, Data }) => localId(Type) === 'CookRecipe' &&
      Data.Chance == null && (Data.Conditions == null || (Array.isArray(Data.Conditions) && !Data.Conditions.length)) &&
      localId(Data.Component?.Entity) === 'Cooking')
      .map(({ Data }) => ({ recipe: localId(Data.Recipe), category: localId(Data.Category), subcategory: localId(Data.Subcategory) }));
    const cookingModifiers = cookingTriggers?.length ? persistentModifiers(tool.Bonuses)
      .filter(modifier => modifier.skill === 'Cooking' && modifier.stat === 'FlatProficiency') : [];
    return [item.Id, {
      name: item.DisplayName.Singular, price: item.SellsFor?.Currency === GOLD ? item.SellsFor.Quantity : 0,
      ...(modifiers.length ? { modifiers } : {}),
      ...(cookingModifiers.length ? { cookingCharges: { modifiers: cookingModifiers, triggers: cookingTriggers } } : {})
    }];
  }));
  const categories = new Map(['RecipeCategory', 'WoodcuttingRecipeCategory', 'MiningRecipeCategory', 'FishingLocation', 'ThievingLocation']
    .flatMap(type => objects[type].map(record => [record.Id, record])));
  const types = {
    Woodcutting: 'WoodcuttingRecipe', Mining: 'MiningRecipe', Fishing: 'FishingRecipe',
    Thieving: 'ThievingRecipe', Cooking: 'CookingRecipe', Firemaking: 'FiremakingRecipe',
    Herblore: 'HerbloreRecipe', Astrology: 'AstrologyConstellation'
  };
  const actions = [];
  const xpActions = [];
  const fireEvents = new Map((objects.FiremakingEvent ?? []).map(event => [event.Id, event]));
  const astrologyItemEvents = new Map((objects.AstrologyItemEvent ?? []).map(event => [event.Id, event]));
  const requirements = (list = []) => list.map(({ Type, Data }) => ({
    type: localId(Type), skill: localId(Data.Component?.Entity), level: Data.Level, or: !!Data.IsOr,
    item: localId(Data.Item), rank: localId(Data.Rank), node: localId(Data.MajorNode ?? Data.MinorNode),
    purchase: localId(Data.ShopPurchase), amount: Data.Amount, statistic: localId(Data.Statistic),
    statisticTarget: localId(Data.Course ?? Data.Event ?? Data.Item), statisticValue: Data.Value
  }));

  for (const skill of [...Object.keys(SKILLS), 'Herblore', 'Astrology']) {
    const recipes = new Map(objects[types[skill] ?? 'ArtisanRecipe'].map(recipe => [recipe.Id, recipe]));
    const config = data.EntityConfig['MelvorBase:' + skill];
    const included = config.Recipes ?? config.Constellations;
    for (const { Id } of included) {
      const recipe = recipes.get(localId(Id));
      if (!recipe) continue;
      const area = categories.get(localId(recipe.Location ?? recipe.Category));
      const requirementGroups = [area, recipe].filter(Boolean).flatMap(record => [
        record.Requirements ?? [], record.DisplayRequirements ?? [], record.AccessRequirements ?? [],
        record.SecondaryRequirements ?? []
      ]).filter(group => group.length).map(requirements);
      const kind = types[skill] ? skill : 'Artisan';
      const action = {
        id: skill + ':' + recipe.Id, recipe: recipe.Id, name: recipe.DisplayName, area: area?.DisplayName, skill, kind,
        category: localId(recipe.Category), subcategory: localId(recipe.Subcategory), location: localId(recipe.Location),
        requirementGroups, seconds: recipe.BaseInterval / 1000,
        steps: Math.max(1, recipe.Steps ?? 1), baseXp: recipe.BaseExperience, costs: [], rewards: [], cash: 0
      };
      const product = ({ Item, Quantity, Chance }) => [localId(Item), Quantity, Chance ?? 1];
      const weighted = (table = []) => {
        const total = table.reduce((sum, row) => sum + row.Weight, 0);
        return table.map(row => [localId(row.Item), (row.MinQuantity + row.MaxQuantity) / 2, row.Weight / total,
          row.MinQuantity, row.MaxQuantity]);
      };
      action.costs = (recipe.Ingredients?.Items ?? []).map(row => [localId(row.Item), row.Quantity]);
      action.currencyCosts = (recipe.Ingredients?.Currencies ?? []).map(row => [localId(row.Currency), row.Quantity]);
      action.rewards = (recipe.Products ?? []).map(product);
      if (recipe.CurrencyReward?.Currency === GOLD) {
        action.cash = recipe.CurrencyReward.Quantity ?? 0;
        action.cashReward = true;
      }
      switch (kind) {
        case 'Woodcutting':
          if (!recipe.Product || !(recipe.BaseMaxHealth > 0)) continue;
          action.steps = recipe.BaseMaxHealth;
          action.rewards = [product(recipe.Product), ...recipe.RandomProductsPerCut.map(product)];
          action.hitRewards = recipe.RandomProductsPerHit.map(product);
          break;
        case 'Mining':
          if (!recipe.Product) continue;
          action.ore = [localId(recipe.Product.Item), recipe.Product.Quantity, recipe.BaseProductChance];
          action.rewards = recipe.RandomProductsPerHit.map(product);
          action.bar = localId(recipe.BarItem);
          action.stone = localId(recipe.StoneItem);
          action.essence = localId(recipe.EssenceItem);
          break;
        case 'Fishing':
          action.seconds = (recipe.BaseMinInterval + recipe.BaseMaxInterval) / 2000;
          action.minSeconds = recipe.BaseMinInterval / 1000;
          action.maxSeconds = recipe.BaseMaxInterval / 1000;
          action.fish = weighted(recipe.RandomProducts);
          action.fishChance = recipe.FishChance;
          action.junk = localId(recipe.JunkItem);
          action.special = recipe.SpecialProducts.map(product);
          break;
        case 'Cooking':
          action.difficulty = recipe.Difficulty ?? 0;
          break;
        case 'Firemaking':
          action.events = (config.Events ?? []).flatMap(({ Id }) => {
            const event = fireEvents.get(localId(Id));
            if (!event?.Reward || (event.Category && event.Category !== recipe.Category)) return [];
            return [{ item: localId(event.Reward.Item), quantity: event.Reward.Quantity,
              chance: event.Chance, requirements: requirements(event.Requirements ?? []) }];
          });
          break;
        case 'Astrology':
          action.constellation = recipe.Id;
          action.knowledge = recipe.BaseKnowledge;
          action.minorNodes = recipe.MinorNodes.map(localId);
          action.majorNodes = recipe.MajorNodes.map(localId);
          action.minorNodeModifiers = persistentModifiers(recipe.PerMinorNodeBonuses);
          action.events = [...new Set([...(config.GlobalEvents ?? []).map(({ Id }) => Id), ...(recipe.Events ?? [])].map(localId))]
            .flatMap(id => {
              const event = astrologyItemEvents.get(id);
              if (!event) return [];
              return [{ id, item: localId(event.Item), quantity: event.BaseQuantity, quantityPerLevel: event.LevelScalingQuantity,
                chance: event.Chance, requirements: requirements(event.Requirements ?? []) }];
            });
          break;
        case 'Herblore':
          action.phases = ['Preparing', 'Heating', 'Stirring', 'Bottling'].map(phase => ({
            phase, seconds: recipe['Base' + phase + 'Interval'] / 1000
          }));
          action.seconds = action.phases.reduce((sum, phase) => sum + phase.seconds, 0);
          break;
        case 'Thieving':
          if (recipe.Stages !== 1 || !['NPC', 'Stall'].includes(localId(recipe.RecipeType))) continue;
          action.perception = recipe.Perception;
          action.damage = recipe.Damage;
          action.recipeType = localId(recipe.RecipeType);
          action.cash = recipe.CurrencyReward?.Currency === GOLD
            ? (recipe.CurrencyReward.MinQuantity + recipe.CurrencyReward.MaxQuantity) / 2 : 0;
          action.cashRange = recipe.CurrencyReward?.Currency === GOLD
            ? [recipe.CurrencyReward.MinQuantity, recipe.CurrencyReward.MaxQuantity] : null;
          action.cashChance = recipe.BaseCurrencyLootChance;
          action.commonChance = recipe.BaseCommonLootChance;
          action.rareChance = recipe.BaseRareLootChance;
          action.common = weighted(recipe.CommonDropTable);
          action.rare = weighted(recipe.RareDropTable);
          action.completion = weighted(recipe.CompletionDropTable ?? []);
          break;
      }
      if (Number.isFinite(action.seconds) && action.seconds > 0) {
        if (Object.hasOwn(SKILLS, skill)) actions.push(action);
        if (action.baseXp > 0) xpActions.push(action);
      }
    }
  }
  const shopModifiers = Object.fromEntries(objects.ShopPurchase.flatMap(purchase => {
    const modifiers = persistentModifiers(purchase.Provides?.Bonuses);
    return modifiers.length ? [[purchase.Id, modifiers]] : [];
  }));
  const astrologyModifiers = Object.fromEntries(objects.AstrologyNode.map(node => [
    node.Id, persistentModifiers(node.Bonuses)
  ]));
  const petModifiers = Object.fromEntries(objects.Pet.map(pet => [pet.Id, persistentModifiers(pet.Bonuses)]));
  const equipmentSets = objects.EquipmentSetBonus.flatMap(set => {
    const bonuses = set.Bonuses.map(bonus => ({
      count: bonus.ItemCount, modifiers: persistentModifiers(bonus.Modifiers)
    })).filter(bonus => bonus.modifiers.length);
    return bonuses.length ? [{ items: set.Items.map(localId), bonuses }] : [];
  });
  const registered = (entries = []) => new Set(entries.map(({ Id }) => localId(Id)));
  const points = new Map(objects.MasteryGuildCategory.map(row => [row.Id, row.BasePoints]));
  function masteryDescription(guild) {
    const taskIds = registered(guild.MasteryGuildTasks);
    const rankIds = registered(guild.MasteryGuildRanks);
    const bonusIds = registered(guild.MasteryGuildBonuses);
    return {
      tasks: objects.MasteryGuildTask.filter(task => taskIds.has(task.Id)).map(task => ({
        id: task.Id, points: points.get(localId(task.Category)) ?? 0,
        goal: task.Goal?.Data.Id, max: task.Goal?.Data.MaxProgress, linked: localId(task.LinkedTask),
        condition: task.ConditionGoal, trigger: !!task.TriggerGoal
      })),
      ranks: objects.MasteryGuildRank.filter(rank => rankIds.has(rank.Id))
        .sort((a, b) => a.PointPercentRequired - b.PointPercentRequired)
        .map(rank => ({ id: rank.Id, percent: rank.PointPercentRequired })),
      bonuses: objects.MasteryGuildBonus.filter(bonus => bonusIds.has(bonus.Id) &&
        bonus.Requirements.length === 1 && bonus.Requirements[0].Type === 'MelvorBase:MasteryGuildRank')
        .map(bonus => ({
          rank: localId(bonus.Requirements[0].Data.Rank),
          modifiers: persistentModifiers(bonus.Rewards.Bonuses)
        }))
    };
  }
  const mastery = Object.fromEntries(Object.keys(XP_SKILLS).flatMap(skill => {
    const guild = data.EntityConfig['MelvorBase:' + skill];
    return guild?.MasteryGuildTasks ? [[skill, masteryDescription(guild)]] : [];
  }));
  const combatSlots = Object.fromEntries([...(objects.EquipmentSlot ?? []), ...(objects.ToolbeltSlot ?? []), ...(objects.PrayerSlot ?? [])]
    .map(slot => [slot.Id, { name: slot.DisplayName }]));
  const combatSpells = Object.fromEntries([...(objects.MagicSpell ?? []), ...(objects.Imbuement ?? [])].map(spell =>
    [spell.Id, { name: spell.DisplayName, stats: spell.Stats, element: localId(spell.Element), runes: (spell.RuneCosts ?? []).map(({ Item, Quantity }) =>
      ({ id: localId(Item), quantity: Quantity })) }]
  ));
  const runeIds = new Set(Object.values(combatSpells).flatMap(spell => spell.runes.map(row => row.id)));
  const toolSlots = registered(data.EntityConfig['MelvorBase:Combat']?.ToolbeltSlots);
  const toolTypes = new Set((objects.ToolbeltSlot ?? []).filter(slot => toolSlots.has(slot.Id)).map(slot => slot.FitsType));
  const combatSupplies = Object.fromEntries(objects.Item.flatMap(item => {
    const capabilities = item.Capabilities ?? {};
    const tool = capabilities['MelvorBase:Toolbelt'];
    const equipment = capabilities['MelvorBase:Equipment'];
    const food = capabilities['MelvorBase:Food'];
    const conditions = equipment?.ConsumesOn ?? (toolTypes.has(tool?.FitsInSlot) ? tool.ConsumesOn : null);
    const rule = food ? { kind: 'food', healing: food.BaseHealing,
      bonuses: food.Bonuses?.Component?.Component === 'Food' ? food.Bonuses.Modifiers?.Component ?? [] : [] } :
      runeIds.has(item.Id) ? { kind: 'rune' } :
      equipment?.Type === 'MelvorBase:Ammo' ? { kind: 'ammo', ammoType: equipment.AmmoType } :
      conditions?.length ? { kind: 'charged', events: conditions } : null;
    return rule ? [[item.Id, rule]] : [];
  }));
  const named = (types, select = () => ({})) => Object.fromEntries(types.flatMap(type =>
    (objects[type] ?? []).map(row => [row.Id, { name: row.DisplayName, ...select(row) }])
  ));
  const combatModel = {
    items: Object.fromEntries(objects.Item.flatMap(item => {
      const capabilities = item.Capabilities ?? {};
      const equipment = capabilities['MelvorBase:Equipment'];
      const tool = capabilities['MelvorBase:Toolbelt'];
      if (!equipment && !toolTypes.has(tool?.FitsInSlot)) return [];
      return [[item.Id, { stats: equipment?.Stats, weapon: capabilities['MelvorBase:Weapon'],
        ammoType: equipment?.AmmoType, bonuses: equipment?.Bonuses?.Component ?? tool?.Bonuses?.Component,
        xpModifiers: persistentModifiers(equipment?.Bonuses ?? tool?.Bonuses) }]];
    })),
    weaponTypes: named(['WeaponType'], row => ({ stances: row.Stances.map(localId) })),
    stances: named(['AttackStance'], row => ({ style: localId(row.CombatStyle), accuracy: localId(row.AccuracyStat),
      evasion: localId(row.EvasionStat), bonuses: row.Bonuses?.Component, xpModifiers: persistentModifiers(row.Bonuses),
      xpPerDamage: Object.fromEntries((row.ExperienceGain ?? []).map(gain => [localId(gain.Component.Entity), gain.ExperiencePerDamage])) })),
    styles: named(['CombatStyle'], row => ({ ...row })),
    attributes: named(['CombatStat'], row => ({ percent: row.IsPercent, category: localId(row.Category) })),
    names: named(['Element', 'DamageType']),
    prayers: named(['Prayer'], row => ({ bonuses: row.Bonuses?.Component, cost: row.Cost, event: row.ConsumesOn,
      xpModifiers: persistentModifiers(row.Bonuses) })),
    triangle: (objects.CombatTriangleBonus ?? []).map(row => ({ player: localId(row.PlayerStyle),
      enemy: localId(row.EnemyStyle), bonuses: row.Bonuses?.Component ?? [] })),
    foodUpgrades: Object.fromEntries(objects.ShopPurchase.flatMap(row => {
      const global = (row.Provides?.Bonuses?.Global ?? []).filter(bonus => /^GlobalFlatAutoEat/.test(bonus.StatGroup));
      return global.length ? [[row.Id, global]] : [];
    })),
    savedBonuses: Object.fromEntries([
      ['ShopPurchase', row => row.Provides?.Bonuses?.Component], ['AstrologyNode', row => row.Bonuses?.Component],
      ['Pet', row => row.Bonuses?.Component]
    ].map(([type, bonuses]) => [type, Object.fromEntries((objects[type] ?? []).flatMap(row => {
      const applicable = (bonuses(row) ?? []).filter(bonus => bonus.LocalContext?.Component?.Entity === 'MelvorBase:Combat');
      return applicable.length ? [[row.Id, applicable]] : [];
    }))])),
    sets: objects.EquipmentSetBonus.map(set => ({ items: set.Items.map(localId), bonuses: set.Bonuses.map(bonus =>
      ({ count: bonus.ItemCount, rows: bonus.Modifiers?.Component, xpModifiers: persistentModifiers(bonus.Modifiers) })) }))
  };
  return { items, actions, combatTargets: makeCombatTargets(data, items), combatSlots, combatSpells, combatSupplies, combatModel,
    skills: SKILLS, xpActions, xpSkills: XP_SKILLS, shopModifiers, astrologyModifiers,
    petModifiers, equipmentSets, mastery };
}

module.exports = { makeCatalog };
