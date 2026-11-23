function combatHealthLimit(attributes, rate, hitpoints = attributes?.currentHp) {
  if (!attributes?.enemy || !(rate > 0)) return null;
  const { enemy, maxHp, enemyHp, lifesteal } = attributes;
  const initial = Math.max(0, Math.min(maxHp, hitpoints ?? maxHp));
  const damage = Math.max(0, enemy.turnsPerKill * enemy.damagePerTurn + (enemy.passiveDamagePerKill ?? 0) -
    Math.min(maxHp, (enemyHp ?? 0) * (lifesteal ?? 0))) * rate;
  if (!Number.isFinite(damage)) return null;
  const budget = Math.max(0, initial - enemy.maxHit);
  if (!(damage > 0) && budget > 0) return null;
  return { hours: budget > 0 ? budget / damage : 0, remaining: hours => Math.max(0, initial - damage * hours) };
}

function estimateCombat(target, items, options) {
  const plannedHours = Math.min(options.hours, options.cap || Infinity);
  let activeHours = 0;
  let killProgress = 0;
  let limit;
  let unknown = false;
  let stage = options;
  let hitpoints = options.attributes?.currentHp;
  const phases = [];
  const expired = new Map();
  const remaining = new Map(options.supplies.map(supply => [supply.id, supply.available]));
  const used = new Map(options.supplies.map(supply => [supply.id, 0]));
  while (activeHours < plannedHours) {
    unknown ||= Boolean(stage.unknown);
    const left = plannedHours - activeHours;
    let duration = left;
    const bounds = [];
    const activeSupplies = stage.supplies.filter(supply => !expired.has(supply.id) &&
      (!supply.food || (remaining.get(supply.id) ?? supply.available ?? Infinity) > 0));
    const food = activeSupplies.filter(supply => supply.food);
    const health = food.length ? null :
      combatHealthLimit(stage.attributes, stage.killsPerHour, hitpoints);
    if (health) {
      duration = Math.min(duration, health.hours);
      bounds.push({ supply: { id: 'Hitpoints' }, hours: health.hours });
    }
    for (const supply of activeSupplies) {
      if (!remaining.has(supply.id)) remaining.set(supply.id, supply.available);
      const available = remaining.get(supply.id);
      if (available == null) continue;
      const hours = supply.projection ? supply.projection.hoursAtStock(available) :
        supply.perHour > 0 ? available / supply.perHour : Infinity;
      bounds.push({ supply, hours });
      duration = Math.min(duration, hours);
    }
    if (duration > 0) {
      phases.push({ hours: duration, killsPerHour: stage.killsPerHour, progress: killProgress,
        attributes: stage.attributes, character: stage.character, encounters: stage.encounters,
        lethalHit: lethalCombatHit(stage.attributes, food, hitpoints) });
    }
    activeHours += duration;
    killProgress += stage.killsPerHour * duration;
    for (const { id, perHour, projection } of activeSupplies) {
      const available = remaining.get(id);
      const quantity = Math.min(projection ? projection.neededAt(duration) : (perHour || 0) * duration, available ?? Infinity);
      used.set(id, (used.get(id) ?? 0) + quantity);
      if (available != null) remaining.set(id, Math.max(0, available - quantity));
      if (projection?.hitpointsAt) hitpoints = projection.hitpointsAt(duration, available);
    }
    if (health) hitpoints = health.remaining(duration);
    if (duration === left) break;
    const exhausted = bounds.filter(row => row.hours <= duration + 1e-10).map(row => row.supply);
    const required = exhausted.find(supply => !supply.optional);
    if (required) {
      limit = required.id;
      break;
    }
    for (const supply of exhausted) expired.set(supply.id, activeHours);
    const next = options.nextStage?.({ expired, remaining, hitpoints, kills: Math.floor(killProgress) });
    if (options.nextStage && !next) {
      limit = exhausted[0]?.id;
      break;
    }
    stage = next ?? stage;
  }
  const kills = Math.floor(killProgress);
  const direct = target.gold * kills;
  const drops = target.drops.map(({ id, perKill }) => {
    const quantity = options.collect ? perKill * kills : 0;
    const price = items[id]?.price ?? 0;
    const sold = options.collect && options.sell && !options.keep.has(id);
    return { id, quantity, price, sold, value: sold ? quantity * price : 0 };
  });
  const costs = [...used].map(([id, quantity]) => ({ id, quantity, value: quantity * (items[id]?.price ?? 0) }));
  const payout = direct + drops.reduce((sum, row) => sum + row.value, 0);
  const net = payout - costs.reduce((sum, row) => sum + row.value, 0);
  return { plannedHours, activeHours, limit, kills, killsPerHour: options.killsPerHour, phases, expired: [...expired], unknown,
    direct, drops, costs, payout, net, netPerHour: net / options.hours };
}

function lethalCombatHit(attributes, food, hitpoints) {
  const maxHit = attributes?.enemy?.maxHit;
  if (!(maxHit > 0)) return false;
  const hp = hitpoints ?? attributes.currentHp ?? attributes.maxHp;
  return maxHit >= hp || maxHit >= attributes.maxHp ||
    food.some(row => (row.threshold ?? row.projection?.threshold) < maxHit);
}

let combatView;

function combatSetup(character) {
  const { equipment, toolbelt, spell, imbuement, activeImbuement, stances, food, prayers } = character?.combat ?? {};
  if (!equipment || !toolbelt) return null;
  const levels = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer', 'Slayer']
    .map(id => character.levels?.[id] ?? 1);
  return JSON.stringify([equipment.map(row => [row.slot, row.id]), toolbelt.map(row => [row.slot, row.id]),
    spell, imbuement, activeImbuement, stances, food, prayers, levels,
    Object.entries(character.purchases ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(character.ranks ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    [...(character.astrologyNodes ?? [])].sort(), [...(character.unlockedPets ?? [])].sort()]);
}

function measuredCombatRate(before, after) {
  const first = before?.combat?.totals;
  const next = after?.combat?.totals;
  if (!first || !next || first.deaths !== next.deaths) return null;
  const setup = combatSetup(before);
  if (!setup || setup !== combatSetup(after)) return null;
  const encounter = before.combat.encounter;
  const nextEncounter = after.combat.encounter;
  if (!encounter?.area || !encounter.enemy || encounter.dungeon || nextEncounter?.dungeon ||
      encounter.area !== nextEncounter?.area || encounter.enemy !== nextEncounter?.enemy) return null;
  const milliseconds = next.milliseconds - first.milliseconds;
  if (milliseconds <= 0) return null;
  const changes = combatKillChanges(first, next);
  if (changes.length !== 1 || changes[0].kills < 1 || changes[0].id !== encounter.enemy) return null;
  const usage = first.usageTracked && next.usageTracked ? Object.fromEntries(
    Object.keys(next.supplies ?? {}).map(id => {
      const change = next.supplies[id] - (first.supplies?.[id] ?? 0);
      return [id, Math.max(0, change) * 3600000 / milliseconds];
    })
  ) : null;
  const food = after.combat.food;
  const portions = food && first.foodEaten && next.foodEaten
    ? (next.foodEaten[food] ?? 0) - (first.foodEaten[food] ?? 0) : null;
  const foodUsage = portions != null && portions >= 0 && milliseconds >= 120000 && changes[0].kills >= 5
    ? { id: food, perHour: portions * 3600000 / milliseconds } : null;
  return { ...changes[0], area: encounter.area, setup, milliseconds,
    perHour: changes[0].kills * 3600000 / milliseconds, usage, foodUsage };
}

function combatKillChanges(first, next) {
  const ids = new Set([...Object.keys(first.kills), ...Object.keys(next.kills)]);
  return [...ids].map(id => ({ id, kills: (next.kills[id] ?? 0) - (first.kills[id] ?? 0) }))
    .filter(row => row.kills !== 0);
}

function updateCombatSample(entry, snapshot) {
  if (!entry) return { snapshot, checkedAt: snapshot.date, rates: [] };
  if (Date.parse(snapshot.date) <= Date.parse(entry.checkedAt ?? entry.snapshot.date)) return entry;
  const first = entry.snapshot.combat.totals;
  const next = snapshot.combat.totals;
  const before = entry.snapshot.combat.encounter;
  const after = snapshot.combat.encounter;
  const rates = entry.rates ?? [];
  const changes = combatKillChanges(first, next);
  const reset = next.deaths !== first.deaths || next.milliseconds < first.milliseconds ||
    !after?.area || !after.enemy || after.dungeon || before?.dungeon ||
    before?.area !== after.area || before?.enemy !== after.enemy ||
    combatSetup(snapshot) !== combatSetup(entry.snapshot) ||
    changes.some(row => row.kills < 0 || row.id !== after.enemy);
  if (reset) return { snapshot, checkedAt: snapshot.date, rates };
  const result = measuredCombatRate(entry.snapshot, snapshot);
  if (!(result?.milliseconds >= 120000 && result.kills >= 5)) return { ...entry, checkedAt: snapshot.date, rates };
  const others = rates.filter(rate => rate.id !== result.id || rate.area !== result.area || rate.setup !== result.setup);
  return { snapshot, checkedAt: snapshot.date, rates: [result, ...others].slice(0, 12) };
}

function combatExperiencePlan(character, attributes, target, estimate, model, modifierFor) {
  const health = Math.max(0, (target.levels?.Hitpoints ?? 0) * 10);
  const stat = id => Math.max(0, target.stats?.Stats?.find(row => row.Stat === 'MelvorBase:' + id)?.Value ?? 0);
  const bonusDamage = 4 * stat('Armour') + 50 * stat('MaximumWard');
  const tasks = (character?.slayerTasks ?? []).filter(task => task.monster === target.id && task.remaining > 0);
  const phases = estimate.phases ?? [{ hours: estimate.activeHours, killsPerHour: estimate.killsPerHour, progress: 0 }];
  const rewards = phases.map(phase => {
    const actor = phase.character ?? character;
    const stats = phase.attributes ?? attributes;
    const stance = model.stances[stats?.stanceId];
    const perKill = {};
    const perFight = {};
    const adjusted = (skill, base, awards = 1) => {
      const mods = modifierFor(skill, actor, stats);
      return Math.max(0, (base + mods('FlatXPGained') * awards) * (1 + mods('PercentXPGained')));
    };
    for (const [skill, coefficient] of Object.entries(stance?.xpPerDamage ?? {})) {
      perFight[skill] = adjusted(skill, coefficient * health, health);
      perKill[skill] = adjusted(skill, coefficient * bonusDamage);
    }
    if (stats?.prayerXpPerKill > 0) {
      perFight.Prayer = adjusted('Prayer', stats.prayerXpPerKill, stats.hitsPerKill);
    }
    const slayerPerKill = adjusted('Slayer', health / 8 + 4);
    const rate = phase.killsPerHour;
    const cycle = rate > 0 ? 3600000 / rate : Infinity;
    const interval = stats?.interval ?? Infinity;
    const wait = Math.min(stats?.respawn ?? 0, Math.max(0, cycle - interval));
    const expectedTurns = Math.max(1, Math.ceil((cycle - wait) / interval));
    const fightInterval = (cycle - wait) / expectedTurns;
    const completeBefore = Math.floor(phase.progress);
    function damageProgress(cycles) {
      const kills = Math.floor(cycles);
      const elapsed = (cycles - kills) * cycle;
      const partial = Number.isFinite(fightInterval) && fightInterval > 0
        ? Math.floor(Math.max(0, elapsed - wait) / fightInterval) / expectedTurns : 0;
      return kills + partial;
    }
    const damageBefore = damageProgress(phase.progress);
    return {
      milliseconds: phase.hours * 3600000,
      cycle,
      slayerEnd: Math.max(0, ...tasks.map(task => task.remaining - phase.progress)) * cycle,
      xpPerCycle: skill => skill === 'Slayer' ? slayerPerKill : (perFight[skill] ?? 0) + (perKill[skill] ?? 0),
      hasXp: skill => skill === 'Slayer' ? tasks.length > 0 && slayerPerKill > 0 :
        (perFight[skill] ?? 0) + (perKill[skill] ?? 0) > 0,
      xpAt(skill, milliseconds) {
        const cycles = phase.progress + milliseconds * rate / 3600000;
        const kills = Math.floor(cycles);
        if (skill === 'Slayer') {
          return tasks.reduce((sum, task) => sum + Math.min(kills, task.remaining) -
            Math.min(completeBefore, task.remaining), 0) * slayerPerKill;
        }
        return (damageProgress(cycles) - damageBefore) * (perFight[skill] ?? 0) +
          (kills - completeBefore) * (perKill[skill] ?? 0);
      }
    };
  });
  function xpAt(skill, milliseconds) {
    let xp = 0;
    for (const phase of rewards) {
      if (milliseconds <= 0) break;
      xp += phase.xpAt(skill, Math.min(phase.milliseconds, milliseconds));
      milliseconds -= phase.milliseconds;
    }
    return xp;
  }
  const end = estimate.activeHours * 3600000;
  function firstReach(totalAt, remaining, end) {
    if (!(end >= 0) || !Number.isFinite(end) || !(totalAt(end) >= remaining)) return null;
    let low = 0;
    let high = Math.floor(end);
    if (totalAt(high) < remaining) return end;
    while (low < high) {
      const middle = Math.floor((high + low) / 2);
      if (totalAt(middle) >= remaining) high = middle;
      else low = middle + 1;
    }
    return high;
  }
  function timeForGoal(skill, remaining) {
    if (remaining <= 0) return 0;
    const reached = firstReach(time => xpAt(skill, time), remaining, end);
    return reached == null ? null : reached / 3600000;
  }
  return {
    tasks,
    at: (skill, hours) => xpAt(skill, hours * 3600000),
    total: skill => xpAt(skill, end),
    completedFights(skill, count) {
      const reward = rewards[0];
      if (!reward) return 0;
      const kills = skill === 'Slayer' ? tasks.reduce((sum, task) => sum + Math.min(count, task.remaining), 0) : count;
      return kills * reward.xpPerCycle(skill);
    },
    hasXp: skill => rewards.some(phase => phase.hasXp(skill)),
    timeForGoal,
    projectedTimeForGoal(skill, remaining) {
      const exact = timeForGoal(skill, remaining);
      if (exact != null) return exact;
      // Extend the latest XP-producing phase while assuming its supplies can be replenished.
      const index = rewards.findLastIndex(phase => Number.isFinite(phase.cycle) && phase.hasXp(skill));
      if (index < 0) return null;
      const phase = rewards[index];
      const before = rewards.slice(0, index).reduce((elapsed, entry) => elapsed + entry.milliseconds, 0);
      const needed = remaining - xpAt(skill, before);
      const end = skill === 'Slayer' ? phase.slayerEnd + 1 : (needed / phase.xpPerCycle(skill) + 2) * phase.cycle;
      const reached = firstReach(time => phase.xpAt(skill, time), needed, end);
      return reached == null ? null : (before + reached) / 3600000;
    }
  };
}

function forecastCombatExperience(target, items, options, goals, modifiers) {
  // Start with a finite projection, then extend it only as far as the selected goals need.
  let hours = 24;
  while (true) {
    const estimate = estimateCombat(target, items, { ...options, hours, cap: 0 });
    const plan = combatExperiencePlan(options.character, options.attributes, target, estimate, options.model, modifiers);
    if (estimate.limit) return { estimate, plan };
    const next = Math.max(hours, ...[...goals].map(([skill, remaining]) => plan.projectedTimeForGoal(skill, remaining) ?? 0));
    if (next <= hours) return { estimate, plan };
    hours = next + 1 / 3600000;
  }
}

function combatXpModifiers(model, catalogue) {
  const bonuses = new Map();
  return (skill, actor, stats) => {
    if (!bonuses.has(actor)) {
      const gear = [...(actor?.combat?.equipment ?? []), ...(actor?.combat?.toolbelt ?? [])].map(row => row.id);
      const extras = gear.flatMap(id => model.items[id]?.xpModifiers ?? []);
      extras.push(...(model.stances[stats?.stanceId]?.xpModifiers ?? []));
      for (const prayer of actor?.combat?.prayers ?? []) {
        if (prayer.state === 1) extras.push(...(model.prayers[prayer.active]?.xpModifiers ?? []));
      }
      for (const set of model.sets) {
        const count = set.items.filter(id => gear.includes(id)).length;
        for (const bonus of set.bonuses) if (count >= bonus.count) extras.push(...(bonus.xpModifiers ?? []));
      }
      bonuses.set(actor, extras);
    }
    return actionModifiers({ skill }, actor ?? {}, catalogue, bonuses.get(actor));
  };
}

function renderCombatExperience(attributes, target, options) {
  combatView.xpEncounter = { attributes, target, options };
  updateCombatTraining();
}

function renderCombatLevelGains(character, status, xpForSkill) {
  byId('combatLevelsStatus').textContent = status;
  const available = Boolean(xpForSkill && character?.characterId);
  byId('combatLevelsTable').hidden = !available;
  if (!available) {
    byId('combatLevelsRows').replaceChildren();
    return;
  }
  byId('combatLevelsRows').replaceChildren(...COMBAT_XP_SKILLS.map(skill => {
    const row = create('tr');
    const level = character.levels[skill];
    const state = xpGoalProgress(level, character.skillXp?.[skill], Math.min(XP_LEVEL_CAP, level + 1));
    const gained = Math.max(0, xpForSkill(skill));
    const xp = state ? state.xp + gained : null;
    const projected = xp == null ? null : levelFor(xp);
    const remaining = projected == null || projected >= XP_LEVEL_CAP ? null : Math.ceil(xpThresholds[projected + 1] - xp);
    const levelChange = projected != null && projected > level ? level + ' → ' + projected : level ?? '—';
    row.append(create('td', skillName(skill, catalog.xpSkills)), create('td', levelChange),
      create('td', fullNumber(gained)),
      create('td', remaining == null ? '—' : fullNumber(remaining)));
    return row;
  }));
}

function renderCombatXpOverview(character, selected, owned, craft, prepared) {
  const { attributes, target, options } = combatView.xpEncounter ?? {};
  const goals = new Map(COMBAT_XP_SKILLS.map(skill => {
    const goal = selectedExperienceGoal(character, skill);
    return [skill, xpGoalProgress(character?.levels?.[skill], character?.skillXp?.[skill], goal.level, null, goal.startingXp)];
  }));
  const { plan, estimate } = options
    ? forecastCombatExperience(target, combatView.items, options,
      new Map([...goals].map(([skill, goal]) => [skill, goal?.remaining ?? 0])), combatXpModifiers(combatView.model, catalog)) : {};
  byId('combatXpStatus').textContent = t(!character?.characterId ? '读取角色存档后可按战斗配装估算经验。' :
    '选择战斗技能，在下方比较到目标等级的时间。');
  const grid = byId('combatXpRows');
  const focused = grid.contains(document.activeElement) ? document.activeElement.dataset.skill : null;
  const encounterName = target ? gameName(target) : '';
  const current = new Map(COMBAT_XP_SKILLS.map(skill => {
    if (!plan || (!attributes && skill !== 'Slayer')) return [skill, null];
    const remaining = goals.get(skill)?.remaining ?? 0;
    const goalHours = plan.hasXp(skill) ? plan.timeForGoal(skill, remaining) : null;
    const xp = goalHours == null ? plan.total(skill) : Math.max(remaining, plan.at(skill, goalHours));
    const hours = goalHours ?? estimate.activeHours;
    const explanation = skill === 'Slayer' && plan.tasks.length
      ? t('当前任务剩余 {count} 次', { count: fullNumber(plan.tasks.reduce((sum, task) => sum + task.remaining, 0)) })
      : xp === 0 && remaining > 0 && estimate.kills > 0
        ? t(skill === 'Slayer' ? '当前目标无匹配的屠杀任务' : skill === 'Prayer'
          ? '暂无可计入的祝祭经验' : '当前姿态不提供此项经验') : '';
    return [skill, {
      xp, goalHours, projectedHours: plan.projectedTimeForGoal(skill, remaining),
      perHour: hours ? xp / hours : null, estimate, explanation
    }];
  }));
  const alternatives = combatCardPlans(character, selected, goals);
  const ranked = [
    ['owned', '已拥有装备推荐', owned],
    ['craft', '可制造装备推荐', craft],
    ['prepared', '备齐符文后的推荐', prepared],
    ['current', '当前战斗', current.get(selected)]
  ].filter(([, , result]) => result).sort((a, b) => compareCombatTraining(a[2], b[2]));
  const actionName = result => result.enemy ? gameName(result.enemy.target) + ' · ' + gameName(result.enemy.area) : encounterName;
  const choices = experienceActionChoices(character);
  const saved = choices[selected] ?? '';
  const best = ranked.find(([, , result]) => result.xp > 0);
  const picked = ranked.find(([id]) => id === saved) ?? best ?? ranked[0];
  const input = byId('combatXpAction');
  const automatic = goals.get(selected)?.remaining === 0 ? t('已达到目标') : best
    ? t(best[2].goalHours == null ? '当前库存经验最多 · {action}' : '最快升级 · {action}', { action: actionName(best[2]) })
    : t('暂无可用行动');
  const optionsList = [new Option(automatic, ''), ...ranked.map(([id, label, result]) =>
    new Option(t(label) + ' · ' + actionName(result), id))];
  if (saved && !ranked.some(([id]) => id === saved)) {
    const label = { owned: '已拥有装备推荐', craft: '可制造装备推荐', current: '当前战斗', prepared: '备齐符文后的推荐' }[saved];
    if (label) {
      const unavailable = new Option(t('{action}（暂不可用）', { action: t(label) }), saved);
      unavailable.disabled = true;
      optionsList.push(unavailable);
    }
  }
  if (input.options.length !== optionsList.length || optionsList.some((option, index) => {
    const previous = input.options[index];
    return previous.value !== option.value || previous.text !== option.text || previous.disabled !== option.disabled;
  })) input.replaceChildren(...optionsList);
  input.value = optionsList.some(option => option.value === saved) ? saved : '';
  input.disabled = !ranked.length;

  grid.replaceChildren(...COMBAT_XP_SKILLS.map(skill => {
    const estimate = current.get(skill);
    const alternative = alternatives.get(skill);
    const row = skill === selected ? picked?.[2] :
      alternative && (!estimate || compareCombatTraining(alternative, estimate) < 0) ? alternative : estimate;
    const waiting = row?.goalHours == null && goals.get(skill)?.remaining > 0 && character?.characterId &&
      character.combat?.equipment && (skill === selected ? combatTraining.pending && saved !== 'current' : !alternatives.has(skill));
    const summary = goals.get(skill)?.remaining === 0 ? t('已达到目标') : row?.goalHours != null
      ? t(row.missingRunes?.length ? '备齐符文后约 {time}' : '到目标约 {time}', { time: formatXpDuration(row.goalHours) })
      : waiting ? t('正在估算…')
        : row?.projectedHours != null ? t('补足补给后约 {time}', { time: formatXpDuration(row.projectedHours) })
          : row?.xp > 0 ? t('库存可获 {xp} XP', { xp: fullNumber(row.xp) })
            : row?.explanation || t('暂无升级时间');
    return experienceCard(grid, skill, selected, skillName(skill, catalog.xpSkills), character?.levels?.[skill],
      row && (row.xp > 0 || row.projectedHours > 0) ? actionName(row) : t('暂无可用行动'), summary, id => {
        byId('combatTrainingSkill').value = id;
        updateCombatTraining();
      });
  }));
  if (focused === selected) grid.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });

  byId('combatXpDetailHeading').textContent = t('{skill}练级方案', { skill: skillName(selected, catalog.xpSkills) });
  const level = selectedExperienceGoal(character, selected).level;
  const field = byId('combatGoalLevel');
  if (document.activeElement !== field || field.dataset.skill !== selected ||
      field.dataset.character !== (character?.characterId ?? '')) field.value = level;
  field.dataset.skill = selected;
  field.dataset.character = character?.characterId ?? '';
  renderXpGoalSlider(byId('combatGoalSlider'), level);

  const limit = result => result.estimate.limit === 'Hitpoints' ? t('生命值不足以继续战斗') :
    result.estimate.limit ? t('限制：{conditions}', { conditions: combatSupplyName(result.estimate.limit) }) : '';
  const timing = result => {
    if (!result) return t('暂无升级时间');
    if (result.goalHours != null) return result.missingRunes?.length
      ? t('备齐符文后约 {time}', { time: formatXpDuration(result.goalHours) }) : formatXpDuration(result.goalHours);
    if (result.projectedHours != null) return formatXpDuration(result.projectedHours);
    if (selected === 'Slayer' && result.xp > 0 && !result.estimate.limit) return t('当前任务结束前无法升级');
    return t(result.estimate.limit ? '本次补给或材料不足以升级' : '暂无升级时间');
  };
  const goal = goals.get(selected);
  const overview = byId('combatGoalOverview');
  if (!goal) overview.textContent = t('暂无等级进度');
  else {
    const row = picked?.[2];
    const notes = [
      goal.remaining > 0 && row && t('按「{action}」的经验收益估算', { action: actionName(row) }),
      saved && picked?.[0] !== saved && row && t('所选行动暂不可用，当前按推荐行动估算'),
      row && limit(row),
      row?.missingRunes?.length && t('先制作所需装备并补齐符文。预计用时只计算战斗。'),
      row?.goalHours == null && row?.projectedHours != null && t('额外用时按持续战斗、补给充足估算。'),
      !goal.exact && t('按所设等级的起始经验计算')
    ].filter(Boolean);
    renderExperienceGoalSummary(overview, goal, [
      ['等级', t('{current} → {target}', { current: goal.level, target: goal.target })],
      ['剩余 XP', fullNumber(Math.ceil(goal.remaining))],
      ['预计剩余时间', goal.remaining === 0 ? t('已达到目标') : timing(row)]
    ], notes);
  }
  byId('combatXpTable').hidden = !ranked.length;
  byId('combatXpPlans').replaceChildren(...ranked.map(entry => {
    const [, label, result] = entry;
    const row = create('tr');
    row.classList.toggle('xp-estimate-action', entry === picked);
    const action = create('td', actionName(result));
    action.append(create('small', t(label), 'muted'));
    const restriction = [result.explanation, limit(result),
      result.goalHours == null && result.projectedHours != null && t('额外用时按持续战斗、补给充足估算。')].filter(Boolean);
    row.append(action, create('td', fullNumber(result.xp), 'number'),
      create('td', result.perHour == null ? '—' : fullNumber(result.perHour), 'number'),
      create('td', timing(result)), create('td', restriction.join(' · ') || '—', 'muted'));
    return row;
  }));
}

function initCombat(catalog) {
  const targets = catalog.combatTargets ?? [];
  const model = catalog.combatModel;
  const prayerCosts = Object.values(model.prayers).map(row => baseCombatId(row.cost?.Currency)).filter(Boolean);
  const currencyRules = Object.fromEntries(prayerCosts.map(id => [id, { kind: 'prayer' }]));
  const currencies = Object.fromEntries(prayerCosts.map(id => [id, { name: id, price: id === 'GoldPieces' ? 1 : 0 }]));
  const dungeons = catalog.combatDungeons ?? [];
  combatView = { targets, dungeons, items: { ...currencies, ...catalog.items }, slots: catalog.combatSlots, spells: catalog.combatSpells,
    model, supplyRules: { ...catalog.combatSupplies, ...currencyRules }, suppressed: new Set(),
    kept: new Set(), supplies: [], samples: new Map(), character: null };
  initCombatTraining();
  const target = byId('combatTarget');
  target.replaceChildren(...targets.map(enemy => new Option('', enemy.id)), ...dungeons.map(dungeon => new Option('', dungeon.id)));
  byId('combatOptions').hidden = !targets.length;
  byId('combatUnavailable').hidden = !!targets.length;
  const form = byId('combatOptions');
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', renderCombat);
  form.addEventListener('change', renderCombat);
  byId('combatAddSupply').addEventListener('click', () => openCombatSupplyPicker(null));
  byId('combatPickerClose').addEventListener('click', () => byId('combatSupplyPicker').close());
  byId('combatPickerSearch').addEventListener('input', renderCombatSupplyChoices);
  byId('combatResetGoals').addEventListener('click', () => {
    resetExperienceGoals(COMBAT_XP_SKILLS, combatView.character);
    updateCombatTraining();
  });
  byId('combatRestoreSupplies').addEventListener('click', () => {
    combatView.suppressed.clear();
    const equipped = equippedSupplyIds();
    combatView.supplies = combatView.supplies.filter(row => {
      const role = exclusiveSupplyRole(row.item.value);
      if (!role || equipped.has(row.item.value) || ![...equipped].some(id => exclusiveSupplyRole(id) === role)) return true;
      row.row.remove();
      return false;
    });
    syncCombatSupplies();
    renderCombat();
    queuePreferences();
  });
}

function localizeCombat() {
  if (!combatView) return;
  const targets = new Map([...combatView.targets, ...combatView.dungeons].map(enemy => [enemy.id, enemy]));
  for (const option of byId('combatTarget').options) {
    const name = gameName(targets.get(option.value));
    option.text = option.value.startsWith('Dungeon:') ? t('副本 · {name}', { name }) : name;
  }
  for (const supply of combatView.supplies) localizeCombatSupply(supply);
  renderCombatSupplyChoices();
  renderCombat();
}

function updateCombat(character) {
  if (!combatView) return;
  const equipment = character?.combat?.equipment;
  if (equipment?.some(row => !isCombatEquipment(row))) {
    character = { ...character, combat: { ...character.combat, equipment: equipment.filter(isCombatEquipment) } };
  }
  if (character?.characterId && character.date && character.combat?.totals) {
    const entry = combatView.samples.get(character.characterId);
    const { date, combat, levels, purchases, astrologyNodes, unlockedPets, ranks } = character;
    const snapshot = { date, combat, levels, purchases, astrologyNodes, unlockedPets, ranks };
    combatView.samples.set(character.characterId, updateCombatSample(entry, snapshot));
  }
  combatView.character = character;
  syncCombatSupplies();
  renderCombat();
}

function renderCombatLoadout(attributes) {
  const { character, items, slots, spells, model } = combatView;
  const state = character?.combat;
  const rows = [];
  for (const [equipment, entries] of [[true, state?.equipment], [false, state?.toolbelt]]) {
    for (const entry of entries ?? []) {
      const slot = gameName(slots?.[entry.slot]) ?? t('未知名称');
      const item = gameName(items[entry.id]) ?? t('未知物品');
      const quantity = entry.quantity > 1 || (equipment && entry.slot === 'Ammo') ? ' × ' + fullNumber(entry.quantity) : '';
      rows.push(slot + ' · ' + item + quantity);
    }
    if (equipment) {
      for (const [id, item] of combatOccupiedSlots(model, entries)) {
        const slot = gameName(slots?.[id]) ?? t('未知名称');
        rows.push(slot + ' · ' + t('由{item}占用', { item: gameName(items[item]) ?? t('未知物品') }));
      }
    }
  }
  for (const [title, id] of [['所选法术', state?.spell], ['所选附魔', state?.imbuement], ['已激活附魔', state?.activeImbuement]]) {
    if (!id) continue;
    const spell = spells?.[id];
    const runes = (attributes?.spellSupplies[id]?.runes ?? spell?.runes ?? []).map(({ id, quantity }) => t('{item} × {quantity}（仓库 {stock}）', {
      item: gameName(items[id]) ?? t('未知物品'), quantity: fullNumber(quantity), stock: fullNumber(character.stock[id] ?? 0)
    }));
    rows.push([t(title), gameName(spell) ?? t('未知名称'), ...runes].join(' · '));
  }
  if (state) {
    if (!state.equipment?.some(row => row.slot === 'Weapon')) {
      rows.push((gameName(slots?.Weapon) ?? t('武器')) + ' · ' + (gameName(items.DefaultWeapon) ?? t('未知物品')));
    }
    const selectedFood = state.food ? t('{item} × {quantity}', {
      item: gameName(items[state.food]) ?? t('未知物品'), quantity: fullNumber(character.stock[state.food] ?? 0)
    }) : t('未选择');
    rows.push(t('食物') + ' · ' + selectedFood);
    if (attributes) rows.push(t('攻击姿态') + ' · ' + (gameName(model.stances[attributes.stanceId]) ?? t('未知名称')));
    for (const prayer of state.prayers ?? []) {
      const id = prayer.active ?? prayer.selected;
      const label = gameName(model.prayers[id]) ?? t('未知名称');
      const currency = model.prayers[id]?.cost?.Currency?.replace(/^MelvorBase:/, '');
      const status = t(prayer.state === 1 ? '已启用' : prayer.state === 2 ? '待生效' : '已选择');
      rows.push([t('祝祭'), label, status, currency && t('{item} × {quantity}', {
        item: shopCurrencyName(currency), quantity: fullNumber(character.currencies?.[currency] ?? 0)
      })].filter(Boolean).join(' · '));
    }
    if (!state.prayers?.length) rows.push(t('祝祭') + ' · ' + t('未选择'));
    if (!state.toolbelt?.length) rows.push(t('战斗工具栏') + ' · ' + t('空'));
    if (!state.spell) rows.push(t('所选法术') + ' · ' + t('未选择'));
    if (![state.spell, state.activeImbuement, state.imbuement].some(id => spells?.[id]?.runes.length)) {
      rows.push(t('符文需求') + ' · ' + t('无'));
    }
  }
  byId('combatLoadout').hidden = !rows.length;
  byId('combatLoadoutRows').replaceChildren(...rows.map(row => create('li', row)));
}

function renderCombatAttributes(attributes) {
  byId('combatAttributes').hidden = !attributes;
  if (!attributes) return;
  const model = combatView.model;
  const label = (group, id) => gameName(model[group][id]) ?? t('未知名称');
  const number = value => value == null ? '—' : decimals.format(value);
  const percent = value => value == null ? '—' : number(value * 100) + '%';
  const damageType = label('names', attributes.damageType);
  const gear = Object.entries(attributes.stats).filter(([id, value]) => id !== 'AttackInterval' &&
    (value !== 0 || /AttackBonus|DefenceBonus|StrengthBonus|MagicDamageBonus/.test(id))).map(([id, value]) =>
      [label('attributes', id), model.attributes[id].percent ? percent(value) : number(value)]
    );
  const groups = [
    ['战斗等级', Object.entries(attributes.levels).map(([id, value]) => [skillName(id, catalog.xpSkills), number(value)])],
    ['进攻属性', [
      [t('战斗等级'), number(attributes.combatLevel)], [t('战斗风格'), label('styles', attributes.style)],
      [t('攻击姿态'), label('stances', attributes.stanceId)], [t('元素'), label('names', attributes.element)],
      [t('生命值'), number(attributes.currentHp) + ' / ' + number(attributes.maxHp)],
      [t('最小伤害'), number(attributes.minHit)], [t('最大伤害'), number(attributes.maxHit)],
      [t('精准值'), number(attributes.accuracy)], [t('命中几率'), percent(attributes.hitChance)],
      [t('战力（{type}）', { type: damageType }), number(attributes.power)]
    ]],
    ['躲避值', [...Object.entries(attributes.evasion).map(([id, value]) => [label('stances', id), number(value)]),
      [t('防护（{type}）', { type: label('names', attributes.protectionType) }), number(attributes.protection)]]],
    ['装备属性', [[t('回合间隔'), t('{value} 秒', { value: number(attributes.interval / 1000) })], ...gear]],
    ['其他属性', [
      [t('暴击几率'), percent(attributes.crit)], [t('暴击倍率'), percent(attributes.critMultiplier)],
      [t('攻击反射'), percent(attributes.reflect)], [t('光明／黑暗'), number(attributes.light) + ' / ' + number(attributes.darkness)]
    ]]
  ];
  byId('combatAttributeGroups').replaceChildren(...groups.map(([title, values]) => {
    const group = create('section');
    const list = create('dl');
    for (const [key, value] of values) list.append(create('dt', key), create('dd', value));
    group.append(create('h3', t(title)), list);
    return group;
  }));
}

function addCombatSupply(saved) {
  const row = create('tr');
  const item = create('button', undefined, 'supply-select');
  item.type = 'button';
  const use = create('input');
  use.type = 'number';
  use.min = '0';
  use.max = '1000000';
  use.step = 'any';
  const stock = create('input');
  stock.type = 'number';
  stock.min = '0';
  stock.max = '9007199254740991';
  stock.step = '1';
  const remove = create('button');
  remove.type = 'button';
  const rate = create('small');
  const supply = { row, item, use, stock, remove, rate, automatic: saved?.automatic === true };
  item.value = combatSupplyId(saved?.item ?? '') ?? '';
  use.value = saved?.use ?? '';
  stock.value = saved?.stock ?? '';
  combatView.supplies.push(supply);
  localizeCombatSupply(supply);
  for (const field of [item, use, stock, remove]) {
    const cell = create('td');
    cell.append(field);
    if (field === use) {
      cell.classList.add('supply-rate');
      cell.append(rate);
    }
    row.append(cell);
  }
  item.addEventListener('click', () => openCombatSupplyPicker(supply));
  remove.addEventListener('click', () => {
    if (supply.automatic) combatView.suppressed.add(item.value);
    combatView.supplies = combatView.supplies.filter(entry => entry !== supply);
    row.remove();
    renderCombat();
    queuePreferences();
    byId('combatAddSupply').focus();
  });
  byId('combatSupplies').append(row);
  return supply;
}

function localizeCombatSupply({ item, use, stock, remove }) {
  item.textContent = item.value ? combatSupplyName(item.value) : t('选择战斗补给');
  use.setAttribute('aria-label', t('每小时消耗量'));
  stock.setAttribute('aria-label', t('可用库存'));
  remove.textContent = t('移除');
}

function combatSupplyId(text) {
  if (Object.hasOwn(combatView.supplyRules, text)) return text;
  const id = findItem(text);
  return Object.hasOwn(combatView.supplyRules, id) ? id : undefined;
}

function combatSupplyName(id) {
  return combatView.supplyRules[id]?.kind === 'prayer' ? shopCurrencyName(id) : gameName(combatView.items[id]) ?? t('未知物品');
}

function exclusiveSupplyRole(id) {
  const kind = combatView.supplyRules[id]?.kind;
  return kind === 'food' || kind === 'ammo' ? kind : null;
}

function equippedSupplyIds() {
  const { character, model, spells, supplyRules } = combatView;
  const state = character?.combat;
  if (!state) return new Set();
  const equipment = state.equipment ?? [];
  const weapon = model.items[equipment.find(row => row.slot === 'Weapon')?.id ?? 'DefaultWeapon']?.weapon;
  const weaponType = baseCombatId(weapon?.Type);
  const stance = state.stances?.[weaponType] ?? model.weaponTypes[weaponType]?.stances[0];
  const magic = model.styles[model.stances[stance]?.style]?.UsesSpells;
  const desired = [state.food, ...equipment.filter(row => {
    const rule = supplyRules[row.id];
    return rule?.kind === 'charged' || (rule?.kind === 'ammo' && rule.ammoType === weapon?.RequiredAmmoType);
  }).map(row => row.id), ...(state.toolbelt ?? []).map(row => row.id)];
  for (const id of [magic ? state.spell : null, state.imbuement ?? state.activeImbuement]) {
    desired.push(...(spells[id]?.runes ?? []).map(row => row.id));
  }
  for (const prayer of state.prayers ?? []) {
    if (prayer.state === 1) desired.push(baseCombatId(model.prayers[prayer.active]?.cost?.Currency));
  }
  return new Set(desired.filter(id => Object.hasOwn(supplyRules, id)));
}

function syncCombatSupplies() {
  const wanted = equippedSupplyIds();
  combatView.supplies = combatView.supplies.filter(supply => {
    if (!supply.automatic || wanted.has(supply.item.value)) return true;
    if (supply.use.value || supply.stock.value) {
      supply.automatic = false;
      return true;
    }
    supply.row.remove();
    return false;
  });
  for (const id of wanted) {
    const role = exclusiveSupplyRole(id);
    if (!combatView.suppressed.has(id) && !combatView.supplies.some(row =>
      row.item.value === id || (role && exclusiveSupplyRole(row.item.value) === role))) {
      addCombatSupply({ item: id, automatic: true });
    }
  }
}

function openCombatSupplyPicker(row) {
  combatView.pickerRow = row;
  byId('combatPickerSearch').value = '';
  renderCombatSupplyChoices();
  byId('combatSupplyPicker').showModal();
  byId('combatPickerSearch').focus();
}

function renderCombatSupplyChoices() {
  const { items, supplyRules, pickerRow, supplies } = combatView;
  const search = byId('combatPickerSearch').value.trim().toLocaleLowerCase();
  const useful = equippedSupplyIds();
  const ids = Object.keys(supplyRules).filter(id =>
    !supplies.some(row => row !== pickerRow && row.item.value === id) &&
    [id, combatSupplyName(id), ...Object.values(items[id]?.names ?? {})].some(name => name?.toLocaleLowerCase().includes(search))
  ).sort((a, b) => Number(useful.has(b)) - Number(useful.has(a)) || combatSupplyName(a).localeCompare(combatSupplyName(b), uiLocale()));
  byId('combatPickerResults').replaceChildren(...ids.map(id => {
    const button = create('button', combatSupplyName(id));
    button.type = 'button';
    button.setAttribute('aria-pressed', String(pickerRow?.item.value === id));
    button.addEventListener('click', () => {
      const role = exclusiveSupplyRole(id);
      const sameRole = role && supplies.find(row => exclusiveSupplyRole(row.item.value) === role);
      const row = pickerRow ?? sameRole ?? addCombatSupply({ item: id });
      if (sameRole && row !== sameRole) {
        if (sameRole.automatic) combatView.suppressed.add(sameRole.item.value);
        combatView.supplies = supplies.filter(entry => entry !== sameRole);
        sameRole.row.remove();
      }
      if (row.item.value !== id) {
        if (row.automatic) combatView.suppressed.add(row.item.value);
        row.automatic = false;
        row.item.value = id;
        row.use.value = row.stock.value = '';
        localizeCombatSupply(row);
      }
      byId('combatSupplyPicker').close();
      row.item.focus();
      renderCombat();
      queuePreferences();
    });
    return button;
  }));
  if (!ids.length) byId('combatPickerResults').append(create('p', t('没有匹配的战斗补给。'), 'muted'));
}

function combatSupplies(context, observed, expired = null) {
  const { supplies, supplyRules } = combatView;
  const { character } = context;
  const entries = [];
  let unknown = false;
  const actual = equippedSupplyIds();
  for (const { item, use, stock, rate } of supplies) {
    const id = item.value;
    if (!Object.hasOwn(supplyRules, id) || expired?.has(id)) continue;
    const rule = supplyRules[id];
    const equipped = [...(character?.combat?.equipment ?? []), ...(character?.combat?.toolbelt ?? [])]
      .filter(row => row.id === id).reduce((total, row) => total + Math.max(0, row.quantity), 0);
    const counts = rule.kind === 'prayer' ? character?.currencies : character?.stock;
    const knownStock = actual.has(id) && ['ammo', 'charged'].includes(rule.kind) ? equipped :
      character?.date || Object.hasOwn(counts ?? {}, id) ? (counts?.[id] ?? 0) + equipped : null;
    if (!expired) stock.placeholder = knownStock ?? '';
    const foodPlan = rule.kind === 'food' ? combatFoodProjection(rule, id, context) : null;
    const measured = actual.has(id) && !use.value
      ? (observed?.foodUsage?.id === id ? observed.foodUsage.perHour * (1 - (foodPlan?.preserve ?? 0)) :
        ['ammo', 'rune'].includes(rule.kind) ? observed?.usage?.[id] : null)
      : null;
    const estimate = foodPlan ?? combatSupplyEstimate(rule, id, context);
    const plan = typeof estimate === 'object' ? estimate : null;
    const projection = !use.value && measured == null ? plan : null;
    const automatic = measured ?? (plan ? plan.neededAt(1) : estimate);
    if (!expired) {
      use.placeholder = automatic == null ? '' : String(Math.round(automatic * 100) / 100);
      rate.textContent = use.value ? t('手动覆盖') : automatic == null ? t('待补充消耗量') :
        measured != null ? t('存档实测 {value}／小时', { value: decimals.format(automatic) }) :
          t('自动估算 {value}／小时', { value: decimals.format(automatic) });
    }
    if (!use.checkValidity() || !stock.checkValidity()) return null;
    const perHour = use.value ? use.valueAsNumber : automatic;
    if (perHour == null) unknown = true;
    if (perHour > 0 || projection) entries.push({ id, perHour, projection, food: rule.kind === 'food', threshold: foodPlan?.threshold,
      optional: ['charged', 'prayer'].includes(rule.kind) || Boolean(plan?.optional),
      available: stock.value ? stock.valueAsNumber : knownStock });
  }
  return { entries, unknown };
}

function combatStageCharacter(context, { expired, remaining, hitpoints, kills }, rules) {
  const { character, target, model } = context;
  const stock = { ...character.stock };
  const currencies = { ...character.currencies };
  for (const [id, quantity] of remaining) {
    if (quantity == null) continue;
    const kind = rules[id]?.kind;
    if (kind === 'prayer') currencies[id] = quantity;
    else if (kind === 'food' || kind === 'rune') stock[id] = quantity;
  }
  const keep = row => !expired.has(row.id);
  const combat = { ...character.combat, hitpoints,
    equipment: character.combat.equipment.filter(keep), toolbelt: character.combat.toolbelt?.filter(keep),
    prayers: character.combat.prayers?.map(prayer => {
      const currency = baseCombatId(model.prayers[prayer.active]?.cost?.Currency);
      return expired.has(currency) ? { ...prayer, state: 0 } : prayer;
    }) };
  return { ...character, stock, currencies, combat, slayerTasks: character.slayerTasks?.map(task =>
    task.monster === target?.id ? { ...task, remaining: Math.max(0, task.remaining - kills) } : task) };
}

function combatAfterSupplies(context, manual, state) {
  const { character, attributes, target, area, spells, model } = context;
  if (!character?.combat) return manual ? { ...context, supplies: [] } : null;
  const stageCharacter = combatStageCharacter(context, state, combatView.supplyRules);
  const stageAttributes = combatAttributes(model, stageCharacter, target, area, spells, combatView.supplyRules);
  const calibration = attributes?.perHour > 0 ? context.killsPerHour / attributes.perHour : 1;
  const killsPerHour = manual ? context.killsPerHour : stageAttributes?.perHour * calibration;
  if (!Number.isFinite(killsPerHour)) return null;
  const stage = { ...context, character: stageCharacter, attributes: stageAttributes, killsPerHour };
  const supplies = combatSupplies(stage, null, state.expired);
  return supplies && { ...stage, supplies: supplies.entries, unknown: supplies.unknown };
}

function renderCombat() {
  if (!combatView) return;
  const targetId = byId('combatTarget').value;
  const dungeon = combatView.dungeons.find(row => row.id === targetId);
  byId('combatRateMode').disabled = Boolean(dungeon);
  if (dungeon) return renderDungeon(dungeon);
  const { targets, items, character, kept } = combatView;
  const target = targets.find(enemy => enemy.id === targetId);
  const areaChoice = byId('combatAreaChoice');
  const previousArea = areaChoice.value || preferences.fields?.combatAreaChoice;
  areaChoice.replaceChildren(...(target?.areas ?? []).map(area => new Option(gameName(area), area.id)));
  const area = target?.areas.find(row => row.id === previousArea) ?? target?.areas[0];
  if (area) areaChoice.value = area.id;
  byId('combatAreaField').hidden = (target?.areas.length ?? 0) < 2;
  byId('combatArea').textContent = (target?.areas.length ?? 0) === 1 ? gameName(area) : '';
  const attributes = combatView.model && combatAttributes(combatView.model, character, target, area,
    combatView.spells, combatView.supplyRules);
  const availableAt = location => !character?.characterId || trainingRequirementsMet(
    [...(target?.requirements ?? []), ...(location?.requirements ?? [])], character, attributes?.style, catalog);
  const encounterAvailable = availableAt(area);
  for (const option of areaChoice.options) {
    const location = target.areas.find(row => row.id === option.value);
    if (!availableAt(location)) option.text += ' · ' + t('未满足解锁条件');
  }
  renderCombatLoadout(attributes);
  renderCombatAttributes(attributes);
  byId('combatSuppliesTable').hidden = !combatView.supplies.length;
  const collect = byId('combatCollect').checked;
  const sellInput = byId('combatSell');
  sellInput.disabled = !collect;
  const result = byId('combatResult');
  const metrics = byId('combatMetrics');
  const detail = result.querySelector('details');
  const status = byId('combatStatus');
  const manual = byId('combatRateMode').value === 'manual';
  const manualRate = byId('combatKillRate');
  byId('combatManualRate').hidden = !manual;
  manualRate.disabled = !manual;
  const setup = combatSetup(character);
  const sample = setup && area && combatView.samples.get(character?.characterId)?.rates?.find(rate =>
    rate.id === target?.id && rate.area === area.id && rate.setup === setup);
  const canFight = attributes?.ammoReady !== false && attributes?.usable !== false;
  const observed = !manual && canFight ? sample : null;
  byId('combatRateStatus').textContent = !encounterAvailable ? '' : manual ? t('手填击杀速度时，请计入怪物重生等待。') :
    observed ? t('存档实测 {rate} 击杀／小时 · {kills} 次击杀 · {time}', {
      rate: decimals.format(observed.perHour), kills: fullNumber(observed.kills),
      time: t('{value} 秒', { value: decimals.format(observed.milliseconds / 1000) })
    }) : attributes?.perHour != null ? t('按配装估算 {rate} 击杀／小时，暂无该目标的存档实测。', {
      rate: decimals.format(attributes.perHour)
    }) : t('请先读取角色存档，只打选中的怪物一段时间，等游戏再次保存后点击「重新读取存档」。');
  const killsPerHour = !encounterAvailable ? null : manual ? manualRate.valueAsNumber : observed?.perHour ?? attributes?.perHour;
  const context = { attributes, character, killsPerHour, target, area, spells: combatView.spells, model: combatView.model };
  const supplies = combatSupplies(context, observed);
  result.hidden = !target;
  byId('combatXp').hidden = !target;
  byId('xpCombatUnavailable').hidden = Boolean(target);
  const sessionHours = byId('combatHours').valueAsNumber;
  byId('xpCombatContext').textContent = target ? t('战斗目标 {target}', { target: gameName(target) }) : '';
  if (result.hidden) {
    renderCombatLevelGains(character, t('本机游戏数据没有可用于估算的普通怪物。'));
    return;
  }
  const canEstimate = encounterAvailable && !!supplies && Number.isFinite(killsPerHour) && killsPerHour > 0 &&
    (!manual || manualRate.checkValidity());
  const options = canEstimate ? {
    ...context, supplies: supplies.entries,
    nextStage: state => combatAfterSupplies(context, manual, state)
  } : null;
  renderCombatExperience(attributes, target, options);
  const valid = encounterAvailable && !!supplies && Number.isFinite(killsPerHour) && byId('combatOptions').checkValidity();
  metrics.hidden = detail.hidden = !valid;
  if (!valid) {
    metrics.replaceChildren();
    status.textContent = t(!encounterAvailable ? '当前角色尚未解锁该战斗地点或目标。' :
      !manual && attributes?.immune ? '目标免疫当前攻击方式。' :
      supplies === null ? '请检查补给的消耗量和库存。' :
      !manual && !Number.isFinite(killsPerHour) ? '暂无可用击杀速度。请检查存档配装、弹药和符文，或切换到手动输入。' :
        '请检查战斗目标、击杀速度和时长。');
    renderCombatLevelGains(character, status.textContent);
    return;
  }
  const locked = new Set(character?.keep ?? []);
  const estimate = estimateCombat(target, items, {
    ...context,
    hours: sessionHours,
    cap: byId('combatCap').valueAsNumber,
    killsPerHour,
    collect,
    sell: sellInput.checked,
    keep: new Set([...kept, ...locked]),
    supplies: supplies.entries,
    nextStage: state => combatAfterSupplies(context, manual, state)
  });
  renderCombatRewards(estimate, locked, collect);
  const plan = combatExperiencePlan(character, attributes, target, estimate, combatView.model,
    combatXpModifiers(combatView.model, catalog));
  renderCombatLevelGains(character, character?.characterId ? [
    t('预计战斗时长 {time}', { time: formatDuration(estimate.activeHours) }),
    t('按当前姿态、祝祭和屠杀任务估算。命中经验计入未打完的一场。'),
    estimate.limit && t('限制：{conditions}', { conditions: estimate.limit === 'Hitpoints' ?
      t('生命值不足以继续战斗') : combatSupplyName(estimate.limit) })
  ].filter(Boolean).join(' · ') : t('读取角色存档后可按战斗配装估算经验。'), skill => plan.total(skill));
  status.textContent = [
    t('预计战斗时长 {time}', { time: formatDuration(estimate.activeHours) }),
    attributes?.effectsApplied && t('已按期望值计入特殊攻击和区域效果。'),
    attributes?.effectsPartial && t('部分复杂效果仍为近似估算。'),
    estimate.limit === 'Hitpoints' ? t('生命值不足以继续战斗') :
      estimate.limit && t('约 {time}后用完{item}', { time: formatDuration(estimate.activeHours), item: combatSupplyName(estimate.limit) }),
    ...estimate.expired.map(([id, hours]) => t('{item}在 {time} 后耗尽，之后按剩余配装计算', {
      item: combatSupplyName(id), time: formatDuration(hours)
    })),
    supplies.entries.some(row => row.available == null) && t('部分补给缺少库存信息'),
    (supplies.unknown || estimate.unknown) && t('净收益尚未扣除消耗量未知的补给'),
    estimate.phases.some(phase => phase.lethalHit) &&
      t('敌人可能在自动进食前击杀角色，当前收益按存活估算。')
  ].filter(Boolean).join(' · ');
}

function renderCombatRewards(estimate, locked, collect, dungeon = false) {
  const { items, kept } = combatView;
  const sellInput = byId('combatSell');
  const metrics = byId('combatMetrics');
  metrics.replaceChildren(...[
    ['预计净收益', estimate.net], ['预计到手 GP', estimate.payout],
    ['净 GP/小时', estimate.netPerHour], [dungeon ? '预计通关次数' : '预计击杀数', estimate.kills]
  ].map(([label, value]) => {
    const field = create('div', t(label));
    field.append(create('strong', fullNumber(value)));
    return field;
  }));
  byId('combatGold').textContent = t('直接 GP {value}', { value: fullNumber(estimate.direct) });
  byId('combatDropsTable').hidden = !estimate.drops.length;
  byId('combatDrops').replaceChildren(...estimate.drops.map(drop => {
    const row = create('tr');
    const sale = create('input');
    const itemName = gameName(items[drop.id]);
    sale.type = 'checkbox';
    sale.checked = drop.sold;
    sale.disabled = !collect || !sellInput.checked || locked.has(drop.id);
    sale.setAttribute('aria-label', t('出售{item}', { item: itemName }));
    sale.addEventListener('change', () => {
      if (sale.checked) kept.delete(drop.id);
      else kept.add(drop.id);
      renderCombat();
      queuePreferences();
      rowReplacementFocus(drop.id);
    });
    sale.dataset.combatLoot = drop.id;
    const cell = create('td');
    cell.append(sale);
    if (locked.has(drop.id)) cell.append(create('small', t('仓库已锁定')));
    row.append(create('td', itemName), create('td', decimals.format(drop.quantity), 'number'),
      create('td', fullNumber(drop.price), 'number'), cell, create('td', fullNumber(drop.value), 'number'));
    return row;
  }));
  byId('combatCosts').replaceChildren(...estimate.costs.map(cost => create('li', t('消耗 · {item} × {quantity} · {value}', {
    item: combatSupplyName(cost.id), quantity: decimals.format(cost.quantity),
    value: combatView.supplyRules[cost.id]?.kind === 'prayer' && !cost.value ? t('不折算为 GP') : '−' + formatGp(cost.value)
  }))));
}

function renderDungeon(dungeon) {
  const { character, items, kept, model, spells, supplyRules } = combatView;
  const result = byId('combatResult');
  const status = byId('combatStatus');
  const unavailable = message => {
    status.textContent = t(message);
    renderCombatLevelGains(character, status.textContent);
  };
  result.hidden = false;
  byId('combatMetrics').hidden = true;
  byId('combatBreakdown').hidden = true;
  byId('combatAreaField').hidden = true;
  byId('combatManualRate').hidden = true;
  byId('combatKillRate').disabled = true;
  byId('combatArea').textContent = gameName(dungeon);
  byId('combatXp').hidden = !combatView.targets.length;
  byId('xpCombatUnavailable').hidden = Boolean(combatView.targets.length);
  byId('xpCombatContext').textContent = gameName(dungeon);
  renderCombatExperience(null, null, null);
  byId('combatRateStatus').textContent = t('副本按完整通关结算。耗时和补给按各波敌人及其战斗效果估算。');
  renderCombatLoadout(combatAttributes(model, character, null, dungeon, spells, supplyRules));
  renderCombatAttributes(null);
  const collect = byId('combatCollect').checked;
  byId('combatSell').disabled = !collect;
  const hours = byId('combatHours').valueAsNumber;
  if (!Number.isFinite(hours) || !byId('combatOptions').checkValidity()) {
    unavailable('请检查战斗目标、击杀速度和时长。');
    return;
  }
  const waves = [];
  for (const stage of dungeon.encounters) {
    const weight = stage.options.reduce((sum, option) => sum + option.weight, 0);
    for (const option of stage.options) {
      if (!option.enemy || !(weight > 0) || !(option.weight > 0)) continue;
      if (stage.count > 0) waves.push({ enemy: option.enemy, count: stage.count * option.weight / weight });
    }
  }
  const context = { character, model };
  const forecast = (current, expired) => {
    const encounters = [];
    for (const wave of waves) {
      const attributes = combatAttributes(model, current, wave.enemy, dungeon, spells, supplyRules);
      if (!(attributes?.perHour > 0)) return { error: attributes?.immune ? '副本中有敌人免疫当前攻击方式。' :
        '暂无可用的副本战斗速度。请检查存档配装、弹药和符文。' };
      encounters.push({ ...wave, attributes, hours: wave.count / attributes.perHour });
    }
    const hoursPerClear = encounters.reduce((sum, row) => sum + row.hours, 0);
    if (!(hoursPerClear > 0)) return { error: '请检查战斗目标、击杀速度和时长。' };
    const supplies = new Map();
    let unknown = false;
    let incoming = 0;
    let maxHit = 0;
    for (const { count, attributes, enemy, hours: phaseHours } of encounters) {
      const phase = combatSupplies({ character: current, attributes, target: enemy, area: dungeon, model, spells,
        killsPerHour: attributes.perHour }, null, expired);
      if (!phase) return { error: '请检查补给的消耗量和库存。' };
      unknown ||= phase.unknown;
      maxHit = Math.max(maxHit, attributes.enemy?.maxHit ?? 0);
      incoming += count * Math.max(0, (attributes.enemy?.turnsPerKill ?? 0) * (attributes.enemy?.damagePerTurn ?? 0) +
        (attributes.enemy?.passiveDamagePerKill ?? 0) -
        Math.min(attributes.maxHp, attributes.enemyHp * attributes.lifesteal));
      for (const { id, perHour, available, food, optional, threshold } of phase.entries) {
        const row = supplies.get(id) ?? { id, perHour: 0, available, food, optional, threshold };
        row.perHour += (perHour ?? 0) * phaseHours / hoursPerClear;
        supplies.set(id, row);
      }
    }
    const attributes = { ...encounters[0].attributes, lifesteal: 0, enemyHp: 0, attacksPerKill: 1,
      enemy: { turnsPerKill: 1, damagePerTurn: incoming, maxHit } };
    const killsPerHour = 1 / hoursPerClear;
    for (const field of combatView.supplies) {
      const row = supplies.get(field.item.value);
      if (!row?.food || field.use.value) continue;
      row.projection = combatFoodProjection(supplyRules[row.id], row.id, { character: current, model, attributes, killsPerHour });
      row.perHour = row.projection?.neededAt(1) ?? row.perHour;
    }
    return { character: current, encounters, attributes, killsPerHour, hoursPerClear,
      supplies: [...supplies.values()], unknown };
  };
  const first = forecast(character);
  if (first.error) {
    unavailable(first.error);
    return;
  }
  if (character?.characterId && !trainingRequirementsMet(dungeon.requirements, character, first.attributes.style, catalog)) {
    unavailable('当前角色尚未解锁该战斗地点或目标。');
    return;
  }
  for (const supply of combatView.supplies) {
    if (supply.use.value) continue;
    const quantity = first.supplies.find(row => row.id === supply.item.value)?.perHour;
    if (quantity != null) {
      supply.use.placeholder = decimals.format(quantity);
      supply.rate.textContent = t('自动估算 {value}／小时', { value: decimals.format(quantity) });
    }
  }
  const locked = new Set(character?.keep ?? []);
  const estimate = estimateCombat(dungeon, items, { ...first, hours, cap: byId('combatCap').valueAsNumber,
    collect, sell: byId('combatSell').checked, keep: new Set([...locked, ...kept]),
    nextStage: state => {
      const stage = forecast(combatStageCharacter(context, state, supplyRules), state.expired);
      return stage.error ? null : stage;
    } });
  byId('combatMetrics').hidden = false;
  byId('combatBreakdown').hidden = false;
  status.textContent = [
    t('单次预计 {time}', { time: formatDuration(first.hoursPerClear, true) }),
    first.encounters.some(row => row.attributes.effectsApplied) && t('已按期望值计入特殊攻击和区域效果。'),
    first.encounters.some(row => row.attributes.effectsPartial) && t('部分复杂效果仍为近似估算。'),
    estimate.limit === 'Hitpoints' ? t('生命值不足以继续战斗') :
      estimate.limit && t('约 {time}后用完{item}', { time: formatDuration(estimate.activeHours), item: combatSupplyName(estimate.limit) }),
    ...estimate.expired.map(([id, elapsed]) => t('{item}在 {time} 后耗尽，之后按剩余配装计算', {
      item: combatSupplyName(id), time: formatDuration(elapsed)
    })),
    estimate.unknown && t('净收益尚未扣除消耗量未知的补给'),
    estimate.phases.some(phase => phase.lethalHit) && t('敌人可能在自动进食前击杀角色，当前收益按存活估算。')
  ].filter(Boolean).join(' · ');
  renderCombatRewards(estimate, locked, collect, true);
  const modifiers = combatXpModifiers(model, catalog);
  const fights = estimate.phases.flatMap(phase => {
    const clears = Math.max(0, Math.min(estimate.kills - phase.progress, phase.hours * phase.killsPerHour));
    if (!clears) return [];
    return phase.encounters.map(({ count, attributes, enemy }) => ({
      count: count * clears,
      plan: combatExperiencePlan(phase.character, attributes, enemy, {
        activeHours: 1, killsPerHour: 1
      }, model, modifiers)
    }));
  });
  renderCombatLevelGains(character, t('副本经验按预计完整通关和各波敌人估算。'),
    skill => fights.reduce((xp, { count, plan }) => xp + plan.completedFights(skill, count), 0));
}

function rowReplacementFocus(id) {
  [...byId('combatDrops').querySelectorAll('input')].find(input => input.dataset.combatLoot === id)?.focus();
}

if (typeof module !== 'undefined') module.exports = {
  estimateCombat, measuredCombatRate, combatExperiencePlan, forecastCombatExperience, updateCombatSample
};
