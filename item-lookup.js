const itemLookupPageSize = 20;
let itemLookupIndex;
let itemLookupMatches = [];
let itemLookupOffset = 0;
let itemLookupSelected;
const itemUseLabels = {
  ingredient: '配方材料', entry: '入场消耗', automation: '自动化消耗', purchaseCost: '购买消耗',
  bait: '诱饵', tool: '工具', animalFood: '动物饲料', bonfire: '篝火消耗', spell: '施法消耗',
  upgrade: '升级材料', submit: '任务交付', collect: '任务收集目标', container: '打开容器',
  equipment: '可装备', food: '食物', compost: '堆肥', bury: '可掩埋', trap: '捕猎陷阱',
  ammo: '武器弹药', imbuement: '赋能消耗', toolbelt: '工具栏装备'
};

function initItemLookup() {
  itemLookupIndex = Object.entries(catalog.items).map(([id, item]) => {
    const simplified = item.names?.zh ?? item.name;
    const aliases = new Set([id, 'MelvorBase:' + id, item.name, ...Object.values(item.names ?? {}),
      simplified && traditionalText(simplified)].filter(name => typeof name === 'string').map(normalizedSuggestion));
    return {
      id, item, aliases: [...aliases], price: Number.isFinite(item.price) ? item.price : 0
    };
  });
  const search = byId('itemLookupSearch');
  search.addEventListener('input', event => {
    if (!event.isComposing) searchItemLookup();
  });
  search.addEventListener('compositionend', searchItemLookup);
  search.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && itemLookupMatches.length) {
      const query = normalizedSuggestion(search.value);
      const exact = itemLookupMatches.find(entry => entry.aliases.includes(query));
      selectItemLookup((exact ?? itemLookupMatches[itemLookupOffset]).id, true);
    }
  });
  byId('itemLookupSort').addEventListener('change', searchItemLookup);
  byId('itemLookupPrevious').addEventListener('click', () => {
    itemLookupOffset -= itemLookupPageSize;
    renderItemLookupList();
  });
  byId('itemLookupNext').addEventListener('click', () => {
    itemLookupOffset += itemLookupPageSize;
    renderItemLookupList();
  });
}

function localizeItemLookup() {
  if (!itemLookupIndex) return;
  const collator = new Intl.Collator(uiLocale(), { numeric: true });
  for (const entry of itemLookupIndex) entry.label = gameName(entry.item) ?? t('未知物品');
  itemLookupIndex.sort((a, b) => collator.compare(a.label, b.label) || a.id.localeCompare(b.id));
  searchItemLookup();
  renderItemLookupDetail();
}

function searchItemLookup() {
  const query = normalizedSuggestion(byId('itemLookupSearch').value);
  const order = byId('itemLookupSort').value;
  itemLookupMatches = itemLookupIndex.filter(entry => !query || entry.aliases.some(name => name.includes(query)));
  if (order === 'price-desc' || order === 'price-asc') {
    const direction = order === 'price-desc' ? -1 : 1;
    itemLookupMatches.sort((a, b) => direction * (a.price - b.price));
  }
  itemLookupOffset = 0;
  renderItemLookupList();
}

function renderItemLookupList() {
  const end = Math.min(itemLookupOffset + itemLookupPageSize, itemLookupMatches.length);
  const list = byId('itemLookupList');
  list.replaceChildren(...itemLookupMatches.slice(itemLookupOffset, end).map(({ id, label, price }) => {
    const row = create('li');
    const button = create('button');
    button.append(create('span', label));
    button.append(create('small', formatGp(price), 'item-lookup-value'));
    button.type = 'button';
    button.setAttribute('aria-pressed', String(itemLookupSelected === id));
    button.addEventListener('click', () => selectItemLookup(id, true));
    row.append(button);
    return row;
  }));
  byId('itemLookupCount').textContent = itemLookupMatches.length
    ? t('第 {first}–{last} 项，共 {total} 项', {
      first: fullNumber(itemLookupOffset + 1), last: fullNumber(end), total: fullNumber(itemLookupMatches.length)
    }) : t('没有找到匹配的物品。');
  byId('itemLookupPrevious').disabled = itemLookupOffset === 0;
  byId('itemLookupNext').disabled = end >= itemLookupMatches.length;
}

function selectItemLookup(id, reveal) {
  itemLookupSelected = id;
  const index = itemLookupMatches.findIndex(item => item.id === id);
  if (index >= 0) itemLookupOffset = Math.floor(index / itemLookupPageSize) * itemLookupPageSize;
  renderItemLookupList();
  renderItemLookupDetail();
  if (reveal) {
    const title = byId('itemLookupDetailTitle');
    title.focus({ preventScroll: true });
    if (matchMedia('(max-width: 780px)').matches) title.scrollIntoView({ block: 'start' });
  }
}

function itemLookupLink(id, quantity) {
  if (!Object.hasOwn(catalog.items, id)) return null;
  const label = questItem(id) + (Number.isFinite(quantity) ? ' × ' + fullNumber(quantity) : '');
  const button = create('button', label, 'item-lookup-related');
  button.type = 'button';
  button.addEventListener('click', () => selectItemLookup(id, true));
  return button;
}

function appendItemLookupRelated(row, label, entries) {
  const links = entries.map(({ item, quantity }) => itemLookupLink(item, quantity)).filter(Boolean);
  if (!links.length) return;
  const related = create('div', undefined, 'item-lookup-related-list');
  related.append(create('span', t(label), 'muted'), ...links);
  row.append(related);
}

function renderItemLookupSource(where) {
  const row = create('li');
  const quantity = !Number.isFinite(where.min) ? '' : where.min === where.max || !Number.isFinite(where.max)
    ? ' × ' + fullNumber(where.min) : ' × ' + fullNumber(where.min) + '–' + fullNumber(where.max);
  row.append(create('strong', questSourceLabel(where) + quantity));
  const notes = questSourceNotes(where, []);
  if (notes.length) row.append(create('small', notes.join(' · ')));
  appendItemLookupRelated(row, '所需材料', where.ingredients);
  if (where.container) appendItemLookupRelated(row, '容器', [{ item: where.container }]);
  return row;
}

function renderItemLookupUse(where) {
  const row = create('li');
  const showPath = where.skill || !where.target?.startsWith('Item:');
  const parts = [t(itemUseLabels[where.kind]), showPath && questSourcePath(where),
    where.step && t('第 {step} 步', { step: fullNumber(where.step) })].filter(Boolean);
  if (Number.isFinite(where.quantity)) parts[parts.length - 1] += ' × ' + fullNumber(where.quantity);
  row.append(create('strong', parts.join(' · ')));
  const outputs = [...new Set(where.outputs)].filter(id => id !== itemLookupSelected);
  appendItemLookupRelated(row, '产出物品', outputs.map(item => ({ item })));
  return row;
}

function renderItemLookupDetail() {
  const detail = byId('itemLookupDetail');
  if (!itemLookupSelected) {
    detail.replaceChildren(create('p', t('选择物品查看来源和用途。'), 'muted'));
    return;
  }
  const title = create('h2', questItem(itemLookupSelected));
  title.id = 'itemLookupDetailTitle';
  title.tabIndex = -1;
  const price = create('p', t('单件售价 {value}', {
    value: formatGp(catalog.items[itemLookupSelected].price ?? 0)
  }), 'muted');
  const groups = create('div', undefined, 'item-lookup-groups');
  const sources = questSourcesFor(itemLookupSelected);
  const uses = questGuide.itemUses?.[itemLookupSelected] ?? [];
  for (const [heading, records, render, empty] of [
    ['获取来源', sources, renderItemLookupSource, '游戏数据中未找到获取来源。'],
    ['物品用途', uses, renderItemLookupUse, '游戏数据中未找到用途。']
  ]) {
    const group = create('section');
    group.append(create('h3', t(heading)));
    if (records.length) {
      const list = create('ul');
      list.append(...records.map(render));
      group.append(list);
    } else group.append(create('p', t(empty), 'muted'));
    groups.append(group);
  }
  detail.replaceChildren(title, price, groups);
}
