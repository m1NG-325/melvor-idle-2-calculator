const probability = value => Math.min(1, Math.max(0, value));

function equipmentModifiers(action, profile, catalog, includeXp) {
  const stats = Object.create(null);
  function add(modifiers, quantity = 1) {
    for (const modifier of modifiers ?? []) {
      if (modifier.skill !== action.skill || ['recipe', 'category', 'location', 'subcategory'].some(
        key => modifier[key] && modifier[key] !== action[key]
      )) continue;
      stats[modifier.stat] = (stats[modifier.stat] ?? 0) + modifier.value * quantity;
    }
  }
  for (const id of profile.equipped?.[action.skill] ?? []) {
    add(catalog.items[id]?.modifiers);
    if (includeXp) add(catalog.items[id]?.xpModifiers);
  }
  if (includeXp || action.kind === 'Woodcutting') {
    for (const [id, quantity] of Object.entries(profile.purchases ?? {})) add(catalog.shopModifiers?.[id], quantity);
    for (const id of profile.astrologyNodes ?? []) add(catalog.astrologyModifiers?.[id]);
  }
  if (action.kind === 'Woodcutting') {
    for (const bonus of catalog.woodMastery?.bonuses ?? []) {
      if (profile.ranks?.Woodcutting?.includes(bonus.rank)) add(bonus.modifiers);
    }
  }
  return key => stats[key] ?? 0;
}

function expectedWoodHits(health, doubleDamage) {
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
  const interval = (action.seconds + stat('FlatInterval') / 1000) * (1 + stat('PercentInterval')) * (1 + intervalBonus / 100);
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

function evaluate(action, profile, catalog, settings) {
  const { levels, stock, currencies, bonuses } = profile;
  const level = levels[action.skill] ?? 0;
  if (!level || profile.excluded?.includes(action.id)) return;
  const confirmed = profile.confirmed?.includes(action.id);
  const requirementMet = req => {
    if (req.type === 'Level') return (levels[req.skill] ?? 0) >= req.level;
    if (req.type === 'ToolbeltItemEquipped' && req.item && profile.equipped?.[req.skill]?.includes(req.item)) return true;
    if (req.type === 'MasteryGuildRank' && req.rank && profile.ranks?.[req.skill]?.includes(req.rank)) return true;
    if (settings.experience && req.type === 'ShopPurchase' && (profile.purchases?.[req.purchase] ?? 0) >= req.amount) return true;
    return confirmed;
  };
  if (!action.requirementGroups.every(group => {
    let passed = requirementMet(group[0]);
    for (const req of group.slice(1)) passed = req.or ? passed || requirementMet(req) : passed && requirementMet(req);
    return passed;
  })) return;

  const bonus = bonuses?.[action.skill] ?? {};
  const stat = equipmentModifiers(action, profile, catalog, settings.experience);
  const flatInterval = stat('FlatInterval') / 1000;
  const percentInterval = stat('PercentInterval');
  const wood = action.kind === 'Woodcutting' ? woodcuttingModifiers(action, stat, bonus.interval ?? 0) : null;
  const woodHits = wood?.hits ?? 0;
  let seconds = (action.seconds + flatInterval) * (1 + percentInterval) * (woodHits || action.steps);
  if (action.kind === 'Fishing') {
    const minimum = (action.minSeconds + stat('FlatMinInterval') / 1000) * (1 + stat('PercentMinInterval'));
    const maximum = (action.maxSeconds + stat('FlatMaxInterval') / 1000) * (1 + stat('PercentMaxInterval'));
    seconds = (minimum + Math.max(minimum, maximum)) / 2;
  }
  if (action.kind === 'Herblore') {
    seconds = action.phases.reduce((total, { phase, seconds }) => total +
      (seconds + stat('Flat' + phase + 'Interval') / 1000) * (1 + stat('Percent' + phase + 'Interval')), 0);
  }
  if (settings.experience && action.kind === 'Artisan') {
    seconds = (action.seconds + flatInterval) * (1 + percentInterval) *
      expectedWoodHits(action.steps, probability(stat('SkipStepChance')));
  }
  seconds = wood ? wood.interval * wood.hits : seconds * (1 + (bonus.interval ?? 0) / 100);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  let cash = action.cash;
  const rewards = new Map();
  const add = (id, quantity) => {
    if (quantity > 0) rewards.set(id, (rewards.get(id) ?? 0) + quantity);
  };
  let success = 1;
  let risky = false;
  if (action.kind === 'Cooking') {
    const proficiency = Math.max(0, level + stat('FlatProficiency') + (bonus.proficiency ?? 0));
    success = probability((69 + proficiency) / (69 + Math.max(0, action.difficulty + stat('FlatDifficulty'))));
  }
  if (action.kind === 'Thieving') {
    const stealth = Math.max(0, Math.floor((level + stat('FlatStealth') + (bonus.stealth ?? 0)) * (1 + stat('PercentStealth'))));
    const perception = Math.max(0, Math.floor((action.perception + stat('FlatPerception')) * (1 + stat('PercentPerception'))));
    success = probability((100 + stealth) / (100 + perception));
    risky = success < 1 && action.damage > 0;
    if (risky && !settings.experience) return;
    seconds += (1 - success) * 2 * (1 + stat('PercentStunInterval'));
    cash *= success;
  }
  const extraProduct = Math.trunc(stat('FlatProductQuantity'));
  for (const [index, [id, qty, chance]] of action.rewards.entries()) {
    const quantity = index === 0 && ['Woodcutting', 'Artisan'].includes(action.kind) ? qty + extraProduct : qty;
    add(id, quantity * chance * success);
  }
  if (action.kind === 'Woodcutting') {
    for (const [id, qty, chance] of action.hitRewards) add(id, qty * chance * woodHits);
  }
  let xpChance = ['Cooking', 'Thieving'].includes(action.kind) ? success : 1;
  if (action.kind === 'Mining') {
    const [id, qty, baseChance] = action.ore;
    const chance = probability(baseChance * (1 + stat('PercentIncreaseRockBreakChance')));
    add(id, (qty + extraProduct + probability(stat('AdditionalProductQuantityChance'))) * chance);
    add(action.bar, action.bar ? chance * probability(stat('BarItemChance')) : 0);
    add(action.stone, action.stone ? probability(stat('StoneItemChance')) : 0);
    add(action.essence, action.essence ? probability(stat('EssenceItemChance')) : 0);
    if (chance > 0) {
      const prospecting = probability(stat('FlatMinimumProspecting'));
      const maxHits = Math.max(1, Math.ceil((0.9999 - prospecting) / chance));
      const unbroken = -Math.expm1(maxHits * Math.log1p(-chance));
      xpChance = (chance / unbroken) * (1 + probability(stat('ShatterChance')));
    } else xpChance = 0;
  }
  if (action.kind === 'Fishing') {
    const fishChance = probability(action.fishChance + stat('FlatFishChance') + (bonus.fishChance ?? 0) / 100);
    for (const [id, qty, chance] of action.fish) add(id, qty * chance * fishChance);
    add(action.junk, 1 - fishChance);
    let remaining = 1;
    for (const [id, qty, baseChance] of [...action.special].sort((a, b) => a[2] - b[2])) {
      const chance = probability(baseChance * (1 + stat('IncreasedSpecialProductChance')));
      add(id, qty * chance * remaining);
      remaining *= 1 - chance;
    }
  }

  const outputMultiplier = (1 + probability(stat('DoublingChance'))) * (1 + (bonus.output ?? 0) / 100);
  const sales = [...rewards].reduce((sum, [id, qty]) => {
    return sum + (profile.keep?.includes(id) ? 0 : (catalog.items[id]?.price ?? 0) * qty * outputMultiplier);
  }, 0);
  const materialsValue = action.costs.reduce((sum, [id, qty]) => sum + (catalog.items[id]?.price ?? 0) * qty, 0);
  const goldCost = action.currencyCosts.filter(([id]) => id === 'GoldPieces').reduce((sum, [, qty]) => sum + qty, 0);
  const scheduled = Math.floor(settings.seconds / seconds);
  let cycles = scheduled;
  let limit = '';
  for (const [id, qty] of action.costs) {
    const available = profile.keep?.includes(id) ? 0 : stock[id] ?? 0;
    const possible = Math.floor(available / qty);
    if (possible < cycles) {
      cycles = possible;
      limit = catalog.items[id]?.name ?? id;
    }
  }
  for (const [id, qty] of action.currencyCosts) {
    const possible = Math.floor((currencies[id] ?? 0) / qty);
    if (possible < cycles) {
      cycles = possible;
      limit = id === 'GoldPieces' ? '金币' : id;
    }
  }
  if (cycles <= 0 || !Number.isFinite(cycles)) return;
  const payout = (cash - goldCost + (settings.sell ? sales : 0)) * cycles;
  const net = payout - materialsValue * cycles;
  const knownXpPercent = stat('PercentXPGained') * 100;
  const manualXpPercent = profile.xpBonuses?.[action.skill] ?? 0;
  const xpPerCycle = Math.max(0, ((action.baseXp ?? 0) + stat('FlatXPGained')) *
    (1 + (knownXpPercent + manualXpPercent) / 100) * xpChance);
  return {
    action, cycles, net, payout, limit, activeHours: cycles * seconds / 3600,
    direct: (cash - goldCost) * cycles, sales: sales * cycles, materialCost: materialsValue * cycles,
    netPerHour: net / settings.hours, payoutPerHour: payout / settings.hours,
    xp: xpPerCycle * cycles, xpPerHour: xpPerCycle * cycles / settings.hours,
    sustainableXpPerHour: xpPerCycle * 3600 / seconds, knownXpPercent, manualXpPercent, risky,
    wood, flatXp: stat('FlatXPGained'), xpPerCycle
  };
}

function rank(catalog, profile, options) {
  const { hours, offlineCap, sell, metric } = options;
  const seconds = Math.min(hours, offlineCap || Infinity) * 3600;
  const results = [];
  const experience = metric === 'xp';
  for (const action of experience ? catalog.xpActions : catalog.actions) {
    const result = evaluate(action, profile, catalog, { seconds, sell, hours, experience });
    if (result && result[metric] > 0) results.push(result);
  }
  return results.sort((a, b) => b[metric] - a[metric] || b.net - a.net || a.action.id.localeCompare(b.action.id));
}

if (typeof module !== 'undefined') module.exports = { rank };
