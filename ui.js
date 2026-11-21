'use strict';

const byId = id => document.getElementById(id);
const gpOfflineHours = 24;
let numbers;
let decimals;
const fullNumber = value => numbers.format(value);
const actionArea = action => localizedName(action.areaNames, action.area);
let catalog;
let profile;
let results = [];
let keptDrops = new Set();
let showCount = 15;
let profileRequest = 0;
let profileReading = false;
let savesRefreshing = false;
let autoSaveReadFailed = false;
let runtimeStatus;
let updateActionPending = false;
let updateMessage;
let reportedBrowserError = false;

function reportBrowserError(event) {
  if (reportedBrowserError) return;
  reportedBrowserError = true;
  const script = event?.filename?.split('/').pop();
  const source = ['language.js', 'rank.js', 'production.js', 'statistics.js', 'ui.js', 'shop.js', 'quests.js', 'experience.js', 'xp-progress.js', 'combat.js', 'combat-model.js', 'combat-training.js', 'skill-training.js', 'preferences.js', 'choices.js', 'access-poll.js'].includes(script)
    ? '/' + script + '/' + (event.lineno || 0) : '';
  fetch('diagnostics/client-error' + source, { method: 'POST', keepalive: true }).catch(() => {});
}
window.addEventListener('error', reportBrowserError);
window.addEventListener('unhandledrejection', reportBrowserError);

function create(tag, content, className) {
  const element = document.createElement(tag);
  if (content !== undefined) element.textContent = content;
  if (className) element.className = className;
  return element;
}

function applyIdleDuration(input, value) {
  input.value = Math.min(Number(input.max), Math.max(Number(input.min), value));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function initIdleDurations() {
  for (const input of document.querySelectorAll('[data-idle-duration]')) {
    const label = input.parentElement;
    const field = create('div', undefined, 'idle-duration-field');
    const controls = create('div', undefined, 'idle-duration-controls');
    label.before(field);
    label.htmlFor = input.id;
    field.append(label, controls);
    controls.append(input);
    function adjust(step) {
      const current = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : Number(input.defaultValue);
      const next = current + step;
      const minutes = Math.round(next * 60);
      applyIdleDuration(input, Math.abs(next * 60 - minutes) < 1e-9 ? minutes / 60 : Number(next.toPrecision(15)));
    }
    for (const step of [.5, -.5]) {
      const button = create('button');
      button.type = 'button';
      button.dataset.durationStep = step;
      button.addEventListener('click', () => adjust(step));
      controls.append(button);
    }
    input.addEventListener('keydown', event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      adjust(event.key === 'ArrowUp' ? .5 : -.5);
    });
    input.addEventListener('blur', () => {
      if (!input.checkValidity()) applyIdleDuration(input, Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : Number(input.defaultValue));
    });
  }
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

function configureProfile(data, automatic = false) {
  const edits = characterEdits(data);
  profile = { ...data, levels: { ...data.levels, ...edits.levels }, stock: { ...data.stock, ...edits.stock },
    bonuses: edits.bonuses, confirmed: [...edits.confirmed], excluded: [...edits.excluded] };
  renderProfile(automatic, automatic);
  queuePreferences();
}

function renderProfile(keepCount = false, automatic = false) {
  if (!automatic || !byId('levels').contains(document.activeElement)) {
    renderSkillSettings();
  }
  if (!automatic) byId('editStatus').textContent = '';
  calculate(keepCount);
  updateShop(profile);
  updateExperience(profile, automatic);
  updateCombat(profile);
  renderProduction();
  void renderStatistics();
  if (!byId('questsPage').hidden) renderQuest();
}

function renderSkillSettings() {
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
    if (key === 'level') characterEdits().levels[skill] = profile.levels[skill] = input.valueAsNumber;
    else (profile.bonuses[skill] ??= {})[key] = input.valueAsNumber;
    calculate();
    updateExperience(profile);
    renderProduction();
    queuePreferences();
  });
  cell.append(input);
  return cell;
}

function calculate(keepCount = false) {
  if (!profile || !byId('options').checkValidity()) return;
  const hours = byId('hours').valueAsNumber;
  const sell = byId('sell').checked;
  byId('sellFishingSpecial').disabled = !sell;
  const sellSpecial = byId('sellFishingSpecial').checked;
  const metric = byId('metric').value;
  results = rank(catalog, profile, { hours, offlineCap: gpOfflineHours, sell, sellSpecial, metric, keptDrops });
  const now = profile.date && new Date(profile.date).toLocaleString(uiLocale(), { hour12: false });
  const source = now ? t('存档 {name}', { name: profile.name }) + ' · ' + now : t('手动设置');
  byId('status').textContent = [
    source, t('仓库 {count} 种物品', { count: fullNumber(Object.keys(profile.stock).length) }),
    t('{count} 项正收益方案', { count: fullNumber(results.length) }),
    ...(hours > gpOfflineHours ? [t('离线最多结算 {time}', { time: formatDuration(gpOfflineHours) })] : [])
  ].join(' · ');
  byId('status').classList.remove('error');
  if (keepCount !== true) showCount = 15;
  renderResults();
}

function renderKeptDrops() {
  byId('keptDropCount').textContent = t('（{count} 种）', { count: fullNumber(keptDrops.size) });
  byId('keptDropList').replaceChildren(...[...keptDrops].map(id => {
    const name = gameName(catalog.items[id]) ?? id;
    const button = create('button', name + ' ×');
    button.type = 'button';
    button.setAttribute('aria-label', t('恢复出售 {item}', { item: name }));
    button.title = t('恢复出售 {item}', { item: name });
    button.addEventListener('click', () => {
      keptDrops.delete(id);
      renderKeptDrops();
      byId('keptDropItem').focus();
      calculate(true);
      queuePreferences();
    });
    return button;
  }));
}

function keepDrop() {
  const input = byId('keptDropItem');
  const id = findItem(input.value);
  if (!id) {
    input.setCustomValidity(t('请选择有效物品。'));
    input.reportValidity();
    return;
  }
  keptDrops.add(id);
  input.value = '';
  renderKeptDrops();
  calculate(true);
  queuePreferences();
  input.focus();
}

function showWinner(winner, sell) {
  const { action, net, payout, netPerHour, payoutPerHour, activeNetPerHour, materialCost, direct, sales } = winner;
  byId('winnerName').textContent = [skillName(action.skill, catalog.skills), gameName(action), actionArea(action)].filter(Boolean).join(' · ');
  byId('metrics').replaceChildren(...[
    ['预计净收益', net], ['预计到手 GP', payout], ['整段平均净 GP／小时', netPerHour],
    ['行动中净 GP／小时', activeNetPerHour], ['整段平均到手 GP／小时', payoutPerHour]
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
    winner.limit ? t('约 {time}后用完{item}', { time: formatDuration(winner.activeHours), item: limitName(winner) })
      : t('预计行动 {time}', { time: formatDuration(winner.activeHours) })
  ].join(' · ');
  const previous = byId('winnerSources').querySelector('details');
  const details = incomeSources(winner);
  details.dataset.action = action.id;
  details.open = previous?.dataset.action === action.id && previous.open;
  byId('winnerSources').replaceChildren(details);
}

function incomeSources(result) {
  const details = create('details', undefined, 'income-sources');
  details.append(create('summary', t('收益来源')));
  const labels = {
    product: '动作产物', hit: '敲击掉落', cut: '砍倒掉落', break: '碎裂掉落',
    common: '普通战利品', rare: '稀有战利品', completion: '完成奖励', fish: '鱼获', junk: '杂物', special: '钓鱼特殊物品',
    event: '事件掉落'
  };
  const list = create('ul');
  if (result.directSources?.length) {
    for (const row of result.directSources) {
      list.append(create('li', t('{source} · {value} GP', {
        source: gameName(row.target) + ' · ' + t('直接获得金币'), value: fullNumber(row.value)
      })));
    }
  } else if (result.direct) {
    const label = result.action.kind === 'Fishing' ? '杂物兑换金币' : '直接获得金币';
    list.append(create('li', t('{source} · {value} GP', { source: t(label), value: fullNumber(result.direct) })));
  }
  for (const row of result.drops) {
    list.append(create('li', t('{source} · {item} × {quantity} · {value}', {
      source: [gameName(row.target), t(labels[row.source])].filter(Boolean).join(' · '),
      item: gameName(catalog.items[row.id]) ?? row.id,
      quantity: decimals.format(row.quantity),
      value: row.sold ? t('{price} GP／件，共 {total} GP', {
        price: fullNumber(row.unitPrice), total: fullNumber(row.value)
      }) : t('保留，不计出售收入')
    })));
  }
  for (const row of result.inputs) {
    const item = row.currency ? shopCurrencyName(row.id) : gameName(catalog.items[row.id]) ?? row.id;
    list.append(create('li', t('消耗 · {item} × {quantity} · {value}', {
      item, quantity: row.currency && row.id === 'GoldPieces' ? fullNumber(row.quantity) : decimals.format(row.quantity),
      value: row.currency && !row.unitPrice ? t('不折算为 GP') : '−' + fullNumber(row.value) + ' GP'
    })));
  }
  details.append(list);
  return details;
}

function renderResults() {
  const expanded = new Set([...byId('rows').querySelectorAll('details[open]')].map(item => item.dataset.action));
  const skill = byId('filter').value;
  const text = byId('search').value.trim().toLowerCase();
  const matches = results.filter(({ action }) => (!skill || skill === action.skill) &&
    (!text || [action.id, action.name, action.area, catalog.skills[action.skill], skillName(action.skill, catalog.skills),
      gameName(action), actionArea(action),
      ...Object.values(action.names ?? {}), ...Object.values(action.areaNames ?? {})]
      .some(value => value?.toLowerCase().includes(text))));
  byId('winner').hidden = !matches.length;
  if (matches.length) showWinner(matches[0], byId('sell').checked);
  byId('empty').hidden = !!matches.length;
  byId('empty').textContent = t(results.length ? '当前筛选没有匹配项。' : '没有正收益方案。检查技能等级、库存或出售选项。');
  byId('ranking').hidden = !matches.length;
  byId('more').hidden = matches.length <= showCount;
  byId('rows').replaceChildren(...matches.slice(0, showCount).map(result => {
    const { action, net, payout, netPerHour, activeNetPerHour, limit, activeHours } = result;
    const row = create('tr');
    const plan = create('td', gameName(action));
    const line = [skillName(action.skill, catalog.skills), actionArea(action)].filter(Boolean).join(' · ');
    plan.append(' ', create('small', line, 'action-context'));
    const details = incomeSources(result);
    details.dataset.action = action.id;
    details.open = expanded.has(action.id);
    plan.append(details);
    row.append(plan, create('td', fullNumber(net), 'number gold'),
      create('td', fullNumber(payout), 'number'), create('td', fullNumber(netPerHour), 'number'),
      create('td', fullNumber(activeNetPerHour), 'number'),
      create('td', limit ? t('{time} · {item}用完', { time: formatDuration(activeHours), item: limitName(result) }) :
        formatDuration(activeHours)));
    return row;
  }));
}

function renderRuntimeStatus() {
  if (!runtimeStatus) return;
  const { state, version, latest, releases, canInstall, installation, updateNotice } = runtimeStatus;
  const labels = {
    checking: 'v{version} · 正在检查更新',
    current: 'v{version} · 没有可用更新',
    available: 'v{version} · 发现新版本 v{latest}',
    unavailable: 'v{version} · 暂时无法检查更新'
  };
  byId('versionStatus').textContent = t(labels[state], { version, latest });
  byId('releaseLink').hidden = state !== 'available';
  if (state === 'available') byId('releaseLink').href = releases;
  const button = byId('installUpdate');
  const phase = installation?.phase;
  const busy = ['downloading', 'verifying', 'installing'].includes(phase);
  button.hidden = state !== 'available' || !canInstall;
  button.disabled = !preferencesReady || busy || updateActionPending;
  button.textContent = t(phase === 'ready' ? '打开新版' : phase === 'failed' ? '重试更新' : '下载并更新');
  const progress = byId('updateProgress');
  progress.hidden = !busy;
  const ratio = phase === 'downloading' && installation.total > 0
    ? Math.min(1, installation.received / installation.total) : null;
  if (ratio == null) progress.removeAttribute('value');
  else progress.value = ratio;
  const messages = {
    downloading: ratio != null ? '正在下载更新… {percent}%' : '正在下载更新…',
    verifying: '正在校验更新包…', installing: '正在安装更新…',
    ready: '已安装，正在打开新版…', failed: '更新未完成，当前版本可继续使用。'
  };
  const message = updateMessage ?? messages[phase] ?? (updateNotice === 'installed' ? '已更新至 v{version}' :
    updateNotice === 'restored' ? '新版启动失败，已打开可用的上一版。' : '');
  const feedback = byId('updateFeedback');
  feedback.hidden = !message;
  feedback.textContent = message ? t(message, { version, percent: Math.round((ratio ?? 0) * 100) }) : '';
}

async function openUpdatedVersion() {
  const next = new URL(runtimeStatus.installation.url);
  if (next.protocol !== 'http:' || next.hostname !== '127.0.0.1' || !next.port ||
      !/^\/[a-f0-9]{40}\/$/.test(next.pathname)) throw Error('invalid-update-destination');
  if (!(await savePreferences())) {
    updateMessage = '新版已就绪。请保存设置后重试打开。';
    return;
  }
  next.hash = location.hash;
  next.searchParams.set('lang', uiLanguage);
  location.replace(next);
}

async function loadRuntimeStatus(attempt = 0) {
  try {
    runtimeStatus = await get('status');
    if (runtimeStatus.state === 'checking') {
      if (attempt < 10) setTimeout(() => loadRuntimeStatus(attempt + 1), 700);
      else runtimeStatus.state = 'unavailable';
    }
    renderRuntimeStatus();
    if (['downloading', 'verifying', 'installing'].includes(runtimeStatus.installation?.phase)) {
      setTimeout(loadRuntimeStatus, 400);
    } else if (runtimeStatus.installation?.phase === 'ready') {
      await openUpdatedVersion();
      renderRuntimeStatus();
    }
  } catch {
    if (runtimeStatus?.installation && attempt < 5) setTimeout(() => loadRuntimeStatus(attempt + 1), 700);
    else {
      if (runtimeStatus?.installation) runtimeStatus.installation = { phase: 'failed' };
      renderRuntimeStatus();
      reportBrowserError();
    }
  }
}

async function startUpdate() {
  if (updateActionPending || !runtimeStatus) return;
  updateActionPending = true;
  updateMessage = undefined;
  renderRuntimeStatus();
  try {
    if (runtimeStatus.installation?.phase === 'ready') {
      await openUpdatedVersion();
      return;
    }
    if (!(await savePreferences())) {
      updateMessage = '无法保存设置，更新尚未开始。';
      return;
    }
    const response = await fetch('update/install', { method: 'POST', headers: { 'X-Calculator-Update': 'install' } });
    if (!response.ok && response.status !== 409) throw Error('update-request-failed');
    runtimeStatus.installation = { phase: 'downloading' };
    await loadRuntimeStatus();
  } catch {
    runtimeStatus.installation = { phase: 'failed' };
  } finally {
    updateActionPending = false;
    renderRuntimeStatus();
  }
}

function limitName(row) {
  const id = row.limit;
  return gameName(catalog.items[id]) ?? shopCurrencyName(id);
}

function renderSaveRefreshStatus() {
  const status = byId('saveRefreshStatus');
  status.hidden = byId('save').value === '';
  status.textContent = t(autoSaveReadFailed ? '存档暂无法读取，15 秒后重试' : '存档每 15 秒刷新');
}

async function loadProfile(automatic = false) {
  const selected = byId('save').value;
  if (automatic && (!selected || !profile?.characterId || profileReading || savesRefreshing)) return;
  const current = ++profileRequest;
  profileReading = true;
  try {
    const data = selected === '' ? manualProfile() : await get('profile/character/' + selected);
    if (current !== profileRequest) return;
    if (automatic && (data.characterId !== profile.characterId || Date.parse(data.date) <= Date.parse(profile.date))) {
      autoSaveReadFailed = false;
      if (data.characterId === profile.characterId && statisticsState.failed) void renderStatistics();
      return;
    }
    autoSaveReadFailed = false;
    configureProfile(data, automatic);
  } catch (error) {
    if (current !== profileRequest) return;
    if (automatic) {
      autoSaveReadFailed = true;
      return;
    }
    byId('save').value = '';
    configureProfile(manualProfile());
    byId('status').textContent = t(error.message);
    byId('status').classList.add('error');
  } finally {
    if (current === profileRequest) {
      profileReading = false;
      renderSaveRefreshStatus();
    }
  }
}

async function refreshSaves() {
  if (savesRefreshing) return;
  savesRefreshing = true;
  const select = byId('save');
  const selectedId = select.options.length ? (select.value === '' ? 'manual' : select.selectedOptions[0]?.dataset.characterId) :
    preferences.character;
  try {
    const saves = await get('saves');
    select.replaceChildren(...saves.map(({ index, name, unknown, characterId }) => {
      const option = new Option(unknown ? t('存档 {count}（格式未知）', { count: index + 1 }) : name,
        characterId ?? 'unknown-' + index);
      if (unknown) {
        option.dataset.unknown = index + 1;
        option.disabled = true;
      }
      if (characterId) option.dataset.characterId = characterId;
      return option;
    }), new Option(t('手动设置'), ''));
    const previous = selectedId && Array.from(select.options).find(option => option.dataset.characterId === selectedId);
    if (selectedId === 'manual') select.value = '';
    else if (previous) select.value = previous.value;
    else if (selectedId) select.value = '';
    else select.value = Array.from(select.options).find(option => !option.disabled).value;
    await loadProfile();
  } catch (error) {
    select.replaceChildren(new Option(t('手动设置'), ''));
    configureProfile(manualProfile());
    byId('status').textContent = t(error.message);
    byId('status').classList.add('error');
  } finally {
    savesRefreshing = false;
    renderSaveRefreshStatus();
  }
}

function findItem(text = byId('item').value) {
  const value = text.trim();
  if (Object.hasOwn(catalog.items, value)) return value;
  const separator = value.lastIndexOf(' · ');
  if (separator === -1) return;
  const id = value.slice(separator + 3);
  if (Object.hasOwn(catalog.items, id) && hasGameLabel(catalog.items[id], value.slice(0, separator))) return id;
}

function editItem() {
  const id = findItem();
  const quantity = byId('quantity');
  if (!id || quantity.value === '' || !quantity.checkValidity()) {
    byId('editStatus').textContent = t('请选择有效物品并输入非负整数。');
    return;
  }
  characterEdits().stock[id] = profile.stock[id] = quantity.valueAsNumber;
  byId('editStatus').textContent = t(profile.keep.includes(id)
    ? '{item}可用数量设为 {value}，仓库锁定设置仍生效。' : '{item}可用数量设为 {value}。', {
    item: gameName(catalog.items[id]), value: fullNumber(quantity.valueAsNumber)
  });
  calculate();
  updateShop(profile);
  updateExperience(profile);
  updateCombat(profile);
  renderProduction();
  queuePreferences();
}

function findAction(text = byId('action').value) {
  const value = text.trim();
  const separator = value.lastIndexOf(' · ');
  const id = separator === -1 ? value : value.slice(separator + 3);
  const action = catalog.actions.find(entry => entry.id === id);
  if (action && (separator === -1 || hasGameLabel(action, value.slice(0, separator)))) return action;
}

function setAction(include) {
  const action = findAction();
  if (!action) {
    byId('editStatus').textContent = t('请选择一个已有动作。');
    return;
  }
  profile.confirmed = profile.confirmed.filter(id => id !== action.id);
  profile.excluded = profile.excluded.filter(id => id !== action.id);
  (include ? profile.confirmed : profile.excluded).push(action.id);
  characterEdits().confirmed = profile.confirmed;
  characterEdits().excluded = profile.excluded;
  byId('editStatus').textContent = t(include ? '{name}已确认解锁，仍按等级、库存和偷窃安全条件计算。' : '{name}已排除。', {
    name: gameName(action)
  });
  calculate();
  updateExperience(profile);
  renderProduction();
  queuePreferences();
}

async function init() {
  preferences = await get('preferences').catch(() => ({}));
  uiLanguage = requestedLanguage ?? supportedLanguage(preferences.language) ?? uiLanguage;
  experienceSection = preferences.fields?.xpSection === 'combat' ? 'combat' : 'skills';
  if (!location.hash && ['#combat', '#shop', '#quests', '#experience', '#ranking-page', '#production', '#statistics'].includes(preferences.page)) {
    history.replaceState(null, '', preferences.page);
  }
  initTheme();
  function showPage() {
    const page = { '#shop': 'shop', '#quests': 'quests', '#experience': 'xp', '#combat': 'combat', '#production': 'production',
      '#statistics': 'statistics' }[location.hash] ?? 'rank';
    showExperienceSection(page === 'xp');
    for (const key of ['rank', 'xp', 'shop', 'combat', 'quests', 'production', 'statistics']) {
      byId(key + 'Page').hidden = key !== page;
      const link = byId(key + 'Link');
      if (key === page) {
        link.setAttribute('aria-current', 'page');
        byId('activePage').textContent = t({ rank: '挂机收益', xp: '经验收益', shop: '商店升级', combat: '战斗收益',
          quests: '任务材料', production: '连锁产线', statistics: '数据统计' }[page]);
      } else link.removeAttribute('aria-current');
    }
    if (page === 'xp' || page === 'combat') updateCombatTraining();
    if (page === 'xp' && experienceSection === 'skills') renderExperience();
  }
  for (const [id, section] of [['xpSkillsButton', 'skills'], ['xpCombatButton', 'combat']]) {
    byId(id).addEventListener('click', () => {
      experienceSection = section;
      showExperienceSection(true);
      updateCombatTraining();
      if (section === 'skills') renderExperience();
      queuePreferences();
    });
  }
  function localizeControls() {
    applyLanguage();
    for (const button of document.querySelectorAll('[data-duration-step]')) {
      button.title = t(Number(button.dataset.durationStep) > 0 ? '增加 30 分钟' : '减少 30 分钟');
      button.setAttribute('aria-label', button.title);
    }
    renderSaveRefreshStatus();
    renderTheme();
    renderRuntimeStatus();
    numbers = new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: 0 });
    decimals = new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: 2 });
    showPage();
    if (!catalog) return;
    byId('source').textContent = t('Steam 构建 {build} · {count} 项动作', {
      build: t(catalog.build), count: fullNumber(catalog.actions.length)
    });
    const dataNotes = [];
    if (catalog.dataSource === 'selected-file') dataNotes.push(t('正在使用手动选择的游戏文件。'));
    if (catalog.checksumMismatch) dataNotes.push(t('游戏数据校验值不同。收益按可读取的配方估算。'));
    byId('dataNotice').textContent = dataNotes.join(' ');
    byId('dataNotice').hidden = !dataNotes.length;
    for (const option of byId('save').options) {
      if (option.value === '') option.text = t('手动设置');
      else if (option.dataset.unknown) option.text = t('存档 {count}（格式未知）', { count: +option.dataset.unknown });
    }
    for (const option of byId('filter').options) {
      if (option.value) option.text = skillName(option.value, catalog.skills);
    }
    byId('items').replaceChildren(...Object.entries(catalog.items).map(([id, item]) => new Option('', gameName(item) + ' · ' + id)));
    byId('actions').replaceChildren(...catalog.actions.map(action => new Option('', gameName(action) + ' · ' + action.id)));
    renderKeptDrops();
    const item = byId('item');
    const action = byId('action');
    const itemId = item.value.includes(' · ') && findItem(item.value);
    const selectedAction = action.value.includes(' · ') && findAction(action.value);
    if (itemId) item.value = gameName(catalog.items[itemId]) + ' · ' + itemId;
    if (selectedAction) action.value = gameName(selectedAction) + ' · ' + selectedAction.id;
    localizeExperience();
    localizeShop();
    localizeCombat();
    localizeQuests();
    localizeProduction();
    if (profile) renderProfile(true);
    else void renderStatistics();
  }
  byId('language').addEventListener('change', event => {
    uiLanguage = supportedLanguage(event.currentTarget.value) ?? 'en';
    const url = new URL(location.href);
    url.searchParams.set('lang', uiLanguage);
    history.replaceState(null, '', url);
    localizeControls();
    queuePreferences();
  });
  byId('installUpdate').addEventListener('click', startUpdate);
  window.addEventListener('hashchange', () => {
    showPage();
    if (!byId('questsPage').hidden) renderQuest();
    renderProduction();
    void renderStatistics();
    queuePreferences();
  });
  for (const event of ['input', 'change', 'toggle']) document.addEventListener(event, queuePreferences, true);
  window.addEventListener('pagehide', savePreferences);
  localizeControls();
  initAccessPoll();
  loadRuntimeStatus();
  try {
    catalog = await get('catalog');
    initStatistics();
    initProduction(catalog);
    initExperience(catalog);
    initCombat(catalog);
    initQuests(catalog.questGuide);
    const shopLoad = get('shop').then(shop => {
      initShop(shop, catalog.items);
      if (profile) updateShop(profile);
    }).catch(error => {
      byId('shopStatus').textContent = t('商店数据读取失败。请重新启动计算器。') + ' ' + t(error.message);
    });
    const filter = byId('filter');
    for (const [id, name] of Object.entries(catalog.skills)) filter.append(new Option(name, id));
    restorePreferences();
    initIdleDurations();
    localizeControls();
    for (const input of document.querySelectorAll('[data-suggestions]')) initSuggestions(input);
    const keptDropItem = byId('keptDropItem');
    keptDropItem.addEventListener('input', () => keptDropItem.setCustomValidity(''));
    keptDropItem.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.defaultPrevented) keepDrop();
    });
    byId('keepDrop').addEventListener('click', keepDrop);
    byId('options').addEventListener('submit', event => { event.preventDefault(); calculate(); });
    byId('options').addEventListener('change', calculate);
    byId('options').addEventListener('input', calculate);
    for (const button of document.querySelectorAll('[data-hours]')) {
      button.addEventListener('click', () => applyIdleDuration(byId('hours'), Number(button.dataset.hours)));
    }
    for (const id of ['filter', 'search']) {
      byId(id).addEventListener('input', () => { showCount = 15; renderResults(); });
    }
    byId('more').addEventListener('click', () => { showCount += 30; renderResults(); });
    byId('save').addEventListener('change', () => loadProfile());
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
    preferencesReady = true;
    renderRuntimeStatus();
    setInterval(() => loadProfile(true), 15000);
  } catch (error) {
    byId('empty').textContent = t('初始化失败。请检查启动窗口。') + ' ' + t(error.message);
  }
}

init();
