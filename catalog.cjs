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

function persistentModifiers(bonuses, components) {
  return (bonuses?.Component ?? []).filter(row => !row.Condition && !row.Scaling && !row.FromContext &&
    components.includes(row.LocalContext?.Component?.Component) &&
    Object.keys(row.LocalContext).every(key =>
      row.LocalContext[key] == null || ['Component', 'Recipe', 'Location', 'Category', 'Subcategory'].includes(key)
    )).map(row => ({
    stat: row.Stat.Name, value: row.Value, skill: localId(row.LocalContext.Component.Entity),
    recipe: localId(row.LocalContext.Recipe), category: localId(row.LocalContext.Category),
    subcategory: localId(row.LocalContext.Subcategory), location: localId(row.LocalContext.Location)
  }));
}

function makeCatalog(data) {
  const objects = data.Objects;
  const items = Object.fromEntries(objects.Item.map(item => {
    const tool = item.Capabilities?.['MelvorBase:Toolbelt'];
    const permanent = tool && !tool.ConsumesOn && !tool.CanEquipQuantity;
    const modifiers = permanent ? persistentModifiers(tool.Bonuses, ['Action']) : [];
    const xpModifiers = permanent ? persistentModifiers(tool.Bonuses, ['Experience']) : [];
    return [item.Id, {
      name: item.DisplayName.Singular, price: item.SellsFor?.Currency === GOLD ? item.SellsFor.Quantity : 0,
      ...(modifiers.length ? { modifiers } : {}),
      ...(xpModifiers.length ? { xpModifiers } : {})
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
      ]).filter(group => group.length).map(group => group.map(({ Type, Data }) => ({
        type: localId(Type), skill: localId(Data.Component?.Entity), level: Data.Level, or: !!Data.IsOr,
        item: localId(Data.Item), rank: localId(Data.Rank),
        purchase: localId(Data.ShopPurchase), amount: Data.Amount
      })));
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
        return table.map(row => [localId(row.Item), (row.MinQuantity + row.MaxQuantity) / 2, row.Weight / total]);
      };
      action.costs = (recipe.Ingredients?.Items ?? []).map(row => [localId(row.Item), row.Quantity]);
      action.currencyCosts = (recipe.Ingredients?.Currencies ?? []).map(row => [localId(row.Currency), row.Quantity]);
      action.rewards = (recipe.Products ?? []).map(product);
      if (recipe.CurrencyReward?.Currency === GOLD) action.cash = recipe.CurrencyReward.Quantity ?? 0;
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
          action.difficulty = recipe.Difficulty;
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
          action.cash = recipe.CurrencyReward?.Currency === GOLD
            ? (recipe.CurrencyReward.MinQuantity + recipe.CurrencyReward.MaxQuantity) / 2 * recipe.BaseCurrencyLootChance : 0;
          action.rewards = [
            ...weighted(recipe.CommonDropTable).map(([id, qty, chance]) => [id, qty, chance * recipe.BaseCommonLootChance]),
            ...weighted(recipe.RareDropTable).map(([id, qty, chance]) => [id, qty, chance * recipe.BaseRareLootChance])
          ];
          break;
      }
      if (Number.isFinite(action.seconds) && action.seconds > 0) {
        if (Object.hasOwn(SKILLS, skill)) actions.push(action);
        if (action.baseXp > 0) xpActions.push(action);
      }
    }
  }
  const shopModifiers = Object.fromEntries(objects.ShopPurchase.flatMap(purchase => {
    const modifiers = persistentModifiers(purchase.Provides?.Bonuses, ['Action', 'Experience']);
    return modifiers.length ? [[purchase.Id, modifiers]] : [];
  }));
  const astrologyModifiers = Object.fromEntries(objects.AstrologyNode.map(node => [
    node.Id, persistentModifiers(node.Bonuses, ['Action', 'Experience'])
  ]));
  const guild = data.EntityConfig['MelvorBase:Woodcutting'];
  const registered = entries => new Set(entries.map(({ Id }) => localId(Id)));
  const taskIds = registered(guild.MasteryGuildTasks);
  const rankIds = registered(guild.MasteryGuildRanks);
  const bonusIds = registered(guild.MasteryGuildBonuses);
  const points = new Map(objects.MasteryGuildCategory.map(row => [row.Id, row.BasePoints]));
  const woodMastery = {
    tasks: objects.MasteryGuildTask.filter(task => taskIds.has(task.Id)).map(task => ({
      id: task.Id, points: points.get(localId(task.Category)),
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
        modifiers: persistentModifiers(bonus.Rewards.Bonuses, ['Action', 'Experience'])
      }))
  };
  return { items, actions, skills: SKILLS, xpActions, xpSkills: XP_SKILLS, shopModifiers, astrologyModifiers, woodMastery };
}

module.exports = { makeCatalog };
