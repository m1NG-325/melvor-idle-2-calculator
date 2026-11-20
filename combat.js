function estimateCombat(target, items, options) {
  const plannedHours = Math.min(options.hours, options.cap || Infinity);
  let activeHours = plannedHours;
  let limit;
  for (const supply of options.supplies) {
    if (supply.available == null) continue;
    let duration = supply.available / supply.perHour;
    if (supply.projection) {
      const expected = supply.projection.neededAt(plannedHours);
      duration = expected > 0 && expected >= supply.available ? supply.projection.hoursAtStock(supply.available) : Infinity;
    }
    if (duration < activeHours) {
      activeHours = duration;
      limit = supply.id;
    }
  }
  const kills = Math.floor(options.killsPerHour * activeHours);
  const direct = target.gold * kills;
  const drops = target.drops.map(({ id, perKill }) => {
    const quantity = options.collect ? perKill * kills : 0;
    const price = items[id].price;
    const sold = options.collect && options.sell && !options.keep.has(id);
    return { id, quantity, price, sold, value: sold ? quantity * price : 0 };
  });
  const costs = options.supplies.map(({ id, perHour, projection, available }) => {
    const quantity = projection ? Math.min(projection.neededAt(activeHours), available ?? Infinity) : perHour * activeHours;
    return { id, quantity, value: quantity * items[id].price };
  });
  const payout = direct + drops.reduce((sum, row) => sum + row.value, 0);
  const net = payout - costs.reduce((sum, row) => sum + row.value, 0);
  return { plannedHours, activeHours, limit, kills, direct, drops, costs, payout, net, netPerHour: net / options.hours };
}

let combatView;

function combatSetup(character) {
  const { equipment, toolbelt, spell, imbuement, activeImbuement, stances, food, prayers } = character?.combat ?? {};
  if (!equipment || !toolbelt) return null;
  return JSON.stringify([equipment.map(row => [row.slot, row.id]), toolbelt.map(row => [row.slot, row.id]),
    spell, imbuement, activeImbuement, stances, food, prayers]);
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

function estimateCombatExperience(character, attributes, target, estimate, model, modifierFor) {
  const totals = {};
  const health = Math.max(0, (target.levels?.Hitpoints ?? 0) * 10);
  const stat = id => Math.max(0, target.stats?.Stats?.find(row => row.Stat === 'MelvorBase:' + id)?.Value ?? 0);
  const bonusDamage = 4 * stat('Armour') + 50 * stat('MaximumWard');
  const stance = model.stances[attributes?.stanceId];
  const adjusted = (skill, base, awards = 1) => {
    const mods = modifierFor(skill);
    return Math.max(0, (base + mods('FlatXPGained') * awards) * (1 + mods('PercentXPGained')));
  };
  for (const [skill, coefficient] of Object.entries(stance?.xpPerDamage ?? {})) {
    totals[skill] = adjusted(skill, coefficient * (health + bonusDamage), health + 1) * estimate.kills;
  }
  if (attributes?.prayerXpPerKill > 0) {
    totals.Prayer = adjusted('Prayer', attributes.prayerXpPerKill, attributes.hitsPerKill) * estimate.kills;
  }
  const taskKills = (character?.slayerTasks ?? []).filter(task => task.monster === target.id).reduce((sum, task) =>
    sum + Math.min(estimate.kills, task.remaining), 0);
  totals.Slayer = taskKills * adjusted('Slayer', health / 8 + 4);
  return totals;
}

function renderCombatExperience(character, attributes, target, estimate) {
  const { model } = combatView;
  const gear = [...(character?.combat?.equipment ?? []), ...(character?.combat?.toolbelt ?? [])].map(row => row.id);
  const extras = gear.flatMap(id => model.items[id]?.xpModifiers ?? []);
  extras.push(...(model.stances[attributes?.stanceId]?.xpModifiers ?? []));
  for (const prayer of character?.combat?.prayers ?? []) {
    if (prayer.state === 1) extras.push(...(model.prayers[prayer.active]?.xpModifiers ?? []));
  }
  for (const set of model.sets) {
    const count = set.items.filter(id => gear.includes(id)).length;
    for (const bonus of set.bonuses) if (count >= bonus.count) extras.push(...(bonus.xpModifiers ?? []));
  }
  const modifierFor = skill => actionModifiers({ skill }, character ?? {}, catalog, extras);
  const totals = estimate ? estimateCombatExperience(character, attributes, target, estimate, model, modifierFor) : {};
  const tasks = (character?.slayerTasks ?? []).filter(task => task.monster === target.id);
  const hours = byId('combatHours').valueAsNumber;
  byId('combatXpStatus').textContent = t(!attributes ? '读取角色存档后可按战斗配装估算经验。' :
    estimate ? '按当前姿态、启用的祝祭及剩余屠杀任务计算。' : '有可用的击杀速度后会显示经验和预计时间。');
  const body = byId('combatXpRows');
  COMBAT_XP_SKILLS.forEach((skill, index) => {
    let card = body.children[index];
    if (!card) {
      card = create('article', undefined, 'combat-xp-card');
      card.dataset.skill = skill;
      const metrics = create('dl', undefined, 'combat-xp-metrics');
      for (const metric of ['预计 XP', 'XP / 小时']) {
        const field = create('div');
        field.append(create('dt', t(metric)), create('dd'));
        metrics.append(field);
      }
      const slider = create('input');
      slider.type = 'range';
      slider.min = '1';
      slider.max = XP_LEVEL_CAP;
      slider.step = '1';
      const field = create('label', undefined, 'xp-level-slider combat-goal-slider');
      field.append(create('span'), slider);
      card.append(create('h3'), metrics, field, create('div', undefined, 'combat-goal-progress'),
        create('p', undefined, 'combat-xp-note muted'));
      body.append(card);
    }
    const xp = totals[skill] ?? (estimate && attributes ? 0 : null);
    const rate = xp == null ? null : xp / hours;
    const taskLimited = skill === 'Slayer' && xp > 0 && tasks.every(task => task.remaining <= estimate?.kills);
    const [label, metrics, field, progress, note] = card.children;
    const [[totalLabel, totalCell], [rateLabel, rateCell]] = Array.from(metrics.children, node => node.children);
    label.textContent = skillName(skill, catalog.xpSkills);
    totalLabel.textContent = t('预计 XP');
    rateLabel.textContent = t('XP / 小时');
    totalCell.textContent = xp == null ? '—' : fullNumber(xp);
    rateCell.textContent = rate == null ? '—' : fullNumber(rate);
    let explanation = '';
    if (skill === 'Slayer' && tasks.length) {
      explanation = t('当前任务剩余 {count} 次', { count: fullNumber(tasks.reduce((sum, task) => sum + task.remaining, 0)) });
    } else if (xp === 0 && estimate?.kills > 0) {
      const reason = skill === 'Slayer' ? '当前目标无匹配的屠杀任务' :
        skill === 'Prayer' ? '暂无可计入的祝祭经验' : '当前姿态不提供此项经验';
      explanation = t(reason);
    }
    note.textContent = explanation;
    note.hidden = !explanation;
    const [caption, slider] = field.children;
    slider.setAttribute('aria-label', t('{skill}目标等级', { skill: skillName(skill, catalog.xpSkills) }));
    function updateGoal() {
      const goal = selectedExperienceGoal(character, skill);
      if (slider.valueAsNumber !== goal.level) slider.value = goal.level;
      caption.textContent = t('目标等级 {level}', { level: goal.level });
      progress.replaceChildren(renderXpProgress(character, skill, goal, rate,
        estimate?.limit || taskLimited ? xp : null, taskLimited ? '当前任务结束前无法升级' : undefined));
    }
    slider.oninput = () => {
      setExperienceGoal(character, skill, slider.valueAsNumber);
      updateGoal();
    };
    updateGoal();
  });
}

function initCombat(catalog) {
  const targets = catalog.combatTargets ?? [];
  const model = catalog.combatModel;
  const prayerCosts = Object.values(model.prayers).map(row => baseCombatId(row.cost?.Currency)).filter(Boolean);
  const currencyRules = Object.fromEntries(prayerCosts.map(id => [id, { kind: 'prayer' }]));
  const currencies = Object.fromEntries(prayerCosts.map(id => [id, { name: id, price: id === 'GoldPieces' ? 1 : 0 }]));
  combatView = { targets, items: { ...currencies, ...catalog.items }, slots: catalog.combatSlots, spells: catalog.combatSpells,
    model, supplyRules: { ...catalog.combatSupplies, ...currencyRules }, suppressed: new Set(),
    kept: new Set(), supplies: [], samples: new Map(), character: null };
  const target = byId('combatTarget');
  target.replaceChildren(...targets.map(enemy => new Option('', enemy.id)));
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
    renderCombat();
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
  const targets = new Map(combatView.targets.map(enemy => [enemy.id, enemy]));
  for (const option of byId('combatTarget').options) option.text = gameName(targets.get(option.value));
  for (const supply of combatView.supplies) localizeCombatSupply(supply);
  renderCombatSupplyChoices();
  renderCombat();
}

function updateCombat(character) {
  if (!combatView) return;
  if (character?.characterId && character.date && character.combat?.totals) {
    const entry = combatView.samples.get(character.characterId);
    const snapshot = { date: character.date, combat: character.combat };
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
      const slot = gameName(slots?.[entry.slot]) ?? entry.slot;
      const item = gameName(items[entry.id]) ?? entry.id;
      const quantity = entry.quantity > 1 || (equipment && entry.slot === 'Ammo') ? ' × ' + fullNumber(entry.quantity) : '';
      rows.push(slot + ' · ' + item + quantity);
    }
  }
  for (const [title, id] of [['所选法术', state?.spell], ['所选附魔', state?.imbuement], ['已激活附魔', state?.activeImbuement]]) {
    if (!id) continue;
    const spell = spells?.[id];
    const runes = (spell?.runes ?? []).map(({ id, quantity }) => t('{item} × {quantity}（仓库 {stock}）', {
      item: gameName(items[id]) ?? id, quantity: fullNumber(quantity), stock: fullNumber(character.stock[id] ?? 0)
    }));
    rows.push([t(title), gameName(spell) ?? id, ...runes].join(' · '));
  }
  if (state) {
    if (!state.equipment?.some(row => row.slot === 'Weapon')) {
      rows.push((gameName(slots?.Weapon) ?? t('武器')) + ' · ' + (gameName(items.DefaultWeapon) ?? 'DefaultWeapon'));
    }
    const selectedFood = state.food ? t('{item} × {quantity}', {
      item: gameName(items[state.food]) ?? state.food, quantity: fullNumber(character.stock[state.food] ?? 0)
    }) : t('未选择');
    rows.push(t('食物') + ' · ' + selectedFood);
    if (attributes) rows.push(t('攻击姿态') + ' · ' + (gameName(model.stances[attributes.stanceId]) ?? attributes.stanceId));
    for (const prayer of state.prayers ?? []) {
      const id = prayer.active ?? prayer.selected;
      const label = gameName(model.prayers[id]) ?? id;
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
  const label = (group, id) => gameName(model[group][id]) ?? id;
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
  return combatView.supplyRules[id]?.kind === 'prayer' ? shopCurrencyName(id) : gameName(combatView.items[id]) ?? id;
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
  if (magic) {
    for (const id of [state.spell, state.imbuement ?? state.activeImbuement]) {
      desired.push(...(spells[id]?.runes ?? []).map(row => row.id));
    }
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
    const button = create('button', combatSupplyName(id) + ' · ' + id);
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

function combatSupplies(context, observed) {
  const { supplies, character, supplyRules } = combatView;
  const entries = [];
  let unknown = false;
  const actual = equippedSupplyIds();
  for (const { item, use, stock, rate } of supplies) {
    const id = item.value;
    if (!Object.hasOwn(supplyRules, id)) continue;
    const rule = supplyRules[id];
    const equipped = [...(character?.combat?.equipment ?? []), ...(character?.combat?.toolbelt ?? [])]
      .filter(row => row.id === id).reduce((total, row) => total + Math.max(0, row.quantity), 0);
    const counts = rule.kind === 'prayer' ? character?.currencies : character?.stock;
    const knownStock = character?.date || Object.hasOwn(counts ?? {}, id) ? (counts?.[id] ?? 0) + equipped : null;
    stock.placeholder = knownStock ?? '';
    const foodPlan = rule.kind === 'food' ? combatFoodProjection(rule, id, context) : null;
    const measured = actual.has(id) && !use.value
      ? (observed?.foodUsage?.id === id ? observed.foodUsage.perHour * (1 - (foodPlan?.preserve ?? 0)) :
        ['ammo', 'rune'].includes(rule.kind) ? observed?.usage?.[id] : null)
      : null;
    const projection = !use.value && measured == null ? foodPlan : null;
    const automatic = measured ?? (foodPlan ? foodPlan.neededAt(1) : combatSupplyRate(rule, id, context));
    use.placeholder = automatic == null ? '' : String(Math.round(automatic * 100) / 100);
    rate.textContent = use.value ? t('手动覆盖') : automatic == null ? t('待补充消耗量') :
      measured != null ? t('存档实测 {value}／小时', { value: decimals.format(automatic) }) :
        t('自动估算 {value}／小时', { value: decimals.format(automatic) });
    if (!use.checkValidity() || !stock.checkValidity()) return null;
    const perHour = use.value ? use.valueAsNumber : automatic;
    if (perHour == null) unknown = true;
    if (perHour > 0 || projection) entries.push({ id, perHour, projection, available: stock.value ? stock.valueAsNumber : knownStock });
  }
  return { entries, unknown };
}

function renderCombat() {
  if (!combatView) return;
  const { targets, items, character, kept } = combatView;
  const target = targets.find(enemy => enemy.id === byId('combatTarget').value);
  const areaChoice = byId('combatAreaChoice');
  const previousArea = areaChoice.value || preferences.fields?.combatAreaChoice;
  areaChoice.replaceChildren(...(target?.areas ?? []).map(area => new Option(gameName(area), area.id)));
  const area = target?.areas.find(row => row.id === previousArea) ?? target?.areas[0];
  if (area) areaChoice.value = area.id;
  byId('combatAreaField').hidden = (target?.areas.length ?? 0) < 2;
  byId('combatArea').textContent = (target?.areas.length ?? 0) === 1 ? gameName(area) : '';
  const attributes = combatView.model && combatAttributes(combatView.model, character, target, area,
    combatView.spells, combatView.supplyRules);
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
  byId('combatRateStatus').textContent = manual ? t('手填击杀速度时，请计入怪物重生等待。') :
    observed ? t('存档实测 {rate} 击杀／小时 · {kills} 次击杀 · {time}', {
      rate: decimals.format(observed.perHour), kills: fullNumber(observed.kills),
      time: t('{value} 秒', { value: decimals.format(observed.milliseconds / 1000) })
    }) : attributes?.perHour != null ? t('按配装估算 {rate} 击杀／小时，暂无该目标的存档实测。', {
      rate: decimals.format(attributes.perHour)
    }) : t('请先读取角色存档，只打选中的怪物一段时间，等游戏再次保存后点击「重新读取存档」。');
  const killsPerHour = manual ? manualRate.valueAsNumber : observed?.perHour ?? attributes?.perHour;
  const supplies = combatSupplies({ attributes, character, killsPerHour, target, area,
    spells: combatView.spells, model: combatView.model }, observed);
  result.hidden = !target;
  byId('combatXp').hidden = !target;
  if (result.hidden) return;
  const valid = !!supplies && Number.isFinite(killsPerHour) && byId('combatOptions').checkValidity();
  metrics.hidden = detail.hidden = !valid;
  if (!valid) {
    status.textContent = t(supplies === null ? '请检查补给的消耗量和库存。' :
      !manual && !Number.isFinite(killsPerHour) ? '暂无可用击杀速度。请检查存档配装、弹药和符文，或切换到手动输入。' :
        '请检查战斗目标、击杀速度和时长。');
    renderCombatExperience(character, attributes, target, null);
    return;
  }
  const locked = new Set(character?.keep ?? []);
  const estimate = estimateCombat(target, items, {
    hours: byId('combatHours').valueAsNumber,
    cap: byId('combatCap').valueAsNumber,
    killsPerHour,
    collect,
    sell: sellInput.checked,
    keep: new Set([...kept, ...locked]),
    supplies: supplies.entries
  });
  renderCombatExperience(character, attributes, target, estimate);
  metrics.replaceChildren(...[
    ['预计净收益', estimate.net], ['预计到手 GP', estimate.payout],
    ['净 GP/小时', estimate.netPerHour], ['预计击杀数', estimate.kills]
  ].map(([label, value]) => {
    const field = create('div', t(label));
    field.append(create('strong', fullNumber(value)));
    return field;
  }));
  status.textContent = [
    t('预计战斗时长 {time}', { time: formatDuration(estimate.activeHours) }),
    estimate.limit && t('约 {time}后用完{item}', { time: formatDuration(estimate.activeHours), item: combatSupplyName(estimate.limit) }),
    supplies.entries.some(row => row.available == null) && t('部分补给缺少库存信息'),
    supplies.unknown && t('净收益尚未扣除消耗量未知的补给')
  ].filter(Boolean).join(' · ');
  byId('combatGold').textContent = t('直接 GP {value}', { value: decimals.format(estimate.direct) });
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
      create('td', decimals.format(drop.price), 'number'), cell, create('td', decimals.format(drop.value), 'number'));
    return row;
  }));
  byId('combatCosts').replaceChildren(...estimate.costs.map(cost => create('li', t('消耗 · {item} × {quantity} · {value}', {
    item: combatSupplyName(cost.id), quantity: decimals.format(cost.quantity),
    value: combatView.supplyRules[cost.id]?.kind === 'prayer' && !cost.value ? t('不折算为 GP') : '−' + decimals.format(cost.value) + ' GP'
  }))));
}

function rowReplacementFocus(id) {
  [...byId('combatDrops').querySelectorAll('input')].find(input => input.dataset.combatLoot === id)?.focus();
}

if (typeof module !== 'undefined') module.exports = { estimateCombat, measuredCombatRate, estimateCombatExperience, updateCombatSample };
