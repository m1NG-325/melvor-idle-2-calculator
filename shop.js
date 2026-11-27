function meetsShopCondition(condition, character) {
  switch (condition.type) {
    case 'Level': {
      const level = character.levels?.[condition.skill];
      return level == null ? null : level >= condition.level;
    }
    case 'ShopPurchase':
      return character.purchases ? (character.purchases[condition.id] ?? 0) >= condition.amount : null;
    case 'DungeonStatistic':
      return character.dungeonCompletions ? (character.dungeonCompletions[condition.id] ?? 0) >= condition.amount : null;
    case 'SlayerMasterStatistic':
      return character.slayerCompletions ? (character.slayerCompletions[condition.id] ?? 0) >= condition.amount : null;
    case 'DemoLocked':
      return false;
    default:
      return null;
  }
}

function meetsShopGroup(conditions, character) {
  const groups = [];
  for (const condition of conditions) {
    if (!condition.or || !groups.length) groups.push([]);
    groups.at(-1).push(meetsShopCondition(condition, character));
  }
  if (groups.some(group => group.every(state => state === false))) return false;
  return groups.every(group => group.includes(true)) ? true : null;
}

function shopVisibility(upgrade, character, purchased) {
  if (upgrade.referenceReason) return { state: 'reference' };
  if (!character.date) return { state: 'unknown' };
  const display = (upgrade.displayRequirements ?? []).map(group => meetsShopGroup(group, character));
  if (display.includes(false)) return { state: 'hidden', reason: '未满足显示条件' };
  if (display.includes(null)) return { state: 'unknown' };
  const unlocked = meetsShopGroup(upgrade.requirements ?? [], character);
  if (purchased || unlocked || character.shopShowLocked === true) return { state: 'visible', unlocked };
  if (unlocked === false && character.shopShowLocked === false) {
    return { state: 'hidden', reason: '商店关闭了显示锁定项' };
  }
  return { state: 'unknown' };
}

function calculateShoppingList(shop, items, selected, character, scope = 'all', purchaseFilter = 'pending', language = 'zh',
  formatName = (names, fallback) => names?.[language] ?? fallback) {
  const resources = new Map();
  let upgradeCount = 0;
  let hiddenCount = 0;
  let unknownCount = 0;
  let purchasedCount = 0;
  let pendingCount = 0;
  const purchases = [];
  const upgrades = scope === 'reference' ? shop.referenceUpgrades : shop.upgrades;
  for (const upgrade of upgrades) {
    if (!selected.has(upgrade.group)) continue;
    const bought = character.purchases?.[upgrade.id] ?? 0;
    const remaining = purchaseFilter === 'purchased' ? 0 : Math.max(0, upgrade.target - bought);
    const purchased = purchaseFilter === 'pending' ? 0 : bought;
    if (!remaining && !purchased) continue;
    const visibility = shopVisibility(upgrade, character, bought > 0);
    if (visibility.state === 'hidden') hiddenCount++;
    if (visibility.state === 'unknown') unknownCount++;
    if (scope === 'visible' && visibility.state !== 'visible') continue;
    upgradeCount++;
    if (purchased) purchasedCount++;
    if (remaining) pendingCount++;
    purchases.push({ upgrade, remaining, purchased, visibility });
    for (const cost of upgrade.costs) {
      const key = cost.type + ':' + cost.id;
      let resource = resources.get(key);
      if (!resource) {
        const isCurrency = cost.type === 'currency';
        const names = isCurrency ? shop.currencyLabels?.[cost.id] : items[cost.id]?.names;
        const fallback = isCurrency ? shop.currencies[cost.id] : items[cost.id]?.name;
        resource = {
          ...cost, total: 0, spent: 0, uses: [],
          names, name: formatName(names, fallback) ?? cost.id,
          available: character.date
            ? (isCurrency ? character.currencies[cost.id] : character.stock[cost.id]) ?? 0
            : null
        };
        resources.set(key, resource);
      }
      const total = cost.quantity * remaining;
      const spent = cost.quantity * purchased;
      resource.total += total;
      resource.spent += spent;
      resource.uses.push({ upgrade, remaining, total, purchased, spent, visibility });
    }
  }
  for (const resource of resources.values()) {
    resource.shortage = resource.available === null ? null : Math.max(0, resource.total - resource.available);
  }
  const sorted = [...resources.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, language));
  return { upgradeCount, pendingCount, purchasedCount, hiddenCount, unknownCount, resources: sorted, purchases };
}

let shopView;

function shopCurrencyName(id) {
  const shop = shopView?.shop;
  return localizedName(shop?.currencyLabels?.[id], shop?.currencies?.[id]) ??
    (id === 'GoldPieces' ? t('金币') : t('未知货币'));
}

function localizeShop() {
  if (!shopView) return;
  const labels = new Map(shopView.shop.groups.map(group => [group.id, gameName(group)]));
  shopView.categoryNames = labels;
  for (const input of byId('shopCategories').querySelectorAll('input')) {
    input.nextElementSibling.textContent = labels.get(input.value);
  }
}

function initShop(shop, items) {
  const categoryNames = new Map(shop.groups.map(group => [group.id, gameName(group)]));
  const selected = new Set(preferences.shopSelected?.filter(id => categoryNames.has(id)) ?? categoryNames.keys());
  shopView = { shop, items, categoryNames, selected, character: null,
    choices: { purchase: new Set(), resource: new Set() } };
  const categoryControls = new Map();
  const selectAll = byId('shopSelectAll');

  function refreshSelection() {
    selectAll.checked = selected.size === categoryNames.size;
    selectAll.indeterminate = selected.size > 0 && selected.size < categoryNames.size;
    for (const [id, box] of categoryControls) box.checked = selected.has(id);
    renderShop();
  }

  byId('shopCategories').replaceChildren(...shop.groups.map(group => {
    const label = create('label', undefined, 'check');
    const box = create('input');
    box.type = 'checkbox';
    box.value = group.id;
    box.addEventListener('change', () => {
      if (box.checked) selected.add(group.id);
      else selected.delete(group.id);
      refreshSelection();
    });
    label.append(box, create('span', gameName(group)));
    categoryControls.set(group.id, box);
    return label;
  }));

  selectAll.addEventListener('change', () => {
    const checked = selectAll.checked;
    selected.clear();
    if (checked) for (const id of categoryNames.keys()) selected.add(id);
    refreshSelection();
  });
  byId('shopClear').addEventListener('click', () => { selected.clear(); refreshSelection(); queuePreferences(); });
  byId('shopSearch').addEventListener('input', renderShop);
  byId('shopShortages').addEventListener('change', renderShop);
  byId('shopScope').addEventListener('change', renderShop);
  byId('shopPurchaseFilter').addEventListener('change', renderShop);
  byId('shopLayout').addEventListener('change', renderShop);
  byId('shopToQueue').addEventListener('click', addShoppingQueue);
  refreshSelection();
}

function updateShop(character) {
  if (!shopView) return;
  shopView.character = character;
  renderShop();
}

function renderShop() {
  const { shop, items, categoryNames, selected, character } = shopView;
  if (!character) return;
  const scope = byId('shopScope').value;
  const purchases = byId('shopPurchaseFilter');
  purchases.disabled = !character.purchases;
  const purchaseFilter = purchases.disabled ? 'pending' : purchases.value;
  const showPurchased = purchaseFilter !== 'pending';
  const showPending = purchaseFilter !== 'purchased';
  const list = calculateShoppingList(shop, items, selected, character, scope, purchaseFilter, uiLocale(), localizedName);
  const search = byId('shopSearch').value.trim().toLocaleLowerCase();
  const shortages = byId('shopShortages');
  shortages.disabled = !character.date || !showPending;
  const showShortages = shortages.checked && !shortages.disabled;
  const byPurchase = byId('shopLayout').value === 'purchase';
  const searchMatches = values => values.some(value => value?.toLocaleLowerCase().includes(search));
  const matches = list.resources.filter(resource => (!showShortages || resource.shortage > 0) && (
    !search || [resource.name, resource.id, ...Object.values(resource.names ?? {})].some(name => name.toLocaleLowerCase().includes(search)) ||
    resource.uses.some(({ upgrade }) => [gameName(upgrade), upgrade.name, upgrade.id, upgrade.section,
      localizedName(upgrade.sectionNames, upgrade.section), categoryNames.get(upgrade.group),
      ...Object.values(upgrade.names ?? {}), ...Object.values(upgrade.sectionNames ?? {})]
      .some(text => text?.toLocaleLowerCase().includes(search)))
  ));
  const purchasesShown = list.purchases.filter(({ upgrade, remaining }) => {
    const costs = upgrade.costs;
    if (showShortages && !costs.some(cost => cost.quantity * remaining >
      ((cost.type === 'currency' ? character.currencies : character.stock)?.[cost.id] ?? 0))) return false;
    return !search || searchMatches([gameName(upgrade), upgrade.name, upgrade.id, shopPurchaseLocation(upgrade),
      ...Object.values(upgrade.names ?? {}), ...costs.flatMap(cost => [cost.id, cost.type === 'currency' ?
        shopCurrencyName(cost.id) : gameName(items[cost.id])])]);
  });
  const rows = byPurchase ? purchasesShown : matches;
  shopView.queueChoices = { byPurchase, rows };

  byId('shopStatus').textContent = [
    t('{count} 个已选类别', { count: selected.size }),
    ...(list.hiddenCount ? [t(scope === 'all' ? '其中 {count} 项当前隐藏' : '已排除 {count} 项当前隐藏', { count: list.hiddenCount })] : []),
    ...(character.date && list.unknownCount ? [t('{count} 项显示状态待核对', { count: list.unknownCount })] : []),
    character.purchases ? t('存档 {name}', { name: character.name }) :
      t(character.date ? '未读到购买记录，按未购计算' : '未载入存档，仅显示总需求')
  ].join(' · ');
  byId('shopPendingCount').textContent = fullNumber(list.pendingCount);
  byId('shopPurchasedCount').textContent = showPurchased ? fullNumber(list.purchasedCount) : '—';
  byId('shopResourceCount').textContent = fullNumber(list.resources.length);
  byId('shopTable').classList.toggle('show-spent', showPurchased);
  byId('shopTable').classList.toggle('purchased-only', !showPending);
  byId('shopCostHelp').textContent = t(showPurchased
    ? '已购用量按存档购买次数和本版标价估算。还缺只计算尚未购买的部分。'
    : '带已购标记的商品按首次购买规划。普通可重复购买的补给不计入。');
  byId('shopScopeHelp').textContent = t({
    visible: '按存档的商店显示设置筛选。游戏开启「显示锁定项」时，这里也会统计可见但尚未解锁的升级。',
    all: '统计本版正式商店里所有升级，包含还没显示或解锁的项目。展开资源可查看显示状态和前置条件。',
    reference: '这里只列安装数据中有价格的未上架或旧测试条目，费用单独统计。'
  }[scope]);
  byId('shopTable').hidden = !rows.length;
  byId('shopResourceHeader').hidden = byPurchase;
  byId('shopResourcesTitle').textContent = t(byPurchase ? '购买项目清单' : '升级资源清单');
  const empty = byId('shopEmpty');
  empty.hidden = !!rows.length;
  empty.textContent = t(!selected.size ? '请选择至少一个商店类别。' :
    scope === 'visible' && !character.date ? '载入角色存档后可判断当前显示的升级。也可以切换到「全部已知」。' :
    list.upgradeCount === 0 ? (showPending ? '所选类别没有匹配的升级。' : '所选类别没有已购升级。') :
      !list.resources.length ? '所选升级无需支付资源。' :
        search ? '没有匹配的资源或升级。' : '所选升级的资源已经够用。');

  const container = byId('shopResources');
  const expanded = new Set([...container.querySelectorAll('details[open]')].map(row => row.dataset.resource));
  container.replaceChildren(...(byPurchase ? rows.map(row => renderShopPurchase(row, expanded, showPurchased, showPending)) :
    rows.map(resource => renderShopResource(resource, expanded, showPurchased, showPending))));
  updateShoppingQueueButton();
}

function shopPurchaseLocation(upgrade) {
  const category = shopView.categoryNames.get(upgrade.group);
  const section = localizedName(upgrade.sectionNames, upgrade.section);
  return [category, section === category ? '' : section].filter(Boolean).join(' › ');
}

function shoppingCheckbox(mode, key, name) {
  const input = create('input');
  input.type = 'checkbox';
  input.checked = shopView.choices[mode].has(key);
  input.setAttribute('aria-label', t('选择 {name}', { name }));
  input.addEventListener('click', event => event.stopPropagation());
  input.addEventListener('change', () => {
    if (input.checked) shopView.choices[mode].add(key);
    else shopView.choices[mode].delete(key);
    byId('shopQueueStatus').textContent = '';
    updateShoppingQueueButton();
  });
  return input;
}

function selectedShoppingCosts() {
  const { byPurchase, rows } = shopView.queueChoices;
  const selected = shopView.choices[byPurchase ? 'purchase' : 'resource'];
  const costs = byPurchase ? rows.filter(row => selected.has(row.upgrade.id)).flatMap(({ upgrade, remaining }) =>
    upgrade.costs.map(cost => ({ ...cost, total: cost.quantity * remaining }))) :
    rows.filter(row => selected.has(row.type + ':' + row.id));
  const resources = new Map();
  for (const { total, id, type } of costs) if (total > 0) {
    const key = type + ':' + id;
    if (!resources.has(key)) resources.set(key, { type, id, total: 0 });
    resources.get(key).total += total;
  }
  return [...resources.values()];
}

function updateShoppingQueueButton() {
  byId('shopToQueue').disabled = !shopView.character?.characterId || !selectedShoppingCosts().length;
}

function addShoppingQueue() {
  const actor = shopView.character;
  const notice = byId('shopQueueStatus');
  const costs = selectedShoppingCosts();
  const missingCurrencies = costs.filter(cost => cost.type === 'currency' && cost.total > (actor.currencies?.[cost.id] ?? 0));
  const shopping = new Map(costs.filter(cost => cost.type === 'item').map(cost => [cost.id, cost.total]));
  const result = planProduction(catalog, actor, productionView.index, null, 0, true, productionCycle, { shopping });
  if (result.missing.length) {
    notice.textContent = t('以下材料暂无可执行的产线：{items}', { items: result.missing.map(questItem).join(' · ') });
    return;
  }
  const steps = productionQueueSteps(result);
  if (steps.some(step => !validQueueStep(step))) {
    notice.textContent = t('所选产线包含需手动完成的步骤，无法整批加入队列。');
    return;
  }
  if (!steps.length) {
    notice.textContent = t(missingCurrencies.length ? '所选项目的货币仍有缺口，需另行准备。' : '所选项目的材料已齐备。');
    return;
  }
  if (missingCurrencies.length) {
    const names = missingCurrencies.map(cost => shopCurrencyName(cost.id)).join(' · ');
    if (!confirm(t('仍需另行准备 {items}。继续添加材料产线？', { items: names }))) return;
  }
  if (!appendQueuePlan(steps)) notice.textContent = t(queueBusy() ? '挂机中，队列已锁定。' : '队列最多可添加 200 步。');
}

function renderShopPurchase({ upgrade, remaining, purchased, visibility }, expanded, showPurchased, showPending) {
  const detail = create('details');
  detail.dataset.resource = 'purchase:' + upgrade.id;
  detail.open = expanded.has(detail.dataset.resource);
  const name = gameName(upgrade);
  const summary = create('summary', undefined, 'shop-row shop-purchase-summary');
  const heading = create('span', undefined, 'shop-purchase-row');
  if (remaining && upgrade.costs.length) heading.append(shoppingCheckbox('purchase', upgrade.id, name));
  heading.append(create('strong', name), create('span', shopPurchaseLocation(upgrade), 'muted'));
  if (purchased) heading.append(create('small', t('已购买') + ' × ' + fullNumber(purchased), 'purchase-badge'));
  summary.append(heading);
  const uses = create('div', undefined, 'shop-uses');
  const requirements = [...upgrade.requirements, ...upgrade.displayRequirements.flat()]
    .map(requirement => describeShopGate(requirement, shopView.shop)).filter(Boolean);
  if (requirements.length || visibility.reason) uses.append(create('p',
    [visibility.reason && t(visibility.reason), ...new Set(requirements)].filter(Boolean).join(' · '), 'muted'));
  const table = create('table');
  const header = create('thead');
  const titles = create('tr');
  const columns = ['材料', ...(showPurchased ? ['已购用量'] : []),
    ...(showPending ? ['未购总需', '仓库 / 余额', '还缺'] : [])];
  titles.append(...columns.map(label => create('th', t(label))));
  header.append(titles);
  const body = create('tbody');
  for (const cost of upgrade.costs) {
    const currency = cost.type === 'currency';
    const bank = shopView.character.date ? ((currency ? shopView.character.currencies : shopView.character.stock)?.[cost.id] ?? 0) : null;
    const needed = cost.quantity * remaining;
    const values = [currency ? shopCurrencyName(cost.id) : questItem(cost.id),
      ...(showPurchased ? [fullNumber(purchased * cost.quantity)] : []),
      ...(showPending ? [fullNumber(needed), bank === null ? '—' : fullNumber(bank),
        bank === null ? '—' : fullNumber(Math.max(0, needed - bank))] : [])];
    const row = create('tr');
    row.append(...values.map(value => create('td', value)));
    body.append(row);
  }
  table.append(header, body);
  uses.append(table);
  detail.append(summary, uses);
  return detail;
}

function describeShopGate(requirement, shop) {
  const target = gameName(requirement) ?? t('未知名称');
  switch (requirement.type) {
    case 'Level':
      return t('{skill} {level} 级', { skill: skillName(requirement.skill, shop.skillNames), level: requirement.level });
    case 'ShopPurchase':
      return t(requirement.amount > 1 ? '先购买「{name}」 {count} 次' : '先购买「{name}」', { name: target, count: requirement.amount });
    case 'DungeonStatistic':
      return t('通关「{name}」{count} 次', { name: target, count: requirement.amount });
    case 'SlayerMasterStatistic':
      return t('完成「{name}」的任务 {count} 次', { name: target, count: requirement.amount });
    case 'QuestComplete':
      return t('完成任务「{name}」', { name: target });
    default:
      return null;
  }
}

function renderShopResource(resource, expanded, showPurchased, showPending) {
  const { shop, categoryNames, items } = shopView;
  const detail = create('details');
  detail.dataset.resource = resource.type + ':' + resource.id;
  detail.open = expanded.has(detail.dataset.resource);
  const summary = create('summary', undefined, 'shop-row');
  const columns = create('div', undefined, 'shop-row shop-row-content');
  const value = number => number === null ? '—' : fullNumber(number);
  const nameLabel = resource.type === 'currency' ? shopCurrencyName(resource.id) :
    gameName(items[resource.id]) ?? t('未知物品');
  const resourceName = create('span', undefined, 'resource-name shop-purchase-row');
  if (showPending && resource.total > 0) resourceName.append(shoppingCheckbox('resource', detail.dataset.resource, nameLabel));
  resourceName.append(create('span', nameLabel + ' · ' + t('{count} 项', { count: resource.uses.length })));
  columns.append(
    resourceName,
    create('span', value(resource.spent), 'number spent-col'),
    create('span', value(resource.total), 'number pending-col'),
    create('span', value(resource.available), 'number'),
    create('span', showPending ? value(resource.shortage) : '—', resource.shortage > 0 ? 'number gold pending-col' : 'number pending-col')
  );
  summary.append(columns);

  const uses = create('div', undefined, 'shop-uses');
  if (resource.type === 'item' && showPending && resource.shortage > 0) {
    const sources = create('details', undefined, 'shop-source-comparison');
    sources.dataset.resource = 'sources:' + detail.dataset.resource;
    sources.open = expanded.has(sources.dataset.resource);
    sources.append(create('summary', t('比较获取途径')));
    const showSources = () => {
      if (sources.open && sources.childElementCount === 1) {
        sources.append(questSourceList(questSourcesFor(resource.id), resource.id, resource.shortage));
      }
    };
    sources.addEventListener('toggle', showSources);
    showSources();
    uses.append(sources);
  }
  const table = create('table');
  const header = create('thead');
  const headings = create('tr');
  headings.append(create('th', t('升级')), create('th', t('商店位置')));
  if (showPurchased) headings.append(create('th', t('已购用量'), 'number'));
  if (showPending) headings.append(create('th', t('未购需求'), 'number'));
  header.append(headings);
  const body = create('tbody');
  body.append(...resource.uses.map(({ upgrade, remaining, total, purchased, spent, visibility }) => {
    const row = create('tr');
    const name = create('td', gameName(upgrade));
    const requirements = [...new Set([...upgrade.requirements, ...upgrade.displayRequirements.flat()]
      .map(requirement => describeShopGate(requirement, shop)).filter(Boolean))];
    if (remaining > 1) requirements.push(t('剩余 {count} 次', { count: remaining }));
    const status = {
      hidden: t('当前隐藏') + ' · ' + t(visibility.reason ?? ''),
      visible: t(visibility.unlocked === false ? '当前显示 · 尚未解锁' : '当前显示'),
      unknown: t('显示状态待核对'),
      reference: t(upgrade.referenceReason ?? '')
    }[visibility.state];
    if (purchased) name.append(create('small', t('已购买') + (purchased > 1 ? ' × ' + purchased : ''), 'purchase-badge'));
    if (remaining || visibility.state === 'reference') {
      name.append(create('small', status, visibility.state === 'hidden' ? 'gold' : undefined));
    }
    if (requirements.length) name.append(create('small', requirements.join(' · ')));
    const category = categoryNames.get(upgrade.group);
    const section = localizedName(upgrade.sectionNames, upgrade.section);
    const location = category === section ? category : category + ' › ' + section;
    row.append(name, create('td', location));
    if (showPurchased) row.append(create('td', purchased ? fullNumber(spent) : '—', 'number'));
    if (showPending) row.append(create('td', remaining ? fullNumber(total) : '—', 'number'));
    return row;
  }));
  table.append(header, body);
  uses.append(table);
  detail.append(summary, uses);
  return detail;
}

if (typeof module !== 'undefined') module.exports = { calculateShoppingList };
