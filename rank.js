const probability = value => Math.min(1, Math.max(0, value));

function actionModifiers(action, profile, catalog, extraModifiers) {
  const stats = new Map();
  function add(modifiers, quantity = 1) {
    for (const modifier of modifiers ?? []) {
      if ((modifier.skill && modifier.skill !== action.skill) || ['recipe', 'category', 'location', 'subcategory', 'constellation', 'recipeType'].some(
        key => modifier[key] && modifier[key] !== action[key]
      )) continue;
      const scale = modifier.scalesWithLevel ? profile.levels[modifier.scalesWithLevel] ?? 0 : 1;
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
  return (key, item, event) => (stats.get([key, '', ''].join(':')) ?? 0) +
    (item || event ? stats.get([key, item, event].join(':')) ?? 0 : 0);
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
  let passed = !group.length || requirementMet(group[0]);
  for (const req of group.slice(1)) passed = req.or ? passed || requirementMet(req) : passed && requirementMet(req);
  return passed;
}

function unlocked(action, profile) {
  if (!profile.levels[action.skill] || profile.excluded?.includes(action.id)) return false;
  const confirmed = profile.confirmed?.includes(action.id);
  return action.requirementGroups.every(group => meetsRequirements(group, profile, confirmed));
}

function thievingSuccess(action, level, stat, bonus) {
  const stealth = Math.max(0, Math.floor((level + stat('FlatStealth') + (bonus.stealth ?? 0)) * (1 + stat('PercentStealth'))));
  const perception = Math.max(0, Math.floor((action.perception + stat('FlatPerception')) * (1 + stat('PercentPerception'))));
  return probability((100 + stealth) / (100 + perception));
}

function cookingPlan(action, profile, catalog, stat, bonus) {
  const difficulty = Math.max(0, action.difficulty + stat('FlatDifficulty'));
  const preserveOnFail = probability(stat('PreservationChanceOnFail'));
  const preserve = probability(stat('PreservationChance'));
  const charges = (profile.cookingCharges ?? []).flatMap(({ item, quantity }) => {
    const data = catalog.items[item]?.cookingCharges;
    return quantity > 0 && data?.triggers.some(trigger =>
      ['recipe', 'category', 'subcategory'].every(key => !trigger[key] || trigger[key] === action[key]))
      ? [{ item, quantity, modifiers: data.modifiers }] : [];
  });
  let used = 0;
  const phases = [...new Set(charges.map(row => row.quantity)), Infinity].sort((a, b) => a - b).map(end => {
    const active = charges.filter(row => row.quantity > used).flatMap(row => row.modifiers);
    const proficiencyStat = active.length ? actionModifiers(action, profile, catalog, active) : stat;
    const proficiency = Math.max(0, profile.levels.Cooking + proficiencyStat('FlatProficiency') + (bonus.proficiency ?? 0));
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
      if (amount <= 0) return attempts;
    }
    return attempts;
  }
  return { difficulty, proficiency: phases[0].proficiency, success: phases[0].success, preserveOnFail,
    charges, total, attemptsFor };
}

function evaluate(action, profile, catalog, settings) {
  const { levels, stock, currencies, bonuses } = profile;
  if (!unlocked(action, profile)) return;
  const level = levels[action.skill];

  const bonus = bonuses?.[action.skill] ?? {};
  const stat = actionModifiers(action, profile, catalog);
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
  seconds = wood ? wood.interval * wood.hits : seconds * manualInterval;
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  let cash = action.cash;
  let directSources;
  const rewards = new Map();
  const add = (id, quantity, source, target, doubling) => {
    if (!id || !(quantity > 0)) return;
    const key = [source, id, target?.id].join(':');
    const prior = rewards.get(key);
    rewards.set(key, { id, source, target, doubling, quantity: (prior?.quantity ?? 0) + quantity });
  };
  let success = 1;
  let thievingCompletion = 1;
  let risky = false;
  const cooking = action.kind === 'Cooking' ? cookingPlan(action, profile, catalog, stat, bonus) : null;
  let thieving;
  if (action.kind === 'Thieving') {
    success = thievingSuccess(action, level, stat, bonus);
    risky = success < 1 && action.damage > 0 && probability(stat('DamageAvoidanceChance')) < 1;
    if (risky && !settings.experience && !settings.itemProjection) return;
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
        add(id, total / (maximum - minimum + 1) * weight * odds, source, target, doubling);
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
      addLoot(target.common, odds * probability(target.commonChance * (1 + targetStat('PercentCommonLootChance'))), fortune, 'common', different, doubling);
      addLoot(target.rare, odds * probability(target.rareChance * (1 + targetStat('PercentRareLootChance'))), fortune, 'rare', different, doubling);
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
      add(id, qty * probability((chance + stat('FlatOnHitItemChance', id)) * (1 + stat('PercentOnHitItemChance', id))), 'hit');
    } else if (action.kind === 'Woodcutting' && index > 0) {
      add(id, (qty + Math.trunc(stat('FlatOnCutItemQuantity', id))) *
        probability((chance + stat('FlatOnCutItemChance', id)) * (1 + stat('PercentOnCutItemChance', id))), 'cut');
    } else if (action.kind === 'Firemaking') {
      const quantity = qty + Math.trunc(stat('FlatProductQuantity', id));
      const odds = probability(chance * (1 + stat('IncreasedProductChance', id)) + stat('FlatProductChance', id));
      add(id, quantity * odds, 'product');
    } else {
      const quantity = Math.max(1, Math.trunc((qty + stat('FlatProductQuantity', id)) * (1 + stat('PercentProductQuantity', id))));
      const odds = singleProduct ? Math.min(probability(chance), productChanceLeft) : chance;
      if (singleProduct) productChanceLeft -= odds;
      add(id, quantity * odds * success, 'product');
    }
  }
  if (action.kind === 'Firemaking' && (action.cashReward || cash)) {
    cash = Math.max(1, Math.trunc(cash * (1 + stat('PercentCurrencyReward', 'GoldPieces')) +
      stat('FlatCurrencyReward', 'GoldPieces'))) * (1 + probability(stat('DoublingChance')));
  }
  for (const event of action.events ?? []) {
    if (!meetsRequirements(event.requirements, profile)) continue;
    if (action.kind === 'Firemaking') {
      add(event.item, Math.max(1, Math.trunc(event.quantity * seconds)) * event.chance, 'event');
    } else {
      const chance = probability(event.chance * (1 + stat('PercentEventChance', undefined, event.id)) +
        stat('FlatEventChance', undefined, event.id));
      const quantity = event.quantity + level * event.quantityPerLevel / 2;
      add(event.item, quantity * chance * (1 + probability(stat('ItemDoublingChance', undefined, event.id))), 'event');
    }
  }
  if (action.kind === 'Woodcutting') {
    for (const [id, qty, chance] of action.hitRewards) {
      add(id, (qty + Math.trunc(stat('FlatOnHitItemQuantity', id))) *
        probability((chance + stat('FlatOnHitItemChance', id)) * (1 + stat('PercentOnHitItemChance', id))) * woodHits, 'hit');
    }
  }
  let xpChance = thievingCompletion;
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
    add(id, (qty + Math.trunc(stat('FlatProductQuantity', id)) + probability(stat('AdditionalProductQuantityChance'))) *
      breakRate * (1 + 2 * shatter), 'break');
    add(action.bar, breakRate * probability(stat('BarItemChance')), 'break');
    add(action.stone, probability(stat('StoneItemChance')), 'hit');
    add(action.essence, probability(stat('EssenceItemChance')), 'hit');
  }
  let fishing;
  if (action.kind === 'Fishing') {
    const baseFishChance = probability((action.fishChance + stat('FlatFishChance') + (bonus.fishChance ?? 0) / 100) *
      (1 + stat('IncreasedFishChance')));
    const priority = action.fish.find(([id]) => id === profile.fishingPriorities?.[action.recipe]);
    const priorityChance = priority ? baseFishChance * priority[2] : 0;
    const junkChance = (1 - priorityChance) * (1 - baseFishChance) * (1 - probability(stat('JunkRerollChance')));
    for (const [id, qty, chance] of action.fish) {
      add(id, qty * (chance * (1 - priorityChance - junkChance) + (id === priority?.[0] ? priorityChance : 0)), 'fish');
    }
    fishing = { junkChance, priority: priority?.[0] };
    const conversion = stat('JunkToGP');
    if (conversion > 0 && action.junk) {
      const price = (catalog.items[action.junk]?.price ?? 0) * conversion;
      const doubling = probability(stat('DoublingChance'));
      cash += junkChance * (Math.floor(price) * (1 - doubling) + Math.floor(2 * price) * doubling);
    } else add(action.junk, junkChance, 'junk');
    let remaining = 1;
    const special = action.special.map(([id, qty, chance]) => [id, qty + Math.trunc(stat('FlatSpecialProductQuantity', id)),
      probability(chance * (1 + stat('IncreasedSpecialProductChance', id)) + stat('FlatSpecialProductChance', id))]);
    special.sort((a, b) => a[2] - b[2]);
    const rolls = 1 + (1 - special.reduce((rest, [, , chance]) => rest * (1 - chance), 1)) *
      probability(stat('SecondSpecialItemChance'));
    for (const [id, qty, chance] of special) {
      add(id, qty * chance * remaining * rolls, 'special');
      remaining *= 1 - chance;
    }
  }

  const outputMultiplier = (1 + probability(stat('DoublingChance'))) * (1 + (bonus.output ?? 0) / 100);
  const ingredients = action.costs.map(([id, qty]) => [id, Math.max(1, Math.trunc(qty * (1 + stat('PercentIngredientCost', id))))]);
  const currencyIngredients = action.currencyCosts.map(([id, qty]) => [id, Math.max(1, Math.trunc(qty * (1 + stat('PercentIngredientCost'))))]);
  const preservation = probability(stat('PreservationChance'));
  let consumption = 1 - preservation;
  let scheduled = Math.floor(settings.seconds / seconds);
  let durationForCycles = cycles => cycles * seconds;
  if (brewing) {
    const { setup, bottling, batchSize } = brewing;
    const batchTime = setup + bottling * batchSize;
    const batches = Math.floor(settings.seconds / batchTime);
    const partial = Math.floor((settings.seconds - batches * batchTime - setup) / bottling);
    scheduled = batches * batchSize + Math.max(0, Math.min(batchSize, partial));
    durationForCycles = cycles => Math.ceil(cycles / batchSize) * setup + cycles * bottling;
  }
  let cycles = scheduled;
  let stockCycles = Infinity;
  let limit = '';
  const possibleCycles = portions => !portions ? 0 : cooking ? cooking.attemptsFor(portions, 'consumes', true) :
    consumption ? Math.floor(portions / consumption) : Infinity;
  for (const [id, qty] of ingredients) {
    const available = profile.keep?.includes(id) ? 0 : stock[id] ?? 0;
    const possible = possibleCycles(Math.floor(available / qty));
    stockCycles = Math.min(stockCycles, possible);
    if (possible < cycles) {
      cycles = possible;
      limit = id;
    }
  }
  for (const [id, qty] of currencyIngredients) {
    const available = currencies[id] ?? 0;
    const possible = possibleCycles(Math.floor(available / qty));
    stockCycles = Math.min(stockCycles, possible);
    if (possible < cycles) {
      cycles = possible;
      limit = id;
    }
  }
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
  const drops = [...rewards.values()].map(({ id, source, target, quantity, doubling }) => {
    const perCycle = quantity * (source === 'event' ? 1 :
      target ? (1 + doubling) * (1 + (bonus.output ?? 0) / 100) : outputMultiplier);
    const amount = perCycle * effectiveCycles;
    if (itemRates && !target) itemRates.set(id, (itemRates.get(id) ?? 0) + perCycle);
    const unitPrice = catalog.items[id]?.price ?? 0;
    const sold = settings.sell && (source !== 'special' || settings.sellSpecial !== false) &&
      !profile.keep?.includes(id) && !settings.keptDrops?.has(id);
    return { id, source, target, quantity: amount, unitPrice, value: sold ? unitPrice * amount : 0, sold };
  }).sort((a, b) => b.value - a.value);
  const inputs = [...ingredients.map(([id, qty]) => ({ id, qty, unitPrice: catalog.items[id]?.price ?? 0 })),
    ...currencyIngredients.map(([id, qty]) => ({ id, qty, unitPrice: id === 'GoldPieces' ? 1 : 0, currency: true }))]
    .map(input => ({ ...input, quantity: input.qty * cycles * consumption, value: input.qty * cycles * consumption * input.unitPrice }));
  for (const { item: id, quantity: charges } of cooking?.charges ?? []) {
    const quantity = Math.min(charges, cycles);
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
    (1 + (knownXpPercent + manualXpPercent) / 100) * xpChance);
  const xpPerCycle = xpPerReward * effectiveCycles / cycles;
  const hoursForXp = xp => {
    if (xpPerReward <= 0) return null;
    const attempts = xp / xpPerReward;
    if (cooking) return durationForCycles(cooking.attemptsFor(attempts, 'success')) / 3600;
    return durationForCycles(brewing ? Math.ceil(attempts) : attempts) / 3600;
  };
  const knowledge = action.knowledge == null ? null : Math.max(0,
    (action.knowledge + stat('FlatKnowledge')) * (1 + stat('PercentKnowledge')));
  const activeHours = durationForCycles(cycles) / 3600;
  const timeForItems = itemRates && ((id, amount) => {
    const rate = itemRates.get(id);
    if (!(rate > 0)) return null;
    const needed = amount / rate;
    const attempts = Math.ceil(cooking ? cooking.attemptsFor(needed, 'success') : needed);
    return attempts <= stockCycles && Number.isFinite(attempts) ? durationForCycles(attempts) / 3600 : null;
  });
  return {
    action, cycles, net, payout, limit, activeHours, timeForItems,
    direct, directSources: directSources?.map(row => ({ ...row, value: row.value * cycles })),
    sales, materialCost, goldCost, drops, inputs, seconds, knowledge, percentInterval, flatInterval,
    netPerHour: net / settings.hours, payoutPerHour: payout / settings.hours,
    activeNetPerHour: net / activeHours,
    xp: xpPerReward * effectiveCycles, xpPerHour: xpPerReward * effectiveCycles / settings.hours,
    stockXp: xpPerReward ? (cooking && Number.isFinite(stockCycles) ? cooking.total(stockCycles, 'success') : stockCycles) * xpPerReward : 0,
    sustainableXpPerHour: xpPerCycle * 3600 / seconds, knownXpPercent, manualXpPercent, risky,
    wood, mining, cooking, thieving, fishing, brewing, craftingSteps, preservation, consumption,
    hoursForXp, doubleOutput: probability(stat('DoublingChance')), flatXp: stat('FlatXPGained'), xpPerCycle
  };
}

function projectHourlyProduction(action, profile, catalog) {
  if (!unlocked(action, profile)) return { locked: true };
  return evaluate(action, profile, catalog, { seconds: 3600, hours: 1, itemProjection: true });
}

function rank(catalog, profile, options) {
  const { hours, offlineCap, sell, sellSpecial, metric, keptDrops } = options;
  const seconds = Math.min(hours, offlineCap || Infinity) * 3600;
  const results = [];
  const experience = metric === 'xp';
  for (const action of experience ? catalog.xpActions : catalog.actions) {
    const result = evaluate(action, profile, catalog, { seconds, sell, sellSpecial, hours, experience, keptDrops });
    if (result && result[metric] > 0) results.push(result);
  }
  return results.sort((a, b) => b[metric] - a[metric] || b.net - a.net || a.action.id.localeCompare(b.action.id));
}

if (typeof module !== 'undefined') module.exports = { rank, actionModifiers, projectHourlyProduction };
