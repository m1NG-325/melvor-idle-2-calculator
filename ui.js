'use strict';

const byId = id => document.getElementById(id);
let numbers;
let decimals;
const fullNumber = value => numbers.format(value);
const formattedHours = value => decimals.format(value) + (uiLanguage === 'en' ? ' hr' : ' 小时');
const actionArea = action => action.areaNames?.[uiLanguage] ?? action.area;
let catalog;
let profile;
let results = [];
let showCount = 15;
let profileRequest = 0;

function create(tag, content, className) {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = content;
  if (className) element.className = className;
  return element;
}

async function get(route) {
  const response = await fetch(route);
  const body = await response.json();
  if (!response.ok) throw new Error(t(body.error));
  return body;
}

function manualProfile() {
  return { name: '', levels: { Woodcutting: 1 }, stock: {}, currencies: {}, keep: [] };
}

function configureProfile(data) {
  profile = { ...data, bonuses: data.bonuses ?? {}, confirmed: [], excluded: [] };
  renderProfile();
}

function renderProfile(keepCount = false) {
  byId('levels').replaceChildren(...Object.keys(catalog.skills).map(id => {
    const row = create('tr');
    const bonus = profile.bonuses[id] ?? {};
    row.append(create('th', skillName(id, catalog.skills)));
    for (const [key, title, value, min, max] of [
      ['level', '等级', profile.levels[id] ?? 0, 0, 99],
      ['interval', '间隔变化百分比', bonus.interval ?? 0, -90, 500],
      ['output', '产量变化百分比', bonus.output ?? 0, -99, 1000]
    ]) row.append(numberCell(skillName(id, catalog.skills) + ' · ' + t(title), id, key, value, min, max));

    const extra = {
      Thieving: ['stealth', '额外隐匿'],
      Cooking: ['proficiency', '额外熟练度'],
      Fishing: ['fishChance', '额外鱼获概率百分点']
    }[id];
    row.append(extra ? numberCell(t(extra[1]), id, extra[0], bonus[extra[0]] ?? 0, 0, 10000, t(extra[1])) : create('td', '—'));
    return row;
  }));
  byId('editStatus').textContent = '';
  calculate(keepCount);
  updateShop(profile);
  updateExperience(profile);
}

function numberCell(label, skill, key, value, min, max, placeholder) {
  const cell = create('td');
  const input = create('input');
  input.type = 'number';
  input.min = min;
  input.max = max;
  input.step = key === 'level' ? 1 : 'any';
  input.value = value;
  if (placeholder) cell.append(create('small', placeholder));
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => {
    if (!input.checkValidity() || input.value === '') {
      input.value = key === 'level' ? profile.levels[skill] ?? 0 : profile.bonuses[skill]?.[key] ?? 0;
      return;
    }
    if (key === 'level') profile.levels[skill] = input.valueAsNumber;
    else (profile.bonuses[skill] ??= {})[key] = input.valueAsNumber;
    calculate();
    updateExperience(profile);
  });
  cell.append(input);
  return cell;
}

function calculate(keepCount = false) {
  if (!profile || !byId('options').checkValidity()) return;
  const hours = byId('hours').valueAsNumber;
  const offlineCap = byId('cap').valueAsNumber;
  const sell = byId('sell').checked;
  const metric = byId('metric').value;
  results = rank(catalog, profile, { hours, offlineCap, sell, metric });
  const now = profile.date && new Date(profile.date).toLocaleString(uiLocale(), { hour12: false });
  const source = now ? t('存档 {name}', { name: profile.name }) + ' · ' + now : t('手动设置');
  const countdown = offlineCap && offlineCap < hours ? ['离线最多结算 {time}'] : [];
  byId('status').textContent = [
    source, t('仓库 {count} 种物品', { count: fullNumber(Object.keys(profile.stock).length) }),
    t('{count} 项正收益方案', { count: fullNumber(results.length) }),
    ...countdown.map(message => t(message, { time: formattedHours(offlineCap) }))
  ].join(' · ');
  byId('status').classList.remove('error');
  const winner = results[0];
  byId('winner').hidden = !winner;
  if (winner) showWinner(winner, sell);
  if (keepCount !== true) showCount = 15;
  renderResults();
}

function showWinner(winner, sell) {
  const { action, net, payout, netPerHour, payoutPerHour, materialCost, direct, sales } = winner;
  byId('winnerName').textContent = [skillName(action.skill, catalog.skills), gameName(action), actionArea(action)].filter(Boolean).join(' · ');
  byId('metrics').replaceChildren(...[
    ['预计净收益', net], ['预计到手 GP', payout], ['净 GP/小时', netPerHour], ['到手 GP/小时', payoutPerHour]
  ].map(([label, value]) => {
    const field = create('div', t(label));
    field.append(create('strong', fullNumber(value)));
    return field;
  }));
  byId('winnerDetail').textContent = [
    t('直接 GP {value}', { value: fullNumber(direct) }),
    ...(sell ? [t('出售收入 {value}', { value: fullNumber(sales) })] : []),
    t('材料原值 {value}', { value: fullNumber(materialCost) }),
    t('{value} 次', { value: fullNumber(winner.cycles) }),
    winner.limit ? t('约 {time}后用完{item}', { time: formattedHours(winner.activeHours), item: limitName(winner) })
      : t('在本次计时时长内材料充足')
  ].join(' · ');
}

function renderResults() {
  const skill = byId('filter').value;
  const text = byId('search').value.trim().toLowerCase();
  const matches = results.filter(({ action }) => (!skill || skill === action.skill) &&
    (!text || [action.id, action.name, action.area, catalog.skills[action.skill], gameName(action), actionArea(action),
      ...Object.values(action.names ?? {}), ...Object.values(action.areaNames ?? {})]
      .some(value => value?.toLowerCase().includes(text))));
  byId('empty').hidden = !!matches.length;
  byId('empty').textContent = t(results.length ? '当前筛选没有匹配项。' : '没有正收益方案。检查技能等级、库存或出售选项。');
  byId('ranking').hidden = !matches.length;
  byId('more').hidden = matches.length <= showCount;
  byId('rows').replaceChildren(...matches.slice(0, showCount).map(result => {
    const { action, net, payout, netPerHour, limit, activeHours } = result;
    const row = create('tr');
    const plan = create('td', gameName(action));
    const line = [skillName(action.skill, catalog.skills), actionArea(action)].filter(Boolean).join(' · ');
    plan.append(create('small', line));
    row.append(plan, create('td', fullNumber(net), 'number gold'),
      create('td', fullNumber(payout), 'number'), create('td', fullNumber(netPerHour), 'number'),
      create('td', limit ? t('{time} · {item}用完', { time: formattedHours(activeHours), item: limitName(result) }) : '—'));
    return row;
  }));
}

function limitName(row) {
  const id = row.limit;
  return gameName(catalog.items[id]) ?? shopCurrencyName(id);
}

async function loadProfile() {
  const current = ++profileRequest;
  const selected = byId('save').value;
  try {
    const data = selected === '' ? manualProfile() : await get('profile/' + selected);
    if (current === profileRequest) configureProfile(data);
  } catch (error) {
    if (current !== profileRequest) return;
    byId('save').value = '';
    configureProfile(manualProfile());
    byId('status').textContent = error.message;
    byId('status').classList.add('error');
  }
}

async function refreshSaves() {
  const selectedName = byId('save').selectedOptions[0]?.text;
  const select = byId('save');
  try {
    const saves = await get('saves');
    select.replaceChildren(...saves.map(({ index, name, unknown }) => {
      const option = new Option(unknown ? t('存档 {count}（格式未知）', { count: index + 1 }) : name, index);
      if (unknown) option.dataset.unknown = 'true';
      return option;
    }), new Option(t('手动设置'), ''));
    const previous = Array.from(select.options).find(option => option.text === selectedName);
    if (previous && previous.value !== '') select.value = previous.value;
    await loadProfile();
  } catch (error) {
    select.replaceChildren(new Option(t('手动设置'), ''));
    configureProfile(manualProfile());
    byId('status').textContent = error.message;
    byId('status').classList.add('error');
  }
}

function findItem() {
  const value = byId('item').value.trim();
  return Object.hasOwn(catalog.items, value) ? value :
    Object.keys(catalog.items).find(id => Object.values(catalog.items[id].names ?? { original: catalog.items[id].name })
      .some(name => name + ' · ' + id === value));
}

function editItem() {
  const id = findItem();
  const quantity = byId('quantity');
  if (!id || quantity.value === '' || !quantity.checkValidity()) {
    byId('editStatus').textContent = t('请选择有效物品并输入非负整数。');
    return;
  }
  if (quantity.valueAsNumber) profile.stock[id] = quantity.valueAsNumber;
  else delete profile.stock[id];
  byId('editStatus').textContent = t(profile.keep.includes(id)
    ? '{item}可用数量设为 {value}，仓库锁定设置仍生效。' : '{item}可用数量设为 {value}。', {
    item: gameName(catalog.items[id]), value: fullNumber(quantity.valueAsNumber)
  });
  calculate();
  updateShop(profile);
  updateExperience(profile);
}

function setAction(include) {
  const value = byId('action').value.trim();
  const action = catalog.actions.find(entry => value === entry.id ||
    Object.values(entry.names ?? { original: entry.name }).some(name => value === name + ' · ' + entry.id));
  if (!action) {
    byId('editStatus').textContent = t('请选择一个已有动作。');
    return;
  }
  profile.confirmed = profile.confirmed.filter(id => id !== action.id);
  profile.excluded = profile.excluded.filter(id => id !== action.id);
  (include ? profile.confirmed : profile.excluded).push(action.id);
  byId('editStatus').textContent = t(include ? '{name}已确认解锁，仍按等级、库存和偷窃安全条件计算。' : '{name}已排除。', {
    name: gameName(action)
  });
  calculate();
  updateExperience(profile);
}

async function init() {
  function showPage() {
    const page = { '#shop': 'shop', '#experience': 'xp' }[location.hash] ?? 'rank';
    for (const key of ['rank', 'xp', 'shop']) {
      byId(key + 'Page').hidden = key !== page;
      const link = byId(key + 'Link');
      if (key === page) {
        link.setAttribute('aria-current', 'page');
        byId('activePage').textContent = t({ rank: '挂机收益', xp: '经验效率', shop: '商店升级' }[page]);
      } else link.removeAttribute('aria-current');
    }
  }
  function localizeControls() {
    applyLanguage();
    numbers = new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: 0 });
    decimals = new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: 2 });
    showPage();
    if (!catalog) return;
    byId('source').textContent = t('Steam 构建 {build} · {count} 项动作', {
      build: t(catalog.build), count: fullNumber(catalog.actions.length)
    });
    for (const option of byId('save').options) {
      if (option.value === '') option.text = t('手动设置');
      else if (option.dataset.unknown) option.text = t('存档 {count}（格式未知）', { count: +option.value + 1 });
    }
    for (const option of byId('filter').options) {
      if (option.value) option.text = skillName(option.value, catalog.skills);
    }
    byId('items').replaceChildren(...Object.entries(catalog.items).map(([id, item]) => new Option('', gameName(item) + ' · ' + id)));
    byId('actions').replaceChildren(...catalog.actions.map(action => new Option('', gameName(action) + ' · ' + action.id)));
    localizeExperience();
    localizeShop();
    if (profile) renderProfile(true);
  }
  byId('language').addEventListener('change', event => {
    uiLanguage = event.currentTarget.value;
    const url = new URL(location.href);
    url.searchParams.set('lang', uiLanguage);
    history.replaceState(null, '', url);
    localizeControls();
  });
  window.addEventListener('hashchange', showPage);
  localizeControls();
  try {
    catalog = await get('catalog');
    initExperience(catalog);
    const shopLoad = get('shop').then(shop => {
      initShop(shop, catalog.items);
      if (profile) updateShop(profile);
    }).catch(error => {
      byId('shopStatus').textContent = t('商店数据读取失败。请重新启动计算器。') + ' ' + error.message;
    });
    const filter = byId('filter');
    for (const [id, name] of Object.entries(catalog.skills)) filter.append(new Option(name, id));
    localizeControls();
    byId('options').addEventListener('submit', event => { event.preventDefault(); calculate(); });
    byId('options').addEventListener('change', calculate);
    for (const button of document.querySelectorAll('[data-hours]')) {
      button.addEventListener('click', () => { byId('hours').value = button.dataset.hours; calculate(); });
    }
    for (const id of ['filter', 'search']) {
      byId(id).addEventListener('input', () => { showCount = 15; renderResults(); });
    }
    byId('more').addEventListener('click', () => { showCount += 30; renderResults(); });
    byId('save').addEventListener('change', loadProfile);
    byId('reload').addEventListener('click', refreshSaves);
    byId('item').addEventListener('input', () => {
      const id = findItem();
      if (id && profile) byId('quantity').value = profile.stock[id] ?? 0;
    });
    byId('setItem').addEventListener('click', editItem);
    byId('confirmAction').addEventListener('click', () => setAction(true));
    byId('excludeAction').addEventListener('click', () => setAction(false));
    await refreshSaves();
    await shopLoad;
  } catch (error) {
    byId('empty').textContent = t('初始化失败。请检查启动窗口。') + ' ' + error.message;
  }
}

init();
