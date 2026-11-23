const { localId } = require('./game-data.cjs');

function normalizeRequirements(list) {
  return (list ?? []).map(({ Type, Data: data }) => {
    const Data = data ?? {};
    return {
      type: localId(Type), skill: localId(Data.Component?.Entity), level: Data.Level, or: !!Data.IsOr,
      item: localId(Data.Item), rank: localId(Data.Rank), node: localId(Data.MajorNode ?? Data.MinorNode),
      purchase: localId(Data.ShopPurchase), amount: Data.Amount, statistic: localId(Data.Statistic),
      statisticTarget: localId(Data.Course ?? Data.Event ?? Data.Item ?? Data.Dungeon ?? Data.SlayerMaster ?? Data.Enemy),
      statisticValue: Data.Value, technique: localId(Data.Technique), combatStyle: localId(Data.CombatStyle ?? Data.Style),
      quest: localId(Data.Quest), questStep: Data.Step, questTask: Data.Task, goalIdIncomplete: Data.GoalIdIncomplete
    };
  });
}

const actionTypes = {
  Woodcutting: 'WoodcuttingRecipe', Mining: 'MiningRecipe', Fishing: 'FishingRecipe',
  Cooking: 'CookingRecipe', Firemaking: 'FiremakingRecipe', Thieving: 'ThievingRecipe',
  Herblore: 'HerbloreRecipe', Farming: 'FarmingRecipe', Hunting: 'HuntingAnimal',
  Ranching: 'RanchingAnimal', Agility: 'AgilityCourse', Astrology: 'AstrologyConstellation'
};
const actionLists = {
  Hunting: 'Animals', Ranching: 'Animals', Agility: 'Courses', Astrology: 'Constellations'
};
const artisanSkills = ['Smithing', 'Crafting', 'Fletching', 'Runecrafting', 'Beastcrafting'];
const places = {
  Woodcutting: 'WoodcuttingRecipeCategory', Mining: 'MiningRecipeCategory', Fishing: 'FishingLocation',
  Hunting: 'HuntingLocation', Farming: 'RecipeCategory', Ranching: 'RanchingCategory', Agility: 'AgilityLocation',
  Combat: 'CombatAreaCategory', Shop: 'ShopSubcategory', Quests: 'QuestCategory'
};
const actionGoals = {
  WoodcuttingCutTree: ['Recipe', 'cut'], MiningMineRock: ['Recipe', 'mine'],
  ArtisanCreateRecipe: ['Recipe', 'make'], FiremakingBurnRecipe: ['Recipe', 'burn'],
  FarmingPlantRecipe: ['Recipe', 'plant'], HuntingTrapAnimal: ['Animal', 'trap'],
  ThievingPickpocketTarget: ['Target', 'pickpocket'], CombatKillEnemy: ['Enemy', 'kill'],
  CompleteDungeon: ['Dungeon', 'clear'], AgilityCompleteCourse: ['Course', 'clear']
};

function makeQuestGuide(data) {
  const { Objects: objects, EntityConfig: config } = data;
  const indexes = new Map();
  const names = Object.create(null);
  const actions = new Map();
  const sources = new Map();
  const observations = new Map();
  const needed = new Set();
  const get = (type, id) => {
    if (!indexes.has(type)) indexes.set(type, new Map((objects[type] ?? []).map(row => [row.Id, row])));
    return indexes.get(type).get(localId(id));
  };
  const registered = skill => config['MelvorBase:' + skill] ?? {};
  const records = (skill, list, type) => (registered(skill)[list] ?? [])
    .map(({ Id }) => get(type, Id)).filter(Boolean);
  const nameRef = (type, row) => {
    if (!row?.Id) return undefined;
    const ref = type + ':' + row.Id;
    names[ref] ??= { name: row.DisplayName?.Singular ?? row.DisplayName ?? row.Id };
    return ref;
  };
  const label = (type, id) => nameRef(type, get(type, id));
  const ingredients = row => (row?.Ingredients?.Items ?? row?.EntryCost?.Items ?? [])
    .filter(entry => entry.Item && entry.Quantity > 0).map(entry => ({ item: localId(entry.Item), quantity: entry.Quantity }));
  function source(skill, type, row, kind, area, related = []) {
    const groups = [row, ...related].filter(Boolean).flatMap(record =>
      ['Requirements', 'DisplayRequirements', 'AccessRequirements', 'UnlockRequirements', 'SecondaryRequirements']
        .map(key => record[key] ?? []));
    const mandatory = groups.filter(group => group.every(({ Data }) => !Data?.IsOr)).flat();
    const level = Math.max(0, ...mandatory.filter(({ Type, Data }) => localId(Type) === 'Level' &&
      localId(Data?.Component?.Entity) === skill).map(({ Data }) => Data.Level ?? 0));
    const stages = new Map();
    for (const { Type, Data } of groups.flat()) {
      if (!Data?.Quest || !['QuestTaskGoalActive', 'QuestStepActive'].includes(localId(Type))) continue;
      const quest = localId(Data.Quest);
      const step = Data.Step;
      stages.set(quest + ':' + step, { quest, step });
    }
    return { skill, target: nameRef(type, row), area, kind, level, questOnly: stages.size > 0,
      stages: [...stages.values()], ingredients: ingredients(row),
      requirementGroups: groups.filter(group => group.length).map(normalizeRequirements) };
  }
  function addProducts(products, where) {
    for (const entry of products ?? []) {
      const id = localId(entry.Item);
      if (!id || entry.Chance === 0 || entry.Weight === 0 || entry.Quantity === 0 || entry.MaxQuantity === 0) continue;
      if (!sources.has(id)) sources.set(id, new Map());
      const key = [where.skill, where.target, where.area, where.variant, where.kind, where.upgrade].join(':');
      sources.get(id).set(key, where);
    }
  }
  function addDrops(drops, where) {
    addProducts(drops?.FixedItems, where);
    for (const table of drops?.ItemTables ?? []) if (table.Chance > 0) addProducts(table.Table, where);
  }
  function addAction(skill, type, row) {
    const areaId = row.Location ?? row.Category;
    const areaType = type === 'GrainMillRecipe' ? 'FarmingMillCategory' : places[skill] ?? 'RecipeCategory';
    const area = get(areaType, areaId);
    const actionId = (type === 'GrainMillRecipe' ? 'Farming:Mill:' : skill + ':') + row.Id;
    const where = { ...source(skill, type, row, 'action', nameRef(areaType, area), [area]), actionId };
    actions.set(actionId, [where]);
    addProducts([...(row.Products ?? []), ...(row.Product ? [row.Product] : [])], where);
    if (skill === 'Woodcutting' || skill === 'Mining') {
      addProducts([...(row.RandomProductsPerHit ?? []), ...(row.RandomProductsPerCut ?? [])], { ...where, kind: 'drop' });
      addProducts([row.BarItem, row.StoneItem, row.EssenceItem].filter(Boolean).map(Item => ({ Item })),
        { ...where, kind: 'modifierDrop' });
    } else if (skill === 'Fishing') {
      addProducts(row.RandomProducts, where);
      addProducts(row.SpecialProducts, { ...where, kind: 'drop' });
      if (row.JunkItem) addProducts([{ Item: row.JunkItem }], { ...where, kind: 'drop' });
    } else if (skill === 'Thieving') {
      if (row.BaseCommonLootChance > 0) addProducts(row.CommonDropTable, { ...where, kind: 'drop' });
      if (row.BaseRareLootChance > 0) addProducts(row.RareDropTable, { ...where, kind: 'drop' });
      addProducts(row.CompletionDropTable, { ...where, kind: 'drop' });
    } else if (skill === 'Hunting') {
      addProducts(row.SurveyingProducts, { ...where, kind: 'drop' });
      for (const entry of row.RareSpecies ?? []) {
        const variant = get('HuntingAnimalSpecies', entry.Species);
        if (!variant) continue;
        addProducts(variant.ExtraProducts, { ...where, ...source(skill, type, row, 'drop', where.area, [area, variant]),
          variant: nameRef('HuntingAnimalSpecies', variant) });
      }
    } else if (skill === 'Astrology') {
      for (const event of row.Events ?? []) {
        if (!observations.has(localId(event))) observations.set(localId(event), []);
        observations.get(localId(event)).push(where);
      }
    }
  }
  for (const skill of [...Object.keys(actionTypes), ...artisanSkills]) {
    const type = actionTypes[skill] ?? 'ArtisanRecipe';
    for (const row of records(skill, actionLists[skill] ?? 'Recipes', type)) addAction(skill, type, row);
  }
  for (const row of records('Farming', 'GrainMillRecipes', 'GrainMillRecipe')) addAction('Farming', 'GrainMillRecipe', row);
  for (const row of objects.ItemUpgrade ?? []) {
    const item = get('Item', row.UpgradedItem);
    if (!item || !(row.QuantityPerUpgrade > 0)) continue;
    const costs = ingredients({ Ingredients: row.Costs });
    addProducts([{ Item: row.UpgradedItem, Quantity: row.QuantityPerUpgrade }], {
      ...source(null, 'Item', { ...item, Requirements: row.Requirements, DisplayRequirements: row.DisplayRequirements }, 'upgrade'),
      ingredients: costs, upgrade: row.Id
    });
  }
  for (const type of ['CombatArea', 'Dungeon']) {
    for (const area of records('Combat', 'Areas', type)) {
      const category = label('CombatAreaCategory', area.Category);
      const where = source('Combat', type, area, 'clear', category);
      if (type === 'Dungeon') actions.set('Dungeon:' + area.Id, [where]);
      addDrops(area.Rewards, where);
      for (const enemyId of (area.Enemies ?? []).flatMap(entry =>
        typeof entry === 'string' ? [entry] : (entry.Enemies ?? []).map(choice => choice.Enemy))) {
        const enemy = get('Enemy', enemyId);
        if (!enemy) continue;
        const location = source('Combat', 'Enemy', enemy, 'drop', where.target, [area]);
        const key = 'Combat:' + enemy.Id;
        if (!actions.has(key)) actions.set(key, []);
        if (!actions.get(key).some(entry => entry.area === location.area)) actions.get(key).push(location);
        addDrops(enemy.Drops, location);
      }
    }
  }
  for (const row of records('Shop', 'Purchases', 'ShopPurchase')) {
    addProducts(row.Provides?.Items, source('Shop', 'ShopPurchase', row, 'purchase', label('ShopSubcategory', row.Subcategory)));
  }
  const questRows = records('Quests', 'Quests', 'Quest');
  for (const row of questRows) {
    addProducts(row.Rewards?.Items, source('Quests', 'Quest', row, 'reward', label('QuestCategory', row.Category)));
  }
  const opened = new Set();
  const containers = (objects.Item ?? []).filter(row => row.Capabilities?.['MelvorBase:Openable']);
  let changed;
  do {
    changed = false;
    for (const row of containers) {
      if (opened.has(row.Id) || !sources.has(row.Id)) continue;
      const openable = row.Capabilities['MelvorBase:Openable'];
      opened.add(row.Id);
      changed = true;
      addProducts([...(openable.AlwaysDrops ?? []), ...(openable.DropTable ?? [])],
        { ...source(null, 'Item', row, 'open'), container: row.Id });
    }
  } while (changed);

  function goal({ Type, Data }) {
    if (!Data) return null;
    const type = localId(Type);
    const skill = localId(Data.Component?.Entity);
    if (type === 'ActionGainItem' && Data.Item) {
      const item = localId(Data.Item);
      needed.add(item);
      return { kind: 'collect', item, skill, quantity: Data.MaxProgress };
    }
    if (type === 'AstrologyObserveEvent') {
      return { kind: 'observe', skill, target: label('AstrologyObservationEvent', Data.Event),
        quantity: Data.MaxProgress, locations: observations.get(localId(Data.Event)) ?? [] };
    }
    if (type === 'AgilityTechniqueLevel' || type === 'AstrologyMajorNodeUnlockCount') {
      return { kind: type === 'AgilityTechniqueLevel' ? 'level' : 'nodes', skill,
        target: label(type === 'AgilityTechniqueLevel' ? 'AgilityTechnique' : 'AstrologyConstellation',
          Data.Technique ?? Data.Constellation), quantity: Data.Level ?? Data.Count };
    }
    const action = actionGoals[type];
    if (!action) return { kind: 'unknown', skill };
    const [field, kind] = action;
    const id = localId(Data[field]);
    const locations = actions.get((field === 'Dungeon' ? 'Dungeon' : skill) + ':' + id) ?? [];
    return { kind, skill, id, target: locations[0]?.target, locations, quantity: Data.MaxProgress,
      itemCount: !!Data.UseOutputQuantity, variant: label('HuntingAnimalSpecies', Data.Species),
      style: localId(Data.PlayerCombatStyle) };
  }
  const quests = questRows.map(row => ({
    id: row.Id, name: row.DisplayName, category: label('QuestCategory', row.Category),
    steps: (row.Steps ?? []).map(step => ({
      id: step.Id,
      tasks: (step.TasksInOrder ?? []).map(task => ({ id: task.Id, objectives: [
        ...[...(task.Goals ?? []), ...(task.ConditionGoals ?? [])].flatMap(entry => {
          const objective = goal(entry);
          return objective ? [{ ...objective, goalId: entry.Data.Id }] : [];
        }),
        ...(task.Costs?.Items ?? []).map(({ Item, Quantity }) => {
          const item = localId(Item);
          needed.add(item);
          return { kind: 'submit', item, quantity: Quantity };
        }),
        ...(task.Costs?.Currencies ?? []).map(({ Currency, Quantity }) =>
          ({ kind: 'submit', currency: localId(Currency), quantity: Quantity }))
      ] }))
    }))
  }));
  for (const purchase of objects.ShopPurchase ?? []) {
    for (const { Item } of purchase.Costs?.Items ?? []) if (Item) needed.add(localId(Item));
  }
  for (const quest of quests) for (const step of quest.steps) for (const objective of step.tasks.flatMap(task => task.objectives)) {
    for (const where of objective.locations ?? []) for (const { item } of where.ingredients) needed.add(item);
  }
  for (const item of needed) {
    for (const where of sources.get(item)?.values() ?? []) {
      for (const input of where.ingredients) needed.add(input.item);
      if (where.container) needed.add(where.container);
    }
  }
  const itemSources = Object.fromEntries([...needed].map(item => [item, [...(sources.get(item)?.values() ?? [])]]));
  const visibleNames = new Set(quests.map(quest => quest.category));
  const collectNames = ({ target, area, variant }) => {
    for (const ref of [target, area, variant]) if (ref) visibleNames.add(ref);
  };
  for (const where of Object.values(itemSources).flat()) collectNames(where);
  const queueSources = Object.fromEntries(actions);
  for (const where of Object.values(queueSources).flat()) collectNames(where);
  for (const quest of quests) for (const step of quest.steps) for (const objective of step.tasks.flatMap(task => task.objectives)) {
    collectNames(objective);
    (objective.locations ?? []).forEach(collectNames);
  }
  return { quests, names: Object.fromEntries([...visibleNames].filter(ref => names[ref]).map(ref => [ref, names[ref]])),
    sources: itemSources, queueSources };
}

module.exports = { makeQuestGuide, normalizeRequirements };
