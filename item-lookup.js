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
const itemEffectGroups = {
  equipment: '装备效果', tool: '工具效果', food: '食物效果', bait: '诱饵效果',
  compost: '堆肥效果', trap: '陷阱效果', trapFail: '捕猎失败时', attack: '特殊攻击', set: '套装效果'
};
const itemEffectNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
const itemLookupHash = id => '#item-lookup/' + encodeURIComponent(id);

function itemDetailLabel(id, language = uiLanguage) {
  const names = catalog.itemDetailLabels?.[id]?.names;
  const value = names?.[language] ?? (language === 'zh-Hant' ? names?.zh : undefined);
  return language === 'zh-Hant' ? traditionalText(value) : value;
}

function itemEffectValue(value, unit, signed, language = uiLanguage) {
  const amount = unit === 'percent' ? value * 100 : unit === 'seconds' ? value / 1000 : value;
  return (signed && amount > 0 ? '+' : '') + itemEffectNumber.format(amount) +
    (unit === 'percent' ? '%' : unit === 'seconds' ? language === 'en' ? 's' : ' 秒' : '');
}

function plainItemText(text) {
  return text.replace(/\[\/?(?:b|i|u|s|color|url|font|font_size|center|left|right)(?:=[^\]]*)?\]/gi, '');
}

function itemModifierText(row, language = uiLanguage) {
  const label = id => itemDetailLabel(id, language);
  if (row.template && label(row.template)) {
    const template = label(row.template);
    const value = itemEffectValue(row.value, row.unit, true, language);
    return plainItemText(template.replace(/\{[^{}]+\}/g, token => {
      if (token.startsWith('{Value:cond:')) {
        return /Increased|Decreased/.test(token) ? (row.value < 0 ? 'Decreased' : 'Increased') : '';
      }
      if (token === '{0:combatStatModifier:}') {
        const percent = row.stat === 'PercentCombatStatValue';
        return itemEffectValue(row.value, percent ? 'percent' : undefined, true, language);
      }
      if (token.startsWith('{Value:')) {
        return /Increased|Decreased/.test(template) ? itemEffectValue(Math.abs(row.value), row.unit, false, language) : value;
      }
      return label(row.args?.[token]) ?? '';
    })).trim();
  }
  const name = label(row.name ?? row.statLabel);
  if (!Number.isFinite(row.value)) return name ?? '';
  const rating = { power: '战力（{type}）', protection: '防护（{type}）' }[row.rating];
  const description = rating ? (language === 'en' ? { power: 'Power ({type})', protection: 'Protection ({type})' }[row.rating]
    : language === 'zh-Hant' ? traditionalText(rating) : rating).replace('{type}', name ?? '') : name;
  const stat = description ?? (language === 'en' ? row.stat?.replace(/([a-z])([A-Z])/g, '$1 $2') : undefined);
  return [stat, itemEffectValue(row.value, row.unit, Boolean(row.polarity), language)].filter(Boolean).join(' ');
}

function itemEffectMatches(entry, terms) {
  return entry.effects.filter(({ aliases }) => terms.every(term => aliases.some(name => name.includes(term))));
}

function syncItemLookupHash() {
  if (!itemLookupIndex || !location.hash.startsWith('#item-lookup/')) return;
  const entry = itemLookupIndex.find(({ id }) => itemLookupHash(id) === location.hash);
  if (entry && entry.id !== itemLookupSelected) selectItemLookup(entry.id, true);
}

function itemResultLink(id, label) {
  const link = create('a', label, 'item-lookup-result-link');
  link.href = itemLookupHash(id);
  link.addEventListener('click', event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (location.hash !== link.hash) history.pushState(null, '', link.hash);
    selectItemLookup(id, true);
  });
  return link;
}

function initItemLookup() {
  itemLookupIndex = Object.entries(catalog.items).map(([id, item]) => {
    const simplified = item.names?.zh ?? item.name;
    const aliases = new Set([id, 'MelvorBase:' + id, item.name, ...Object.values(item.names ?? {}),
      simplified && traditionalText(simplified)].filter(name => typeof name === 'string').map(normalizedSuggestion));
    const details = catalog.itemDetails?.[id];
    const effects = [...(details?.stats ?? []), ...(details?.effects ?? [])].map(row => {
      const keywords = ['en', 'zh', 'zh-Hant'].flatMap(language => [
        itemModifierText(row, language), itemDetailLabel(row.group?.name, language),
        ...row.skills?.map(skill => itemDetailLabel('skill:' + skill, language)) ?? []
      ]);
      if (row.globalSkillEffect) {
        for (const [skill, name] of Object.entries(catalog.xpSkills)) keywords.push(skill, name, traditionalText(name));
      }
      if (row.globalSkillEffect || row.skills?.includes('Astrology')) keywords.push('星象', '占星', 'astrology');
      if (/^Stab/.test(row.stat ?? '')) keywords.push('戳刺', '刺击', '穿刺', 'stab');
      if (row.polarity) keywords.push(row.polarity, ...(row.polarity === 'buff' ? ['增益'] : ['减益', '減益']));
      return { row, aliases: keywords.filter(Boolean).map(normalizedSuggestion) };
    });
    return { id, item, aliases: [...aliases], effects, price: Number.isFinite(item.price) ? item.price : 0 };
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
      const { id } = exact ?? itemLookupMatches[itemLookupOffset];
      if (location.hash !== itemLookupHash(id)) history.pushState(null, '', itemLookupHash(id));
      selectItemLookup(id, true);
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
  syncItemLookupHash();
  renderItemLookupDetail();
}

function searchItemLookup() {
  const input = byId('itemLookupSearch').value.trim();
  const query = normalizedSuggestion(input);
  const terms = input.split(/\s+/u).map(normalizedSuggestion).filter(Boolean);
  const order = byId('itemLookupSort').value;
  itemLookupMatches = itemLookupIndex.filter(entry => {
    entry.matchedEffects = query ? itemEffectMatches(entry, terms) : [];
    return !query || entry.matchedEffects.length || entry.aliases.some(name => name.includes(query));
  });
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
  list.replaceChildren(...itemLookupMatches.slice(itemLookupOffset, end).map(({ id, label, price, matchedEffects }) => {
    const row = create('li');
    const link = itemResultLink(id, label);
    link.replaceChildren(create('span', label), create('small', formatGp(price), 'item-lookup-value'));
    if (itemLookupSelected === id) link.setAttribute('aria-current', 'true');
    if (matchedEffects.length) {
      const preview = create('small', itemModifierText(matchedEffects[0].row), 'item-effect-match');
      preview.dataset.polarity = matchedEffects[0].row.polarity ?? '';
      link.append(preview);
    }
    row.append(link);
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

function renderItemProperties(data) {
  if (!data) return null;
  const section = create('section', undefined, 'item-properties');
  const description = itemDetailLabel(data.description);
  if (description) section.append(create('p', plainItemText(description), 'muted'));
  const slot = itemDetailLabel(data.slot);
  const occupied = data.occupies.map(id => itemDetailLabel(id)).filter(Boolean);
  const requirements = requirementClauses([data.requirements]).map(clause =>
    clause.map(questSourceRequirementText).filter(Boolean).join(' / ')).filter(Boolean);
  const facts = [
    slot && t('装备栏位：{slot}', { slot }),
    occupied.length && t('同时占用：{slots}', { slots: occupied.join(' · ') }),
    requirements.length && t('装备要求：{conditions}', { conditions: requirements.join(' · ') }),
    data.healing > 0 && t('恢复生命值 +{value}', { value: decimals.format(data.healing) })
  ].filter(Boolean);
  if (facts.length) section.append(create('p', facts.join(' · '), 'muted'));
  if (data.stats.length) {
    const grid = create('ul', undefined, 'item-stat-grid');
    for (const stat of data.stats) {
      const row = create('li', itemModifierText(stat));
      row.dataset.polarity = stat.polarity ?? '';
      grid.append(row);
    }
    section.append(create('h3', t('装备属性')), grid);
  }
  if (data.effects.length) {
    section.append(create('h3', t('增益与减益')));
    const groups = new Map();
    for (const effect of data.effects) {
      const { type, name, count, chance } = effect.group;
      const label = [t(itemEffectGroups[type]), itemDetailLabel(name), count && t('{value} 件', { value: fullNumber(count) }),
        Number.isFinite(chance) && itemEffectValue(chance, 'percent', false)].filter(Boolean).join(' · ');
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(effect);
    }
    const cards = create('div', undefined, 'item-effect-groups');
    for (const [heading, effects] of groups) {
      const group = create('section');
      const list = create('ul');
      for (const effect of effects) {
        const text = itemModifierText(effect);
        if (!text || effect.name === effect.group.name && !effect.polarity) continue;
        const note = [effect.target && t('施加给目标'), Number.isFinite(effect.chance) && itemEffectValue(effect.chance, 'percent', false),
          effect.conditional && t('按条件生效')].filter(Boolean);
        const row = create('li', text);
        row.dataset.polarity = effect.polarity ?? '';
        if (note.length) row.append(create('small', note.join(' · '), 'muted'));
        list.append(row);
      }
      group.append(create('h4', heading), list);
      cards.append(group);
    }
    section.append(cards);
  }
  return section.childElementCount ? section : null;
}

function renderItemLookupDetail() {
  const detail = byId('itemLookupDetail');
  if (!itemLookupSelected) {
    detail.replaceChildren(create('p', t('选择物品查看属性、来源和用途。'), 'muted'));
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
  const properties = renderItemProperties(catalog.itemDetails?.[itemLookupSelected]);
  detail.replaceChildren(title, price, ...(properties ? [properties] : []), groups);
}
