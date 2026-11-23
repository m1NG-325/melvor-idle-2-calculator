const baseCombatId = id => id?.replace(/^MelvorBase:/, '');
const combatProbability = value => Math.max(0, Math.min(1, value));

function isCombatEquipment(row) {
  return !(row.quantity < 0);
}

function combatOccupiedSlots(model, equipment) {
  return new Map((equipment ?? []).flatMap(({ id, slot }) => (model?.items[id]?.occupies ?? [])
    .filter(occupied => occupied !== slot).map(occupied => [occupied, id])));
}

function combatAttackAverage(patterns, source, defender, defend) {
  const normal = { damage: defend((source.min + source.max) / 2) * source.chance,
    maxDamage: defend(source.max, true), hits: source.chance, delay: 0 };
  let probability = 1;
  const result = { damage: 0, maxDamage: 0, hits: 0, delay: 0, effects: [], partial: false };
  for (const pattern of patterns ?? []) {
    const weight = Math.min(probability, pattern.chance);
    if (!(weight > 0)) continue;
    probability -= weight;
    const chance = pattern.avoidable === false ? 1 - source.immunity : source.chance;
    let damage = 0, maxDamage = 0, hits = 0, delay = 0, supported = true;
    for (const group of pattern.hits ?? []) {
      let average = 0, maximum = 0;
      for (const entry of group.damage ?? []) {
        const avg = combatFormula(entry, source, defender);
        const max = combatFormula(entry, source, defender, true);
        if (!Number.isFinite(avg) || !Number.isFinite(max)) supported = false;
        else { average += avg; maximum += max; }
      }
      const count = group.count ?? 1;
      if (hits || count > 1) delay += (hits ? count : count - 1) * (group.interval ?? 0);
      hits += count;
      if (group.damage?.length) {
        damage += count * defend(average);
        maxDamage += count * defend(maximum, true);
      }
    }
    result.partial ||= !supported || !!(pattern.damageType && pattern.damageType !== source.damageType);
    result.damage += weight * (supported ? damage * chance : normal.damage);
    result.maxDamage = Math.max(result.maxDamage, chance > 0 ? supported ? maxDamage : normal.maxDamage : 0);
    result.hits += weight * (supported ? hits * chance : normal.hits);
    result.delay += weight * delay;
    for (const effect of pattern.before ?? []) result.effects.push({ effect, frequency: weight });
    for (const effect of pattern.onHit ?? []) result.effects.push({ effect, frequency: weight * chance * hits });
  }
  result.damage += probability * normal.damage;
  result.hits += probability * normal.hits;
  if (probability > 0 && source.chance > 0) result.maxDamage = Math.max(result.maxDamage, normal.maxDamage);
  return result;
}

function combatFormula(entry, source, defender, maximum = false) {
  const target = ['Target', 'Defender'].includes(entry?.character) ? defender : source;
  if (!Number.isFinite(entry?.factor)) return NaN;
  const amount = {
    NormalDamage: maximum ? target.max : (target.min + target.max) / 2,
    MaxHit: target.max,
    CurrentHitpoints: maximum ? target.hp : target.hp / 2,
    MaximumHitpoints: target.hp
  }[entry.type];
  return amount * entry.factor;
}

function estimateCombatEffects(definitions, events, playerAttack, enemyAttack, player, enemy, playerInterval, enemyInterval, duration,
  effectModifier = () => 0) {
  const result = { modifiers: [], playerStun: 0, enemyStun: 0, playerDamagePerMs: 0, enemyDamagePerMs: 0,
    playerHealingPerMs: 0, enemyHealingPerMs: 0, partial: false };
  const sides = {
    Player: { interval: playerInterval, stats: player, attack: playerAttack, key: 'player' },
    Enemy: { interval: enemyInterval, stats: enemy, attack: enemyAttack, key: 'enemy' }
  };
  const other = side => side === 'Player' ? 'Enemy' : 'Player';
  const candidates = [];
  for (const { row, magnitude } of events) {
    const side = row.Character?.Component;
    const source = sides[side];
    const opponent = sides[other(side)];
    if (!source || !(magnitude > 0)) continue;
    const { Effect, Trigger, AppliesTo } = row.Modifier ?? {};
    const chance = combatProbability((row.Chance ?? 1) * magnitude);
    if (row.Condition || row.Scaling) { result.partial = true; continue; }
    const trigger = baseCombatId(Trigger?.Type);
    const data = Trigger?.Data?.Type;
    const attack = trigger === 'WhenAttacked' ? opponent : source;
    const perHit = ['OnHit', 'WhenHit'].includes(data);
    const cadence = Number.isFinite(attack.interval) ? 1 / Math.max(1, attack.interval) : 0;
    const entry = ['AtStartOfFight', 'OnDeath'].includes(trigger) || data === 'OnFirstAttack';
    if (!entry && !['OnAttack', 'WhenAttacked'].includes(trigger)) { result.partial = true; continue; }
    if (trigger === 'OnDeath') result.partial = true;
    const hitFactor = attack.attack?.hits ?? attack.stats.chance ?? 0;
    const firstHit = ['OnFirstHit', 'WhenFirstHit'].includes(data);
    if (firstHit && attack.attack) result.partial = true;
    const frequency = entry ? 1 / Math.max(1, duration) : cadence *
      (perHit ? hitFactor : firstHit ? combatProbability(hitFactor) :
        data === 'WhenAttackEvaded' ? 1 - combatProbability(hitFactor) : 1);
    candidates.push({ side, recipient: AppliesTo === 'Self' ? side : other(side), Effect, rate: chance * frequency, entry });
  }
  for (const [side, source] of Object.entries(sides)) {
    if (!Number.isFinite(source.interval)) continue;
    for (const { effect, frequency } of source.attack?.effects ?? []) {
      candidates.push({ side, recipient: effect.AppliesTo === 'Self' ? side : other(side),
        Effect: effect.Effect, rate: frequency * combatProbability(effect.Chance ?? 1) / source.interval });
    }
  }
  for (const { side, recipient, Effect, rate: applicationRate, entry, depth = 0 } of candidates) {
    const effectId = baseCombatId(Effect?.Data?.Effect);
    const rate = applicationRate * (1 - combatProbability(effectModifier(recipient, 'AvoidanceChance', effectId)));
    if (!(rate > 0)) continue;
    const rule = definitions[effectId];
    if (!rule) { result.partial = true; continue; }
    const source = sides[side];
    const destination = sides[recipient];
    const config = Effect.Data.Configuration ?? {};
    const sideInterval = destination.interval || 3000;
    const span = Math.max(1, duration);
    const turns = config.Turns ?? rule.DefaultTurns ?? rule.DefaultAttacks ?? 1;
    const uptime = ms => Math.min(1, rate * Math.min(ms, span));
    let weight = uptime(turns * sideInterval);
    if (rule.type === 'Stacking') {
      const added = config.StacksToAdd ?? rule.DefaultStacksToAdd ?? 1;
      weight = Math.min(rule.MaxStacks ?? 1, added * rate * span / (entry ? 1 : 2));
    } else if (rule.type === 'RandomMagnitude') {
      weight *= ((config.MinStacks ?? rule.DefaultMinStacks ?? 1) + (config.MaxStacks ?? rule.DefaultMaxStacks ?? 1)) / 2;
    } else if (rule.type === 'AttackCharging') {
      weight = Math.min(1, rate * span / Math.max(1, rule.StacksRequired)) / Math.max(1, rule.StacksRequired);
      result.partial = true;
    } else if (rule.type === 'Stun') {
      result[destination.key + 'Stun'] = combatProbability(result[destination.key + 'Stun'] + weight);
    }
    if (Array.isArray(rule.Modifiers) && weight > 0) {
      const rows = rule.Modifiers.map(row => ({ ...row, LocalContext: { ...row.LocalContext,
        Component: { Entity: 'MelvorBase:Combat', Component: recipient } } }));
      result.modifiers.push({ rows, weight });
    }
    if (rule.type === 'DamageOverTime' || rule.type === 'Bleed') {
      const entryDamage = rule.DamagePerProc;
      const damage = rule.type === 'Bleed' ? ((source.stats.min + source.stats.max) / 2) * rule.PercentDamageDealtPerProc :
        combatFormula({ character: entryDamage?.Character, type: baseCombatId(entryDamage?.Formula?.Type),
          factor: entryDamage?.Formula?.Data?.Percent }, source.stats, destination.stats);
      const tick = Math.max(1, rule.ProcInterval ?? 1);
      const stacks = Math.min(rule.MaxStacks ?? 1, Math.max(0, rate * Math.min(Math.max(0, span - tick), tick * rule.ProcCount) *
        (config.StacksToAdd ?? rule.DefaultStacksToAdd ?? 1)));
      if (Number.isFinite(damage)) {
        const amount = Math.max(0, damage) * stacks / tick;
        result[destination.key + 'DamagePerMs'] += amount;
        result[source.key + 'HealingPerMs'] += amount * combatProbability(effectModifier(side, 'EffectLifesteal', effectId));
      }
      else result.partial = true;
    } else if (rule.type === 'EndOfTurnDamage' || rule.type === 'EndOfTurnHealing') {
      const healing = rule.type === 'EndOfTurnHealing';
      const entryDamage = healing ? rule.HealingPerTurn : rule.DamagePerTurn;
      const damage = combatFormula({ character: entryDamage?.Character, type: baseCombatId(entryDamage?.Formula?.Type),
        factor: entryDamage?.Formula?.Data?.Percent }, source.stats, destination.stats);
      if (Number.isFinite(damage)) result[destination.key + (healing ? 'HealingPerMs' : 'DamagePerMs')] +=
        Math.max(0, damage) * (entry ? uptime(span) : uptime(sideInterval)) *
        Math.floor(span / sideInterval) / span;
      else result.partial = true;
    } else if (!['TurnCounting', 'Stun', 'Stacking', 'RandomMagnitude', 'AttackCharging', 'AttackCounting'].includes(rule.type)) {
      result.partial = true;
    }
    if (rule.RemovalEffect && span > turns * sideInterval) {
      if (depth >= 2) result.partial = true;
      else candidates.push({ side, recipient, Effect: rule.RemovalEffect, rate: rate *
        (span - turns * sideInterval) / span, entry, depth: depth + 1 });
    }
  }
  return result;
}

function combatAttributes(model, character, target, area, spells, foodRules = {}, { quick = false, forecast } = {}) {
  const saved = character?.combat;
  if (!saved?.equipment) return null;
  const weapon = model.items[saved.equipment.find(row => row.slot === 'Weapon')?.id ?? 'DefaultWeapon']?.weapon;
  if (!weapon) return null;
  const weaponType = baseCombatId(weapon.Type);
  const stanceId = saved.stances?.[weaponType] ?? model.weaponTypes[weaponType]?.stances[0];
  const stance = model.stances[stanceId];
  const style = stance && model.styles[stance.style];
  if (!style) return null;
  const spell = style.UsesSpells ? spells[saved.spell] : null;
  const element = spell?.element ?? baseCombatId(weapon.Elements?.[0]) ?? 'Neutral';
  const damageType = baseCombatId(weapon.DamageType) ?? 'Normal';
  const equipment = saved.equipment.map(row => row.id);
  if (!saved.equipment.some(row => row.slot === 'Weapon')) equipment.push('DefaultWeapon');
  const gear = [...equipment, ...(saved.toolbelt ?? []).map(row => row.id)].map(id => model.items[id]).filter(Boolean);
  const mods = new Map();
  const enemyMods = new Map();
  const effectMods = new Map();
  const foodBonuses = [];
  const supplyBonuses = [];
  const enemyStanceId = target?.stances[0]?.[0];
  const enemyStance = model.stances[enemyStanceId];
  const enemyStyle = enemyStance?.style;
  const enemyElement = target?.element;
  function add(rows, count = 1) {
    for (const row of rows ?? []) {
      const c = row.LocalContext;
      if (c?.Component?.Entity === 'MelvorBase:Combat' && !row.FromContext &&
          (!row.Scaling || row.Scaling.Type === 'MelvorBase:Level') &&
          (!row.Condition || (row.Condition.Type === 'MelvorBase:CharacterUsingStance' &&
            baseCombatId(row.Condition.Data?.Stance) === stanceId)) &&
          ['AmmoPreservationChance', 'RunePreservationChance', 'FlatRuneCost'].includes(row.Stat.Name)) {
        const scale = row.Scaling ? character.levels[baseCombatId(row.Scaling.Data?.Experience?.Entity)] ?? 0 : 1;
        supplyBonuses.push({ name: row.Stat.Name, context: c, value: row.Value * count * scale });
      }
      if (c?.Component?.Entity === 'MelvorBase:Combat' && c.Component.Component === 'Food') {
        foodBonuses.push({ row, count });
      }
      const enemySide = c?.Component?.Component === 'Enemy';
      const matchup = ['AvoidanceChance', 'ImmunityFrom'].includes(row.Stat.Name);
      if (c?.Component?.Entity === 'MelvorBase:Combat' && c.Effect &&
          ['AvoidanceChance', 'EffectLifesteal'].includes(row.Stat.Name)) {
        if (!row.Condition && !row.FromContext && !row.Scaling) {
          const key = [c.Component.Component, row.Stat.Name, baseCombatId(c.Effect)].join(':');
          effectMods.set(key, (effectMods.get(key) ?? 0) + row.Value * count);
        }
        continue;
      }
      if (c?.Component?.Entity !== 'MelvorBase:Combat' || !['Player', 'Action', 'Enemy'].includes(c.Component.Component) ||
          row.Condition || row.FromContext || c.Effect ||
          (c.CombatStyle && baseCombatId(c.CombatStyle) !== ((enemySide !== matchup) ? enemyStyle : stance.style)) ||
          (c.AttackStance && baseCombatId(c.AttackStance) !== ((enemySide !== matchup) ? enemyStanceId : stanceId)) ||
          (c.Element && baseCombatId(c.Element) !== ((enemySide !== matchup) ? enemyElement : element))) continue;
      if (row.Scaling && row.Scaling.Type !== 'MelvorBase:Level') continue;
      const scale = row.Scaling ? character.levels[baseCombatId(row.Scaling.Data?.Experience?.Entity)] ?? 0 : 1;
      const key = row.Stat.Name + ':' + (baseCombatId(c.CombatStat ?? c.CombatLevel ?? c.DamageType) ?? '');
      const table = enemySide ? enemyMods : mods;
      table.set(key, (table.get(key) ?? 0) + row.Value * count * scale);
    }
  }
  for (const item of gear) add(item.bonuses);
  if ((character.stock[saved.food] ?? 0) > 0) {
    add(foodRules[saved.food]?.bonuses.filter(row => row.LocalContext?.Component?.Component !== 'Food'));
  }
  add(stance.bonuses);
  for (const prayer of saved.prayers ?? []) {
    if (prayer.state === 1) add(model.prayers[prayer.active]?.bonuses);
  }
  for (const set of model.sets) {
    const count = set.items.filter(id => equipment.includes(id)).length;
    for (const bonus of set.bonuses) if (count >= bonus.count) add(bonus.rows);
  }
  for (const [id, count] of Object.entries(character.purchases ?? {})) add(model.savedBonuses.ShopPurchase[id], count);
  for (const id of character.astrologyNodes ?? []) add(model.savedBonuses.AstrologyNode[id]);
  for (const id of character.unlockedPets ?? []) add(model.savedBonuses.Pet[id]);
  for (const [skill, ranks] of Object.entries(character.ranks ?? {})) {
    for (const id of ranks) add(model.savedBonuses.MasteryGuildBonus?.[id]);
  }
  for (const row of model.triangle) if (row.player === stance.style && row.enemy === enemyStyle) add(row.bonuses);
  const mod = (stat, key = '') => (mods.get(stat + ':') ?? 0) + (key ? mods.get(stat + ':' + key) ?? 0 : 0);
  const enemyMod = (stat, key = '') => (enemyMods.get(stat + ':') ?? 0) + (key ? enemyMods.get(stat + ':' + key) ?? 0 : 0);
  const combatEffects = [...(area?.effects ?? []), ...(target?.effects ?? [])];
  const hasConditionalEffect = combatEffects.some(bundle => (bundle.modifiers.Component ?? []).some(row =>
    row.Condition || row.FromContext ||
    (row.LocalContext?.Effect && !['AvoidanceChance', 'EffectLifesteal'].includes(row.Stat.Name)) ||
    (row.Scaling && row.Scaling.Type !== 'MelvorBase:Level')));
  const areaMagnitude = bundle => bundle.magnitude * (bundle.area ? Math.max(0, 1 + mod('PercentAreaEffectMagnitude')) : 1);
  for (const bundle of combatEffects) add(bundle.modifiers.Component, areaMagnitude(bundle));
  for (const { rows, weight } of forecast?.modifiers ?? []) add(rows, weight);
  const levels = Object.fromEntries(['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic'].map(id =>
    [id, Math.trunc((character.levels[id] ?? 1) + mod('FlatCombatLevel', id))]
  ));
  const ratio = (rows, values) => (rows ?? []).reduce((sum, row) => sum + (values[baseCombatId(row.Level)] ?? 1) * row.Ratio, 0);
  const sources = [...gear.map(item => item.stats), spell?.stats].filter(Boolean);
  const totals = values => values.reduce((sum, row) => sum + row.Value, 0);
  const stats = Object.fromEntries(Object.entries(model.attributes).map(([id, record]) => {
    const base = totals(sources.flatMap(source => source.Stats ?? []).filter(row => baseCombatId(row.Stat) === id));
    const value = (base + mod('FlatCombatStatValue', id)) * (1 + mod('PercentCombatStatValue', id));
    return [id, record.percent ? value : Math.round(value)];
  }));
  const rating = (type, key) => totals(sources.flatMap(source => source[key] ?? [])
    .filter(row => baseCombatId(row.DamageType) === type));
  const stat = id => stats[baseCombatId(id)] ?? 0;
  const formula = style.MaxHitFormula?.Data;
  const level = ratio(formula?.Levels, levels);
  let baseHit;
  if (style.MaxHitFormula?.Type === 'MelvorBase:StrengthBonus') {
    baseHit = Math.floor(22 + level + (level + 17) * stat(formula.StrengthBonusStat) / 64);
  } else if (style.MaxHitFormula?.Type === 'MelvorBase:DamageBonus' && spell?.stats) {
    baseHit = Math.floor(stat(formula.MaxHitStat) * (1 + stat(formula.DamageBonusStat)) * (1 + (level + 1) / 200));
  }
  const maxHit = baseHit == null ? null : Math.max(1, Math.floor((baseHit * (1 + mod('PercentMaxHit')) + mod('FlatMaxHit')) *
    (1 + mod('MaxHitCombatTriangle'))));
  const minHit = maxHit == null ? null : Math.max(1, Math.min(maxHit, Math.floor(1 + mod('FlatMinHit') + maxHit * mod('MinHitBasedOnMaxHit'))));
  const light = mod('FlatLight');
  const darkness = (area?.darkness ?? 0) * (1 + mod('PercentDarkness')) + mod('FlatDarkness');
  const visibility = 1 - .05 * Math.max(0, Math.min(20, Math.trunc(darkness - light)));
  const baseAccuracy = Math.floor((ratio(style.AccuracyRatingLevels, levels) + 9) * (stat(stance.accuracy) + 64));
  const accuracy = Math.max(1, Math.trunc(Math.floor(baseAccuracy * (1 + mod('PercentAccuracyRating'))) * visibility));
  const evasion = Object.fromEntries(Object.entries(model.stances).map(([id, row]) => {
    const base = Math.floor((ratio(model.styles[row.style]?.EvasionLevels, levels) + 9) * (stat(row.evasion) + 64));
    return [id, Math.max(1, Math.trunc(Math.floor(base * (1 + mod('PercentEvasionRating')) + mod('FlatEvasionRating')) * visibility))];
  }));
  const enemyStats = id => (totals((target?.stats?.Stats ?? []).filter(row => baseCombatId(row.Stat) === id)) +
    enemyMod('FlatCombatStatValue', id)) * (1 + enemyMod('PercentCombatStatValue', id));
  const enemyEvasion = Math.max(1, Math.floor((ratio(style.EvasionLevels, target?.levels ?? {}) + 9) *
    (enemyStats(stance.evasion) + 64) * (1 + enemyMod('PercentEvasionRating')) + enemyMod('FlatEvasionRating')));
  const enemyImmunity = enemyMod('ImmunityFrom', damageType) > 0 ? 1 : 0;
  const hitChance = target ? combatProbability((accuracy >= enemyEvasion ? 1 - enemyEvasion / (2 * accuracy) :
    accuracy / (2 * enemyEvasion)) + mod('FlatHitChance')) * (1 - enemyImmunity) *
      (1 - combatProbability(enemyMod('AvoidanceChance', damageType))) : null;
  const power = Math.max(0, (rating(damageType, 'PowerRatings') + mod('FlatPowerRating', damageType)) * (1 + mod('PercentPowerRating', damageType)));
  const protectionType = target?.damageType ?? damageType;
  const protection = Math.max(0, (rating(protectionType, 'ProtectionRatings') + mod('FlatProtectionRating', protectionType)) *
    (1 + mod('PercentProtectionRating', protectionType)));
  const interval = Math.max(250, Math.floor(stat(style.AttackIntervalStat) * (1 + mod('PercentAttackInterval')) + mod('FlatAttackInterval'))) /
    Math.max(.1, 1 - (forecast?.playerStun ?? 0));
  const crit = combatProbability(mod('FlatCriticalHitChance'));
  const critMultiplier = Math.max(1, 1.5 + mod('FlatCriticalHitMultiplier'));
  const maxHp = Math.max(1, Math.floor((levels[baseCombatId(style.MaxHitpointsLevel)] ?? 1) * 10 *
    (1 + mod('PercentMaxHitpoints')) + mod('FlatMaxHitpoints')));
  const enemyProtection = Math.max(0, (((target?.stats?.ProtectionRatings ?? []).find(row => baseCombatId(row.DamageType) === damageType)?.Value ?? 0) +
    enemyMod('FlatProtectionRating', damageType)) * (1 + enemyMod('PercentProtectionRating', damageType)));
  const resistance = Math.min(.7, enemyProtection / (power + enemyProtection || 1));
  const enemyHealth = (target?.levels?.Hitpoints ?? 0) * 10;
  const enemyHp = enemyHealth + Math.max(0, enemyStats('MaximumWard'));
  const ammoReady = !weapon.RequiredAmmoType || saved.equipment.some(row =>
    row.quantity > 0 && model.items[row.id]?.ammoType === weapon.RequiredAmmoType);
  const ammoPreservation = combatProbability(supplyBonuses.reduce((sum, row) =>
    row.name === 'AmmoPreservationChance' && (!row.context.AmmoType || row.context.AmmoType === weapon.RequiredAmmoType)
      ? sum + row.value : sum, 0));
  const spellSupplies = {};
  for (const id of new Set([saved.spell, saved.imbuement, saved.activeImbuement].filter(Boolean))) {
    const entry = spells[id];
    if (!entry) continue;
    const matching = supplyBonuses.filter(({ context }) =>
      (!context.Spell || baseCombatId(context.Spell) === id) &&
      (!context.Element || baseCombatId(context.Element) === entry.element));
    const preserve = combatProbability(matching.reduce((sum, row) =>
      row.name === 'RunePreservationChance' && !row.context.Rune ? sum + row.value : sum, 0));
    const runes = entry.runes.map(rune => {
      const flat = matching.reduce((sum, row) => row.name === 'FlatRuneCost' &&
        (!row.context.Rune || baseCombatId(row.context.Rune) === rune.id) ? sum + row.value : sum, 0);
      return { ...rune, quantity: Math.max(1, rune.quantity + Math.trunc(flat)) };
    });
    spellSupplies[id] = { preserve, runes };
  }
  const affordable = entry => entry?.runes.every(row => (character.stock[row.id] ?? 0) >= row.quantity) ?? false;
  const usable = !style.UsesSpells || affordable(spellSupplies[saved.spell]);
  const imbuementId = saved.imbuement ?? saved.activeImbuement;
  const imbuementReady = affordable(spellSupplies[imbuementId]);
  const damage = hit => Math.max(1, Math.trunc(hit * (1 + mod('PercentDamageDealt')) * (1 - resistance) *
    (1 + enemyMod('PercentDamageTaken') + enemyMod('PercentDamageTakenFromAttacks')) - enemyStats('Armour')));
  const respawn = Math.max(0, 3000 * (1 + mod('PercentSpawnInterval')) + mod('FlatSpawnInterval'));
  const averageDamage = quick && maxHit != null
    ? damage((minHit + maxHit) / 2) * (1 - crit) + damage(Math.trunc((minHit + maxHit) / 2 * critMultiplier)) * crit : 0;
  const enemyCombatStyle = model.styles[enemyStance?.style];
  const enemyFormula = enemyCombatStyle?.MaxHitFormula?.Data;
  const enemyLevel = ratio(enemyFormula?.Levels, target?.levels ?? {});
  let enemyMaxHit;
  if (enemyCombatStyle?.MaxHitFormula?.Type === 'MelvorBase:StrengthBonus') {
    enemyMaxHit = Math.floor(22 + enemyLevel + (enemyLevel + 17) * enemyStats(baseCombatId(enemyFormula.StrengthBonusStat)) / 64);
  } else if (enemyCombatStyle?.MaxHitFormula?.Type === 'MelvorBase:DamageBonus') {
    enemyMaxHit = Math.floor(enemyStats(baseCombatId(enemyFormula.MaxHitStat)) *
      (1 + enemyStats(baseCombatId(enemyFormula.DamageBonusStat))) * (1 + (enemyLevel + 1) / 200));
  }
  if (Number.isFinite(enemyMaxHit)) enemyMaxHit = Math.max(1, Math.floor(enemyMaxHit * (1 + enemyMod('PercentMaxHit')) + enemyMod('FlatMaxHit')));
  const enemyMin = Math.min(enemyMaxHit ?? 1, Math.max(1, Math.floor(1 + enemyMod('FlatMinHit') + (enemyMaxHit ?? 1) * enemyMod('MinHitBasedOnMaxHit'))));
  const targetCombat = { min: enemyMin, max: enemyMaxHit ?? 1, hp: enemyHealth };
  const playerCombat = { min: minHit, max: maxHit, hp: maxHp, chance: hitChance, immunity: enemyImmunity, damageType };
  const playerPatterns = gear.flatMap(item => item.attacks ?? []);
  const playerAttack = playerPatterns.length && maxHit != null ? combatAttackAverage(playerPatterns, playerCombat, targetCombat,
    (value, critical) => critical ? damage(Math.trunc(value * (crit > 0 ? critMultiplier : 1))) :
      damage(value) * (1 - crit) + damage(Math.trunc(value * critMultiplier)) * crit) : null;
  const canAttack = target && maxHit != null && enemyHp > 0 && ammoReady && usable && (hitChance > 0 || playerAttack?.damage > 0);
  const normalHits = canAttack && hitChance > 0
    ? quick ? Math.max(1, enemyHp / averageDamage) : expectedCombatHits(enemyHp, minHit, maxHit, damage, crit, critMultiplier) : 0;
  const attackInterval = interval + (playerAttack?.delay ?? 0);
  const playerDamagePerTurn = playerAttack?.damage ?? 0;
  const encounterDamage = (playerAttack ? playerDamagePerTurn : (normalHits > 0 ? enemyHp * hitChance / normalHits : 0)) +
    attackInterval * ((forecast?.enemyDamagePerMs ?? 0) - (forecast?.enemyHealingPerMs ?? 0));
  const changesDamage = playerAttack || forecast?.enemyDamagePerMs || forecast?.enemyHealingPerMs;
  const attacksPerKill = canAttack && encounterDamage > 0
    ? changesDamage ? Math.max(1, enemyHp / encounterDamage) : normalHits / hitChance : null;
  const hits = attacksPerKill ? playerAttack ? attacksPerKill * playerAttack.hits : attacksPerKill * hitChance : 0;
  const prayerCost = (saved.prayers ?? []).filter(prayer => prayer.state === 1)
    .reduce((sum, prayer) => sum + (model.prayers[prayer.active]?.cost?.Quantity ?? 0), 0);
  const prayerXpPerKill = hits && prayerCost > 0
    ? playerAttack ? hits * Math.sqrt(3 + .2 * Math.min(enemyHealth, playerDamagePerTurn / Math.max(.001, playerAttack.hits)) * prayerCost) :
      quick ? Math.max(1, enemyHealth / averageDamage) * Math.sqrt(3 + .2 * Math.min(averageDamage, enemyHealth) * prayerCost) :
      expectedCombatHits(enemyHealth, minHit, maxHit, damage, crit, critMultiplier,
      healthDamage => Math.sqrt(3 + .2 * healthDamage * prayerCost)) : 0;
  let enemy;
  let enemyAttack;
  let enemyAttackInterval;
  if (enemyStance && attacksPerKill && enemyMaxHit > 0 && enemyStats('AttackInterval') > 0) {
    const enemyPower = Math.max(0, (((target.stats?.PowerRatings ?? []).find(row => baseCombatId(row.DamageType) === protectionType)?.Value ?? 0) +
      enemyMod('FlatPowerRating', protectionType)) * (1 + enemyMod('PercentPowerRating', protectionType)));
    const enemyInterval = Math.max(250, enemyStats('AttackInterval') * (1 + enemyMod('PercentAttackInterval')) + enemyMod('FlatAttackInterval')) /
      Math.max(.1, 1 - (forecast?.enemyStun ?? 0));
    const enemyAccuracy = Math.max(1, Math.floor((ratio(enemyCombatStyle.AccuracyRatingLevels, target.levels) + 9) *
      (enemyStats(enemyStance.accuracy) + 64) * (1 + enemyMod('PercentAccuracyRating'))));
    const defence = evasion[enemyStanceId];
    const immunity = mod('ImmunityFrom', protectionType) > 0 ? 1 : 0;
    const chance = combatProbability(enemyAccuracy >= defence ? 1 - defence / (2 * enemyAccuracy) : enemyAccuracy / (2 * defence)) *
      (1 - immunity) * (1 - combatProbability(mod('AvoidanceChance', protectionType)));
    const resist = Math.min(.7, protection / (enemyPower + protection || 1));
    const hitAfterDefence = hit => Math.max(1, Math.trunc(hit * (1 + mod('PercentDamageTaken') + mod('PercentDamageTakenFromAttacks')) *
      (1 - resist) - stat(style.ArmourStat)));
    Object.assign(targetCombat, { min: enemyMin, max: enemyMaxHit, chance, immunity, damageType: protectionType });
    const rolls = Math.min(enemyMaxHit, quick ? 8 : 4096);
    const meanHit = () => {
      let total = 0;
      for (let i = 1; i <= rolls; i++) {
        total += hitAfterDefence(enemyMin - 1 + Math.ceil(i * (enemyMaxHit - enemyMin + 1) / rolls));
      }
      return total / rolls;
    };
    const plain = meanHit(1) * chance;
    enemyAttack = target.damagePatterns?.length ? combatAttackAverage(target.damagePatterns, targetCombat, playerCombat, hitAfterDefence) : null;
    enemyAttackInterval = enemyInterval + (enemyAttack?.delay ?? 0);
    const turns = quick || changesDamage || enemyAttack ? Math.max(0, attacksPerKill * attackInterval / enemyAttackInterval - .5) :
      expectedEnemyTurns({ health: enemyHp, minHit, maxHit, hitChance, interval: attackInterval, enemyInterval, damage, crit, critMultiplier,
      attacksPerKill });
    const extraDamage = ((forecast?.playerDamagePerMs ?? 0) - (forecast?.playerHealingPerMs ?? 0)) *
      attacksPerKill * attackInterval + enemyHp * combatProbability(enemyMod('PercentAttackReflect'));
    const damagePerTurn = Math.max(0, (enemyAttack?.damage ?? plain) + (turns > 0 ? extraDamage / turns : 0));
    enemy = { turnsPerKill: turns, chance, maxHit: enemyAttack?.maxDamage ?? hitAfterDefence(enemyMaxHit), damagePerTurn,
      passiveDamagePerKill: turns > 0 ? 0 : Math.max(0, extraDamage),
      wardFraction: combatProbability(Math.max(0, enemyStats('MaximumWard')) / enemyHp) };
  }
  const sourcesWithEffects = combatEffects.flatMap(bundle => (bundle.modifiers.CombatEffect ?? []).map(row =>
    ({ row, magnitude: areaMagnitude(bundle) }))).concat(gear.flatMap(item => (item.effects ?? []).map(row => ({ row, magnitude: 1 }))));
  if (imbuementReady) {
    for (const row of spells[imbuementId]?.effects ?? []) sourcesWithEffects.push({ row, magnitude: 1 });
  }
  if (!forecast && target && model.effects && attacksPerKill && (sourcesWithEffects.length || playerAttack?.effects.length ||
      enemyAttack?.effects.length || enemyMod('EffectLifesteal'))) {
    const phase = estimateCombatEffects(model.effects, sourcesWithEffects, playerAttack, enemyAttack, playerCombat, targetCombat,
      attackInterval, enemyAttackInterval, attacksPerKill * attackInterval,
      (side, stat, id) => (effectMods.get([side, stat, id].join(':')) ?? 0) +
        (stat === 'EffectLifesteal' ? Math.max(0, side === 'Enemy' ? enemyMod(stat) : mod(stat)) : 0));
    return combatAttributes(model, character, target, area, spells, foodRules, { quick, forecast: phase });
  }
  return { levels, stats, evasion, stanceId, style: stance.style, element, damageType, protectionType, light, darkness, interval: attackInterval,
    combatLevel: Math.floor(ratio(style.CombatLevelRatios, levels)), maxHp, minHit, maxHit, accuracy, hitChance, power,
    currentHp: saved.hitpoints, protection, crit, critMultiplier, reflect: mod('PercentAttackReflect'), ammoReady, usable,
    attacksPerKill, hitsPerKill: hits, prayerXpPerKill, enemy, foodBonuses, lifesteal: Math.max(0, stat(style.LifestealStat)), enemyHp, respawn,
    ammoType: weapon.RequiredAmmoType, ammoPreservation, usesSpells: style.UsesSpells, spellSupplies, imbuementReady,
    effectsApplied: Boolean(combatEffects.length || playerAttack || enemyAttack || forecast),
    effectsPartial: Boolean(playerAttack?.partial || enemyAttack?.partial || forecast?.partial || hasConditionalEffect),
    immune: enemyImmunity === 1,
    perHour: attacksPerKill > 0 ? 3600000 / (respawn + attackInterval * attacksPerKill) : null };
}

function expectedEnemyTurns({ health, minHit, maxHit, hitChance, interval, enemyInterval, damage, crit, critMultiplier, attacksPerKill }) {
  if (interval <= 0 || enemyInterval <= 0) return 0;
  if (hitChance === 1 && minHit === maxHit && crit === 0) {
    return Math.max(0, Math.ceil(Math.ceil(health / damage(minHit)) * interval / enemyInterval) - 1);
  }
  if (attacksPerKill > 64) return Math.max(0, attacksPerKill * interval / enemyInterval - .5);
  let seed = 0x51dfa20b;
  const roll = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const trials = 384;
  let total = 0;
  for (let trial = 0; trial < trials; trial++) {
    let hp = health;
    let attacks = 0;
    while (hp > 0 && attacks < 512) {
      attacks++;
      if (roll() < hitChance) {
        const hit = minHit + Math.floor(roll() * (maxHit - minHit + 1));
        hp -= damage(crit > 0 && roll() < crit ? Math.trunc(hit * critMultiplier) : hit);
      }
    }
    // The killing blow ends the encounter before another enemy attack can land.
    total += Math.max(0, Math.ceil(attacks * interval / enemyInterval) - 1);
  }
  return total / trials;
}

function combatFoodProjection(rule, id, context) {
  const { attributes, character, killsPerHour, model } = context;
  if (!attributes?.enemy || !Number.isFinite(killsPerHour) || !(rule.healing > 0)) return null;
  const mods = new Map();
  function add(key, value) { mods.set(key, (mods.get(key) ?? 0) + value); }
  for (const [purchase, count] of Object.entries(character.purchases ?? {})) {
    for (const bonus of model.foodUpgrades[purchase] ?? []) add(bonus.StatGroup.replace(/^Global/, ''), bonus.Value * count);
  }
  for (const { row, count } of [...(attributes.foodBonuses ?? []), ...(rule.bonuses ?? []).map(row => ({ row, count: 1 }))]) {
    const food = baseCombatId(row.LocalContext?.Item);
    if (!row.Condition && !row.Scaling && !row.FromContext && (!food || food === id)) add(row.Stat.Name, row.Value * count);
  }
  const mod = key => mods.get(key) ?? 0;
  const efficiency = Math.max(.01, 1 + mod('FlatAutoEatEfficiency'));
  const healing = Math.max(1, Math.floor((rule.healing + mod('FlatHealing')) * (1 + mod('PercentHealing')) * efficiency));
  const threshold = Math.round(combatProbability(.25 + mod('FlatAutoEatThreshold')) * attributes.maxHp);
  const eatLimit = Math.round(combatProbability(1 + mod('FlatAutoEatLimit')) * attributes.maxHp);
  const batch = Math.max(1, Math.floor((eatLimit - threshold) / healing));
  const preserve = combatProbability(mod('FoodPreservationChance'));
  const initialHp = Math.max(1, Math.min(attributes.maxHp, attributes.currentHp ?? attributes.maxHp));
  const beforeFirstMeal = Math.max(0, initialHp - threshold);
  const healingPerKill = Math.min(attributes.enemyHp * attributes.lifesteal, attributes.maxHp) || 0;
  const effectiveKills = Math.min(killsPerHour, 3600000 / (attributes.interval * attributes.attacksPerKill));
  const damagePerHour = Math.max(0, (attributes.enemy.turnsPerKill * attributes.enemy.damagePerTurn +
    (attributes.enemy.passiveDamagePerKill ?? 0) - healingPerKill) * effectiveKills);
  const unitsPerMeal = batch * (1 - preserve);
  function neededAt(hours) {
    const loss = hours * damagePerHour;
    if (loss <= 0 || loss < beforeFirstMeal) return 0;
    return (1 + Math.floor((loss - beforeFirstMeal) / (batch * healing))) * unitsPerMeal;
  }
  function hoursAtStock(stock) {
    if (!(damagePerHour > 0)) return Infinity;
    if (!(stock > 0)) return beforeFirstMeal / damagePerHour;
    if (!(unitsPerMeal > 0)) return Infinity;
    const availableHealing = Math.max(0, stock) * healing / (1 - preserve);
    return (beforeFirstMeal + availableHealing) / damagePerHour;
  }
  function hitpointsAt(hours, stock) {
    const loss = hours * damagePerHour;
    if (loss <= 0 || loss < beforeFirstMeal || stock === 0) return Math.max(1, initialHp - loss);
    const meals = 1 + Math.floor((loss - beforeFirstMeal) / (batch * healing));
    const restored = preserve === 1 ? meals * batch * healing :
      Math.min(meals * batch, (stock ?? Infinity) / (1 - preserve)) * healing;
    return Math.max(1, Math.min(attributes.maxHp, initialHp - loss + restored));
  }
  return { preserve, threshold, neededAt, hoursAtStock, hitpointsAt };
}

function expectedCombatHits(health, minHit, maxHit, damage, crit, multiplier, reward = () => 1) {
  if (health * (maxHit - minHit + 1) > 1000000) {
    const mid = (minHit + maxHit) / 2;
    const average = damage(mid) * (1 - crit) + damage(Math.trunc(mid * multiplier)) * crit;
    return Math.max(1, health / average) * reward(Math.min(health, average));
  }
  const roll = 1 / (maxHit - minHit + 1);
  const distribution = new Map();
  function add(hit, weight) {
    distribution.set(hit, (distribution.get(hit) ?? 0) + weight);
  }
  for (let hit = minHit; hit <= maxHit; hit++) {
    add(damage(hit), (1 - crit) * roll);
    if (crit > 0) add(damage(Math.trunc(hit * multiplier)), crit * roll);
  }
  const expected = new Float64Array(health + 1);
  for (let hp = 1; hp <= health; hp++) {
    let hits = 0;
    for (const [damage, odds] of distribution) {
      hits += odds * (reward(Math.min(hp, damage)) + expected[Math.max(0, hp - damage)]);
    }
    expected[hp] = hits;
  }
  return expected[health];
}

function combatSupplyEstimate(rule, id, context) {
  const { attributes, character, killsPerHour, model, target, area } = context;
  if (!character?.combat || !attributes || !Number.isFinite(killsPerHour)) return null;
  const { combat } = character;
  const playerTurns = attributes.attacksPerKill == null ? null :
    Math.min(3600000 / attributes.interval, killsPerHour * attributes.attacksPerKill);
  const enemyTurns = attributes.enemy ? playerTurns / attributes.attacksPerKill * attributes.enemy.turnsPerKill : null;

  function eventRate(trigger) {
    const data = trigger?.Data;
    if (!data || data.Attack || data.TotalAttackCount || data.TotalHitCount || data.TotalMissCount) return null;
    let fraction = 1;
    const conditions = data.Conditions ?? [];
    const areaMatches = params => (!params.Area || area?.id === baseCombatId(params.Area)) &&
      (!params.Category || area?.category === baseCombatId(params.Category));
    for (let index = 0; index < conditions.length; index++) {
      const condition = conditions[index];
      if (condition.Data?.IsOr) return null;
      const params = condition.Data;
      switch (baseCombatId(condition.Type)) {
        case 'FightingSlayerTask':
          break;
        case 'PrayerActive':
          if (!combat.prayers?.some(row => row.state === 1 && (!params.Prayer || row.active === baseCombatId(params.Prayer)))) return 0;
          break;
        case 'CharacterUsingCombatStyle':
          if (attributes.style !== baseCombatId(params.Style)) return 0;
          break;
        case 'CombatInArea': {
          let matches = areaMatches(params);
          while (conditions[index + 1]?.Data?.IsOr) {
            const alternative = conditions[++index];
            if (baseCombatId(alternative.Type) !== 'CombatInArea') return null;
            matches ||= areaMatches(alternative.Data);
          }
          if (!matches) return 0;
          break;
        }
        case 'CharacterHasWard':
          if (!attributes.enemy || params.Component?.Component !== 'Enemy' || params.MinWard != null || params.MaxWard != null) return null;
          fraction *= attributes.enemy.wardFraction;
          break;
        default: return null;
      }
    }
    const type = baseCombatId(trigger.Type);
    const actor = data.Character?.Component ?? data.Component?.Component;
    const turns = actor === 'Player' ? playerTurns : actor === 'Enemy' ? enemyTurns : null;
    let rate;
    if (type === 'CharacterFightStarted') rate = killsPerHour;
    else if (type === 'EnemyKilled') rate = !data.Enemy || target?.id === baseCombatId(data.Enemy) ? killsPerHour : 0;
    else if (type === 'CharacterDefended' && actor === 'Player' && enemyTurns != null) {
      rate = enemyTurns * (data.WasHit == null ? 1 : data.WasHit ? attributes.enemy.chance : 1 - attributes.enemy.chance);
    }
    else if (type === 'FoodEaten' && !data.Item && data.IsAutoEat !== false && enemyTurns != null) {
      rate = combat.food ? enemyTurns * attributes.enemy.damagePerTurn / Math.max(1, attributes.maxHp * .75) : 0;
    }
    else if (['AttackTurn', 'CharacterTurnEnded', 'CharacterTurnStarted'].includes(type)) rate = turns;
    else if (type === 'CharacterAttacked' && data.WasHit == null) rate = turns;
    else if (type === 'CharacterAttacked' && actor === 'Player' && playerTurns != null) {
      rate = playerTurns * (data.WasHit ? attributes.hitChance : 1 - attributes.hitChance);
    } else if (type === 'CharacterAttacked' && actor === 'Enemy' && enemyTurns != null) {
      rate = enemyTurns * (data.WasHit ? attributes.enemy.chance : 1 - attributes.enemy.chance);
    }
    return rate == null ? null : rate * fraction * (data.Chance ?? 1);
  }

  if (rule.kind === 'food') {
    return combatFoodProjection(rule, id, context)?.neededAt(1) ?? null;
  }
  if (rule.kind === 'ammo') {
    if (rule.ammoType !== attributes.ammoType) return 0;
    return playerTurns == null ? null : playerTurns * (1 - attributes.ammoPreservation);
  }
  if (rule.kind === 'rune') {
    const expectedRunes = key => {
      const spell = attributes.spellSupplies[key];
      return spell ? spell.runes.filter(row => row.id === id)
        .reduce((sum, row) => sum + row.quantity * (1 - spell.preserve), 0) : 0;
    };
    const required = attributes.usesSpells ? expectedRunes(combat.spell) : 0;
    const optional = attributes.imbuementReady ? expectedRunes(combat.imbuement ?? combat.activeImbuement) : 0;
    if (!required && !optional) return 0;
    if (playerTurns == null) return null;
    if (!required) {
      const rate = optional * playerTurns;
      if (!(rate > 0)) return 0;
      return { optional: true, neededAt: hours => hours * rate, hoursAtStock: stock => stock / rate };
    }
    return (required + optional) * playerTurns;
  }
  if (rule.kind === 'prayer') {
    const active = (combat.prayers ?? []).filter(row => row.state === 1).map(row => model.prayers[row.active])
      .filter(prayer => baseCombatId(prayer?.cost?.Currency) === id);
    let quantity = 0;
    for (const prayer of active) {
      if (requiresSlayerTask(prayer.event)) return null;
      const rate = eventRate(prayer.event);
      if (rate == null) return null;
      quantity += rate * prayer.cost.Quantity;
    }
    return quantity;
  }
  if (rule.kind === 'charged') {
    let regular = 0;
    let onTask = 0;
    for (const event of rule.events) {
      const rate = eventRate(event);
      if (rate == null) return null;
      if (requiresSlayerTask(event)) onTask += rate;
      else regular += rate;
    }
    if (!onTask) return regular;
    if (!character.slayerTasks || !target) return null;
    const remaining = character.slayerTasks.reduce((maximum, task) =>
      task.monster === target.id ? Math.max(maximum, task.remaining) : maximum, 0);
    const taskHours = killsPerHour > 0 ? remaining / killsPerHour : 0;
    if (!taskHours) return regular;
    return {
      neededAt: hours => regular * hours + onTask * Math.min(hours, taskHours),
      hoursAtStock(stock) {
        const beforeCompletion = (regular + onTask) * taskHours;
        if (stock < beforeCompletion) return stock / (regular + onTask);
        return regular > 0 ? taskHours + (stock - beforeCompletion) / regular : Infinity;
      }
    };
  }
  return null;
}

function requiresSlayerTask(event) {
  return event?.Data?.Conditions?.some(condition => baseCombatId(condition.Type) === 'FightingSlayerTask');
}

if (typeof module !== 'undefined') module.exports = { combatAttributes, expectedCombatHits, combatSupplyEstimate, combatFoodProjection,
  expectedEnemyTurns, combatAttackAverage, estimateCombatEffects };
