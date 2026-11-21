function trainingRequirementsMet(groups, character, style, catalogue) {
  const { combat } = character;
  function met(req) {
    const count = (table, id) => table && (table[id] ?? 0) >= req.statisticValue;
    switch (req.type) {
      case 'QuestComplete': return character.questProgress?.[req.quest]?.status === 3;
      case 'DungeonStatistic': return count(character.dungeonCompletions, req.statisticTarget);
      case 'SlayerMasterStatistic': return count(character.slayerCompletions, req.statisticTarget);
      case 'EnemyStatistic': return count(combat?.totals?.kills, req.statisticTarget);
      case 'AgilityTechniqueLevel': {
        const xp = character.xpSkillState?.Agility?.[req.technique];
        const cap = catalogue?.xpSkillData?.agilityTechniques?.find(row => row.id === req.technique)?.cap;
        return Number.isFinite(xp) && agilityTechniqueLevel(xp, cap) >= req.level;
      }
      case 'EquipmentItemEquipped': return combat?.equipment?.some(row => row.id === req.item);
      case 'CharacterUsingCombatStyle': return Boolean(style && req.combatStyle === style);
      case 'ToolbeltItemEquipped':
        if (req.skill === 'Combat') return combat?.toolbelt?.some(row => row.id === req.item);
        break;
    }
    return meetsRequirements([req], character);
  }
  return requirementClauses(groups).every(clause => clause.some(met));
}

function trainingEquipment(catalogue, character, recipes = new Map()) {
  const model = catalogue.combatModel;
  const worn = new Map(character.combat.equipment.map(row => [row.slot, row]));
  const owned = { ...character.stock, DefaultWeapon: 1 };
  for (const { id, quantity } of worn.values()) owned[id] = (owned[id] ?? 0) + quantity;
  const slots = model.equipmentSlots.filter(slot => worn.has(slot.id) || trainingRequirementsMet([slot.requirements], character));
  const available = { ...owned };
  for (const id of recipes.keys()) {
    const copies = slots.filter(slot => slot.type === model.items[id].slotType).length;
    available[id] = Math.max(available[id] ?? 0, copies);
  }
  const options = new Map(slots.map(slot => [slot.id, Object.entries(available).flatMap(([id, quantity]) => {
    const item = model.items[id];
    if (!(quantity > 0) || item?.slotType !== slot.type ||
        (worn.get(slot.id)?.id !== id && !trainingRequirementsMet([item.requirements], character))) return [];
    return [{ slot: slot.id, id, quantity: slot.id === 'Ammo' ? quantity : 1 }];
  })]));
  function equip(equipment, slot, item) {
    const occupied = model.items[item?.id]?.occupies ?? [];
    const next = equipment.filter(row => row.slot !== slot && !occupied.includes(row.slot) &&
      !(model.items[row.id]?.occupies?.includes(slot) && slot === 'Weapon'));
    if (!item) return next;
    if (next.some(row => model.items[row.id]?.occupies?.includes(slot))) return null;
    const used = next.reduce((sum, row) => sum + (row.id === item.id ? row.quantity : 0), 0);
    return used + item.quantity <= available[item.id] ? [...next, item] : null;
  }
  return { options, equip, owned };
}

function trainingCraftRecipes(catalogue, character,
  equipmentFor = id => catalogue.combatModel.items[id]?.slotType === 'Ammo' ? null : catalogue.combatModel.items[id]) {
  const recipes = new Map();
  for (const action of catalogue.actions) {
    if (action.kind !== 'Artisan' || character.excluded?.includes(action.id) ||
        !character.levels[action.skill] || !trainingRequirementsMet(action.requirementGroups, character)) continue;
    for (const [id, quantity, chance] of action.rewards) {
      const item = equipmentFor(id);
      if (!item?.slotType || !Number.isInteger(quantity) || quantity < 1 ||
          chance !== 1 || !trainingRequirementsMet([item.requirements], character)) continue;
      if (!recipes.has(id)) recipes.set(id, []);
      recipes.get(id).push({ action, quantity });
    }
  }
  return recipes;
}

function trainingCraftPlan(equipment, character, owned, recipes) {
  const counts = new Map();
  for (const { id, quantity } of equipment) counts.set(id, (counts.get(id) ?? 0) + quantity);
  const used = { items: new Map(), currencies: new Map() };
  const bank = { ...character.stock };
  const wallet = { ...character.currencies };
  for (const [id, quantity] of counts) {
    const worn = (owned[id] ?? 0) - (bank[id] ?? 0);
    bank[id] = Math.max(0, (bank[id] ?? 0) - Math.max(0, quantity - worn));
  }
  const crafts = [];
  for (const [id, quantity] of counts) {
    const needed = quantity - (owned[id] ?? 0);
    if (needed <= 0) continue;
    const choices = (recipes.get(id) ?? []).flatMap(({ action, quantity }) => {
      const batches = Math.ceil(needed / quantity);
      if (action.remainingPurchases != null && batches > action.remainingPurchases) return [];
      const items = action.costs.map(([id, quantity]) => [id, quantity * batches]);
      const currencies = (action.currencyCosts ?? []).map(([id, quantity]) => [id, quantity * batches]);
      const shortage = (cost, stock) => cost.reduce((sum, [id, quantity]) =>
        sum + Math.max(0, quantity - (stock[id] ?? 0)) / quantity, 0);
      return [{ id, action, batches, quantity: batches * quantity, items, currencies,
        shortage: shortage(items, bank) + shortage(currencies, wallet) }];
    }).sort((a, b) => a.shortage - b.shortage || a.batches - b.batches);
    const recipe = choices[0];
    if (!recipe) return null;
    crafts.push(recipe);
    for (const [type, stock] of [['items', bank], ['currencies', wallet]]) {
      recipe[type + 'Needed'] = recipe[type].map(([id, quantity]) => {
        const row = used[type].get(id) ?? { id, quantity: 0, missing: 0 };
        const available = stock[id] ?? 0;
        const missing = Math.max(0, quantity - available);
        row.quantity += quantity;
        row.missing += missing;
        stock[id] = Math.max(0, available - quantity);
        used[type].set(id, row);
        return { id, quantity, missing };
      });
    }
  }
  return { crafts, items: [...used.items.values()], currencies: [...used.currencies.values()] };
}

let combatTraining = {};
let combatTrainingEnemyGates = [];

function initCombatTraining() {
  combatTrainingEnemyGates = [...new Set(catalog.combatTargets.flatMap(target =>
    [...(target.requirements ?? []), ...target.areas.flatMap(area => area.requirements ?? [])].flat()
      .filter(req => req.type === 'EnemyStatistic').map(req => JSON.stringify([req.statisticTarget, req.statisticValue]))))]
    .map(gate => JSON.parse(gate));
  const select = byId('combatTrainingSkill');
  select.append(...COMBAT_XP_SKILLS.map(skill => new Option(skillName(skill, catalog.xpSkills), skill)));
  select.addEventListener('change', updateCombatTraining);
  const hours = byId('combatTrainingHours');
  hours.addEventListener('input', updateCombatTraining);
}

function combatTrainingInputs(character) {
  const { equipment, toolbelt, food, prayers, hitpoints, totals } = character.combat;
  const combat = [equipment, toolbelt, food, prayers, hitpoints,
    combatTrainingEnemyGates.map(([id, count]) => (totals?.kills?.[id] ?? 0) >= count)];
  return [character.levels, character.stock, character.currencies, character.bonuses, character.excluded, character.equipped,
    character.purchases, character.ranks, character.unlockedPets, character.astrologyNodes, character.slayerTasks,
    character.questProgress, character.dungeonCompletions, character.slayerCompletions,
    character.recipeStatistics, character.xpSkillState?.Agility, combat];
}

function bestTrainingWithCrafts(owned, craft) {
  return craft && (!owned || craft.xp > owned.xp) ? craft : owned;
}

function updateCombatTraining() {
  const select = byId('combatTrainingSkill');
  const skill = select.value;
  const character = combatView?.character;
  const panel = byId('combatXp');
  if (!catalog || panel.closest('[hidden]')) return;
  select.options[0].text = t('选择战斗技能');
  for (const option of [...select.options].slice(1)) option.text = skillName(option.value, catalog.xpSkills);
  const result = byId('combatTrainingResult');
  const status = byId('combatTrainingStatus');
  const craftSection = byId('combatTrainingCraft');
  const ownedSection = byId('combatTrainingOwned');
  const craftResult = byId('combatTrainingCraftResult');
  const craftStatus = byId('combatTrainingCraftStatus');
  ownedSection.hidden = !skill;
  if (!skill) {
    craftSection.hidden = true;
    return;
  }
  const duration = byId('combatTrainingHours');
  const hours = duration.valueAsNumber;
  const error = !character?.characterId || !character.combat?.equipment ? '读取角色存档后可推荐配装。' :
    !duration.checkValidity() ? '挂机时长须为 1 分钟到 24 小时。' : null;
  if (error) {
    result.hidden = craftSection.hidden = true;
    status.hidden = false;
    status.textContent = t(error);
    return;
  }
  craftSection.hidden = false;
  const scope = JSON.stringify([skill, hours, character.characterId]);
  const key = JSON.stringify([scope, combatTrainingInputs(character)]);
  if (combatTraining.key !== key && !(combatTraining.pending && combatTraining.scope === scope)) {
    const previous = combatTraining.scope === scope ? combatTraining.summary : null;
    const request = { scope, key, summary: previous, pending: true };
    combatTraining = request;
    let craft = false;
    const summary = {};
    let search = combatTrainingSearch(catalog, character, skill, hours, 0);
    function runBatch() {
      if (combatTraining !== request || combatView?.character?.characterId !== character.characterId || select.value !== skill ||
          !duration.checkValidity() || duration.valueAsNumber !== hours) {
        if (combatTraining === request) {
          request.key = null;
          request.pending = false;
        }
        return;
      }
      try {
        const until = performance.now() + 20;
        let step;
        do {
          step = search.next();
          if (step.done) break;
        } while (performance.now() < until);
        if (!step.done) {
          setTimeout(runBatch, 0);
          return;
        }
        if (craft) summary.craftResult = step.value;
        else summary.result = step.value;
      } catch (error) {
        if (craft) summary.craftFailed = true;
        else summary.failed = true;
        console.error(error);
      }
      if (!craft) {
        craft = true;
        search = combatTrainingSearch(catalog, character, skill, hours, 0, { craft: true });
        setTimeout(runBatch, 0);
        return;
      }
      request.pending = false;
      request.summary = summary;
      updateCombatTraining();
    }
    setTimeout(runBatch, 0);
  }
  const current = combatTraining.summary;
  const owned = current?.result;
  const expanded = bestTrainingWithCrafts(owned, current?.craftResult);
  const ownedMessage = !current ? '正在比较可用配装和战斗目标…' : current.failed ? '暂时无法计算练级方案。' :
    !owned ? '当前存档没有估出可用的练级方案。请检查可穿戴装备、补给或屠杀任务。' : null;
  const craftMessage = !current ? '正在比较当前等级可制造的装备…' : current.craftFailed ? '暂时无法计算练级方案。' :
    !expanded ? '当前未找到可用的制造配装方案。' :
      expanded === owned ? '可制造装备没有更快的方案，沿用现有配装，无需制作。' : null;
  renderTrainingPlan(result, status, owned, ownedMessage, character, skill);
  renderTrainingPlan(craftResult, craftStatus, current?.craftFailed || expanded === owned ? null : expanded, craftMessage, character, skill);
}

function renderTrainingPlan(container, status, plan, message, character, skill) {
  status.hidden = !message;
  if (message && status.textContent !== t(message)) status.textContent = t(message);
  container.hidden = !plan;
  if (plan) renderCombatTraining(container, plan, character, skill);
}

function syncTrainingChildren(container, children) {
  children.forEach((child, index) => {
    const previous = container.children[index];
    if (previous?.isEqualNode(child)) return;
    if (previous) previous.replaceWith(child);
    else container.append(child);
  });
  while (container.children.length > children.length) container.lastElementChild.remove();
}

function renderTrainingPreparation(container, preparation, catalogue, shop = false) {
  const previous = container.querySelector('.combat-training-prep');
  if (previous) container.dataset.preparationOpen = String(previous.open);
  if (!preparation) return null;
  const name = id => gameName(catalogue.items[id]) ?? id;
  const detail = previous ?? create('details', undefined, 'combat-training-prep');
  if (!previous) detail.open = container.dataset.preparationOpen !== 'false';
  const making = create('ul', undefined, 'combat-training-products');
  for (const recipe of preparation.crafts) {
    const item = create('li');
    const source = shop ? [gameName(catalogue.skillShop.group), gameName(catalogue.skillShop.sections[recipe.action.sectionId])]
      .filter(Boolean).join(' › ') : skillName(recipe.action.skill, catalogue.xpSkills);
    item.append(create('strong', t('{source} · {item} × {quantity}', {
      source, item: name(recipe.id), quantity: fullNumber(recipe.quantity)
    })));
    const materials = create('ul', undefined, 'combat-training-materials');
    for (const [rows, label] of [[recipe.itemsNeeded, name], [recipe.currenciesNeeded, shopCurrencyName]]) {
      for (const { id, quantity, missing } of rows) {
        const row = create('li', t('{item} × {quantity}', { item: label(id), quantity: fullNumber(quantity) }));
        if (missing > 0) row.append(' ', create('small', t('还缺 {quantity}', { quantity: fullNumber(missing) }), 'production-restriction'));
        materials.append(row);
      }
    }
    if (materials.childElementCount) item.append(materials);
    making.append(item);
  }
  const contents = [create('summary', t(shop ? '购买清单与所需资源' : '制作清单与材料')), making];
  if (shop) {
    const totals = [...preparation.items.map(row => ({ ...row, label: name(row.id) })),
      ...preparation.currencies.map(row => ({ ...row, label: shopCurrencyName(row.id) }))];
    const prices = totals.map(row => row.label + ' × ' + fullNumber(row.quantity));
    const shortages = totals.filter(row => row.missing > 0).map(row => row.label + ' × ' + fullNumber(row.missing));
    if (prices.length) contents.push(create('p', t('合计花费 {value}', { value: prices.join(' · ') }), 'muted'));
    if (shortages.length) contents.push(create('p', t('还缺 {resources}', { resources: shortages.join(' · ') }), 'production-restriction'));
  }
  syncTrainingChildren(detail, contents);
  return detail;
}

function renderCombatTraining(container, result, character, skill) {
  const { enemy, combat, estimate, plan, xp, perHour } = result;
  const model = catalog.combatModel;
  const stance = estimate.phases[0]?.attributes.stanceId;
  const name = id => gameName(catalog.items[id]) ?? id;
  const box = create('div', undefined, 'metrics');
  const goal = selectedExperienceGoal(character, skill);
  const progress = xpGoalProgress(character.levels[skill], character.skillXp?.[skill], goal.level, null);
  const actualHoursToGoal = progress ? plan.timeForGoal(skill, progress.remaining) : null;
  const hoursToGoal = actualHoursToGoal ?? (progress ? plan.projectedTimeForGoal(skill, progress.remaining) : null);
  for (const [label, value] of [
    ['预计 XP', fullNumber(xp)], ['整段平均 XP／小时', fullNumber(perHour)],
    ['可持续战斗时长', formatXpDuration(estimate.activeHours)],
    ['到目标需时', hoursToGoal == null ? '—' : formatXpDuration(hoursToGoal)]
  ]) {
    const metric = create('div', t(label));
    metric.append(create('strong', value));
    box.append(metric);
  }
  const gear = create('dl', undefined, 'combat-training-gear');
  const worn = new Map(character.combat.equipment.map(row => [row.slot, row.id]));
  for (const slot of model.equipmentSlots) {
    const equipped = combat.equipment.find(row => row.slot === slot.id);
    if (!equipped && !worn.has(slot.id)) continue;
    const label = gameName(catalog.combatSlots[slot.id]) ?? slot.id;
    const row = create('div');
    row.append(create('dt', label), create('dd', equipped ? name(equipped.id) : t('卸下')));
    gear.append(row);
  }
  const setup = [
    ['攻击姿态', gameName(model.stances[stance])],
    ['食物', combat.food && name(combat.food)],
    ['所选法术', combat.spell && gameName(catalog.combatSpells[combat.spell])],
    ['祝祭', (combat.prayers ?? []).map(row => gameName(model.prayers[row.active])).filter(Boolean).join(' · ')],
    ['战斗工具栏', (combat.toolbelt ?? []).map(row => name(row.id)).join(' · ')]
  ];
  for (const [label, value] of setup) {
    if (!value) continue;
    const row = create('div');
    row.append(create('dt', t(label)), create('dd', value));
    gear.append(row);
  }
  const costs = estimate.costs.filter(cost => cost.id !== 'Hitpoints' && cost.quantity > 0)
    .map(cost => combatSupplyName(cost.id) + ' × ' + fullNumber(Math.ceil(cost.quantity)));
  const preparation = result.preparation;
  const children = [create('h4', gameName(enemy.target) + ' · ' + gameName(enemy.area), 'combat-training-target'), box, gear];
  const details = renderTrainingPreparation(container, preparation, catalog);
  if (details) children.push(details);
  if (costs.length) children.push(create('p', t('预计补给用量 {supplies}', { supplies: costs.join(' · ') }), 'muted'));
  if (estimate.limit) children.push(create('p', t('限制：{conditions}', {
    conditions: estimate.limit === 'Hitpoints' ? t('生命值不足以继续战斗') : combatSupplyName(estimate.limit)
  }), 'production-restriction'));
  if (hoursToGoal != null && hoursToGoal > estimate.plannedHours) {
    children.push(create('p', t('超过本次挂机时长'), 'muted'));
  }
  if (hoursToGoal != null && actualHoursToGoal == null) {
    children.push(create('p', t('额外用时按持续战斗、补给充足估算。'), 'muted'));
  }
  if (enemy.target.specialEffects || enemy.area.specialEffects || combat.equipment.some(row => model.items[row.id]?.specialAttacks)) {
    children.push(create('p', t('此方案含特殊攻击或区域效果，实际经验和补给消耗可能不同。'), 'production-restriction'));
  }
  children.push(create('p', t(preparation
    ? '先备齐材料并完成制作，再按所选挂机时长估算。制作时间不计入战斗时长，弹药和符文仍按库存。'
    : '按当前库存与战斗时长比较候选方案，速率为估算值。'), 'muted'));
  syncTrainingChildren(container, children);
}

function trainingGearSeed(equipment, options, equip, stance, model) {
  const style = model.styles[stance.style];
  const combatStats = style.MaxHitFormula?.Data;
  const offence = new Set([stance.accuracy, baseCombatId(combatStats?.StrengthBonusStat),
    baseCombatId(combatStats?.DamageBonusStat)]);
  const score = choice => {
    const stats = model.items[choice.id].stats;
    let value = 0;
    for (const row of stats?.Stats ?? []) {
      const stat = baseCombatId(row.Stat);
      if (offence.has(stat)) value += row.Value * 3;
      else if (stat === stance.evasion || stat === baseCombatId(style.ArmourStat)) value += row.Value;
    }
    for (const row of stats?.ProtectionRatings ?? []) value += row.Value;
    return value;
  };
  let selected = equipment;
  for (const [slot, choices] of options) {
    if (slot === 'Weapon' || slot === 'Ammo') continue;
    for (const item of [...choices].sort((a, b) => score(b) - score(a))) {
      if (score(item) <= 0) break;
      const next = equip(selected, slot, item);
      if (next) {
        selected = next;
        break;
      }
    }
  }
  return selected;
}

function trainingPrayers(model, character, skill) {
  const current = (character.combat.prayers ?? []).filter(row => row.state === 1 &&
    (character.currencies[baseCombatId(model.prayers[row.active]?.cost?.Currency)] ?? 0) > 0);
  const configurations = current.length ? [current] : [];
  if (skill !== 'Prayer') return [...configurations, []];
  for (const [id, prayer] of Object.entries(model.prayers)) {
    if (!prayer.trainable || !(character.currencies[baseCombatId(prayer.cost?.Currency)] > 0) ||
        !trainingRequirementsMet([prayer.requirements], character)) continue;
    const slot = model.prayerSlots.find(row => row.type === prayer.slotType && trainingRequirementsMet([row.requirements], character));
    if (slot) configurations.push([{ slot: slot.id, active: id, state: 1 }]);
  }
  return configurations;
}

function trainingSupplies(context, rules) {
  const { character, attributes, killsPerHour } = context;
  const { equipment, toolbelt, food, prayers, spell } = character.combat;
  if (!attributes?.enemy || !attributes.perHour) return null;
  const entries = [];
  const add = (id, available, projection, optional = false) => {
    if (projection == null) return false;
    if (typeof projection === 'object') entries.push({ id, available, projection, optional, food: rules[id]?.kind === 'food' });
    else if (projection > 0) entries.push({ id, available, perHour: projection, optional });
    return true;
  };
  const initialHp = Math.min(attributes.maxHp, character.combat.hitpoints ?? attributes.maxHp);
  if (food && character.stock[food] > 0) {
    const projection = combatFoodProjection(rules[food], food, context);
    // Leave room for one normal hit when the character is about to auto-eat.
    if (!projection || attributes.enemy.maxHit >= Math.min(initialHp, Math.max(1, projection.threshold))) return null;
    add(food, character.stock[food], projection);
  }
  for (const { id, quantity } of [...equipment, ...(toolbelt ?? [])]) {
    const rule = rules[id];
    if (rule?.kind === 'ammo' || rule?.kind === 'charged') {
      if (!add(id, quantity, combatSupplyEstimate(rule, id, context), rule.kind === 'charged')) return null;
    }
  }
  if (attributes.usesSpells) for (const { id } of attributes.spellSupplies[spell].runes) {
    if (!add(id, character.stock[id] ?? 0, combatSupplyEstimate({ kind: 'rune' }, id, context))) return null;
  }
  const currencies = new Set((prayers ?? []).filter(row => row.state === 1)
    .map(row => baseCombatId(context.model.prayers[row.active]?.cost?.Currency)).filter(Boolean));
  for (const id of currencies) {
    if (!add(id, character.currencies[id] ?? 0, combatSupplyEstimate({ kind: 'prayer' }, id, context), true)) return null;
  }
  return entries;
}

function* combatTrainingSearch(catalogue, character, skill, hours, cap, { craft = false } = {}) {
  if (!character?.combat?.equipment || !(hours > 0)) return null;
  const model = catalogue.combatModel;
  const spells = catalogue.combatSpells;
  const rules = catalogue.combatSupplies;
  const recipes = craft ? trainingCraftRecipes(catalogue, character) : new Map();
  const { options, equip, owned } = trainingEquipment(catalogue, character, recipes);
  if (craft && ![...options.values()].some(rows => rows.some(row => row.quantity > (owned[row.id] ?? 0) ||
      (recipes.has(row.id) && model.items[row.id].slotType === 'Ring')))) return null;
  const preparations = new Map();
  const original = character.combat;
  const enemies = catalogue.combatTargets.flatMap(target => {
    if (target.pauseOnSpawn) return [];
    if (skill === 'Slayer' && !character.slayerTasks?.some(task => task.monster === target.id && task.remaining > 0)) return [];
    return target.areas.map(area => ({ target, area, requirements: [...(area.requirements ?? []), ...(target.requirements ?? [])] }));
  });
  const foods = Object.entries(character.stock).filter(([id, count]) => rules[id]?.kind === 'food' && count > 0)
    .sort(([a, countA], [b, countB]) => rules[b].healing * countB - rules[a].healing * countA);
  const food = foods.some(([id]) => id === original.food) ? original.food : foods[0]?.[0];
  const foodChoices = [...new Set([food, foods[0]?.[0]])];
  const casts = Object.entries(spells).filter(([, spell]) => spell.trainable &&
    trainingRequirementsMet(spell.requirements, character) && spell.runes.every(row => character.stock[row.id] >= row.quantity));
  const prayers = trainingPrayers(model, character, skill);

  function evaluate(combat, enemy, quick) {
    let actor = { ...character, combat };
    let preparation;
    if (craft) {
      const key = combat.equipment.map(row => row.id + ':' + row.quantity).sort().join('|');
      if (!preparations.has(key)) preparations.set(key, trainingCraftPlan(combat.equipment, character, owned, recipes));
      preparation = preparations.get(key);
      if (!preparation) return null;
      if (preparation.crafts.length) {
        actor = { ...actor, stock: { ...actor.stock }, currencies: { ...actor.currencies } };
        for (const [costs, counts] of [[preparation.items, actor.stock], [preparation.currencies, actor.currencies]]) {
          for (const { id, quantity, missing } of costs) counts[id] = Math.max(0, (counts[id] ?? 0) - (quantity - missing));
        }
      } else preparation = undefined;
    }
    const { target, area, requirements } = enemy;
    const weapon = model.items[combat.equipment.find(row => row.slot === 'Weapon')?.id]?.weapon;
    const style = model.stances[combat.stances[baseCombatId(weapon?.Type)]]?.style;
    if (!trainingRequirementsMet(requirements, actor, style, catalogue)) return null;
    function stage(current) {
      const attributes = combatAttributes(model, current, target, area, spells, rules, { quick });
      const context = { character: current, model, target, area, spells, attributes, killsPerHour: attributes?.perHour };
      const supplies = trainingSupplies(context, rules);
      return supplies && { ...context, supplies };
    }
    const initial = stage(actor);
    if (!initial) return null;
    const estimate = estimateCombat(target, catalogue.items, {
      ...initial, hours, cap, collect: false, sell: false,
      nextStage: state => stage(combatStageCharacter(initial, state, rules))
    });
    const plan = combatExperiencePlan(actor, initial.attributes, target, estimate, model, combatXpModifiers(model, catalogue));
    const xp = plan.total(skill);
    return xp > 0 ? { enemy, combat, estimate, plan, xp, perHour: xp / hours, preparation } : null;
  }

  const seeds = [];
  for (const weapon of options.get('Weapon') ?? []) {
    const data = model.items[weapon.id].weapon;
    if (!data) continue;
    const type = baseCombatId(data.Type);
    const ammo = data.RequiredAmmoType ? (options.get('Ammo') ?? []).filter(row => model.items[row.id].ammoType === data.RequiredAmmoType) : [null];
    const held = equip(original.equipment, 'Weapon', weapon);
    if (!held) continue;
    for (const stance of model.weaponTypes[type]?.stances ?? []) {
      const attack = model.stances[stance];
      const style = model.styles[attack?.style];
      if (!style || (skill !== 'Slayer' && skill !== 'Prayer' && !(attack.xpPerDamage?.[skill] > 0))) continue;
      const magic = style.UsesSpells;
      const alternate = trainingGearSeed(held, options, equip, attack, model);
      const sameGear = alternate.length === held.length &&
        alternate.every(row => held.some(saved => saved.slot === row.slot && saved.id === row.id));
      for (const arrows of ammo) for (const [spell] of magic ? casts : [[null]]) {
        for (const armour of sameGear ? [held] : [held, alternate]) {
          const equipment = equip(armour, 'Ammo', arrows);
          if (!equipment) continue;
          for (const active of prayers) for (const equippedFood of foodChoices) {
            seeds.push({ ...original, equipment, food: equippedFood, prayers: active, spell, imbuement: null, activeImbuement: null,
              stances: { ...original.stances, [type]: stance } });
          }
        }
      }
    }
  }

  const exactCandidates = [];
  const compare = (a, b) => b.xp - a.xp || (a.preparation?.crafts.length ?? 0) - (b.preparation?.crafts.length ?? 0) ||
    b.estimate.activeHours - a.estimate.activeHours;
  const scan = combat => enemies.map(enemy => evaluate(combat, enemy, true)).filter(Boolean).sort(compare);
  const rankedSeeds = [];
  for (const combat of seeds) {
    const best = scan(combat)[0];
    if (best) rankedSeeds.push(best);
    yield;
  }

  rankedSeeds.sort(compare);
  const first = new Set(rankedSeeds.slice(0, 8));
  if (craft) for (const candidate of rankedSeeds.filter(row => row.preparation).slice(0, 4)) first.add(candidate);
  for (const initial of first) {
    let best = initial;
    let crafted = initial.preparation ? initial : null;
    function consider(attempt) {
      if (!attempt) return;
      if (compare(attempt, best) < 0) best = attempt;
      if (attempt.preparation && (!crafted || compare(attempt, crafted) < 0)) crafted = attempt;
    }
    for (const set of model.sets) {
      let equipment = best.combat.equipment;
      for (const id of set.items) {
        if (equipment.some(row => row.id === id)) continue;
        for (const [slot, choices] of options) {
          if (slot === 'Weapon' || slot === 'Ammo') continue;
          const choice = choices.find(row => row.id === id);
          const candidate = choice && equip(equipment, slot, choice);
          if (candidate) {
            equipment = candidate;
            break;
          }
        }
      }
      if (equipment === best.combat.equipment ||
          !set.bonuses.some(bonus => bonus.count <= set.items.filter(id => equipment.some(row => row.id === id)).length)) continue;
      consider(evaluate({ ...best.combat, equipment }, best.enemy, true));
    }
    for (const [slot, choices] of options) {
      if (slot === 'Weapon' || slot === 'Ammo') continue;
      const originalEquipment = best.combat.equipment;
      for (const choice of [...choices, null]) {
        const equipment = equip(originalEquipment, slot, choice);
        if (equipment) consider(evaluate({ ...best.combat, equipment }, best.enemy, true));
      }
      yield;
    }
    for (const [candidateFood] of foods.slice(0, 4)) {
      if (candidateFood === best.combat.food) continue;
      consider(evaluate({ ...best.combat, food: candidateFood }, best.enemy, true));
    }
    exactCandidates.push(initial, ...scan(best.combat).slice(0, 5));
    if (craft && crafted && crafted.combat !== best.combat) exactCandidates.push(...scan(crafted.combat).slice(0, 3));
    yield;
  }
  let best = null;
  for (const row of exactCandidates) {
    const candidate = !craft || row.preparation ? evaluate(row.combat, row.enemy, false) : null;
    if (candidate && (!best || compare(candidate, best) < 0)) best = candidate;
    yield;
  }
  return best;
}
