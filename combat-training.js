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
  const worn = new Map(character.combat.equipment.filter(isCombatEquipment).map(row => [row.slot, row]));
  const owned = { ...character.stock, DefaultWeapon: 1 };
  for (const { id, quantity } of worn.values()) owned[id] = (owned[id] ?? 0) + quantity;
  const slots = model.equipmentSlots.filter(slot => worn.has(slot.id) || trainingRequirementsMet([slot.requirements], character));
  const available = { ...owned };
  for (const [id, sources] of recipes) {
    const item = model.items[id];
    const copies = item.stackable ? Math.max(...sources.map(source => source.quantity)) :
      slots.filter(slot => slot.type === item.slotType).length;
    available[id] = Math.max(available[id] ?? 0, copies);
  }
  const options = new Map(slots.map(slot => [slot.id, Object.entries(available).flatMap(([id, quantity]) => {
    const item = model.items[id];
    if (!(quantity > 0) || item?.slotType !== slot.type ||
        (worn.get(slot.id)?.id !== id && !trainingRequirementsMet([item.requirements], character))) return [];
    return [{ slot: slot.id, id, quantity: item.stackable || slot.id === 'Ammo' ? quantity : 1 }];
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

function trainingAmmoChoices(weapon, model, options) {
  const item = model.items[weapon.id];
  const required = item.weapon.RequiredAmmoType;
  if (!required || (item.ammoType === required && item.occupies?.includes('Ammo'))) return [null];
  return (options.get('Ammo') ?? []).filter(row => model.items[row.id].ammoType === required);
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
let combatCardTraining;
let combatTrainingEnemyGates = [];

function initCombatTraining() {
  combatTrainingEnemyGates = [...new Set(catalog.combatTargets.flatMap(target =>
    [...(target.requirements ?? []), ...target.areas.flatMap(area => area.requirements ?? [])].flat()
      .filter(req => req.type === 'EnemyStatistic').map(req => JSON.stringify([req.statisticTarget, req.statisticValue]))))]
    .map(gate => JSON.parse(gate));
  bindExperienceGoalInputs('combat', () => ({
    character: combatView.character, skill: byId('combatTrainingSkill').value
  }), updateCombatTraining);
  byId('combatXpAction').addEventListener('change', event => {
    const choices = experienceActionChoices(combatView.character);
    const skill = byId('combatTrainingSkill').value;
    if (event.target.value) choices[skill] = event.target.value;
    else delete choices[skill];
    updateCombatTraining();
    queuePreferences();
  });
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

function combatTrainingProfileKey(character) {
  return JSON.stringify([character.characterId, combatTrainingInputs(character)]);
}

function combatTrainingCache(character) {
  const key = combatTrainingProfileKey(character);
  if (combatCardTraining?.key !== key) {
    const previous = combatCardTraining?.characterId === character.characterId ? combatCardTraining.results : new Map();
    combatCardTraining = { key, characterId: character.characterId, results: new Map(previous) };
  }
  return combatCardTraining;
}

function combatCardPlans(character, selected, goals) {
  if (!character?.characterId || !character.combat?.equipment) return new Map();
  const state = combatTrainingCache(character);
  const matches = new Map();
  const waiting = [];
  for (const [skill, goal] of goals) {
    if (skill === selected || !(goal?.remaining > 0)) continue;
    const cached = state.results.get(skill);
    if (cached?.level === goal.target) matches.set(skill, recommendedCombatTraining(cached.summary));
    if (cached?.key !== state.key || cached.remaining !== goal.remaining) waiting.push([skill, goal]);
  }
  if (state.job || combatTraining.pending || !waiting.length) return matches;

  const [skill, goal] = waiting[0];
  const cached = state.results.get(skill);
  const previous = cached?.level === goal.target ? cached.summary : null;
  const search = combatTrainingPlans(catalog, character, skill, goal.remaining, previous);
  state.job = true;
  function runBatch() {
    if (combatCardTraining !== state || byId('combatXp').closest('[hidden]') || combatTraining.pending) {
      state.job = false;
      return;
    }
    let summary;
    try {
      const until = performance.now() + 12;
      let step;
      do {
        step = search.next();
        if (step.done) break;
      } while (performance.now() < until);
      if (!step.done) {
        setTimeout(runBatch, 0);
        return;
      }
      summary = step.value;
    } catch (error) {
      console.error(error);
    }
    state.results.set(skill, { key: state.key, level: goal.target, remaining: goal.remaining, summary });
    state.job = false;
    updateCombatTraining();
  }
  setTimeout(runBatch, 0);
  return matches;
}

function compareCombatTraining(a, b) {
  if (a.goalHours != null && b.goalHours != null) return a.goalHours - b.goalHours;
  if (a.goalHours != null) return -1;
  if (b.goalHours != null) return 1;
  const xp = b.xp - a.xp;
  if (xp) return xp;
  return a.projectedHours == null ? Number(b.projectedHours != null) :
    b.projectedHours == null ? -1 : a.projectedHours - b.projectedHours;
}

function bestTrainingWithCrafts(owned, craft) {
  return craft && (!owned || compareCombatTraining(craft, owned) < 0) ? craft : owned;
}

function recommendedCombatTraining(summary) {
  const ready = bestTrainingWithCrafts(summary?.result, summary?.craftResult);
  return ready?.goalHours != null ? ready : bestTrainingWithCrafts(ready, summary?.preparedResult);
}

function stableCombatTraining(candidate, previous) {
  if (!previous) return candidate;
  if (!candidate) return previous;
  // On a save refresh, keep a still-valid plan when improvement is below the forecast's precision.
  if (candidate.goalHours != null && previous.goalHours != null) {
    return candidate.goalHours < previous.goalHours * 0.99 ? candidate : previous;
  }
  if (candidate.goalHours == null && previous.goalHours == null) {
    return candidate.xp > previous.xp * 1.01 ? candidate : previous;
  }
  return candidate.goalHours != null ? candidate : previous;
}

function* combatTrainingPlans(catalogue, character, skill, remaining, previous) {
  const result = yield* combatTrainingSearch(catalogue, character, skill, remaining, { previous: previous?.result });
  const craftResult = yield* combatTrainingSearch(catalogue, character, skill, remaining, {
    craft: true, previous: previous?.craftResult
  });
  const best = bestTrainingWithCrafts(result, craftResult);
  const preparedResult = skill === 'Magic' && best?.goalHours == null
    ? yield* combatTrainingSearch(catalogue, character, skill, remaining, {
      craft: true, replenishRunes: true, previous: previous?.preparedResult
    }) : null;
  return { result, craftResult, preparedResult };
}

function updateCombatTraining() {
  const selected = byId('combatTrainingSkill');
  const skill = COMBAT_XP_SKILLS.includes(selected.value) ? selected.value : 'Attack';
  selected.value = skill;
  const character = combatView?.character;
  const panel = byId('combatXp');
  if (!catalog || panel.closest('[hidden]')) return;
  const result = byId('combatTrainingResult');
  const status = byId('combatTrainingStatus');
  const craftSection = byId('combatTrainingCraft');
  const craftResult = byId('combatTrainingCraftResult');
  const craftStatus = byId('combatTrainingCraftStatus');
  const preparedSection = byId('combatTrainingPrepared');
  const level = selectedExperienceGoal(character, skill).level;
  const remaining = xpGoalProgress(character?.levels?.[skill], character?.skillXp?.[skill], level)?.remaining;
  const error = !character?.characterId || !character.combat?.equipment ? '读取角色存档后可推荐配装。' :
    remaining == null ? '暂无等级进度' : remaining === 0 ? '已达到目标' : null;
  const scope = JSON.stringify([skill, level, character?.characterId]);
  if (error) {
    combatTraining = {};
    result.hidden = craftSection.hidden = preparedSection.hidden = true;
    status.hidden = false;
    status.textContent = t(error);
    renderCombatXpOverview(character, skill);
    return;
  }
  craftSection.hidden = false;
  const cache = combatTrainingCache(character);
  const key = JSON.stringify([scope, remaining, cache.key]);
  if (combatTraining.key !== key && !(combatTraining.pending && combatTraining.scope === scope)) {
    const cached = cache.results.get(skill);
    const previous = combatTraining.scope === scope ? combatTraining.summary :
      cached?.level === level ? cached.summary : null;
    const found = cached?.key === cache.key && cached.remaining === remaining ? cached.summary : null;
    const request = { scope, key, summary: found ?? previous, pending: !found };
    combatTraining = request;
    const search = !found && combatTrainingPlans(catalog, character, skill, remaining, previous);
    function runBatch() {
      if (combatTraining !== request || combatView?.character?.characterId !== character.characterId || selected.value !== skill) {
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
        request.summary = step.value;
        cache.results.set(skill, { key: cache.key, level, remaining, summary: step.value });
      } catch (error) {
        request.summary = { failed: true, craftFailed: true };
        console.error(error);
      }
      request.pending = false;
      updateCombatTraining();
    }
    if (search) setTimeout(runBatch, 0);
  }
  const current = combatTraining.summary;
  const owned = current?.result;
  const expanded = bestTrainingWithCrafts(owned, current?.craftResult);
  const ownedMessage = !current ? '正在比较可用配装和战斗目标…' : current.failed ? '暂时无法计算练级方案。' :
    !owned ? '当前存档没有估出可用的练级方案。请检查可穿戴装备、补给或屠杀任务。' : null;
  const craftMessage = !current ? '正在比较当前等级可制造的装备…' : current.craftFailed ? '暂时无法计算练级方案。' :
    !expanded ? '当前未找到可用的制造配装方案。' :
      expanded === owned ? '用已拥有的装备就能达到最佳收益，无需制作。' : null;
  renderTrainingPlan(result, status, owned, ownedMessage, character);
  const craftPlan = current?.craftFailed || expanded === owned ? null : expanded;
  renderTrainingPlan(craftResult, craftStatus, craftPlan, craftMessage, character);
  preparedSection.hidden = !current?.preparedResult;
  if (current?.preparedResult) renderCombatTraining(byId('combatTrainingPreparedResult'), current.preparedResult, character);
  renderCombatXpOverview(character, skill, owned, craftPlan, current?.preparedResult);
}

function renderTrainingPlan(container, status, plan, message, character) {
  status.hidden = !message;
  if (message && status.textContent !== t(message)) status.textContent = t(message);
  container.hidden = !plan;
  if (plan) renderCombatTraining(container, plan, character);
}

function trainingGearValue(recommended, current) {
  if (recommended === current) return create('dd', recommended);
  const value = create('dd');
  for (const [label, text] of [['当前装备', current], ['推荐装备', recommended]]) {
    const line = create('span', undefined, 'combat-training-gear-line');
    line.append(create('small', t(label)), create('span', text));
    value.append(line);
  }
  return value;
}

function trainingGearName(item, name) {
  if (!item) return t('空');
  return name(item.id) + (item.quantity > 1 || item.slot === 'Ammo' ? ' × ' + fullNumber(item.quantity) : '');
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
  const name = id => gameName(catalogue.items[id]) ?? t('未知物品');
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

function renderCombatTraining(container, result, character) {
  const { enemy, combat, estimate, goalHours, projectedHours, xp, perHour } = result;
  const model = catalog.combatModel;
  const stance = estimate.phases[0]?.attributes.stanceId;
  const name = id => gameName(catalog.items[id]) ?? t('未知物品');
  const box = create('div', undefined, 'metrics');
  const hoursToGoal = goalHours ?? projectedHours;
  for (const [label, value] of [
    ['预计可获 XP', fullNumber(xp)], ['行动中 XP／小时', fullNumber(perHour)],
    ['到目标需时', hoursToGoal == null ? '—' : formatXpDuration(hoursToGoal)]
  ]) {
    const metric = create('div', t(label));
    metric.append(create('strong', value));
    box.append(metric);
  }
  const gear = create('dl', undefined, 'combat-training-gear');
  const worn = new Map(character.combat.equipment.map(row => [row.slot, row]));
  const occupied = combatOccupiedSlots(model, combat.equipment);
  const wornOccupied = combatOccupiedSlots(model, character.combat.equipment);
  const slotName = (item, occupying) => occupying ? t('由{item}占用', { item: name(occupying) }) : trainingGearName(item, name);
  for (const slot of model.equipmentSlots) {
    const equipped = combat.equipment.find(row => row.slot === slot.id);
    const occupiedBy = occupied.get(slot.id);
    const wearing = worn.get(slot.id);
    const wornOccupiedBy = wornOccupied.get(slot.id);
    if (!equipped && !occupiedBy && !wearing && !wornOccupiedBy) continue;
    const label = gameName(catalog.combatSlots[slot.id]) ?? t('未知名称');
    const row = create('div');
    row.append(create('dt', label),
      trainingGearValue(slotName(equipped, occupiedBy), slotName(wearing, wornOccupiedBy)));
    gear.append(row);
  }
  const setup = [
    ['攻击姿态', gameName(model.stances[stance])],
    ['所选附魔', gameName(catalog.combatSpells[combat.imbuement ?? combat.activeImbuement])],
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
  const children = [create('h4', gameName(enemy.target) + ' · ' + gameName(enemy.area), 'combat-training-target'), box];
  if (result.currentGearHours != null) {
    children.push(create('p', t('当前配装打同一目标约 {time}', {
      time: formatXpDuration(result.currentGearHours)
    }), 'muted'));
  }
  if (!preparation) children.push(create('p', t('方案会使用身上和仓库里已有的装备。'), 'muted'));
  children.push(gear);
  const details = renderTrainingPreparation(container, preparation, catalog);
  if (details) children.push(details);
  if (preparation?.crafts.length) {
    const seconds = preparation.crafts.reduce((total, craft) => {
      const cycle = productionCycle(craft.action, character, catalog, { preview: true });
      return total + (cycle?.durationForCycles(craft.batches) ?? NaN);
    }, 0);
    if (Number.isFinite(seconds)) {
      const craftHours = seconds / 3600;
      const needsMaterials = [...preparation.items, ...preparation.currencies].some(row => row.missing > 0);
      children.push(create('p', t('装备制作约 {time}', { time: formatXpDuration(craftHours) }), 'muted'));
      if (!needsMaterials && !result.missingRunes?.length && goalHours != null) {
        children.push(create('p', t('制作和练级合计约 {time}', { time: formatXpDuration(craftHours + goalHours) }), 'muted'));
      }
    }
  }
  if (result.missingRunes?.length) {
    children.push(create('p', t('先制作所需装备并补齐符文。预计用时只计算战斗。'), 'production-restriction'));
    const shortages = new Map(result.missingRunes.map(({ id, quantity }) => [id, quantity]));
    for (const { id, missing } of preparation?.items ?? []) {
      if (catalog.combatSupplies[id]?.kind === 'rune' && missing > 0) {
        shortages.set(id, (shortages.get(id) ?? 0) + missing);
      }
    }
    children.push(create('p', t('符文缺口（制作与战斗合计）'), 'muted'));
    const list = create('ul', undefined, 'combat-training-materials');
    for (const [id, quantity] of shortages) {
      const row = create('li', t('缺少 {item}', { item: name(id) + ' × ' + fullNumber(quantity) }));
      const recipe = catalog.actions.find(action => action.kind === 'Artisan' && action.skill === 'Runecrafting' &&
        action.rewards.some(([item, output, chance]) => item === id && output > 0 && chance === 1) &&
        trainingRequirementsMet(action.requirementGroups, character));
      if (recipe) {
        const batches = Math.ceil(quantity / recipe.rewards.find(([item]) => item === id)[1]);
        const materials = recipe.costs.map(([item, cost]) => name(item) + ' × ' + fullNumber(cost * batches)).join(' · ');
        row.append(create('small', skillName('Runecrafting', catalog.xpSkills) + ' · ' + gameName(recipe) +
          (materials ? ' · ' + materials : ''), 'muted'));
      }
      list.append(row);
    }
    children.push(list);
  }
  if (costs.length) children.push(create('p', t('预计补给用量 {supplies}', { supplies: costs.join(' · ') }), 'muted'));
  if (estimate.limit) children.push(create('p', t('限制：{conditions}', {
    conditions: estimate.limit === 'Hitpoints' ? t('生命值不足以继续战斗') : combatSupplyName(estimate.limit)
  }), 'production-restriction'));
  if (hoursToGoal != null && goalHours == null) {
    children.push(create('p', t('额外用时按持续战斗、补给充足估算。'), 'muted'));
  }
  if (estimate.phases.some(phase => phase.attributes?.effectsApplied))
    children.push(create('p', t('已按期望值计入特殊攻击和区域效果。'), 'muted'));
  if (estimate.phases.some(phase => phase.attributes?.effectsPartial))
    children.push(create('p', t('部分复杂效果仍为近似估算。'), 'production-restriction'));
  if (preparation && !result.missingRunes?.length) children.push(create('p', t('先备齐材料并完成制作。制作时间不计入练级用时，弹药和符文仍按库存。'), 'muted'));
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

function trainingSupplies(context, rules, replenishRunes) {
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
  const equippedSupplies = new Map();
  for (const { id, quantity } of [...equipment, ...(toolbelt ?? [])]) {
    equippedSupplies.set(id, (equippedSupplies.get(id) ?? 0) + Math.max(0, quantity));
  }
  for (const [id, quantity] of equippedSupplies) {
    const rule = rules[id];
    if (rule?.kind === 'ammo' || rule?.kind === 'charged') {
      if (!add(id, quantity, combatSupplyEstimate(rule, id, context), rule.kind === 'charged')) return null;
    }
  }
  const runeIds = new Set([
    ...(attributes.usesSpells ? attributes.spellSupplies[spell].runes : []),
    ...(attributes.imbuementReady ? attributes.spellSupplies[character.combat.imbuement ?? character.combat.activeImbuement].runes : [])
  ].map(rune => rune.id));
  for (const id of runeIds) {
    const use = combatSupplyEstimate({ kind: 'rune' }, id, context);
    if (!add(id, replenishRunes && !use?.optional ? null : character.stock[id] ?? 0, use, use?.optional)) return null;
  }
  const currencies = new Set((prayers ?? []).filter(row => row.state === 1)
    .map(row => baseCombatId(context.model.prayers[row.active]?.cost?.Currency)).filter(Boolean));
  for (const id of currencies) {
    if (!add(id, character.currencies[id] ?? 0, combatSupplyEstimate({ kind: 'prayer' }, id, context), true)) return null;
  }
  return entries;
}

function* combatTrainingSearch(catalogue, character, skill, remaining, {
  craft = false, replenishRunes = false, previous
} = {}) {
  if (!character?.combat?.equipment || !(remaining > 0)) return null;
  const model = catalogue.combatModel;
  const spells = catalogue.combatSpells;
  const rules = catalogue.combatSupplies;
  const recipes = craft ? trainingCraftRecipes(catalogue, character) : new Map();
  const { options, equip, owned } = trainingEquipment(catalogue, character, recipes);
  if (craft && !replenishRunes && ![...options.values()].some(rows => rows.some(row => row.quantity > (owned[row.id] ?? 0) ||
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
  const foodChoices = [...new Set([food, foods[0]?.[0], undefined])];
  const casts = Object.entries(spells).filter(([, spell]) => spell.trainable);
  const prayers = trainingPrayers(model, character, skill);
  const modifiers = combatXpModifiers(model, catalogue);

  function evaluate(combat, enemy, quick, finishAtGoal = false) {
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
    const spell = style && model.styles[style]?.UsesSpells ? spells[combat.spell] : null;
    if (spell && !trainingRequirementsMet(spell.requirements, actor, style, catalogue)) return null;
    const actualStock = actor.stock;
    if (replenishRunes && spell) {
      actor = { ...actor, stock: { ...actualStock, ...Object.fromEntries(spell.runes.map(({ id }) => [id, Infinity])) } };
    }
    function stage(current) {
      const attributes = combatAttributes(model, current, target, area, spells, rules, { quick });
      const context = { character: current, model, target, area, spells, attributes, killsPerHour: attributes?.perHour };
      const supplies = trainingSupplies(context, rules, replenishRunes);
      return supplies && { ...context, supplies };
    }
    const initial = stage(actor);
    if (!initial) return null;
    const options = {
      ...initial, collect: false, sell: false,
      nextStage: state => stage(combatStageCharacter(initial, state, rules))
    };
    const forecast = forecastCombatExperience(target, catalogue.items, options, new Map([[skill, remaining]]), modifiers);
    const goalHours = forecast.plan.timeForGoal(skill, remaining);
    const projectedHours = goalHours ?? forecast.plan.projectedTimeForGoal(skill, remaining);
    const xp = goalHours == null ? forecast.plan.total(skill) : Math.max(remaining, forecast.plan.at(skill, goalHours));
    if (!(xp > 0)) return null;
    const estimate = finishAtGoal && goalHours != null
      ? estimateCombat(target, catalogue.items, { ...options, hours: goalHours }) : forecast.estimate;
    const hours = goalHours ?? estimate.activeHours;
    const missingRunes = replenishRunes ? estimate.costs.filter(cost => rules[cost.id]?.kind === 'rune')
      .map(({ id, quantity }) => ({ id, quantity: Math.max(0, Math.ceil(quantity) - (actualStock[id] ?? 0)) }))
      .filter(row => row.quantity > 0) : [];
    return { enemy, combat, estimate, xp, perHour: xp / hours, preparation, goalHours, projectedHours, missingRunes };
  }

  function reevaluatePrevious() {
    if (!previous) return null;
    const enemy = enemies.find(({ target, area }) => target.id === previous.enemy.target.id && area.id === previous.enemy.area.id);
    const { equipment: oldEquipment, food, spell, stances } = previous.combat;
    if (!enemy || (food && !(character.stock[food] > 0))) return null;
    const prayerKey = rows => (rows ?? []).map(row => row.slot + ':' + row.active).sort().join('|');
    const active = prayers.find(rows => prayerKey(rows) === prayerKey(previous.combat.prayers));
    if (!active) return null;
    let equipment = [];
    for (const { slot, id } of oldEquipment) {
      const item = options.get(slot)?.find(row => row.id === id);
      if (!item) return null;
      equipment = equip(equipment, slot, item);
      if (!equipment) return null;
    }
    if (equipment.length !== oldEquipment.length) return null;
    const combat = { ...original, equipment, food, spell, stances, prayers: active,
      imbuement: previous.combat.imbuement, activeImbuement: null };
    const result = evaluate(combat, enemy, false, true);
    return craft && !replenishRunes && !result?.preparation ? null : result;
  }

  const seeds = [];
  for (const weapon of options.get('Weapon') ?? []) {
    const data = model.items[weapon.id].weapon;
    if (!data) continue;
    const type = baseCombatId(data.Type);
    const ammo = trainingAmmoChoices(weapon, model, options);
    const held = equip(original.equipment, 'Weapon', weapon);
    if (!held) continue;
    for (const stance of model.weaponTypes[type]?.stances ?? []) {
      const attack = model.stances[stance];
      const style = model.styles[attack?.style];
      if (!style || (skill !== 'Slayer' && skill !== 'Prayer' && !(attack.xpPerDamage?.[skill] > 0))) continue;
      const magic = style.UsesSpells;
      if (replenishRunes && !magic) continue;
      // A gear bonus can reduce a cast's rune cost. Check exact affordability with the candidate's stats.
      const caster = { ...character, combat: { ...original, equipment: held } };
      const availableCasts = magic ? casts.filter(([, spell]) =>
        trainingRequirementsMet(spell.requirements, caster, attack.style, catalogue) &&
        (replenishRunes || spell.runes.every(({ id }) => (character.stock[id] ?? 0) > 0))) : [[null]];
      const alternate = trainingGearSeed(held, options, equip, attack, model);
      const sameGear = alternate.length === held.length &&
        alternate.every(row => held.some(saved => saved.slot === row.slot && saved.id === row.id));
      for (const arrows of ammo) for (const [spell] of availableCasts) {
        for (const armour of sameGear ? [held] : [held, alternate]) {
          const equipment = equip(armour, 'Ammo', arrows);
          if (!equipment) continue;
          for (const active of prayers) for (const equippedFood of foodChoices) {
            const imbuement = original.imbuement ?? original.activeImbuement;
            const canImbue = !magic && spells[imbuement]?.effects?.length &&
              trainingRequirementsMet(spells[imbuement].requirements, caster, attack.style, catalogue) &&
              spells[imbuement].runes.every(({ id, quantity }) => (character.stock[id] ?? 0) >= quantity);
            for (const selected of canImbue ? [null, imbuement] : [null]) {
              seeds.push({ ...original, equipment, food: equippedFood, prayers: active, spell, imbuement: selected,
                activeImbuement: null, stances: { ...original.stances, [type]: stance } });
            }
          }
        }
      }
    }
  }

  const exactCandidates = [];
  const compare = (a, b) => compareCombatTraining(a, b) ||
    (a.preparation?.crafts.length ?? 0) - (b.preparation?.crafts.length ?? 0);
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
    const candidate = !craft || replenishRunes || row.preparation ? evaluate(row.combat, row.enemy, false) : null;
    if (candidate && (!best || compare(candidate, best) < 0)) best = candidate;
    yield;
  }
  const candidate = best && evaluate(best.combat, best.enemy, false, true);
  const retained = reevaluatePrevious();
  const recommended = stableCombatTraining(candidate, retained);
  if (craft || !recommended || original.imbuement || original.activeImbuement) return recommended;
  const itemKey = equipment => equipment.map(({ slot, id }) => slot + ':' + id).sort().join('|');
  if (itemKey(recommended.combat.equipment) === itemKey(original.equipment)) return recommended;
  const current = evaluate(original, recommended.enemy, false, true);
  if (current && (retained ? stableCombatTraining(current, recommended) === current :
    compareCombatTraining(current, recommended) < 0)) return current;
  return { ...recommended, currentGearHours: current?.goalHours };
}
