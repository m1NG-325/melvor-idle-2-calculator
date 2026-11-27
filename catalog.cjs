const { GOLD, localId } = require('./game-data.cjs');
const { makeQuestGuide, normalizeRequirements: requirements } = require('./quest-catalog.cjs');

const SKILLS = {
  Woodcutting: '伐木', Mining: '采矿', Fishing: '钓鱼', Thieving: '偷窃',
  Smithing: '锻造', Cooking: '烹饪', Crafting: '制作', Fletching: '制箭',
  Runecrafting: '符文锻造', Beastcrafting: '野兽工艺', Firemaking: '生火',
  Herblore: '草药学', Hunting: '狩猎', Farming: '农务', Ranching: '畜牧'
};

const XP_SKILLS = {
  ...SKILLS, Astrology: '星象学', Agility: '灵巧',
  Attack: '攻击', Strength: '力量', Defence: '防御',
  Hitpoints: '生命值', Ranged: '远程', Magic: '魔法', Prayer: '祝祭', Slayer: '屠杀者'
};

function combatAttackPatterns(attacks, available) {
  return (available ?? []).flatMap(({ Attack, Chance }) => {
    const attack = attacks.get(localId(Attack));
    if (!(Chance > 0) || !attack?.Hits?.length) return [];
    const hits = attack.Hits.map(row => ({
      count: row.Count, interval: row.Interval,
      damage: (row.Damage ?? []).map(entry => ({ character: entry.Character,
        type: localId(entry.Formula?.Type), factor: entry.Formula?.Data?.Percent }))
    }));
    return [{ chance: Chance, avoidable: attack.IsAvoidable, hits, damageType: localId(attack.DamageType),
      before: attack.PreHitEffects, onHit: attack.OnHitEffects }];
  });
}

function makeCombatTargets(data, items, attacks) {
  const registered = new Set((data.EntityConfig['MelvorBase:Combat']?.Areas ?? []).map(entry => localId(entry.Id)));
  const passives = new Map((data.Objects.CombatPassive ?? []).map(row => [row.Id, row.Modifiers]));
  const passiveModifiers = row => (row.Passives ?? []).flatMap(id => {
    const modifiers = passives.get(localId(id));
    return modifiers ? [{ modifiers, magnitude: 1 }] : [];
  });
  const areaModifiers = row => [...passiveModifiers(row), ...(row.Effect?.Modifiers
    ? [{ modifiers: row.Effect.Modifiers, magnitude: row.Effect.Magnitude ?? 1, area: true }] : [])];
  const areasByEnemy = new Map();
  for (const area of data.Objects.CombatArea ?? []) {
    if (!registered.has(area.Id)) continue;
    for (const enemy of area.Enemies ?? []) {
      if (typeof enemy !== 'string') continue;
      const id = localId(enemy);
      if (!areasByEnemy.has(id)) areasByEnemy.set(id, []);
      areasByEnemy.get(id).push({ id: area.Id, name: area.DisplayName, darkness: area.Darkness ?? 0, category: localId(area.Category),
        requirements: [requirements(area.UnlockRequirements), requirements(area.DisplayRequirements)],
        effects: areaModifiers(area), specialEffects: Boolean(area.Effect || area.Passives?.length) });
    }
  }
  const average = entry => (entry.MinQuantity + entry.MaxQuantity) / 2;
  function rewards(source) {
    const quantities = new Map();
    function add(entry, probability) {
      const id = localId(entry.Item);
      const quantity = average(entry) * probability;
      if (Object.hasOwn(items, id) && Number.isFinite(quantity) && quantity > 0) {
        quantities.set(id, (quantities.get(id) ?? 0) + quantity);
      }
    }
    for (const entry of source?.FixedItems ?? []) add(entry, 1);
    for (const { Chance, Table } of source?.ItemTables ?? []) {
      if (!Array.isArray(Table)) continue;
      const weight = Table.reduce((sum, entry) => sum + entry.Weight, 0);
      if (weight > 0) for (const entry of Table) add(entry, Chance * entry.Weight / weight);
    }
    const gold = (source?.FixedCurrencies ?? []).reduce((sum, entry) =>
      entry.Currency === GOLD ? sum + average(entry) : sum, 0);
    return { gold, drops: Array.from(quantities, ([id, perKill]) => ({ id, perKill })) };
  }
  const enemies = new Map((data.Objects.Enemy ?? []).map(enemy => [enemy.Id, {
      id: enemy.Id, name: enemy.DisplayName, areas: areasByEnemy.get(enemy.Id) ?? [], ...rewards(enemy.Drops),
      levels: Object.fromEntries((enemy.Levels ?? []).map(({ Key, Value }) => [localId(Key), Value])),
      stats: enemy.Stats, element: localId(enemy.Element), damageType: localId(enemy.DamageType),
      requirements: [requirements(enemy.Requirements), requirements(enemy.DisplayRequirements)],
      specialEffects: Boolean(enemy.Passives?.length || enemy.Attacks?.length), pauseOnSpawn: Boolean(enemy.PauseOnSpawn),
      damagePatterns: combatAttackPatterns(attacks, enemy.Attacks), effects: passiveModifiers(enemy),
      stances: (enemy.Stances ?? []).map(({ Stance, Weight }) => [localId(Stance), Weight])
  }]));
  const combatTargets = [...enemies.values()].filter(enemy => enemy.areas.length);
  const combatDungeons = (data.Objects.Dungeon ?? []).filter(row => registered.has(row.Id)).map(row => ({
    id: 'Dungeon:' + row.Id, name: row.DisplayName, darkness: row.Darkness ?? 0, category: localId(row.Category),
    requirements: [requirements(row.UnlockRequirements), requirements(row.DisplayRequirements)],
    effects: areaModifiers(row), specialEffects: Boolean(row.Effect || row.Passives?.length), ...rewards(row.Rewards),
    encounters: (row.Enemies ?? []).map(stage => ({
      count: stage.Count,
      options: (stage.Enemies ?? []).map(({ Enemy, Weight }) => ({ enemy: enemies.get(localId(Enemy)), weight: Weight }))
    }))
  }));
  return { combatTargets, combatDungeons };
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
    ['Action', 'Experience', 'Passive', 'GrainMill'].includes(row.LocalContext?.Component?.Component) &&
    Object.keys(row.LocalContext).every(key =>
      row.LocalContext[key] == null ||
        ['Component', 'Recipe', 'Location', 'Category', 'Subcategory', 'Constellation', 'RecipeType', 'Item', 'Event', 'Currency',
          'Animal', 'Tool', 'TrapType', 'Course', 'Path', 'Obstacle', 'Technique', 'Plot'].includes(key)
    )).map(row => ({
    stat: row.Stat.Name, value: row.Value, skill: localId(row.LocalContext.Component.Entity),
    recipe: localId(row.LocalContext.Recipe), category: localId(row.LocalContext.Category),
    subcategory: localId(row.LocalContext.Subcategory), location: localId(row.LocalContext.Location),
    constellation: localId(row.LocalContext.Constellation), recipeType: localId(row.LocalContext.RecipeType),
    animal: localId(row.LocalContext.Animal), tool: localId(row.LocalContext.Tool), trapType: localId(row.LocalContext.TrapType),
    course: localId(row.LocalContext.Course), path: localId(row.LocalContext.Path), obstacle: localId(row.LocalContext.Obstacle),
    technique: localId(row.LocalContext.Technique), plot: localId(row.LocalContext.Plot),
    item: localId(row.LocalContext.Item ?? row.LocalContext.Currency), event: localId(row.LocalContext.Event),
    scalesWithLevel: localId(row.Scaling?.Data?.Experience?.Entity)
  }));
  return [...global, ...local];
}

const chargeEventSkills = {
  AgilityObstacleAttempted: ['Agility'],
  WoodcuttingDamageTree: ['Woodcutting'],
  MiningMineRock: ['Mining'],
  FishingFishRecipe: ['Fishing'],
  FiremakingBurnRecipe: ['Firemaking'],
  AstrologyConstellationStudied: ['Astrology'],
  ThievingActionPerformed: ['Thieving'],
  ArtisanCreateRecipe: ['Runecrafting'],
  ArtisanPerformStep: ['Smithing', 'Crafting', 'Fletching']
};

function skillChargeModel(tool) {
  if (!tool?.ConsumesOn?.length) return;
  const events = tool.ConsumesOn.map(({ Type, Data }) => {
    const type = localId(Type);
    const skill = localId(Data?.Component?.Entity);
    if (!chargeEventSkills[type]?.includes(skill) || Object.entries(Data).some(([key, value]) => value != null &&
      !['Component', 'Chance', 'Conditions', 'Category', 'Recipe', 'Subcategory', 'MustBeSuccessful',
        'MinRecipeSteps', 'RecipeType', 'SuccessfulActionOnly', 'FailedActionOnly'].includes(key)) ||
      (Data.Conditions != null && (!Array.isArray(Data.Conditions) || Data.Conditions.length))) return;
    return { type, skill, chance: Data.Chance ?? 1, successful: Boolean(Data.MustBeSuccessful),
      category: localId(Data.Category), recipe: localId(Data.Recipe), subcategory: localId(Data.Subcategory),
      recipeType: localId(Data.RecipeType), minSteps: Data.MinRecipeSteps,
      successfulOnly: Boolean(Data.SuccessfulActionOnly), failedOnly: Boolean(Data.FailedActionOnly) };
  });
  if (!events.every(Boolean)) return;
  const modifiers = persistentModifiers(tool.Bonuses);
  if (modifiers.length) return { modifiers, events };
}

function makeItemDetails(data) {
  const objects = data.Objects;
  const labels = Object.create(null);
  const records = new Map(Object.entries(objects).map(([type, rows]) =>
    [type, new Map(rows.map(row => [row.Id, row]))]));
  const byId = new Map();
  for (const [type, rows] of records) for (const [id, row] of rows) {
    if (!row.DisplayName) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ type, row });
  }
  function label(key, name) {
    if (!name) return undefined;
    labels[key] ??= { name };
    return key;
  }
  function reference(type, id, field = 'DisplayName', plural = false) {
    id = localId(id);
    if (!id || id === 'Placeholder') return undefined;
    const candidates = byId.get(id) ?? [];
    const typeAlias = { TrapType: 'HuntingTrapType', Constellation: 'AstrologyConstellation',
      Rune: 'Item', Location: 'FishingLocation', Spell: 'MagicSpell' }[type] ?? type;
    const row = records.get(typeAlias)?.get(id) ?? candidates.find(entry =>
      entry.type.endsWith(typeAlias))?.row ?? (candidates.length === 1 ? candidates[0].row : undefined);
    if (type === 'Skill' || type === 'CombatLevel' && XP_SKILLS[id]) {
      return label('skill:' + id, id === 'Combat' ? '战斗' : XP_SKILLS[id]);
    }
    const name = row?.[field];
    return label([type, id, field, plural].join(':'), plural ? name?.Plural ?? name : name);
  }
  const contextKeys = context => Object.keys(context ?? {}).filter(key => context[key] != null).sort();
  const templateKey = (stat, local = [], fromType = '', from = []) =>
    [stat.StatsType, stat.Name, [...local].sort().join(','), fromType ?? '', [...from].sort().join(',')].join('|');
  const templates = new Map((data.ComponentModifierDescriptions ?? []).map(({ Key, TemplateString }) =>
    [templateKey(Key.Stat, Key.LocalContextObjectCombination, Key.FromContextType,
      Key.FromContextObjectCombination), TemplateString]));
  const globalTemplates = new Map((data.GlobalModifierDescriptions ?? []).map(row => [row.StatGroup, row]));
  const decreasesHelp = /Interval|Cost$|DamageTaken|EatsQuantity|ObstacleDifficulty|^FlatDifficulty$/;
  function effect(row, group) {
    if (!Number.isFinite(row.Value) || row.Value === 0) return [];
    const local = row.LocalContext;
    const from = row.FromContext?.Data;
    const stat = row.Stat?.Name ?? row.StatGroup;
    if (!stat) return [];
    const key = row.Stat && templateKey(row.Stat, contextKeys(local), row.FromContext?.Type, contextKeys(from));
    const global = globalTemplates.get(stat);
    const template = global?.TemplateString ?? templates.get(key);
    const args = {};
    for (const [token] of template?.matchAll(/\{(?:LocalContext|FromContext|LocComponent)\.[^{}]+\}/g) ?? []) {
      const [scope, type, field, extra] = token.slice(1, -1).split('.');
      const context = scope === 'FromContext' ? from : local;
      args[token] = type === 'Component' || scope === 'LocComponent'
        ? reference('Skill', context?.Component?.Entity)
        : reference(type, context?.[type], field, extra === 'Plural');
    }
    const skills = [...new Set([local, from].map(context => localId(context?.Component?.Entity))
      .filter(id => XP_SKILLS[id] || id === 'Combat'))];
    const unit = template?.includes('intervaltime') || template?.includes('numbertime(ms)') ? 'seconds' :
      template?.includes('%') || /^Percent/.test(stat) ? 'percent' : undefined;
    const negative = global?.Kind === 'Negative' || decreasesHelp.test(stat);
    return [{ group, stat, template: label('modifier:' + (key || stat), template), args, skills, value: row.Value, unit,
      statLabel: reference('CombatStat', local?.CombatStat), polarity: (negative ? -row.Value : row.Value) > 0 ? 'buff' : 'debuff',
      globalSkillEffect: ['GlobalPercentXpGained', 'GlobalFlatXpGained', 'GlobalPercentActionInterval', 'GlobalFlatActionInterval'].includes(stat),
      conditional: !!(row.Condition || row.Scaling || row.FromContext) }];
  }
  function combatEffect(row, group) {
    const modifier = row.Modifier ?? row;
    const id = localId(modifier.Effect?.Data?.Effect);
    const definition = records.get(localId(modifier.Effect?.Type) + 'Effect')?.get(id);
    const name = label('effect:' + id, definition?.DisplayName ?? (byId.get(id) ?? [])
      .find(entry => entry.type.endsWith('Effect'))?.row.DisplayName);
    if (!name || row.Chance === 0) return [];
    return [{ group, name, chance: row.Chance, target: modifier.AppliesTo === 'Target',
      polarity: (definition?.IsPositive ?? modifier.AppliesTo !== 'Target') ? 'buff' : 'debuff',
      conditional: !!(row.Condition || row.Scaling) }];
  }
  function modifierRows(bonuses, group) {
    return [...(bonuses?.Global ?? []), ...(bonuses?.Component ?? [])].flatMap(row => effect(row, group))
      .concat((bonuses?.CombatEffect ?? []).flatMap(row => combatEffect(row, group)));
  }
  const sets = new Map();
  for (const set of objects.EquipmentSetBonus ?? []) {
    for (const item of set.Items ?? []) {
      const id = localId(item);
      if (!sets.has(id)) sets.set(id, []);
      for (const bonus of set.Bonuses ?? []) sets.get(id).push(...modifierRows(bonus.Modifiers,
        { type: 'set', name: label('set:' + set.Id, set.DisplayName), count: bonus.ItemCount }));
    }
  }
  const details = Object.fromEntries(objects.Item.flatMap(item => {
    const get = capability => item.Capabilities?.['MelvorBase:' + capability];
    const equipment = get('Equipment');
    const tool = get('Toolbelt');
    const food = get('Food');
    const trap = get('HuntingTrap');
    const stats = (equipment?.Stats?.Stats ?? []).flatMap(({ Stat, Value }) => {
      if (!Number.isFinite(Value) || Value === 0) return [];
      const id = localId(Stat);
      const stat = records.get('CombatStat')?.get(id);
      return [{ name: reference('CombatStat', id), stat: id, value: Value,
        unit: id === 'AttackInterval' ? 'seconds' : stat?.IsPercent ? 'percent' : undefined,
        polarity: id === 'AttackInterval' ? undefined : Value > 0 ? 'buff' : 'debuff' }];
    });
    for (const [rows, rating] of [[equipment?.Stats?.PowerRatings, 'power'], [equipment?.Stats?.ProtectionRatings, 'protection']]) {
      for (const { DamageType, Value } of rows ?? []) if (Number.isFinite(Value) && Value !== 0) {
        stats.push({ rating, name: reference('DamageType', DamageType), value: Value, polarity: Value > 0 ? 'buff' : 'debuff' });
      }
    }
    const attacks = (equipment?.Attacks ?? []).flatMap(({ Attack, Chance }) => {
      const attack = records.get('Attack')?.get(localId(Attack));
      if (!attack || !(Chance > 0)) return [];
      const group = { type: 'attack', name: reference('Attack', Attack), chance: Chance };
      const effects = [...(attack.PreHitEffects ?? []), ...(attack.OnHitEffects ?? [])]
        .flatMap(row => combatEffect(row, group));
      return effects.length ? effects : [{ group, name: group.name }];
    });
    const effects = [
      ...modifierRows(equipment?.Bonuses, { type: 'equipment' }), ...modifierRows(tool?.Bonuses, { type: 'tool' }),
      ...modifierRows(food?.Bonuses?.Modifiers ?? food?.Bonuses, { type: 'food' }),
      ...modifierRows(get('FishingBait')?.Bonuses, { type: 'bait' }),
      ...modifierRows({ Component: get('Compost')?.CompostModifierTemplate }, { type: 'compost' }),
      ...modifierRows({ Component: trap?.TrapBonuses }, { type: 'trap' }),
      ...modifierRows({ Component: trap?.FailBonuses }, { type: 'trapFail' }),
      ...attacks, ...(sets.get(item.Id) ?? [])
    ];
    const detail = { description: label('description:' + item.Id, item.Description),
      slot: reference('EquipmentType', equipment?.Type) ?? reference('ToolbeltSlotType', tool?.FitsInSlot),
      occupies: (equipment?.OccupiesSlots ?? []).map(slot => reference('EquipmentType', slot)),
      requirements: requirements(equipment?.Requirements ?? tool?.Requirements),
      healing: food?.BaseHealing, stats, effects };
    return detail.description || detail.slot || detail.healing || stats.length || effects.length ? [[item.Id, detail]] : [];
  }));
  return { itemDetails: details, itemDetailLabels: labels };
}

function makeCatalog(data) {
  const objects = data.Objects;
  const items = Object.fromEntries(objects.Item.map(item => {
    const tool = item.Capabilities?.['MelvorBase:Toolbelt'];
    const trap = item.Capabilities?.['MelvorBase:HuntingTrap'];
    const permanent = tool && !tool.ConsumesOn && !tool.CanEquipQuantity;
    const modifiers = permanent ? persistentModifiers(tool.Bonuses) : [];
    const cookingTriggers = tool?.ConsumesOn?.filter(({ Type, Data }) => localId(Type) === 'CookRecipe' &&
      Data.Chance == null && (Data.Conditions == null || (Array.isArray(Data.Conditions) && !Data.Conditions.length)) &&
      localId(Data.Component?.Entity) === 'Cooking')
      .map(({ Data }) => ({ recipe: localId(Data.Recipe), category: localId(Data.Category), subcategory: localId(Data.Subcategory) }));
    const cookingModifiers = cookingTriggers?.length ? persistentModifiers(tool.Bonuses)
      .filter(modifier => modifier.skill === 'Cooking' && modifier.stat === 'FlatProficiency') : [];
    const skillCharges = skillChargeModel(tool);
    return [item.Id, {
      name: item.DisplayName.Singular, price: item.SellsFor?.Currency === GOLD ? item.SellsFor.Quantity : 0,
      ...(tool ? { skillTool: { slotType: localId(tool.FitsInSlot), requirements: requirements(tool.Requirements),
        consumable: Boolean(tool.CanEquipQuantity || tool.ConsumesOn?.length) } } : {}),
      ...(modifiers.length ? { modifiers } : {}),
      ...(skillCharges ? { skillCharges } : {}),
      ...(trap ? { huntingTrap: { type: localId(trap.TrapType),
        bonuses: persistentModifiers({ Component: trap.TrapBonuses }),
        failBonuses: persistentModifiers({ Component: trap.FailBonuses }) } } : {}),
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
  const heistBonuses = new Map((objects.ThievingHeistBonus ?? []).map(row => [row.Id, row]));
  const requirementGroups = (...rows) => rows.filter(Boolean).flatMap(row =>
    ['Requirements', 'DisplayRequirements', 'AccessRequirements', 'UnlockRequirements', 'SecondaryRequirements']
      .map(key => requirements(row[key] ?? [])).filter(group => group.length));
  const itemCosts = costs => (costs?.Items ?? []).map(row => [localId(row.Item), row.Quantity]);
  const currencyCosts = costs => (costs?.Currencies ?? []).map(row => [localId(row.Currency), row.Quantity]);
  const product = ({ Item, Quantity, Chance }) => [localId(Item), Quantity, Chance ?? 1];
  const index = type => new Map((objects[type] ?? []).map(row => [row.Id, row]));
  const registeredSkillRows = (skill, key, type) => {
    const records = index(type);
    return (data.EntityConfig['MelvorBase:' + skill]?.[key] ?? []).map(row => records.get(localId(row.Id))).filter(Boolean);
  };
  const plainName = row => row.DisplayName?.Singular ?? row.DisplayName;
  const actionCategoryOrder = Object.fromEntries([...Object.keys(XP_SKILLS), 'Combat'].map(skill => {
    const config = data.EntityConfig['MelvorBase:' + skill] ?? {};
    const groups = skill === 'Combat' ? [config.Areas] : [config.Locations, config.Categories, config.MillCategories];
    return [skill, groups.flatMap(group => [...(group ?? [])].sort((a, b) => (a.Priority ?? 0) - (b.Priority ?? 0))
      .map(row => localId(row.Id)).filter(Boolean))];
  }));

  for (const skill of [...Object.keys(SKILLS).filter(skill => !['Hunting', 'Farming', 'Ranching'].includes(skill)), 'Astrology']) {
    const recipes = new Map(objects[types[skill] ?? 'ArtisanRecipe'].map(recipe => [recipe.Id, recipe]));
    const config = data.EntityConfig['MelvorBase:' + skill];
    const included = config.Recipes ?? config.Constellations;
    for (const { Id } of included) {
      const recipe = recipes.get(localId(Id));
      if (!recipe) continue;
      const area = categories.get(localId(recipe.Location ?? recipe.Category));
      const kind = types[skill] ? skill : 'Artisan';
      const action = {
        id: skill + ':' + recipe.Id, recipe: recipe.Id, name: recipe.DisplayName, area: area?.DisplayName, skill, kind,
        category: localId(recipe.Category), subcategory: localId(recipe.Subcategory), location: localId(recipe.Location),
        requirementGroups: requirementGroups(area, recipe), seconds: recipe.BaseInterval / 1000,
        steps: Math.max(1, recipe.Steps ?? 1), baseXp: recipe.BaseExperience, costs: [], rewards: [], cash: 0
      };
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
          if (!(recipe.Stages > 0) || !['NPC', 'Stall', 'Chest', 'Heist'].includes(localId(recipe.RecipeType))) continue;
          action.steps = recipe.Stages;
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
          action.heistBonuses = (recipe.HeistBonuses ?? []).flatMap(id => {
            const row = heistBonuses.get(localId(id));
            if (!row) return [];
            const bonuses = (row.Bonuses ?? []).map(bonus => ({ ...bonus, LocalContext: {
              ...bonus.LocalContext, Recipe: bonus.LocalContext?.Recipe === 'Placeholder:Placeholder'
                ? 'MelvorBase:' + recipe.Id : bonus.LocalContext?.Recipe
            } }));
            return [{ requirements: requirements(row.Requirements), modifiers: persistentModifiers({ Component: bonuses }) }];
          });
          break;
      }
      if (Number.isFinite(action.seconds) && action.seconds > 0) {
        if (Object.hasOwn(SKILLS, skill)) actions.push(action);
        if (action.baseXp > 0) xpActions.push(action);
      }
    }
  }
  const agilityLocations = index('AgilityLocation');
  const agilityPaths = index('AgilityCoursePath');
  const agilityObstacles = index('AgilityObstacle');
  const agilityTechniques = registeredSkillRows('Agility', 'Techniques', 'AgilityTechnique');
  const huntingLocations = index('HuntingLocation');
  const farmingCategories = index('FarmingCategory');
  for (const course of registeredSkillRows('Agility', 'Courses', 'AgilityCourse')) {
    const location = localId(course.Location);
    const area = agilityLocations.get(location);
    for (const id of course.Paths ?? []) {
      const path = agilityPaths.get(localId(id));
      if (!(path?.BaseExperience > 0)) continue;
      const obstacles = (path.Obstacles ?? []).map(localId).map(id => agilityObstacles.get(id));
      if (!obstacles.length || obstacles.some(obstacle => !obstacle)) continue;
      xpActions.push({
        id: 'Agility:' + path.Id, recipe: course.Id, course: course.Id, path: path.Id, location,
        name: [plainName(course), (course.Paths.length > 1 ? plainName(path) : '')].filter(Boolean).join(' · '),
        area: area?.DisplayName, skill: 'Agility', kind: 'Agility', baseXp: path.BaseExperience,
        obstacleData: obstacles.map(row => ({ id: row.Id, ms: row.BaseInterval, technique: localId(row.Technique),
          difficulty: row.Difficulty, damage: row.Damage, trap: row.IsTrap })),
        requirementGroups: requirementGroups(area, course, path), cash: 0, rewards: [],
        costs: itemCosts(course.EntryCost), currencyCosts: currencyCosts(course.EntryCost)
      });
    }
  }
  for (const animal of registeredSkillRows('Hunting', 'Animals', 'HuntingAnimal')) {
    if (!(animal.BaseExperience > 0)) continue;
    const location = localId(animal.Location);
    const area = huntingLocations.get(location);
    xpActions.push({
      id: 'Hunting:' + animal.Id, recipe: animal.Id, animal: animal.Id, location, tool: localId(animal.Tool),
      trapType: localId(animal.TrapType), name: plainName(animal), area: area?.DisplayName,
      skill: 'Hunting', kind: 'Hunting', baseXp: animal.BaseExperience,
      requirementGroups: requirementGroups(area, animal), cash: 0,
      costs: [], currencyCosts: [], rewards: (animal.Products ?? []).map(row => [localId(row.Item), row.Quantity, row.Chance ?? 1]),
      hunt: { tracks: [animal.BaseMinTrackingSteps, animal.BaseMaxTrackingSteps],
        trackingInterval: [animal.BaseMinTrackInterval, animal.BaseMaxTrackInterval],
        trappingInterval: [animal.BaseMinTrapInterval, animal.BaseMaxTrapInterval], surveyMs: area?.BaseSurveyInterval ?? 0,
        trackChance: animal.BaseTrackSuccessChance, trapChance: animal.BaseTrapSuccessChance,
        allowTrapless: animal.EnableTrapless, traplessRequirements: requirements(animal.TraplessRequirements ?? []),
        traplessBonuses: persistentModifiers({ Component: animal.TraplessBonuses }),
        bait: localId(animal.PreferredBait), baitBonuses: persistentModifiers({ Component: animal.BaitModifierTemplate }) }
    });
  }
  for (const crop of registeredSkillRows('Farming', 'Recipes', 'FarmingRecipe')) {
    if (!(crop.BaseExperience > 0) || !(crop.BaseInterval > 0)) continue;
    const category = localId(crop.Category);
    const area = farmingCategories.get(category);
    xpActions.push({
      id: 'Farming:' + crop.Id, recipe: crop.Id, category, subcategory: localId(crop.Subcategory),
      name: plainName(crop), area: area?.DisplayName, skill: 'Farming', kind: 'Farming',
      baseXp: crop.BaseExperience, seconds: crop.BaseInterval / 1000, requirementGroups: requirementGroups(area, crop),
      costs: itemCosts(crop.Ingredients), currencyCosts: currencyCosts(crop.Ingredients),
      rewards: crop.Product ? [product(crop.Product)] : [],
      farm: { regrows: crop.Regrows, regrowMs: crop.RegrowInterval, automation: requirements(crop.AutomationRequirements ?? []),
        autoItems: itemCosts(crop.AutomationCosts), autoCurrencies: currencyCosts(crop.AutomationCosts) }
    });
  }
  const millConfig = objects.GrainMill?.[0];
  const millCategories = index('FarmingMillCategory');
  for (const recipe of registeredSkillRows('Farming', 'GrainMillRecipes', 'GrainMillRecipe')) {
    if (!(recipe.BaseExperience > 0)) continue;
    const category = localId(recipe.Category);
    const area = millCategories.get(category);
    xpActions.push({ id: 'Farming:Mill:' + recipe.Id, recipe: recipe.Id, category,
      name: [area?.DisplayName, plainName(recipe)].filter(Boolean).join(' · '), area: area?.DisplayName,
      skill: 'Farming', kind: 'GrainMill', baseXp: recipe.BaseExperience, seconds: 300,
      requirementGroups: requirementGroups(millConfig, area, recipe), costs: itemCosts(recipe.Ingredients),
      rewards: recipe.Product ? [product(recipe.Product)] : [] });
  }
  const ranchAnimals = registeredSkillRows('Ranching', 'Animals', 'RanchingAnimal');
  for (const land of registeredSkillRows('Ranching', 'Land', 'RanchingLand')) {
    xpActions.push({ id: 'Ranching:' + land.Id, recipe: land.Id, land: land.Id, name: plainName(land),
      skill: 'Ranching', kind: 'Ranching', requirementGroups: [], baseXp: 0 });
  }
  xpActions.push({ id: 'Ranching:CurrentHerd', recipe: 'CurrentHerd', name: '全部畜群',
    names: { en: 'All Animals', zh: '全部畜群' }, skill: 'Ranching', kind: 'Ranching',
    requirementGroups: [], baseXp: 0 });
  const xpSkillData = {
    agilityTechniques: agilityTechniques.map(row => ({ id: row.Id, cap: row.LevelCap,
      bonuses: persistentModifiers({ Component: row.DifficultyMetBonuses }) })),
    huntingJournal: registeredSkillRows('Hunting', 'JournalLevelBonuses', 'HuntingJournalBonus')
      .map(row => ({ level: row.UnlockLevel, bonuses: persistentModifiers({ Component: row.JournalModifierTemplate }) })),
    farmingPlots: Object.fromEntries(registeredSkillRows('Farming', 'Plots', 'FarmingPlot').map(row => [row.Id, localId(row.Category)])),
    ranchAnimals: Object.fromEntries(ranchAnimals.map(row => [row.Id, { baseXp: row.BaseExperience,
      baseVariant: localId(row.BaseVariant), variants: (row.Variants ?? []).map(row => [localId(row.Variant), row.Weight]),
      products: (row.Products ?? []).map(product),
      foods: (row.Eats ?? []).map(entry => [localId(entry.Item), entry.Quantity]) }])),
    ranchUpgrades: Object.fromEntries((objects.RanchingEnclosureUpgrade ?? []).map(row => [row.Id,
      persistentModifiers({ Component: row.Bonuses })])),
    ranchVariants: Object.fromEntries((objects.RanchingAnimalVariant ?? []).map(row => [row.Id,
      persistentModifiers({ Component: (row.SelfBonuses ?? []).map(bonus => ({ ...bonus, FromContext: null })) })]))
  };
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
  const toolbeltSlots = index('ToolbeltSlot');
  const skillToolSlots = Object.fromEntries(Object.keys(XP_SKILLS).map(skill => [
    skill, [...registered(data.EntityConfig['MelvorBase:' + skill]?.ToolbeltSlots)].flatMap(id => {
      const slot = toolbeltSlots.get(id);
      return slot ? [{ id, type: localId(slot.FitsType), requirements: requirements(slot.UnlockRequirements) }] : [];
    })
  ]));
  const shopConfig = data.EntityConfig['MelvorBase:Shop'];
  const shopCategories = index('ShopCategory');
  const shopSections = index('ShopSubcategory');
  const agilityShop = shopCategories.get('AgilityUpgrades');
  const agilitySections = new Set([...registered(shopConfig?.Subcategories)].filter(id =>
    localId(shopSections.get(id)?.Category) === 'AgilityUpgrades'));
  const skillShop = {
    group: { id: 'AgilityUpgrades', name: agilityShop?.DisplayName ?? '灵巧' },
    sections: Object.fromEntries([...agilitySections].map(id => [id, { name: shopSections.get(id).DisplayName }])),
    purchases: []
  };
  if (registered(shopConfig?.Categories).has('AgilityUpgrades')) {
    const purchases = index('ShopPurchase');
    for (const id of registered(shopConfig?.Purchases)) {
      const purchase = purchases.get(id);
      const sectionId = localId(purchase?.Subcategory);
      if (!agilitySections.has(sectionId) || purchase.Provides?.Items?.length !== 1) continue;
      const [reward] = purchase.Provides.Items;
      const item = localId(reward.Item);
      if (!items[item]?.skillTool || !(reward.Quantity > 0)) continue;
      skillShop.purchases.push({ id, item, sectionId, quantity: reward.Quantity, buyLimit: purchase.DefaultBuyLimit,
        requirementGroups: requirementGroups(agilityShop, shopSections.get(sectionId), purchase),
        costs: itemCosts(purchase.Costs), currencyCosts: currencyCosts(purchase.Costs) });
    }
  }
  const combatConfig = data.EntityConfig['MelvorBase:Combat'];
  const spellBooks = new Map((objects.SpellBook ?? []).map(book => [book.Id, book]));
  const availableSpells = registered(combatConfig?.Spells);
  const combatSpells = Object.fromEntries([...(objects.MagicSpell ?? []), ...(objects.Imbuement ?? [])].map(spell =>
    [spell.Id, { name: spell.DisplayName, stats: spell.Stats, effects: spell.Bonuses?.CombatEffect,
      element: localId(spell.Element), runes: (spell.RuneCosts ?? []).map(({ Item, Quantity }) =>
      ({ id: localId(Item), quantity: Quantity })), trainable: availableSpells.has(spell.Id),
      requirements: [requirements(spell.UnlockRequirements), requirements(spellBooks.get(localId(spell.Book))?.Requirements)] }]
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
      equipment?.AmmoType ? { kind: 'ammo', ammoType: equipment.AmmoType } :
      conditions?.length ? { kind: 'charged', events: conditions } : null;
    return rule ? [[item.Id, rule]] : [];
  }));
  const named = (types, select = () => ({})) => Object.fromEntries(types.flatMap(type =>
    (objects[type] ?? []).map(row => [row.Id, { name: row.DisplayName, ...select(row) }])
  ));
  const equipmentSlots = registered(combatConfig?.EquipmentSlots);
  const prayerSlots = registered(combatConfig?.PrayerSlots);
  const availablePrayers = registered(combatConfig?.Prayers);
  const combatAttacks = new Map((objects.Attack ?? []).map(row => [row.Id, row]));
  const combatModel = {
    effects: Object.fromEntries(Object.keys(objects).filter(key => key.endsWith('Effect')).flatMap(key =>
      objects[key].map(row => [row.Id, { ...row, type: key.slice(0, -'Effect'.length) }]))),
    equipmentSlots: (objects.EquipmentSlot ?? []).filter(slot => equipmentSlots.has(slot.Id))
      .map(slot => ({ id: slot.Id, type: localId(slot.FitsType), requirements: requirements(slot.UnlockRequirements) })),
    prayerSlots: (objects.PrayerSlot ?? []).filter(slot => prayerSlots.has(slot.Id))
      .map(slot => ({ id: slot.Id, type: localId(slot.FitsType), requirements: requirements(slot.UnlockRequirements) })),
    items: Object.fromEntries(objects.Item.flatMap(item => {
      const capabilities = item.Capabilities ?? {};
      const equipment = capabilities['MelvorBase:Equipment'];
      const tool = capabilities['MelvorBase:Toolbelt'];
      if (!equipment && !toolTypes.has(tool?.FitsInSlot)) return [];
      return [[item.Id, { stats: equipment?.Stats, weapon: capabilities['MelvorBase:Weapon'],
        slotType: localId(equipment?.Type), occupies: (equipment?.OccupiesSlots ?? []).map(localId),
        stackable: Boolean(equipment?.CanEquipQuantity),
        requirements: requirements(equipment?.Requirements), specialAttacks: Boolean(equipment?.Attacks?.length),
        attacks: combatAttackPatterns(combatAttacks, equipment?.Attacks),
        effects: equipment?.Bonuses?.CombatEffect ?? tool?.Bonuses?.CombatEffect,
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
      requirements: requirements(row.UnlockRequirements), trainable: availablePrayers.has(row.Id), slotType: localId(row.FitsInSlot),
      xpModifiers: persistentModifiers(row.Bonuses) })),
    triangle: (objects.CombatTriangleBonus ?? []).map(row => ({ player: localId(row.PlayerStyle),
      enemy: localId(row.EnemyStyle), bonuses: row.Bonuses?.Component ?? [] })),
    foodUpgrades: Object.fromEntries(objects.ShopPurchase.flatMap(row => {
      const global = (row.Provides?.Bonuses?.Global ?? []).filter(bonus => /^GlobalFlatAutoEat/.test(bonus.StatGroup));
      return global.length ? [[row.Id, global]] : [];
    })),
    savedBonuses: Object.fromEntries([
      ['ShopPurchase', row => row.Provides?.Bonuses?.Component], ['AstrologyNode', row => row.Bonuses?.Component],
      ['Pet', row => row.Bonuses?.Component], ['MasteryGuildBonus', row => row.Rewards?.Bonuses?.Component]
    ].map(([type, bonuses]) => [type, Object.fromEntries((objects[type] ?? []).flatMap(row => {
      const applicable = (bonuses(row) ?? []).filter(bonus => bonus.LocalContext?.Component?.Entity === 'MelvorBase:Combat');
      return applicable.length ? [[row.Id, applicable]] : [];
    }))])),
    sets: objects.EquipmentSetBonus.map(set => ({ items: set.Items.map(localId), bonuses: set.Bonuses.map(bonus =>
      ({ count: bonus.ItemCount, rows: bonus.Modifiers?.Component, xpModifiers: persistentModifiers(bonus.Modifiers) })) }))
  };
  const statisticSubjects = named(['Enemy', 'Dungeon', 'CombatStyle', 'CombatEffect', 'Prayer', 'HuntingAnimal',
    'HuntingAnimalSpecies', 'RanchingAnimal', 'SlayerMaster', 'AstrologyObservationEvent', 'AstrologyConstellation',
    'AgilityCourse', 'FarmingRecipe', 'ThievingRecipe']);
  const anvil = objects.SacrificialAnvilRewardMode?.find(row => row.Id === 'SacrificialAnvil');
  const smithingModes = data.EntityConfig['MelvorBase:Smithing']?.RewardModes ?? [];
  const sacrificialAnvil = anvil && smithingModes.some(row => localId(row.Id) === anvil.Id) ? {
    requirements: requirements(anvil.UnlockRequirements),
    categories: anvil.AllowedCategories?.map(localId),
    xpWeight: anvil.BonusXpWeight, xpMultiplier: anvil.BonusXpMultiplier,
    saleWeight: anvil.BonusSaleValueWeight, saleMultiplier: anvil.BonusSaleValueMultiplier,
    collectableWeight: anvil.CollectableWeight,
    collectables: (anvil.Collectables ?? []).map(row => ({
      id: localId(row.Item), quantity: (row.MinQuantity + row.MaxQuantity) / 2, weight: row.Weight
    }))
  } : undefined;
  const itemUpgrades = (objects.ItemUpgrade ?? []).flatMap(row => {
    const item = localId(row.UpgradedItem);
    const costs = itemCosts(row.Costs);
    const currencies = currencyCosts(row.Costs);
    if (!items[item] || !(row.QuantityPerUpgrade > 0) || !(costs.length || currencies.length)) return [];
    return [{ id: 'ItemUpgrade:' + row.Id, kind: 'ItemUpgrade', item, name: items[item].name, costs,
      currencyCosts: currencies, rewards: [[item, row.QuantityPerUpgrade, 1]], requirementGroups: requirementGroups(row) }];
  });
  const bonfires = Object.fromEntries(registeredSkillRows('Firemaking', 'Bonfires', 'FiremakingBonfire')
    .map(row => [row.Id, persistentModifiers(row.Bonuses)]));
  actions.push(...xpActions.filter(action => ['Hunting', 'Farming', 'GrainMill'].includes(action.kind) ||
    action.id === 'Ranching:CurrentHerd'));
  const offerings = objects.AstralOfferingsRewardMode?.find(row =>
    data.EntityConfig['MelvorBase:Beastcrafting']?.RewardModes?.some(mode => localId(mode.Id) === row.Id));
  const astralOfferings = offerings && {
    requirements: requirements(offerings.UnlockRequirements),
    categories: (offerings.AllowedCategories ?? []).map(localId),
    rewards: (offerings.Rewards ?? []).map(row => ({
      id: localId(row.Item), quantity: row.Quantity, min: row.MinLevel, max: row.MaxLevel
    }))
  };
  if (astralOfferings) for (const action of actions) {
    if (action.skill === 'Beastcrafting' && astralOfferings.categories.includes(action.category)) {
      action.modeProducts = astralOfferings.rewards.map(reward => reward.id);
      action.offeringLevel = action.requirementGroups.flat().find(req => req.type === 'Level' && req.skill === action.skill)?.level ?? 0;
    }
  }
  for (const action of xpActions) {
    action.outputItems = [...new Set([...(action.rewards ?? []).map(([id]) => id), ...(action.fish ?? []).map(([id]) => id),
      ...(action.special ?? []).map(([id]) => id), ...(action.hitRewards ?? []).map(([id]) => id),
      ...(action.events ?? []).map(row => row.item), ...(action.modeProducts ?? []), action.ore?.[0],
      action.bar, action.stone, action.essence, action.junk].filter(id => items[id]))];
  }
  return { items, actions, itemUpgrades, ...makeItemDetails(data), ...makeCombatTargets(data, items, combatAttacks), combatSlots, combatSpells, combatSupplies, combatModel, statisticSubjects, skillToolSlots, skillShop,
    skills: SKILLS, xpActions, xpSkills: XP_SKILLS, xpSkillData, actionCategoryOrder, shopModifiers, astrologyModifiers,
    petModifiers, equipmentSets, mastery, bonfires, sacrificialAnvil, astralOfferings, questGuide: makeQuestGuide(data) };
}

module.exports = { makeCatalog };
