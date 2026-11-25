function skillTrainingPurchases(catalogue, character, equipmentFor) {
  const offers = new Map();
  for (const offer of catalogue.skillShop?.purchases ?? []) {
    const tool = equipmentFor(offer.item);
    if (!tool || (tool.consumable && !catalogue.items[offer.item]?.skillCharges) ||
        !trainingRequirementsMet([tool.requirements, ...offer.requirementGroups], character)) continue;
    const remainingPurchases = offer.buyLimit > 0 ? offer.buyLimit - (character.purchases?.[offer.id] ?? 0) : null;
    if (remainingPurchases != null && remainingPurchases <= 0) continue;
    if (!offers.has(offer.item)) offers.set(offer.item, []);
    offers.get(offer.item).push({ action: { ...offer, remainingPurchases }, quantity: offer.quantity });
  }
  return offers;
}

function skillTrainingOptions(catalogue, character, skill, actions, shop) {
  const current = character.skillToolbelt?.[skill] ?? [];
  const worn = new Map(current.map(row => [row.slot, row]));
  const owned = { ...character.stock };
  for (const { id, quantity } of current) owned[id] = (owned[id] ?? 0) + quantity;
  const slots = (catalogue.skillToolSlots[skill] ?? []).filter(slot =>
    worn.has(slot.id) || trainingRequirementsMet([slot.requirements], character));
  const relevant = new Set(catalogue.equipmentSets.flatMap(set => set.items));
  for (const action of actions) for (const gate of action.requirementGroups.flat()) {
    if (gate.type === 'ToolbeltItemEquipped' && gate.skill === skill) relevant.add(gate.item);
  }
  function equipmentFor(id) {
    const item = catalogue.items[id];
    const tool = item?.skillTool;
    return tool && slots.some(slot => slot.type === tool.slotType) &&
      (item.modifiers?.length || item.cookingCharges || item.skillCharges || relevant.has(id)) ? tool : null;
  }
  const offers = shop ? skillTrainingPurchases(catalogue, character, equipmentFor) : new Map();
  const pool = new Set([...Object.keys(owned), ...offers.keys()]);
  const candidates = slots.map(slot => {
    const saved = worn.get(slot.id) ?? null;
    const choices = [saved];
    for (const id of pool) {
      const tool = equipmentFor(id);
      if (tool?.slotType !== slot.type || !trainingRequirementsMet([tool.requirements], character)) continue;
      if (tool.consumable && !catalogue.items[id].cookingCharges && !catalogue.items[id].skillCharges) continue;
      const stock = owned[id] ?? 0;
      const quantities = tool.consumable ? new Set([stock, ...(offers.get(id) ?? []).map(offer => stock + offer.quantity)]) : [1];
      for (const quantity of quantities) {
        if (!(quantity > 0) || (!(stock > 0) && !offers.has(id))) continue;
        if (saved?.id === id && saved.quantity === quantity) continue;
        choices.push({ slot: slot.id, id, quantity });
      }
    }
    if (saved && (choices.length > 1 || equipmentFor(saved.id))) choices.push(null);
    return { slot: slot.id, choices };
  }).filter(row => row.choices.length > 1);
  return { current, candidates, owned, offers };
}

function skillTrainingProfile(character, skill, loadout, current, preparation) {
  const stock = { ...character.stock };
  const currencies = { ...character.currencies };
  const equippedCounts = new Map();
  for (const { id, quantity } of current) equippedCounts.set(id, (equippedCounts.get(id) ?? 0) + quantity);
  for (const { id, quantity } of loadout) {
    const worn = equippedCounts.get(id) ?? 0;
    equippedCounts.set(id, Math.max(0, worn - quantity));
    stock[id] = Math.max(0, (stock[id] ?? 0) - Math.max(0, quantity - worn));
  }
  for (const [costs, inventory] of [[preparation.items, stock], [preparation.currencies, currencies]]) {
    for (const { id, quantity, missing } of costs) inventory[id] = Math.max(0, (inventory[id] ?? 0) - quantity + missing);
  }
  const updated = { ...character, stock, currencies, equipped: { ...character.equipped, [skill]: loadout.map(row => row.id) },
    skillToolbelt: { ...character.skillToolbelt, [skill]: loadout } };
  if (skill === 'Cooking') updated.cookingCharges = loadout.map(({ id, quantity }) => ({ item: id, quantity }));
  return updated;
}

function compareSkillTraining(a, b, ignoreStock) {
  if (ignoreStock) return experienceHourlyRate(b.row) - experienceHourlyRate(a.row);
  const reachable = Number(Boolean(b.target?.reaches)) - Number(Boolean(a.target?.reaches));
  if (reachable) return reachable;
  if (a.target?.reaches) return a.target.hours - b.target.hours;
  return (b.target?.xp ?? 0) - (a.target?.xp ?? 0);
}

function* skillTrainingSearch(catalogue, character, { skill, hours, goal, actionId, ignoreStock }, shop = false) {
  const actions = catalogue.xpActions.filter(row => row.skill === skill && (!actionId || row.id === actionId));
  const { current, candidates, owned, offers } = skillTrainingOptions(catalogue, character, skill, actions, shop);
  if (!actions.length || (shop && !offers.size)) return null;
  const skillCatalogue = { ...catalogue, xpActions: actions };
  const saved = new Map(current.map(row => [row.slot, row]));
  const compare = (a, b) => compareSkillTraining(a, b, ignoreStock) ||
    (a.preparation?.crafts.length ?? 0) - (b.preparation?.crafts.length ?? 0) || a.changes - b.changes;
  const evaluated = new Map();
  function score(loadout) {
    const key = JSON.stringify(loadout.map(row => [row.slot, row.id, row.quantity]).sort());
    if (evaluated.has(key)) return evaluated.get(key);
    const preparation = trainingCraftPlan(loadout, character, owned, offers);
    let result = null;
    if (preparation) {
      const actor = skillTrainingProfile(character, skill, loadout, current, preparation);
      for (const row of rank(skillCatalogue, actor, { hours, offlineCap: 24, sell: false, metric: 'xp', ignoreStock })) {
        const target = goal?.remaining > 0 ? row.planXp(goal.remaining) : goal ? { hours: 0, xp: 0, reaches: true } : null;
        if (!(row.xp > 0 || target?.xp > 0)) continue;
        const option = { row, target, loadout, current, preparation: preparation.crafts.length ? preparation : null,
          changes: current.filter(item => !loadout.some(row => row.slot === item.slot && row.id === item.id && row.quantity === item.quantity)).length +
            loadout.filter(item => !saved.has(item.slot)).length };
        if (!result || compare(option, result) < 0) result = option;
      }
    }
    evaluated.set(key, result);
    return result;
  }

  let best = null;
  function consider(loadout) {
    const candidate = score(loadout);
    if (candidate && (!best || compare(candidate, best) < 0)) best = candidate;
    return candidate;
  }
  const combinations = candidates.reduce((count, row) => count * row.choices.length, 1);
  if (combinations <= 160) {
    function* search(index, loadout) {
      if (index === candidates.length) {
        consider(loadout);
        yield;
        return;
      }
      const { slot, choices } = candidates[index];
      const base = loadout.filter(row => row.slot !== slot);
      for (const choice of choices) yield* search(index + 1, choice ? [...base, choice] : base);
    }
    yield* search(0, current);
    return best;
  }

  // Test complete equipment sets separately so partial sets with no bonus cannot prune them.
  const seeds = [current];
  for (const set of catalogue.equipmentSets) {
    let loadout = [...current];
    for (const id of set.items) {
      if (loadout.some(row => row.id === id)) continue;
      const option = candidates.flatMap(row => row.choices)
        .find(row => row?.id === id && !set.items.includes(loadout.find(item => item.slot === row.slot)?.id));
      if (option) loadout = [...loadout.filter(row => row.slot !== option.slot), option];
    }
    if (set.items.some(id => loadout.some(row => row.id === id))) seeds.push(loadout);
  }
  for (const loadout of seeds) {
    consider(loadout);
    yield;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const { slot, choices } of candidates) {
      const base = (best?.loadout ?? current).filter(row => row.slot !== slot);
      for (const choice of choices) {
        consider(choice ? [...base, choice] : base);
        yield;
      }
    }
  }
  return best;
}

let skillTrainingState = {};

function updateSkillTraining(character, settings) {
  const panel = byId('skillTraining');
  if (panel.closest('[hidden]')) return;
  const { skill, actionId, hours, goal, ignoreStock } = settings;
  const ownedStatus = byId('skillTrainingOwnedStatus');
  const shopStatus = byId('skillTrainingShopStatus');
  const ownedResult = byId('skillTrainingOwnedResult');
  const shopResult = byId('skillTrainingShopResult');
  const shopSection = byId('skillTrainingShop');
  if (!character?.characterId) {
    ownedStatus.hidden = false;
    ownedStatus.textContent = t('读取角色存档后可推荐配装。');
    ownedResult.hidden = shopSection.hidden = true;
    return;
  }
  shopSection.hidden = false;
  const scope = JSON.stringify([character.characterId, skill, hours, actionId, goal?.target, ignoreStock]);
  const key = JSON.stringify([scope, goal?.remaining, character.levels, character.stock, character.currencies,
    character.equipped, character.skillToolbelt?.[skill], character.bonuses, character.xpBonuses, character.purchases,
    character.ranks, character.astrologyNodes, character.unlockedPets, character.questProgress, character.recipeStatistics,
    character.xpSkillState, character.fishingPriorities, character.excluded, character.confirmed]);
  if (skillTrainingState.key !== key && !(skillTrainingState.pending && skillTrainingState.scope === scope)) {
    const previous = skillTrainingState.scope === scope ? skillTrainingState.summary : null;
    const request = { key, scope, summary: previous, pending: true };
    skillTrainingState = request;
    let shop = false;
    let search = skillTrainingSearch(catalog, character, settings);
    const summary = {};
    function runBatch() {
      if (skillTrainingState !== request) return;
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
        summary[shop ? 'shop' : 'owned'] = step.value;
      } catch (error) {
        summary[shop ? 'shopFailed' : 'ownedFailed'] = true;
        console.error(error);
      }
      if (!shop) {
        shop = true;
        search = skillTrainingSearch(catalog, character, settings, true);
        setTimeout(runBatch, 0);
        return;
      }
      request.summary = summary;
      request.pending = false;
      if (!panel.closest('[hidden]') && xpView.character?.characterId === character.characterId && xpView.skill === skill) renderExperience();
    }
    setTimeout(runBatch, 0);
  }
  const summary = skillTrainingState.summary;
  const owned = summary?.owned;
  const purchased = summary?.shop;
  const upgrade = purchased?.preparation && (!owned || compareSkillTraining(purchased, owned, ignoreStock) < 0) ? purchased : null;
  const ownedMessage = !summary ? '正在比较可用的技能配装…' : summary.ownedFailed ? '暂时无法计算练级方案。' :
    !owned ? (ignoreStock ? '没有符合当前解锁条件和配置的行动。' : '没有同时满足等级、解锁条件和库存的行动。') : null;
  const shopMessage = !summary ? '正在比较灵巧商店的装备…' : summary.shopFailed ? '暂时无法计算练级方案。' :
    !upgrade ? (owned ? '灵巧商店暂无更快的配装，沿用现有装备即可。' : '当前未找到可用的商店配装。') : null;
  showSkillTrainingPlan(ownedResult, ownedStatus, owned, ownedMessage, ignoreStock);
  showSkillTrainingPlan(shopResult, shopStatus, upgrade, shopMessage, ignoreStock);
}

function showSkillTrainingPlan(container, status, result, message, ignoreStock) {
  container.hidden = !result;
  status.hidden = !message;
  if (message && status.textContent !== t(message)) status.textContent = t(message);
  if (!result) return;
  const { row, target, preparation, loadout, current } = result;
  const name = id => gameName(catalog.items[id]) ?? t('未知物品');
  const metrics = create('div', undefined, 'metrics');
  for (const [label, value] of ignoreStock ? [['XP／小时', formatXp(experienceHourlyRate(row))]] : [
    ['预计可获 XP', formatXp(target?.xp ?? row.xp)],
    ['行动中 XP／小时', formatXp(target?.rate ?? row.activeXpPerHour)],
    ['到目标需时', target?.reaches ? formatXpDuration(target.hours) : target ? t(target.reason ?? '当前库存不足') : '—']
  ]) {
    const metric = create('div', t(label));
    metric.append(create('strong', value));
    metrics.append(metric);
  }
  const summary = create('div', undefined, 'skill-training-summary');
  summary.append(create('strong', experienceActionName(row.action), 'skill-training-action'), metrics);
  const children = [summary];
  const gear = create('dl', undefined, 'combat-training-gear');
  for (const id of new Set([...loadout, ...current].map(item => item.slot))) {
    const equipped = loadout.find(item => item.slot === id);
    const slot = create('div');
    slot.append(create('dt', gameName(catalog.combatSlots[id]) ?? t('未知名称')),
      trainingGearValue(trainingGearName(equipped, name), trainingGearName(current.find(item => item.slot === id), name)));
    gear.append(slot);
  }
  if (gear.childElementCount) {
    if (!preparation) children.push(create('p', t('方案会使用身上和仓库里已有的装备。'), 'muted'));
    children.push(gear);
  }
  else children.push(create('p', t('本方案无需额外装备。'), 'muted'));
  const details = renderTrainingPreparation(container, preparation, catalog, true);
  if (details) {
    children.push(details, create('p', t('经验收益按买齐并装备后估算，所需资源不足时会标出缺口。'), 'muted'));
  }
  if (row.risky) children.push(create('p', t('失败可受伤，未计生存时间'), 'xp-risk'));
  if (row.skillCharges?.length) children.push(create('p', t('道具预计消耗 {items}，耗尽后按剩余加成计算。', {
    items: row.skillCharges.map(charge => name(charge.id) + ' × ' + fullNumber(Math.ceil(charge.quantity))).join(' · ')
  }), 'muted'));
  syncTrainingChildren(container, children);
}
