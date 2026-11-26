const probability = value => Math.min(1, Math.max(0, value));
const randomChance = chance => chance > 0 && chance < 1;

function actionModifiers(action, profile, catalog, extraModifiers) {
  const stats = new Map();
  function add(modifiers, quantity = 1) {
    for (const modifier of modifiers ?? []) {
      if ((modifier.skill && modifier.skill !== action.skill) || ['recipe', 'category', 'location', 'subcategory', 'constellation', 'recipeType'].some(
        key => modifier[key] && modifier[key] !== action[key]
      ) || ['animal', 'tool', 'trapType', 'course', 'path', 'obstacle', 'technique', 'plot'].some(
        key => modifier[key] && modifier[key] !== action[key]
      )) continue;
      const scale = modifier.scalesWithLevel ? profile.levels?.[modifier.scalesWithLevel] ?? 0 : 1;
      const key = [modifier.stat, modifier.item, modifier.event].join(':');
      stats.set(key, (stats.get(key) ?? 0) + modifier.value * quantity * scale);
    }
  }
  for (const equipped of Object.values(profile.equipped ?? {})) {
    for (const id of equipped) add(catalog.items[id]?.modifiers);
    for (const set of catalog.equipmentSets ?? []) {
      const count = set.items.filter(id => equipped.includes(id)).length;
      for (const bonus of set.bonuses) {
        if (count >= bonus.count) add(bonus.modifiers);
      }
    }
  }
  for (const [id, quantity] of Object.entries(profile.purchases ?? {})) add(catalog.shopModifiers?.[id], quantity);
  for (const id of profile.astrologyNodes ?? []) add(catalog.astrologyModifiers?.[id]);
  for (const id of profile.unlockedPets ?? []) add(catalog.petModifiers?.[id]);
  for (const [skill, ranks] of Object.entries(profile.ranks ?? {})) {
    for (const bonus of catalog.mastery?.[skill]?.bonuses ?? []) {
      if (ranks.includes(bonus.rank)) add(bonus.modifiers);
    }
  }
  if (action.minorNodes) {
    add(action.minorNodeModifiers, action.minorNodes.filter(id => profile.astrologyNodes?.includes(id)).length);
  }
  add(extraModifiers);
  add(profile.skillPhaseModifiers);
  return (key, item, event) => {
    const get = (itemId, eventId) => stats.get([key, itemId, eventId].join(':')) ?? 0;
    return get('', '') + (item ? get(item, '') : 0) +
      (event ? get('', event) : 0) + (item && event ? get(item, event) : 0);
  };
}

function expectedSteps(health, doubleDamage) {
  let twoBack = 0;
  let oneBack = 1;
  for (let hp = 2; hp <= health; hp++) {
    const expected = 1 + (1 - doubleDamage) * oneBack + doubleDamage * twoBack;
    twoBack = oneBack;
    oneBack = expected;
  }
  return oneBack;
}

function woodcuttingModifiers(action, stat, intervalBonus) {
  const doubleDamage = probability(stat('DoubleDamageChance'));
  const instant = probability(stat('InstantCutChance'));
  const weak = probability(stat('WeakSpotChance'));
  const output = probability(stat('DoublingChance'));
  const health = Math.max(1, Math.ceil((action.steps + stat('FlatMaxHealth')) * (1 + stat('PercentMaxHealth'))));
  const milliseconds = Math.floor((action.seconds * 1000 + stat('FlatInterval')) * (1 + stat('PercentInterval')));
  const interval = milliseconds / 1000 * (1 + intervalBonus / 100);
  const damage = 3 + Math.floor(health * .1);
  const hits = [0, 1];
  for (let hp = 2; hp <= health; hp++) {
    const after = amount => hits[Math.max(0, hp - amount)];
    const normal = (1 - doubleDamage) * after(1) + doubleDamage * after(2);
    const weakSpot = (1 - doubleDamage) * after(damage) + doubleDamage * after(2 * damage);
    hits[hp] = 1 + (1 - instant) * ((1 - weak) * normal + weak * weakSpot);
  }
  return { doubleDamage, instant, weak, output, health, interval, hits: hits[health] };
}

function meetsRequirements(group, profile, confirmed = false) {
  const requirementMet = req => {
    if (req.type === 'Level') return (profile.levels[req.skill] ?? 0) >= req.level;
    if (req.type === 'AgilityTechniqueLevel') {
      const xp = profile.xpSkillState?.Agility?.[req.technique];
      return Number.isFinite(xp) && agilityTechniqueLevel(xp) >= req.level;
    }
    if (req.type === 'ToolbeltItemEquipped' && req.item && profile.equipped?.[req.skill]?.includes(req.item)) return true;
    if (req.type === 'MasteryGuildRank' && req.rank && profile.ranks?.[req.skill]?.includes(req.rank)) return true;
    if (req.type === 'ShopPurchase' && (profile.purchases?.[req.purchase] ?? 0) >= req.amount) return true;
    if (profile.questProgress && (req.type === 'QuestStepActive' || req.type === 'QuestTaskGoalActive')) {
      const quest = profile.questProgress[req.quest];
      const step = quest?.steps?.[req.questStep];
      if (quest?.status !== 1 || step?.status !== 1) return false;
      if (req.questTask == null) return true;
      const task = step.tasks[req.questTask];
      return task?.status === 1 &&
        (req.goalIdIncomplete == null || task.goals[req.goalIdIncomplete]?.complete === false);
    }
    if (req.type === 'AstrologyMajorNodeUnlocked' || req.type === 'AstrologyMinorNodeUnlocked') {
      if (req.node && profile.astrologyNodes?.includes(req.node)) return true;
    }
    if (['AgilityCourseStatistic', 'AstrologyEventStatistic', 'ItemStatistic'].includes(req.type)) {
      if ((profile.recipeStatistics?.[req.statistic]?.[req.statisticTarget] ?? 0) >= req.statisticValue) return true;
    }
    return confirmed;
  };
  if (!group.length) return true;
  let alternativePassed = requirementMet(group[0]);
  for (const req of group.slice(1)) {
    if (req.or) alternativePassed ||= requirementMet(req);
    else {
      if (!alternativePassed) return false;
      alternativePassed = requirementMet(req);
    }
  }
  return alternativePassed;
}

function unlocked(action, profile, { requireVerified = false } = {}) {
  if (!profile.levels[action.skill] || profile.excluded?.includes(action.id)) return false;
  const confirmed = !requireVerified && profile.confirmed?.includes(action.id);
  return action.requirementGroups.every(group => meetsRequirements(group, profile, confirmed));
}

function requirementClauses(groups) {
  return groups.flatMap(group => {
    const clauses = [];
    for (const req of group) {
      if (!req.or || !clauses.length) clauses.push([]);
      clauses.at(-1).push(req);
    }
    return clauses;
  });
}

function productionRestrictions(action, profile) {
  const restrictions = [];
  if (profile.excluded?.includes(action.id)) restrictions.push({ type: 'excluded' });
  const confirmed = profile.confirmed?.includes(action.id);
  const groups = requirementClauses(action.requirementGroups);
  for (const clause of groups) {
    if (!meetsRequirements(clause, profile, confirmed)) restrictions.push({ type: 'requirement', clause });
  }
  if (action.skill && !profile.levels[action.skill] &&
      !restrictions.some(r => r.clause?.some(req => req.type === 'Level' && req.skill === action.skill))) {
    restrictions.push({ type: 'skill', skill: action.skill });
  }
  return restrictions;
}

function thievingSuccess(action, level, stat, bonus) {
  const stealth = Math.max(0, Math.floor((level + stat('FlatStealth') + (bonus.stealth ?? 0)) * (1 + stat('PercentStealth'))));
  const perception = Math.max(0, Math.floor((action.perception + stat('FlatPerception')) * (1 + stat('PercentPerception'))));
  return probability((100 + stealth) / (100 + perception));
}

function secondarySkillLevel(xp, cap, bonus, divisor, exponent, scale) {
  const step = 2 ** (1 / exponent);
  let level = 1;
  while (level < cap) {
    const next = level + 1;
    const threshold = Math.floor((next * (next - 1) +
      bonus * (2 ** (next / divisor) - step) / (step - 1)) / scale);
    if (!(xp >= threshold)) break;
    level = next;
  }
  return level;
}

function agilityTechniqueLevel(xp, cap = 99) {
  return secondarySkillLevel(xp, cap, 600, 3.25, 3.25, 6);
}

function agilityPlan(action, profile, catalog) {
  const techniques = catalog.xpSkillData.agilityTechniques.map(row => ({
    ...row, level: agilityTechniqueLevel(profile.xpSkillState?.Agility?.[row.id] ?? 0, row.cap)
  }));
  const saved = new Map(techniques.map(row => [row.id, row.level]));
  let milliseconds = 0;
  let restarts = 0;
  let attempts = 0;
  let successes = 0;
  let risky = false;
  for (const [index, obstacle] of action.obstacleData.entries()) {
    const scoped = { ...action, obstacle: obstacle.id, technique: obstacle.technique };
    const difficulty = Math.max(0, obstacle.difficulty + actionModifiers(scoped, profile, catalog)('FlatObstacleDifficulty'));
    const stat = actionModifiers(scoped, profile, catalog,
      techniques.filter(row => row.level >= difficulty).flatMap(row => row.bonuses));
    const interval = Math.max(1, Math.floor((obstacle.ms + stat('FlatInterval')) * (1 + stat('PercentInterval'))));
    const chance = obstacle.trap ? Math.min(.95, probability(.8 + stat('FlatTrapSuccessChance'))) :
      obstacle.technique ? .95 ** (Math.max(0, difficulty - (saved.get(obstacle.technique) ?? 1) + 1) / 2) : .6;
    const repeat = probability(stat('RepeatFailedObstacleChance'));
    const skip = index ? probability(stat('SkipObstacleChance')) : 0;
    const failure = (1 - skip) * (1 - chance);
    const reset = failure * (1 - repeat);
    if (failure >= 1) return;
    milliseconds += ((1 - skip) * interval + reset * milliseconds) / (1 - failure);
    attempts += ((1 - skip) + reset * attempts) / (1 - failure);
    successes += ((1 - skip) * chance + reset * successes) / (1 - failure);
    restarts += reset * (restarts + 1) / (1 - failure);
    risky ||= failure > 0 && obstacle.damage > 0 && probability(stat('AvoidDamageChance')) < 1;
  }
  const stats = actionModifiers(action, profile, catalog);
  return { seconds: milliseconds / 1000, entries: 1 + restarts, attempts, successes, risky,
    preservation: probability(stats('EntryCostPreservationChance')) };
}

function huntingPlan(action, profile, catalog, ignoreStock) {
  const { hunt } = action;
  const state = profile.xpSkillState?.Hunting;
  const saved = state?.entries?.[action.animal];
  const trapless = hunt.allowTrapless && (!saved || saved.trapless) &&
    meetsRequirements(hunt.traplessRequirements, profile);
  const available = id => !profile.keep?.includes(id) && profile.stock[id] > 0;
  const matches = id => catalog.items[id]?.huntingTrap?.type === action.trapType;
  const eligible = id => matches(id) && available(id);
  const trap = trapless || !action.trapType ? null : eligible(saved?.trap) ? saved.trap :
    ignoreStock && matches(saved?.trap) ? saved.trap :
      (!saved?.trap || state?.autoSwap) ? Object.keys(profile.stock).find(eligible) ??
        (ignoreStock ? Object.keys(catalog.items).find(matches) : undefined) : null;
  if (action.trapType && !trap && !trapless) return;
  const bait = saved?.bait && hunt.bait && (ignoreStock || available(hunt.bait)) ? hunt.bait : null;
  const journalLevel = secondarySkillLevel(saved?.xp ?? 0, 99, 100, 3.5, 7, 12);
  const bonuses = [
    ...catalog.xpSkillData.huntingJournal.filter(row => row.level <= journalLevel).flatMap(row => row.bonuses),
    ...(trapless ? hunt.traplessBonuses : catalog.items[trap]?.huntingTrap?.bonuses ?? [])
  ];
  const stat = actionModifiers(action, profile, catalog, bonuses);
  const baitStat = bait ? actionModifiers(action, profile, catalog, [...bonuses, ...hunt.baitBonuses]) : stat;
  const failBonus = (catalog.items[trap]?.huntingTrap?.failBonuses ?? [])
    .filter(row => row.stat === 'FlatTrappingSuccessChance').reduce((sum, row) => sum + row.value, 0);
  const meanInterval = ([min, max], phase, mods = stat) => {
    const endpoint = (base, edge) => Math.max(0, Math.floor((base + mods('Flat' + phase + 'Interval') +
      mods('Flat' + edge + phase + 'Interval')) * (1 + mods('Percent' + phase + 'Interval') +
      mods('Percent' + edge + phase + 'Interval'))));
    return (endpoint(min, 'Min') + endpoint(max, 'Max')) / 2;
  };
  const survey = Math.max(0, (hunt.surveyMs + stat('FlatSurveyInterval')) * (1 + stat('PercentSurveyInterval')));
  const tracking = meanInterval(hunt.trackingInterval, 'Tracking');
  const trapping = meanInterval(hunt.trappingInterval, 'Trapping');
  const trackChance = probability(hunt.trackChance * (1 + stat('IncreasedTrackingSuccessChance')) + stat('FlatTrackingSuccessChance'));
  const trapChance = probability(hunt.trapChance * (1 + stat('IncreasedTrappingSuccessChance')) + stat('FlatTrappingSuccessChance'));
  if (!(trapChance > 0 || failBonus > 0)) return;
  let attempts = 1;
  let failure = 1 - trapChance;
  if (failBonus > 0) {
    for (let failures = 1; failure > 1e-10 && failures <= 1000; failures++) {
      attempts += failure;
      failure *= 1 - probability(trapChance + failures * failBonus);
    }
  } else attempts = 1 / trapChance;
  const min = Math.max(1, Math.trunc(hunt.tracks[0] + stat('FlatTrackingSteps') + stat('FlatMinTrackingSteps')));
  const max = Math.max(min, Math.trunc(hunt.tracks[1] + stat('FlatTrackingSteps') + stat('FlatMaxTrackingSteps')));
  const skip = probability(stat('SkipTrackingStepChance'));
  const typical = Array.from({ length: max - min + 1 }, (_, i) => expectedSteps(min + i, skip))
    .reduce((sum, value) => sum + value, 0) / (max - min + 1);
  const extra = saved?.discovered === false ? Math.max(0, expectedSteps(max * 4, skip) - typical) * tracking / 1000 : 0;
  const retryTracks = (attempts - 1) * (1 - probability(stat('TrappingReattemptChance'))) * expectedSteps(min, skip);
  const perCatch = (survey * (1 + (1 - trackChance) + (1 - trackChance) ** 2) +
    (typical + retryTracks) * tracking + attempts * trapping) / 1000;
  const seconds = perCatch / attempts;
  return { seconds, baitSeconds: Math.max(0.001, seconds +
    (meanInterval(hunt.trappingInterval, 'Trapping', baitStat) - trapping) / 1000),
    baitAttempts: bait ? ignoreStock ? Infinity : Math.floor(profile.stock[bait] * attempts) : 0,
    firstExtra: extra, success: 1 / attempts, trap, bait, stat, trapless };
}

function passiveStock(profile, ignoreStock) {
  const items = { ...profile.stock };
  for (const id of profile.keep ?? []) items[id] = 0;
  const currencies = { ...profile.currencies };
  return (costs, consumption = 1, fixedCosts = [], record) => {
    const batches = new Map();
    const add = ([id, amount, currency], factor) => {
      const key = (currency ? 'currency:' : 'item:') + id;
      let batch = batches.get(key);
      if (!batch) {
        batch = { id, currency, stock: currency ? currencies : items, required: 0, consumed: 0 };
        batches.set(key, batch);
      }
      batch.required += amount;
      batch.consumed += amount * factor;
    };
    for (const cost of costs) add(cost, consumption);
    for (const cost of fixedCosts) add(cost, 1);
    if (!ignoreStock) {
      for (const { stock, id, required } of batches.values()) {
        if ((stock[id] ?? 0) + Number.EPSILON * required < required) return id;
      }
      for (const { stock, id, consumed } of batches.values()) {
        stock[id] = Math.max(0, (stock[id] ?? 0) - consumed);
      }
    }
    if (record) for (const { id, currency, consumed } of batches.values()) record(id, currency, consumed);
    return null;
  };
}

function simulateFarming(profile, catalog, stop, manualAction, ignoreStock) {
  const results = new Map();
  const plots = profile.xpSkillState?.Farming;
  if (!plots?.length) return results;
  const crops = new Map(catalog.xpActions.filter(action => action.kind === 'Farming' && unlocked(action, profile))
    .map(action => [action.recipe, action]));
  const xpBonus = (profile.xpBonuses?.Farming ?? 0) / 100;
  const intervalBonus = 1 + (profile.bonuses?.Farming?.interval ?? 0) / 100;
  const spend = passiveStock(profile, ignoreStock);
  const queue = [];
  function plan(action, plot) {
    const { farm } = action;
    const stat = actionModifiers({ ...action, plot: plot.id }, profile, catalog);
    const interval = seconds => Math.max(1, ((seconds + stat('FlatInterval') / 1000) *
      (1 + stat('PercentInterval'))) * intervalBonus);
    const initial = interval(action.seconds);
    const regrow = farm.regrowMs > 0 ? interval(farm.regrowMs / 1000) : initial;
    const regrows = Math.max(0, Math.trunc((farm.regrows ?? 0) + stat('FlatRegrows')));
    const xp = Math.max(0, (action.baseXp + stat('FlatXPGained')) * (1 + stat('PercentXPGained') + xpBonus));
    const costs = (items, wallet, change) => [...items.map(([id, amount]) => [id, change(amount, id)]),
      ...wallet.map(([id, amount]) => [id, change(amount, id), true])].filter(([, amount]) => amount > 0);
    const planting = costs(action.costs, action.currencyCosts,
      (amount, id) => Math.max(1, Math.trunc(amount * (1 + stat('PercentIngredientCost', id)))));
    const service = costs(farm.autoItems, farm.autoCurrencies,
      amount => Math.max(0, Math.floor((amount + stat('FlatAutomationCost')) * (1 + stat('PercentAutomationCost')))));
    const preservation = 1 - probability(stat('PreservationChance'));
    const manual = action === manualAction;
    const canAutomate = meetsRequirements(farm.automation, profile);
    if (!results.has(action.recipe)) {
      results.set(action.recipe, { events: [], spent: new Map(), limit: '', plots: 0, needsHarvest: false,
        seconds: action.seconds, forecast: stop });
    }
    const result = results.get(action.recipe);
    return { recipe: action.recipe, initial, regrow, regrows, xp, planting, service, preservation, manual, canAutomate,
      products: passiveProducts(action, stat),
      record: (id, currency, amount) => recordPassiveCost(result.spent, id, currency, amount), result };
  }
  function schedule(plot, crop, at, remaining, replant) {
    if (!(crop.manual || (plot.autoHarvest && crop.canAutomate))) {
      crop.result.needsHarvest = true;
      return;
    }
    queue.push({ plot, crop, at, remaining, replant });
  }
  function plant(plot, crop, at, replant) {
    if (!crop || (!crop.manual && !(plot.autoPlant && crop.canAutomate))) return;
    if (at >= stop) return;
    const missing = spend(crop.planting, crop.preservation, crop.manual ? [] : crop.service, crop.record);
    if (missing) crop.result.limit ||= missing;
    else schedule(plot, crop, at + crop.initial, crop.regrows, replant);
  }
  for (const plot of plots) {
    const category = catalog.xpSkillData.farmingPlots[plot.id];
    if (ignoreStock && manualAction?.category === category && (plot.crop || plot.state === 1)) {
      const candidate = plan(manualAction, plot);
      candidate.result.plots++;
      if (plot.crop && plot.crop !== manualAction.recipe && Number.isFinite(plot.seconds)) {
        candidate.result.switchWait = Math.max(candidate.result.switchWait ?? 0, plot.seconds);
      }
      plant(plot, candidate, 0, candidate);
      continue;
    }
    const current = crops.get(plot.crop);
    const selected = !plot.crop && plot.state === 1 && manualAction?.category === category
      ? manualAction : crops.get(plot.selected);
    const crop = current && current.category === category ? plan(current, plot) : null;
    const next = selected && selected.category === category
      ? (selected === current ? crop : plan(selected, plot)) : null;
    if (next && next !== crop) next.result.plots++;
    if (crop && Number.isFinite(plot.seconds)) {
      crop.result.plots++;
      schedule(plot, crop, plot.seconds, plot.regrows ?? crop.regrows, crop.manual ? crop : next);
    } else if (!plot.crop && plot.state === 1) {
      plant(plot, next, 0, next);
    }
  }
  while (queue.length) {
    queue.sort((a, b) => a.at - b.at);
    const { at, plot, crop, remaining, replant } = queue.shift();
    if (at > stop) break;
    const missing = crop.manual ? null : spend(crop.service, 1, [], crop.record);
    if (missing) {
      crop.result.limit ||= missing;
      continue;
    }
    crop.result.events.push({ at, xp: crop.xp, products: crop.products });
    if (remaining > 0) schedule(plot, crop, at + crop.regrow, remaining - 1, replant);
    else plant(plot, replant, at, replant);
  }
  return results;
}

function farmExperience(action, profile, catalog, settings, manual) {
  if (settings.ignoreStock) return simulateFarming(profile, catalog, settings.seconds, action, true).get(action.recipe);
  if (manual) {
    return simulateFarming(profile, catalog, 7 * 86400, action).get(action.recipe);
  }
  settings.farming ??= simulateFarming(profile, catalog, settings.seconds);
  const result = settings.farming.get(action.recipe);
  if (result) return result;
  const empty = profile.xpSkillState?.Farming?.filter(plot => !plot.crop && plot.state === 1 &&
    catalog.xpSkillData.farmingPlots[plot.id] === action.category);
  if (empty?.length) return { events: [], limit: '', plots: empty.length, needsHarvest: false,
    seconds: action.seconds, forecast: settings.seconds };
}

function ranchExperience(action, profile, catalog, stop, settings) {
  const state = profile.xpSkillState?.Ranching;
  if (!state?.lands.length || !(state.production.interval > 0) || state.production.state !== 2) return;
  if (settings.experience && !action.land && state.lands.filter(land => land.animals.length).length < 2) return;
  const { ranchAnimals, ranchVariants, ranchUpgrades } = catalog.xpSkillData;
  const xpBonus = (profile.xpBonuses?.Ranching ?? 0) / 100;
  const spend = passiveStock(profile, settings.ignoreStock);
  const animals = state.lands.flatMap(land => land.animals.flatMap(saved => {
    const animal = ranchAnimals[saved.type];
    if (!animal) return [];
    const context = { ...action, animal: saved.type };
    const upgradeBonuses = land.upgrades?.flatMap(id => ranchUpgrades[id] ?? []) ?? [];
    const statsFor = variant => actionModifiers(context, profile, catalog, [...upgradeBonuses, ...(ranchVariants[variant] ?? [])]);
    const stat = statsFor(saved.variant);
    const gainedXp = mods => Math.max(0, (animal.baseXp + mods('FlatXPGained')) * (1 + mods('PercentXPGained') + xpBonus));
    const xp = gainedXp(stat);
    const weight = animal.variants.reduce((sum, [, weight]) => sum + weight, 0);
    const productsFrom = mods => (animal.products ?? []).map(([id, qty, chance]) => [id,
      Math.max(0, (qty + mods('FlatProductQuantity', id)) * (1 + mods('PercentProductQuantity', id))) *
      chance * (1 + probability(mods('DoublingChance')))]);
    const products = productsFrom(stat);
    const canMature = saved.variant === animal.baseVariant && weight > 0;
    const adultXp = saved.variant === animal.baseVariant && weight > 0 ? animal.variants.reduce((sum, [id, value]) =>
      sum + gainedXp(statsFor(id)) * value, 0) / weight : xp;
    const adultProducts = canMature ? sumIngredients(animal.variants.flatMap(([id, value]) =>
      productsFrom(statsFor(id)).map(([item, quantity]) => [item, quantity * value / weight]))) : products;
    const feed = 1 - probability(stat('FoodPreservationChance'));
    return [{ ...saved, land: land.id, xp, adultXp, products, adultProducts, feed, foods: animal.foods, flatHappiness: stat('FlatHappiness'),
      maintenanceSkip: probability(stat('EnclosureMaintenanceSkipChance')) }];
  }));
  const count = animals.filter(animal => !action.land || animal.land === action.land).length;
  if (!count) return;
  const phases = [
    { ...state.maintenance, kind: 'maintenance' }, { ...state.food, kind: 'food' }, { ...state.production, kind: 'xp' }
  ].filter(phase => phase.state === 2 && phase.interval > 0).map(phase => ({ ...phase, at: Math.max(0, phase.first) }));
  const events = [];
  const spent = new Map();
  let limit = '';
  while (phases.some(phase => phase.at <= stop)) {
    const next = phases.reduce((a, b) => a.at <= b.at ? a : b);
    const { at, kind } = next;
    next.at += next.interval;
    let gained = 0;
    const produced = [];
    for (const animal of animals) {
      if (animal.lifeSeconds <= at) continue;
      if (kind === 'maintenance') animal.safety = Math.max(0, animal.safety - .01 * (1 - animal.maintenanceSkip));
      else if (kind === 'food' && animal.feed > 0) {
        const record = at <= settings.seconds && (!action.land || animal.land === action.land)
          ? (id, currency, amount) => recordPassiveCost(spent, id, currency, amount) : undefined;
        const missing = spend(animal.foods, animal.feed, [], record);
        if (missing && (!action.land || animal.land === action.land)) limit ||= missing;
        animal.hunger = missing ? Math.max(0, animal.hunger - .1 * animal.feed) :
          animal.feed + animal.hunger * (1 - animal.feed);
      } else if (kind === 'xp' && (!action.land || animal.land === action.land)) {
        const safety = animal.safety >= .75 ? 1 : animal.safety;
        const happiness = Math.max(0, .3 * animal.hunger + .3 * safety + .4 * animal.satisfaction -
          (animal.sick ? .3 : 0) + animal.flatHappiness);
        const adult = at >= animal.variantSeconds;
        gained += (adult ? animal.adultXp : animal.xp) * happiness;
        if (animal.hunger > 0 && animal.safety > 0) {
          for (const [id, quantity] of adult ? animal.adultProducts : animal.products) {
            produced.push([id, quantity * happiness]);
          }
        }
      }
    }
    if (gained > 0 || produced.length) events.push({ at, xp: gained, products: sumIngredients(produced)
      .map(([id, quantity]) => [id, Math.floor(quantity)]) });
  }
  return { events, spent, limit, animals: count, seconds: state.production.interval, forecast: stop };
}

function millExperience(action, profile, catalog, settings, manual) {
  const state = profile.xpSkillState?.GrainMill;
  if (!state) return;
  const stat = actionModifiers(action, profile, catalog);
  const costs = sumIngredients(action.costs.map(([id, amount]) =>
    [id, Math.max(1, Math.trunc(amount * (1 + stat('PercentIngredientCost', id))))]));
  const xp = Math.max(0, (action.baseXp + stat('FlatXPGained')) *
    (1 + stat('PercentXPGained') + (profile.xpBonuses?.Farming ?? 0) / 100));
  const seconds = Math.max(1, (action.seconds + stat('FlatInterval') / 1000) * (1 + stat('PercentInterval')));
  const stock = { ...state.stock };
  if (manual) for (const [id] of costs) {
    if (!profile.keep?.includes(id)) stock[id] = (stock[id] ?? 0) + (profile.stock[id] ?? 0);
  }
  if (!manual && !state.active && costs.every(([id]) => !(stock[id] > 0) && !(profile.stock[id] > 0))) return;
  const stop = manual && !settings.ignoreStock ? 7 * 86400 : settings.seconds;
  const spend = passiveStock({ stock }, settings.ignoreStock);
  const events = [];
  const spent = new Map();
  const products = passiveProducts(action, stat);
  let missing = '';
  if (manual || (state.active && state.recipe === action.recipe)) {
    const first = state.active && state.recipe === action.recipe && state.first > 0 ? state.first : seconds;
    for (let at = first; at <= stop; at += seconds) {
      missing = spend(costs, 1, [], (id, currency, amount) => recordPassiveCost(spent, id, currency, amount));
      if (missing) break;
      events.push({ at, xp, products });
    }
  }
  return { events, spent, limit: missing, seconds, forecast: stop, mill: true };
}

function recordPassiveCost(spent, id, currency, amount) {
  if (!(amount > 0)) return;
  const key = (currency ? 'currency:' : 'item:') + id;
  const row = spent.get(key) ?? { id, currency, quantity: 0 };
  row.quantity += amount;
  spent.set(key, row);
}

function passiveProducts(action, stat) {
  const doubling = 1 + probability(stat('DoublingChance'));
  return (action.rewards ?? []).map(([id, quantity, chance]) => [id,
    Math.max(0, Math.trunc((quantity + stat('FlatProductQuantity', id)) * (1 + stat('PercentProductQuantity', id)))) *
    chance * doubling]);
}

function evaluatePassiveExperience(action, profile, catalog, settings) {
  const ranch = action.kind === 'Ranching';
  const farm = action.kind === 'GrainMill' ? millExperience : farmExperience;
  const result = ranch ? ranchExperience(action, profile, catalog, settings.experience ? 86400 : settings.seconds, settings) :
    farm(action, profile, catalog, settings, settings.ignoreStock === true);
  if (!result) return;
  const events = result.events.filter(event => event.at <= settings.seconds);
  const xp = events.reduce((sum, event) => sum + event.xp, 0);
  const activeHours = (events.at(-1)?.at ?? 0) / 3600;
  let goal;
  const planXp = target => {
    if (!(target > 0)) return null;
    goal ??= ranch ? result : farm(action, profile, catalog, settings, true);
    if (!goal) return null;
    let xp = 0;
    let hours = (goal.events.at(-1)?.at ?? goal.forecast) / 3600;
    for (const event of goal.events) {
      xp += event.xp;
      if (xp >= target) {
        hours = event.at / 3600;
        break;
      }
    }
    const reason = goal.limit && !ranch ? '当前库存不足' : '在可估算时段内无法达到目标';
    return { xp, hours, rate: hours > 0 ? xp / hours : 0, reaches: xp >= target, reason, limit: goal.limit };
  };
  const drops = sumIngredients(events.flatMap(event => event.products ?? [])).map(([id, quantity]) => {
    const unitPrice = catalog.items?.[id]?.price ?? 0;
    const sold = settings.sell && !profile.keep?.includes(id) && !settings.keptDrops?.has(id);
    return { id, quantity, unitPrice, source: 'product', sold, value: sold ? quantity * unitPrice : 0 };
  });
  const inputs = [...(result.spent?.values() ?? [])].map(row => {
    const unitPrice = row.currency ? Number(row.id === 'GoldPieces') : catalog.items?.[row.id]?.price ?? 0;
    return { ...row, unitPrice, value: row.quantity * unitPrice };
  });
  const sales = drops.reduce((sum, drop) => sum + drop.value, 0);
  const materialCost = inputs.reduce((sum, row) => sum + (row.currency ? 0 : row.value), 0);
  const goldCost = inputs.reduce((sum, row) => sum + (row.currency ? row.value : 0), 0);
  const payout = sales - goldCost;
  const net = payout - materialCost;
  let forecast;
  const timeForItems = (id, target) => {
    if (!(target > 0)) return null;
    if (settings.itemProjection && !ranch) {
      forecast ??= farm(action, profile, catalog, { ...settings, seconds: 86400, farming: undefined }, false)?.events ?? [];
    }
    let amount = 0;
    for (const event of forecast ?? events) {
      for (const [item, quantity] of event.products ?? []) if (item === id) amount += quantity;
      if (amount >= target) return event.at / 3600;
    }
    return null;
  };
  return { action, passive: result, planXp, xp, activeHours, xpPerHour: xp / settings.hours,
    activeXpPerHour: activeHours > 0 ? xp / activeHours : 0, limit: result.limit, stockLimit: result.limit,
    knownXpPercent: 0, manualXpPercent: 0, seconds: result.seconds, flatXp: 0,
    cycles: events.length, drops, inputs, direct: 0, sales, materialCost, goldCost, payout, net, timeForItems,
    payoutPerHour: payout / settings.hours, netPerHour: net / settings.hours,
    activeNetPerHour: activeHours > 0 ? net / activeHours : 0 };
}

function cookingPlan(action, profile, catalog, stat, bonus, useCharges) {
  const difficulty = Math.max(0, action.difficulty + stat('FlatDifficulty'));
  const preserveOnFail = probability(stat('PreservationChanceOnFail'));
  const preserve = probability(stat('PreservationChance'));
  const charges = (useCharges ? profile.cookingCharges ?? [] : []).flatMap(({ item, quantity }) => {
    const data = catalog.items[item]?.cookingCharges;
    return quantity > 0 && data?.triggers.some(trigger =>
      ['recipe', 'category', 'subcategory'].every(key => !trigger[key] || trigger[key] === action[key]))
      ? [{ item, quantity, modifiers: data.modifiers }] : [];
  });
  let used = 0;
  const phases = [...new Set(charges.map(row => row.quantity)), Infinity].sort((a, b) => a - b).map(end => {
    const active = charges.filter(row => row.quantity > used).flatMap(row => row.modifiers);
    const proficiencyStat = active.length ? actionModifiers(action, profile, catalog, active) : stat;
    const proficiency = Math.max(0, (profile.levels.Cooking ?? 1) + proficiencyStat('FlatProficiency') + (bonus.proficiency ?? 0));
    const success = probability((69 + proficiency) / (69 + difficulty));
    const phase = { proficiency, success, length: end - used, consumes: (1 - preserve) * (1 - (1 - success) * preserveOnFail) };
    used = end;
    return phase;
  });
  function total(attempts, key) {
    let remaining = attempts;
    let value = 0;
    for (const phase of phases) {
      const length = Math.min(remaining, phase.length);
      value += length * phase[key];
      remaining -= length;
      if (remaining <= 0) break;
    }
    return value;
  }
  function attemptsFor(amount, key, whole = false) {
    let attempts = 0;
    for (const phase of phases) {
      const length = phase[key] ? amount / phase[key] : Infinity;
      const bound = whole ? Math.floor(length) : length;
      if (bound < phase.length || !Number.isFinite(phase.length)) return attempts + bound;
      attempts += phase.length;
      amount -= phase.length * phase[key];
      if (amount <= 0 && !whole) return attempts;
    }
    return attempts;
  }
  return { difficulty, proficiency: phases[0].proficiency, success: phases[0].success, preserveOnFail,
    charges, total, attemptsFor };
}

function evaluate(action, profile, catalog, settings) {
  const charges = settings.production ? [] : (profile.skillToolbelt?.[action.skill] ?? []).flatMap(({ id, quantity }) => {
    const model = catalog.items[id]?.skillCharges;
    return model && quantity > 0 && model.events.some(event => event.skill === action.skill)
      ? [{ id, quantity, ...model }] : [];
  });
  const bonfire = profile.bonfire;
  const timed = !settings.production && bonfire?.seconds > 0 && catalog.bonfires?.[bonfire.id] &&
    ['Woodcutting', 'Mining', 'Fishing', 'Thieving', 'Artisan', 'Firemaking'].includes(action.kind);
  if (timed) charges.push({ id: 'bonfire', quantity: bonfire.seconds, modifiers: catalog.bonfires[bonfire.id], timed: true });
  return charges.length ? evaluateSkillCharges(action, profile, catalog, settings, charges) :
    evaluateAction(action, profile, catalog, settings);
}

function chargeUsePerCycle(event, action, row) {
  if (event.skill !== action.skill || (event.category && event.category !== action.category) ||
      (event.recipe && event.recipe !== action.recipe) ||
      (event.subcategory && event.subcategory !== action.subcategory) ||
      (event.recipeType && event.recipeType !== action.recipeType)) return 0;
  if (row.agility) return event.chance * (event.successful ? row.agility.successes : row.agility.attempts);
  if (event.type === 'ArtisanPerformStep') {
    const step = row.craftingSteps;
    return step && step.steps >= (event.minSteps ?? 0) ? event.chance * expectedSteps(step.steps, step.skip) : 0;
  }
  if (row.thieving && event.successfulOnly) return event.chance * row.thieving.success;
  if (row.thieving && event.failedOnly) return event.chance * (1 - row.thieving.success);
  return event.chance * (row.wood?.hits ?? 1);
}

function evaluateSkillCharges(action, profile, catalog, settings, charges) {
  const phases = [];
  let remaining = charges;
  while (true) {
    const actor = { ...profile, skillPhaseModifiers: remaining.flatMap(row => row.modifiers) };
    const row = evaluateAction(action, actor, catalog, { ...settings, production: true });
    if (!row) break;
    const usage = remaining.map(charge => ({
      ...charge, rate: charge.timed ? row.seconds :
        charge.events.reduce((total, event) => total + chargeUsePerCycle(event, action, row), 0)
    }));
    const runs = Math.min(Infinity, ...usage.filter(charge => charge.rate > 0).map(charge => charge.quantity / charge.rate));
    phases.push({ row, usage, runs });
    if (!Number.isFinite(runs)) break;
    remaining = usage.map(charge => ({ ...charge, quantity: charge.quantity - runs * charge.rate })).filter(charge => charge.quantity > 1e-8);
  }
  if (!phases.length) return;

  function simulate(seconds, runs = Infinity) {
    const inventory = new Map();
    const segments = [];
    let cycles = 0;
    let limit = '';
    let elapsed = 0;
    let xp = 0;
    for (const phase of phases) {
      const { row } = phase;
      let count = Math.min(phase.runs, runs - cycles, (seconds - elapsed) / row.seconds);
      for (const input of row.inputs) {
        const key = (input.currency ? 'currency:' : 'item:') + input.id;
        if (!inventory.has(key)) {
          inventory.set(key, input.currency ? profile.currencies?.[input.id] ?? 0 :
            profile.keep?.includes(input.id) ? 0 : profile.stock[input.id] ?? 0);
        }
        const available = inventory.get(key);
        const batch = input.qty / (row.agility?.entries ?? 1);
        const usable = settings.ignoreStock ? Infinity :
          available < batch ? 0 : input.quantity > 0 ? 1 + (available - batch) / input.quantity : Infinity;
        if (usable < count) {
          count = usable;
          limit = input.id;
        }
      }
      if (count > 0) {
        segments.push({ ...phase, count });
        for (const input of row.inputs) {
          const key = (input.currency ? 'currency:' : 'item:') + input.id;
          inventory.set(key, Math.max(0, inventory.get(key) - count * input.quantity));
        }
        cycles += count;
        elapsed += count * row.seconds;
        xp += count * row.xp;
      }
      if (limit || cycles >= runs || elapsed >= seconds) break;
    }
    return { cycles, elapsed, xp, limit, segments };
  }
  const scheduled = simulate(settings.seconds);
  // Phase rates are expected values. Only completed cycles grant the projected rewards.
  const cycles = Math.floor(scheduled.cycles + 1e-9);
  if (!(cycles > 0)) return settings.itemProjection && scheduled.limit ? { limit: scheduled.limit, drops: [] } : undefined;
  const completed = simulate(settings.seconds, cycles);
  const inputs = new Map();
  const drops = new Map();
  const chargeSpent = new Map();
  const directSources = new Map();
  let direct = 0;
  for (const { row, usage, count } of completed.segments) {
    direct += row.direct * count;
    for (const source of row.directSources ?? []) {
      const key = JSON.stringify([source.source, source.target?.id]);
      const total = directSources.get(key) ?? { ...source, value: 0 };
      total.value += source.value * count;
      directSources.set(key, total);
    }
    for (const input of row.inputs) {
      const key = (input.currency ? 'currency:' : 'item:') + input.id;
      const total = inputs.get(key) ?? { ...input, quantity: 0, value: 0 };
      total.quantity += input.quantity * count;
      total.value += input.value * count;
      inputs.set(key, total);
    }
    for (const drop of row.drops) {
      const key = JSON.stringify([drop.id, drop.source, drop.target?.id]);
      const total = drops.get(key) ?? { ...drop, quantity: 0, value: 0 };
      total.quantity += drop.quantity * count;
      total.value += drop.value * count;
      drops.set(key, total);
    }
    for (const charge of usage) {
      if (!charge.timed) chargeSpent.set(charge.id, (chargeSpent.get(charge.id) ?? 0) + charge.rate * count);
    }
  }
  for (const { id, quantity } of charges) {
    const spent = Math.min(quantity, chargeSpent.get(id) ?? 0);
    if (!spent) continue;
    const unitPrice = catalog.items[id]?.price ?? 0;
    inputs.set('charge:' + id, { id, quantity: spent, unitPrice, value: spent * unitPrice });
  }
  const spent = [...inputs.values()];
  const products = [...drops.values()].sort((a, b) => b.value - a.value);
  const sales = products.reduce((sum, item) => sum + item.value, 0);
  const goldCost = spent.reduce((sum, item) => sum + (item.currency ? item.value : 0), 0);
  const materialCost = spent.reduce((sum, item) => sum + (item.currency ? 0 : item.value), 0);
  const payout = direct + sales - goldCost;
  const net = payout - materialCost;
  const activeHours = completed.elapsed / 3600;
  function plan(target, amount) {
    if (!(target > 0)) return null;
    const positive = phases.map(({ row }) => amount(row)).filter(value => value > 0);
    if (!positive.length) return null;
    const zeroRuns = phases.reduce((sum, phase) => amount(phase.row) > 0 ? sum : sum + phase.runs, 0);
    const cap = Number.isFinite(zeroRuns) ? Math.ceil(target / Math.min(...positive) + zeroRuns) + 1 :
      phases.reduce((sum, phase) => sum + (Number.isFinite(phase.runs) ? phase.runs : 0), 0);
    const valueOf = result => result.segments.reduce((sum, segment) => sum + segment.count * amount(segment.row), 0);
    const possible = Math.floor(simulate(Infinity, cap).cycles + 1e-9);
    let low = 0;
    let high = possible;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (valueOf(simulate(Infinity, middle)) >= target) high = middle;
      else low = middle + 1;
    }
    const result = simulate(Infinity, low);
    const value = valueOf(result);
    const hours = result.elapsed / 3600;
    return { hours, xp: value, rate: hours > 0 ? value / hours : 0, reaches: value >= target, limit: scheduled.limit };
  }
  return { ...phases[0].row, cycles, activeHours, xp: completed.xp, xpPerHour: completed.xp / settings.hours,
    activeXpPerHour: completed.xp / activeHours, xpPerCycle: completed.xp / cycles, seconds: completed.elapsed / cycles,
    limit: scheduled.limit, stockLimit: scheduled.limit, net, payout, direct,
    directSources: directSources.size ? [...directSources.values()] : undefined,
    goldCost, materialCost, sales, drops: products, inputs: spent, netPerHour: net / settings.hours,
    payoutPerHour: payout / settings.hours, activeNetPerHour: net / activeHours,
    risky: completed.segments.some(phase => phase.row.risky),
    skillCharges: [...chargeSpent].map(([id, quantity]) => ({ id, quantity })),
    planXp: amount => plan(amount, row => row.xp),
    timeForItems: settings.itemProjection ? (id, quantity) => {
      const estimate = plan(quantity, row => row.drops.filter(drop => drop.id === id && !drop.target)
        .reduce((sum, drop) => sum + drop.quantity, 0));
      return estimate?.reaches ? estimate.hours : null;
    } : undefined };
}

function canUseSacrificialAnvil(catalog, profile) {
  return Boolean(catalog.sacrificialAnvil &&
    (!profile.characterId || meetsRequirements(catalog.sacrificialAnvil.requirements, profile)));
}

function canUseAstralOfferings(catalog, profile) {
  return Boolean(catalog.astralOfferings &&
    (!profile.characterId || meetsRequirements(catalog.astralOfferings.requirements, profile)));
}

function evaluateAction(action, profile, catalog, settings) {
  const { levels, stock, currencies, bonuses } = profile;
  if (!settings.productionPreview && !unlocked(action, profile, { requireVerified: settings.experience })) return;
  if (['Farming', 'Ranching', 'GrainMill'].includes(action.kind)) {
    return evaluatePassiveExperience(action, profile, catalog, settings);
  }
  const level = levels[action.skill];
  const agility = action.kind === 'Agility' ? agilityPlan(action, profile, catalog) : null;
  const hunting = action.kind === 'Hunting' ? huntingPlan(action, profile, catalog, settings.ignoreStock) : null;
  if ((action.kind === 'Agility' && !agility) || (action.kind === 'Hunting' && !hunting)) return;

  const bonus = bonuses?.[action.skill] ?? {};
  const heist = action.heistBonuses?.filter(row => meetsRequirements(row.requirements, profile))
    .flatMap(row => row.modifiers);
  const stat = hunting?.stat ?? actionModifiers(action, profile, catalog, heist);
  const flatInterval = stat('FlatInterval') / 1000;
  const percentInterval = stat('PercentInterval');
  const manualInterval = 1 + (bonus.interval ?? 0) / 100;
  const wood = action.kind === 'Woodcutting' ? woodcuttingModifiers(action, stat, bonus.interval ?? 0) : null;
  const woodHits = wood?.hits ?? 0;
  let seconds = Math.floor((action.seconds * 1000 + stat('FlatInterval')) * (1 + percentInterval)) / 1000;
  if (action.kind === 'Fishing') {
    const minimum = Math.floor((action.minSeconds * 1000 + flatInterval * 1000 + stat('FlatMinInterval')) *
      (1 + percentInterval + stat('PercentMinInterval'))) / 1000;
    const maximum = Math.floor((action.maxSeconds * 1000 + flatInterval * 1000 + stat('FlatMaxInterval')) *
      (1 + percentInterval + stat('PercentMaxInterval'))) / 1000;
    seconds = (minimum + Math.max(minimum, maximum)) / 2;
  }
  let brewing;
  let craftingSteps;
  if (action.kind === 'Herblore') {
    const [preparing, heating, stirring, bottling] = action.phases.map(({ phase, seconds }) =>
      Math.floor(seconds * 1000 * (1 + percentInterval + stat('Percent' + phase + 'Interval')) +
        stat('FlatInterval') + stat('Flat' + phase + 'Interval')) / 1000);
    brewing = { setup: (preparing + heating + stirring) * manualInterval, bottling: bottling * manualInterval, batchSize: 10 };
    if (brewing.setup < 0 || !(brewing.bottling > 0)) return;
    seconds = (preparing + heating + stirring) / brewing.batchSize + bottling;
  } else if (action.kind === 'Artisan' || action.kind === 'Cooking') {
    seconds = Math.floor(action.seconds * 1000 * (1 + percentInterval) + stat('FlatInterval')) / 1000;
  }
  if (action.kind === 'Artisan') {
    const steps = Math.max(1, Math.trunc(action.steps + stat('FlatSteps')));
    const skip = probability(stat('SkipStepChance'));
    craftingSteps = { steps, skip };
    seconds *= expectedSteps(steps, skip);
  }
  seconds = wood ? wood.interval * wood.hits : (agility?.seconds ?? hunting?.seconds ?? seconds) * manualInterval;
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  let cash = action.cash;
  let directSources;
  const rewards = new Map();
  const add = (id, quantity, source, { target, doubling, random = false } = {}) => {
    if (!id || !(quantity > 0)) return;
    const key = [source, id, target?.id].join(':');
    const prior = rewards.get(key);
    rewards.set(key, { id, source, target, doubling, quantity: (prior?.quantity ?? 0) + quantity,
      random: random || prior?.random || false });
  };
  let success = hunting?.success ?? 1;
  let thievingCompletion = 1;
  let risky = agility?.risky ?? false;
  const cooking = action.kind === 'Cooking' ? cookingPlan(action, profile, catalog, stat, bonus, !settings.production) : null;
  let thieving;
  if (action.kind === 'Thieving') {
    success = thievingSuccess(action, level, stat, bonus);
    risky = success < 1 && action.damage > 0 && probability(stat('DamageAvoidanceChance')) < 1;
    if (risky && !settings.experience && !settings.itemProjection && !settings.includeRisky) return;
    const stun = Math.max(0, Math.floor((2000 + stat('FlatStunInterval')) * (1 + stat('PercentStunInterval')))) / 1000;
    seconds += (1 - success) * (1 - probability(stat('StunAvoidanceChance'))) * stun;
    thievingCompletion = success / expectedSteps(Math.max(1, action.steps + Math.trunc(stat('FlatStages'))),
      probability(stat('SkipStageChance')));
    thieving = { success, completion: thievingCompletion, stun };
    cash = 0;
    directSources = [];
    function addLoot(table, odds, fortune, source, target, doubling) {
      for (const [id, , weight, minimum, maximum] of table) {
        let total = 0;
        for (let qty = minimum; qty <= maximum; qty++) total += Math.floor(qty * (1 + fortune / 100));
        add(id, total / (maximum - minimum + 1) * weight * odds, source, { target, doubling });
      }
    }
    function pickpocket(target, targetStat, chance, trigger) {
      const odds = chance * trigger;
      const fortune = targetStat('FlatFortune') + (chance < 1 ? targetStat('FlatFortuneUnderSuccess') : 0);
      if (target.cashRange) {
        const values = target.cashRange.map(value => Math.max(0, Math.floor((value + targetStat('FlatCurrencyReward', 'GoldPieces')) *
          (1 + targetStat('PercentCurrencyReward', 'GoldPieces')))));
        const value = (values[0] + values[1]) / 2 * odds *
          probability(target.cashChance * (1 + targetStat('PercentCurrencyLootChance')));
        if (value) directSources.push({ target, value });
        cash += value;
      }
      const different = target === action ? undefined : target;
      const doubling = probability(targetStat('DoublingChance'));
      const commonChance = probability(target.commonChance * (1 + targetStat('PercentCommonLootChance')));
      const rareChance = probability(target.rareChance * (1 + targetStat('PercentRareLootChance')));
      addLoot(target.common, odds * commonChance, fortune, 'common', different, doubling);
      addLoot(target.rare, odds * rareChance, fortune, 'rare', different, doubling);
      if (!different) addLoot(target.completion, thievingCompletion, fortune, 'completion');
    }
    pickpocket(action, stat, success, 1);
    const spillover = probability(stat('SameAreaPickpocketChance')) * success;
    if (spillover) {
      for (const target of catalog.actions) {
        if (target === action || target.kind !== 'Thieving' || target.recipe === action.recipe ||
          target.category !== action.category || target.recipeType !== action.recipeType || !unlocked(target, profile)) continue;
        const targetStat = actionModifiers(target, profile, catalog);
        pickpocket(target, targetStat, thievingSuccess(target, level, targetStat, bonus), spillover);
      }
    }
  }
  const singleProduct = Boolean(cooking || brewing);
  const products = singleProduct ? [...action.rewards].sort((a, b) => a[2] - b[2]) : action.rewards;
  let productChanceLeft = 1;
  for (const [index, [id, qty, chance]] of products.entries()) {
    if (action.kind === 'Mining') {
      const odds = probability((chance + stat('FlatOnHitItemChance', id)) * (1 + stat('PercentOnHitItemChance', id)));
      add(id, qty * odds, 'hit', { random: randomChance(odds) });
    } else if (action.kind === 'Woodcutting' && index > 0) {
      const odds = probability((chance + stat('FlatOnCutItemChance', id)) * (1 + stat('PercentOnCutItemChance', id)));
      add(id, (qty + Math.trunc(stat('FlatOnCutItemQuantity', id))) * odds, 'cut', { random: randomChance(odds) });
    } else if (action.kind === 'Firemaking') {
      const quantity = qty + Math.trunc(stat('FlatProductQuantity', id));
      const odds = probability(chance * (1 + stat('IncreasedProductChance', id)) + stat('FlatProductChance', id));
      add(id, quantity * odds, 'product', { random: randomChance(odds) });
    } else {
      const quantity = Math.max(1, Math.trunc((qty + stat('FlatProductQuantity', id)) * (1 + stat('PercentProductQuantity', id))));
      const odds = singleProduct ? Math.min(probability(chance), productChanceLeft) : chance;
      if (singleProduct) productChanceLeft -= odds;
      add(id, quantity * odds * success, 'product', { random: randomChance(odds) || randomChance(success) });
    }
  }
  if (action.kind === 'Firemaking' && (action.cashReward || cash)) {
    cash = Math.max(1, Math.trunc(cash * (1 + stat('PercentCurrencyReward', 'GoldPieces')) +
      stat('FlatCurrencyReward', 'GoldPieces'))) * (1 + probability(stat('DoublingChance')));
  }
  for (const event of action.events ?? []) {
    if (!meetsRequirements(event.requirements, profile)) continue;
    if (action.kind === 'Firemaking') {
      add(event.item, Math.max(1, Math.trunc(event.quantity * seconds)) * event.chance,
        'event', { random: randomChance(event.chance) });
    } else {
      const chance = probability(event.chance * (1 + stat('PercentEventChance', undefined, event.id)) +
        stat('FlatEventChance', undefined, event.id));
      const quantity = event.quantity + level * event.quantityPerLevel / 2;
      const doubling = probability(stat('ItemDoublingChance', undefined, event.id));
      add(event.item, quantity * chance * (1 + doubling), 'event', { random: randomChance(chance) || randomChance(doubling) });
    }
  }
  if (action.kind === 'Woodcutting') {
    const variableHits = wood.health > 1 && [wood.doubleDamage, wood.instant, wood.weak].some(randomChance);
    for (const [id, qty, chance] of action.hitRewards) {
      const odds = probability((chance + stat('FlatOnHitItemChance', id)) * (1 + stat('PercentOnHitItemChance', id)));
      add(id, (qty + Math.trunc(stat('FlatOnHitItemQuantity', id))) * odds * woodHits,
        'hit', { random: randomChance(odds) || variableHits });
    }
  }
  let xpChance = hunting?.success ?? thievingCompletion;
  let mining;
  if (action.kind === 'Mining') {
    const [id, qty, baseChance] = action.ore;
    const chance = probability(baseChance * (1 + stat('PercentIncreaseRockBreakChance')));
    const shatter = probability(stat('ShatterChance'));
    let breakRate = 0;
    const prospecting = probability(stat('FlatMinimumProspecting'));
    if (chance > 0) {
      const maxHits = Math.max(1, Math.ceil((0.9999 - prospecting) / chance));
      const unbroken = -Math.expm1(maxHits * Math.log1p(-chance));
      breakRate = chance / unbroken;
    }
    mining = { chance, shatter, prospecting, breakRate };
    xpChance = breakRate * (1 + shatter);
    const extra = probability(stat('AdditionalProductQuantityChance'));
    add(id, (qty + Math.trunc(stat('FlatProductQuantity', id)) + extra) * breakRate * (1 + 2 * shatter),
      'break', { random: [breakRate, shatter, extra].some(randomChance) });
    for (const [item, odds, source] of [
      [action.bar, breakRate * probability(stat('BarItemChance')), 'break'],
      [action.stone, probability(stat('StoneItemChance')), 'hit'],
      [action.essence, probability(stat('EssenceItemChance')), 'hit']
    ]) add(item, odds, source, { random: randomChance(odds) });
  }
  let fishing;
  if (action.kind === 'Fishing') {
    const baseFishChance = probability((action.fishChance + stat('FlatFishChance') + (bonus.fishChance ?? 0) / 100) *
      (1 + stat('IncreasedFishChance')));
    const priority = action.fish.find(([id]) => id === profile.fishingPriorities?.[action.recipe]);
    const priorityChance = priority ? baseFishChance * priority[2] : 0;
    const junkChance = (1 - priorityChance) * (1 - baseFishChance) * (1 - probability(stat('JunkRerollChance')));
    for (const [id, qty, chance, min, max] of action.fish) {
      const odds = chance * (1 - priorityChance - junkChance) + (id === priority?.[0] ? priorityChance : 0);
      add(id, qty * odds, 'fish', { random: randomChance(odds) || min !== max });
    }
    fishing = { junkChance, priority: priority?.[0] };
    const conversion = stat('JunkToGP');
    if (conversion > 0 && action.junk) {
      const price = (catalog.items[action.junk]?.price ?? 0) * conversion;
      const doubling = probability(stat('DoublingChance'));
      cash += junkChance * (Math.floor(price) * (1 - doubling) + Math.floor(2 * price) * doubling);
    } else add(action.junk, junkChance, 'junk', { random: randomChance(junkChance) });
    let remaining = 1;
    const special = action.special.map(([id, qty, chance]) => [id, qty + Math.trunc(stat('FlatSpecialProductQuantity', id)),
      probability(chance * (1 + stat('IncreasedSpecialProductChance', id)) + stat('FlatSpecialProductChance', id))]);
    special.sort((a, b) => a[2] - b[2]);
    const rolls = 1 + (1 - special.reduce((rest, [, , chance]) => rest * (1 - chance), 1)) *
      probability(stat('SecondSpecialItemChance'));
    for (const [id, qty, chance] of special) {
      add(id, qty * chance * remaining * rolls, 'special', {
        random: randomChance(chance * remaining) || randomChance(rolls - 1)
      });
      remaining *= 1 - chance;
    }
  }

  const doubleOutput = probability(stat('DoublingChance'));
  const outputMultiplier = (1 + doubleOutput) * (1 + (bonus.output ?? 0) / 100);
  if (action.modeProducts?.length && profile.astralOfferings && canUseAstralOfferings(catalog, profile)) {
    const list = catalog.astralOfferings.rewards.filter(row => action.offeringLevel >= row.min && action.offeringLevel <= row.max);
    if (list.length) {
      for (const [key, row] of rewards) if (row.source === 'product') rewards.delete(key);
      for (const reward of list) add(reward.id, reward.quantity, 'offering');
    }
  }
  let sacrifice;
  const anvil = catalog.sacrificialAnvil;
  if (action.skill === 'Smithing' && action.kind === 'Artisan' && profile.sacrificialAnvil &&
      canUseSacrificialAnvil(catalog, profile) && (!anvil.categories?.length || anvil.categories.includes(action.category))) {
    const rolls = anvil.xpWeight + anvil.saleWeight + anvil.collectableWeight;
    if (rolls > 0) {
      const items = [...rewards.values()].filter(row => row.source === 'product')
        .map(row => ({ id: row.id, quantity: row.quantity * outputMultiplier }));
      for (const [key, row] of rewards) if (row.source === 'product') rewards.delete(key);
      const base = items.reduce((sum, row) => sum + row.quantity * (catalog.items[row.id]?.price ?? 0), 0);
      const extra = base * (anvil.saleMultiplier - 1) * anvil.saleWeight / rolls;
      if (cash) directSources = [{ source: 'direct', value: cash }];
      (directSources ??= []).push({ source: 'sacrifice', value: base }, { source: 'sacrificeBonus', value: extra });
      cash += base + extra;
      const totalWeight = anvil.collectables.reduce((sum, row) => sum + row.weight, 0);
      const chance = action.steps * anvil.collectableWeight / rolls;
      for (const row of anvil.collectables) {
        add(row.id, row.quantity * row.weight / totalWeight * chance, 'collectable', { random: true });
      }
      sacrifice = { items, gp: base + extra, xpFactor: 1 + (anvil.xpMultiplier - 1) * anvil.xpWeight / rolls };
    }
  }
  const entryFactor = agility?.entries ?? 1;
  const ingredientRows = action.costs.map(([id, qty]) => [id,
    Math.max(1, Math.trunc(qty * (1 + stat('PercentIngredientCost', id)))) * entryFactor]);
  if (hunting?.trap) ingredientRows.push([hunting.trap, 1]);
  const ingredients = sumIngredients(ingredientRows);
  const currencyIngredients = sumIngredients(action.currencyCosts.map(([id, qty]) => [id,
    Math.max(1, Math.trunc(qty * (1 + stat('PercentIngredientCost')))) * entryFactor]));
  const preservation = agility?.preservation ?? probability(stat('PreservationChance'));
  let consumption = 1 - preservation;
  const overhead = (hunting?.firstExtra ?? 0) * manualInterval;
  let scheduled = Math.floor(Math.max(0, settings.seconds - overhead) / seconds);
  let durationForCycles = cycles => cycles > 0 ? overhead + cycles * seconds : 0;
  if (!settings.production && hunting?.baitAttempts && hunting.baitSeconds > 0) {
    const baitSeconds = hunting.baitSeconds * manualInterval;
    const work = Math.max(0, settings.seconds - overhead);
    const baited = Math.min(Math.floor(work / baitSeconds), hunting.baitAttempts);
    scheduled = baited + (baited === hunting.baitAttempts ? Math.floor(Math.max(0, work - baited * baitSeconds) / seconds) : 0);
    durationForCycles = cycles => cycles > 0 ? overhead + Math.min(hunting.baitAttempts, cycles) * baitSeconds +
      Math.max(0, cycles - hunting.baitAttempts) * seconds : 0;
  }
  if (brewing) {
    const { setup, bottling, batchSize } = brewing;
    const batchTime = setup + bottling * batchSize;
    const batches = Math.floor(settings.seconds / batchTime);
    const partial = Math.floor((settings.seconds - batches * batchTime - setup) / bottling);
    scheduled = batches * batchSize + Math.max(0, Math.min(batchSize, partial));
    durationForCycles = cycles => Math.ceil(cycles / batchSize) * setup + cycles * bottling;
  }
  let stockCycles = Infinity;
  let stockLimit = '';
  const possibleCycles = (available, quantity) => {
    const firstBatch = quantity / entryFactor;
    if (available < firstBatch) return 0;
    const budget = (available - firstBatch) / quantity;
    if (cooking) return 1 + cooking.attemptsFor(budget, 'consumes', true);
    if (!consumption) return Infinity;
    const prior = budget / consumption;
    return 1 + Math.floor(prior + Math.abs(prior) * Number.EPSILON * 4);
  };
  for (const [id, qty] of ingredients) {
    const available = profile.keep?.includes(id) ? 0 : stock[id] ?? 0;
    const possible = settings.ignoreStock ? Infinity : possibleCycles(available, qty);
    if (possible < stockCycles) {
      stockCycles = possible;
      stockLimit = id;
    }
  }
  for (const [id, qty] of currencyIngredients) {
    const available = currencies[id] ?? 0;
    const possible = settings.ignoreStock ? Infinity : possibleCycles(available, qty);
    if (possible < stockCycles) {
      stockCycles = possible;
      stockLimit = id;
    }
  }
  const cycles = settings.production ? 1 : Math.min(scheduled, stockCycles);
  const limit = stockCycles < scheduled ? stockLimit : '';
  if (cycles <= 0 || !Number.isFinite(cycles)) {
    if (settings.itemProjection && limit) return { limit, drops: [] };
    return;
  }
  const effectiveCycles = cooking ? cooking.total(cycles, 'success') : cycles;
  if (cooking) {
    consumption = cooking.total(cycles, 'consumes') / cycles;
    cooking.sessionSuccess = effectiveCycles / cycles;
  }
  const itemRates = settings.itemProjection ? new Map() : null;
  const drops = [...rewards.values()].map(({ id, source, target, quantity, doubling, random }) => {
    const naturalAmount = ['event', 'collectable', 'offering'].includes(source);
    const perCycle = quantity * (naturalAmount ? 1 :
      target ? (1 + doubling) * (1 + (bonus.output ?? 0) / 100) : outputMultiplier);
    const amount = perCycle * effectiveCycles;
    if (itemRates && !target) itemRates.set(id, (itemRates.get(id) ?? 0) + perCycle);
    const unitPrice = catalog.items[id]?.price ?? 0;
    const sold = settings.sell && (source !== 'special' || settings.sellSpecial !== false) &&
      !profile.keep?.includes(id) && !settings.keptDrops?.has(id);
    return { id, source, target, quantity: amount, unitPrice, value: sold ? unitPrice * amount : 0, sold,
      ...(settings.production ? { random: random || (!naturalAmount && randomChance(target ? doubling : doubleOutput)) ||
        randomChance(cooking?.success) } : {}) };
  }).sort((a, b) => b.value - a.value);
  const inputs = [...ingredients.map(([id, qty]) => ({ id, qty, unitPrice: catalog.items[id]?.price ?? 0 })),
    ...currencyIngredients.map(([id, qty]) => ({ id, qty, unitPrice: id === 'GoldPieces' ? 1 : 0, currency: true }))]
    .map(input => ({ ...input, quantity: input.qty * cycles * consumption, value: input.qty * cycles * consumption * input.unitPrice }));
  for (const { item: id, quantity: charges } of cooking?.charges ?? []) {
    const quantity = Math.min(charges, cycles);
    const unitPrice = catalog.items[id]?.price ?? 0;
    inputs.push({ id, quantity, unitPrice, value: quantity * unitPrice });
  }
  if (!settings.production && hunting?.baitAttempts > 0) {
    const id = hunting.bait;
    const quantity = Math.min(settings.ignoreStock ? Infinity : stock[id], Math.min(cycles, hunting.baitAttempts) * hunting.success);
    const unitPrice = catalog.items[id]?.price ?? 0;
    inputs.push({ id, quantity, unitPrice, value: quantity * unitPrice });
  }
  const sales = drops.reduce((total, row) => total + row.value, 0);
  const materialCost = inputs.reduce((total, row) => total + (row.currency ? 0 : row.value), 0);
  const goldCost = inputs.reduce((total, row) => total + (row.currency ? row.value : 0), 0);
  const direct = cash * cycles;
  const payout = direct + sales - goldCost;
  const net = payout - materialCost;
  const knownXpPercent = stat('PercentXPGained') * 100;
  const manualXpPercent = profile.xpBonuses?.[action.skill] ?? 0;
  const xpPerReward = Math.max(0, ((action.baseXp ?? 0) + stat('FlatXPGained')) *
    (1 + (knownXpPercent + manualXpPercent) / 100) * xpChance * (sacrifice?.xpFactor ?? 1));
  const xpPerCycle = xpPerReward * effectiveCycles / cycles;
  const xpForCycles = count => (cooking ? cooking.total(count, 'success') : count) * xpPerReward;
  const planXp = target => {
    if (!(target > 0) || !(xpPerReward > 0)) return null;
    const rewards = target / xpPerReward;
    const needed = cooking ? cooking.attemptsFor(rewards, 'success') : rewards;
    const attempts = Math.max(1, Math.ceil(needed - needed * Number.EPSILON));
    const available = Math.min(attempts, stockCycles);
    if (!Number.isFinite(available)) return null;
    const hours = durationForCycles(available) / 3600;
    const xp = xpForCycles(available);
    return { hours, xp, rate: hours > 0 ? xp / hours : 0, reaches: attempts <= stockCycles };
  };
  const knowledge = action.knowledge == null ? null : Math.max(0,
    (action.knowledge + stat('FlatKnowledge')) * (1 + stat('PercentKnowledge')));
  const activeHours = durationForCycles(cycles) / 3600;
  const timeForItems = itemRates && ((id, amount) => {
    if (amount === 0) return 0;
    const rate = itemRates.get(id);
    if (!(rate > 0) || !(amount > 0)) return null;
    const needed = amount / rate;
    const expected = cooking ? cooking.attemptsFor(needed, 'success') : needed;
    const attempts = Math.max(1, Math.ceil(expected - expected * Number.EPSILON));
    return attempts <= stockCycles && Number.isFinite(attempts) ? durationForCycles(attempts) / 3600 : null;
  });
  return {
    action, cycles, net, payout, limit, activeHours, timeForItems, durationForCycles,
    direct, directSources: directSources?.map(row => ({ ...row, value: row.value * cycles })),
    sales, materialCost, goldCost, drops, inputs, seconds, knowledge, percentInterval, flatInterval,
    netPerHour: net / settings.hours, payoutPerHour: payout / settings.hours,
    activeNetPerHour: net / activeHours,
    xp: xpPerReward * effectiveCycles, xpPerHour: xpPerReward * effectiveCycles / settings.hours,
    activeXpPerHour: xpPerReward * effectiveCycles / activeHours, stockLimit, knownXpPercent, manualXpPercent, risky,
    wood, mining, cooking, thieving, fishing, brewing, craftingSteps, agility, hunting, preservation, consumption, sacrifice,
    planXp, doubleOutput, flatXp: stat('FlatXPGained'), xpPerCycle
  };
}

function projectHourlyProduction(action, profile, catalog) {
  if (['Ranching', 'Agility'].includes(action.kind)) return;
  if (!unlocked(action, profile)) return { locked: true };
  return evaluate(action, profile, catalog, { seconds: 3600, hours: 1, itemProjection: true });
}

function productionCycle(action, profile, catalog, { preview = false, requirementsOnly = false } = {}) {
  if (action.kind === 'ItemUpgrade') {
    const restrictions = productionRestrictions(action, profile);
    if (requirementsOnly) return { restrictions };
    if (!preview && restrictions.length) return;
    const inputs = [...sumIngredients(action.costs).map(([id, qty]) =>
      ({ id, qty, quantity: qty, value: qty * (catalog.items[id]?.price ?? 0) })),
    ...sumIngredients(action.currencyCosts).map(([id, qty]) =>
      ({ id, qty, quantity: qty, currency: true, value: id === 'GoldPieces' ? qty : 0 }))];
    return { inputs, drops: action.rewards.map(([id, quantity]) => ({ id, quantity })), seconds: 0,
      durationForCycles: () => 0, direct: 0, restrictions };
  }
  const restrictions = preview || requirementsOnly ? productionRestrictions(action, profile) : [];
  if (requirementsOnly) return { restrictions };
  const row = evaluate(action, profile, catalog, { seconds: 3600, hours: 1, production: true, productionPreview: preview });
  return row && { ...row, restrictions };
}

function sumIngredients(rows) {
  const quantities = new Map();
  for (const [id, quantity] of rows) quantities.set(id, (quantities.get(id) ?? 0) + quantity);
  return [...quantities];
}

function rank(catalog, profile, options) {
  const { hours, offlineCap, sell, sellSpecial, metric, keptDrops, includeRisky } = options;
  if (!Number.isFinite(hours) || hours <= 0) return [];
  const seconds = Math.min(hours, offlineCap || Infinity) * 3600;
  const results = [];
  const experience = metric === 'xp';
  const settings = { seconds, sell, sellSpecial, hours, experience, keptDrops, includeRisky,
    ignoreStock: experience && options.ignoreStock === true };
  for (const action of experience ? catalog.xpActions : catalog.actions) {
    const result = evaluate(action, profile, catalog, settings);
    if (result && (result[metric] > 0 || (experience && result.passive))) results.push(result);
  }
  return results.sort((a, b) => b[metric] - a[metric] || b.net - a.net || a.action.id.localeCompare(b.action.id));
}

if (typeof module !== 'undefined') module.exports = { rank, actionModifiers, projectHourlyProduction, productionCycle,
  canUseSacrificialAnvil, canUseAstralOfferings };
