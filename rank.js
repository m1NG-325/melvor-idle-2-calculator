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

function unlocked(action, profile) {
  const { levels } = profile;
  if (!levels[action.skill] || profile.excluded?.includes(action.id)) return false;
  const confirmed = profile.confirmed?.includes(action.id);
  const requirementMet = req => {
    if (req.type === 'Level') return (levels[req.skill] ?? 0) >= req.level;
    if (req.type === 'ToolbeltItemEquipped' && req.item && profile.equipped?.[req.skill]?.includes(req.item)) return true;
    if (req.type === 'MasteryGuildRank' && req.rank && profile.ranks?.[req.skill]?.includes(req.rank)) return true;
    if (req.type === 'ShopPurchase' && (profile.purchases?.[req.purchase] ?? 0) >= req.amount) return true;
    return confirmed;
  };
  return action.requirementGroups.every(group => {
    let passed = requirementMet(group[0]);
    for (const req of group.slice(1)) passed = req.or ? passed || requirementMet(req) : passed && requirementMet(req);
    return passed;
  });
}

function thievingSuccess(action, level, stat, bonus) {
  const stealth = Math.max(0, Math.floor((level + stat('FlatStealth') + (bonus.stealth ?? 0)) * (1 + stat('PercentStealth'))));
  const perception = Math.max(0, Math.floor((action.perception + stat('FlatPerception')) * (1 + stat('PercentPerception'))));
  return probability((100 + stealth) / (100 + perception));
}

function evaluate(action, profile, catalog, settings) {
  const { levels, stock, currencies, bonuses } = profile;
  if (!unlocked(action, profile)) return;
  const level = levels[action.skill];

  const bonus = bonuses?.[action.skill] ?? {};
  const stat = actionModifiers(action, profile, catalog);
  const flatInterval = stat('FlatInterval') / 1000;
  const percentInterval = stat('PercentInterval');
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
  if (action.kind === 'Herblore') {
    seconds = action.phases.reduce((total, { phase, seconds }) => {
      const duration = Math.floor(seconds * 1000 * (1 + stat('Percent' + phase + 'Interval')) +
        stat('Flat' + phase + 'Interval')) / 1000;
      return total + duration * (phase === 'Bottling' ? 10 : 1);
    }, 0);
  }
  if (action.kind === 'Artisan') {
    const steps = Math.max(1, Math.trunc(action.steps + stat('FlatSteps')));
    seconds = Math.floor((action.seconds * (1 + percentInterval) + flatInterval) * 1000) / 1000 *
      expectedSteps(steps, probability(stat('SkipStepChance')));
  }
  seconds = wood ? wood.interval * wood.hits : seconds * (1 + (bonus.interval ?? 0) / 100);
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
  if (action.kind === 'Cooking') {
    const proficiency = Math.max(0, level + stat('FlatProficiency') + (bonus.proficiency ?? 0));
    success = probability((69 + proficiency) / (69 + Math.max(0, action.difficulty + stat('FlatDifficulty'))));
  }
  if (action.kind === 'Thieving') {
    success = thievingSuccess(action, level, stat, bonus);
    risky = success < 1 && action.damage > 0 && probability(stat('DamageAvoidanceChance')) < 1;
    if (risky && !settings.experience) return;
    const stun = Math.max(0, Math.floor((2000 + stat('FlatStunInterval')) * (1 + stat('PercentStunInterval')))) / 1000;
    seconds += (1 - success) * (1 - probability(stat('StunAvoidanceChance'))) * stun;
    thievingCompletion = success / expectedSteps(Math.max(1, action.steps + Math.trunc(stat('FlatStages'))),
      probability(stat('SkipStageChance')));
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
  for (const [index, [id, qty, chance]] of action.rewards.entries()) {
    if (action.kind === 'Mining') {
      add(id, qty * probability((chance + stat('FlatOnHitItemChance', id)) * (1 + stat('PercentOnHitItemChance', id))), 'hit');
    } else if (action.kind === 'Woodcutting' && index > 0) {
      add(id, (qty + Math.trunc(stat('FlatOnCutItemQuantity', id))) *
        probability((chance + stat('FlatOnCutItemChance', id)) * (1 + stat('PercentOnCutItemChance', id))), 'cut');
    } else {
      const quantity = Math.max(1, Math.trunc((qty + stat('FlatProductQuantity', id)) * (1 + stat('PercentProductQuantity', id))));
      const odds = action.kind === 'Firemaking'
        ? probability(chance * (1 + stat('IncreasedProductChance', id)) + stat('FlatProductChance', id)) : chance;
      add(id, quantity * odds * success, 'product');
    }
  }
  if (action.kind === 'Firemaking') cash *= 1 + stat('PercentCurrencyReward', 'GoldPieces');
  if (action.kind === 'Woodcutting') {
    for (const [id, qty, chance] of action.hitRewards) {
      add(id, (qty + Math.trunc(stat('FlatOnHitItemQuantity', id))) *
        probability((chance + stat('FlatOnHitItemChance', id)) * (1 + stat('PercentOnHitItemChance', id))) * woodHits, 'hit');
    }
  }
  let xpChance = action.kind === 'Cooking' ? success : thievingCompletion;
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
  if (action.kind === 'Fishing') {
    const baseFishChance = probability((action.fishChance + stat('FlatFishChance') + (bonus.fishChance ?? 0) / 100) *
      (1 + stat('IncreasedFishChance')));
    const junkChance = (1 - baseFishChance) * (1 - probability(stat('JunkRerollChance')));
    for (const [id, qty, chance] of action.fish) add(id, qty * chance * (1 - junkChance), 'fish');
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
  const consumption = (1 - preservation) * (action.kind === 'Cooking'
    ? 1 - (1 - success) * probability(stat('PreservationChanceOnFail')) : 1);
  const scheduled = Math.floor(settings.seconds / seconds);
  let cycles = scheduled;
  let stockCycles = Infinity;
  let limit = '';
  for (const [id, qty] of ingredients) {
    const available = profile.keep?.includes(id) ? 0 : stock[id] ?? 0;
    const possible = available < qty ? 0 : consumption ? Math.floor(available / (qty * consumption)) : Infinity;
    stockCycles = Math.min(stockCycles, possible);
    if (possible < cycles) {
      cycles = possible;
      limit = id;
    }
  }
  for (const [id, qty] of currencyIngredients) {
    const available = currencies[id] ?? 0;
    const possible = available < qty ? 0 : consumption ? Math.floor(available / (qty * consumption)) : Infinity;
    stockCycles = Math.min(stockCycles, possible);
    if (possible < cycles) {
      cycles = possible;
      limit = id;
    }
  }
  if (cycles <= 0 || !Number.isFinite(cycles)) return;
  const drops = [...rewards.values()].map(({ id, source, target, quantity, doubling }) => {
    const amount = quantity * cycles * (target ? (1 + doubling) * (1 + (bonus.output ?? 0) / 100) : outputMultiplier);
    const unitPrice = catalog.items[id]?.price ?? 0;
    const sold = settings.sell && (source !== 'special' || settings.sellSpecial !== false) && !profile.keep?.includes(id);
    return { id, source, target, quantity: amount, unitPrice, value: sold ? unitPrice * amount : 0, sold };
  }).sort((a, b) => b.value - a.value);
  const inputs = [...ingredients.map(([id, qty]) => ({ id, qty, unitPrice: catalog.items[id]?.price ?? 0 })),
    ...currencyIngredients.map(([id, qty]) => ({ id, qty, unitPrice: id === 'GoldPieces' ? 1 : 0, currency: true }))]
    .map(input => ({ ...input, quantity: input.qty * cycles * consumption, value: input.qty * cycles * consumption * input.unitPrice }));
  const sales = drops.reduce((total, row) => total + row.value, 0);
  const materialCost = inputs.reduce((total, row) => total + (row.currency ? 0 : row.value), 0);
  const goldCost = inputs.reduce((total, row) => total + (row.currency ? row.value : 0), 0);
  const direct = cash * cycles;
  const payout = direct + sales - goldCost;
  const net = payout - materialCost;
  const knownXpPercent = stat('PercentXPGained') * 100;
  const manualXpPercent = profile.xpBonuses?.[action.skill] ?? 0;
  const xpPerCycle = Math.max(0, ((action.baseXp ?? 0) + stat('FlatXPGained')) *
    (1 + (knownXpPercent + manualXpPercent) / 100) * xpChance);
  const knowledge = action.knowledge == null ? null : Math.max(0,
    (action.knowledge + stat('FlatKnowledge')) * (1 + stat('PercentKnowledge')));
  return {
    action, cycles, net, payout, limit, activeHours: cycles * seconds / 3600,
    direct, directSources: directSources?.map(row => ({ ...row, value: row.value * cycles })),
    sales, materialCost, goldCost, drops, inputs, seconds, knowledge, percentInterval, flatInterval,
    netPerHour: net / settings.hours, payoutPerHour: payout / settings.hours,
    xp: xpPerCycle * cycles, xpPerHour: xpPerCycle * cycles / settings.hours, stockXp: xpPerCycle ? stockCycles * xpPerCycle : 0,
    sustainableXpPerHour: xpPerCycle * 3600 / seconds, knownXpPercent, manualXpPercent, risky,
    wood, mining, doubleOutput: probability(stat('DoublingChance')), flatXp: stat('FlatXPGained'), xpPerCycle
  };
}

function rank(catalog, profile, options) {
  const { hours, offlineCap, sell, sellSpecial, metric } = options;
  const seconds = Math.min(hours, offlineCap || Infinity) * 3600;
  const results = [];
  const experience = metric === 'xp';
  for (const action of experience ? catalog.xpActions : catalog.actions) {
    const result = evaluate(action, profile, catalog, { seconds, sell, sellSpecial, hours, experience });
    if (result && result[metric] > 0) results.push(result);
  }
  return results.sort((a, b) => b[metric] - a[metric] || b.net - a.net || a.action.id.localeCompare(b.action.id));
}

if (typeof module !== 'undefined') module.exports = { rank, actionModifiers };
