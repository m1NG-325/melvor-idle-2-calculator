'use strict';

const byId = id => document.getElementById(id);
const webMode = globalThis.calculatorWeb;
const gpOfflineHours = 24;
let numbers;
let decimals;
let fractionalXp;
const fullNumber = value => numbers.format(value);
const formatXp = value => value > 0 && value < 1 ? fractionalXp.format(value) : fullNumber(value);
const expectedQuantity = value => value > 0 && value < 0.01
  ? value.toLocaleString(uiLocale(), { maximumSignificantDigits: 2 }) : decimals.format(value);
const actionArea = action => localizedName(action.areaNames, action.area);
let catalog;
let profile;
let results = [];
let keptDrops = new Set();
let showCount = 15;
let profileRequest = 0;
let savePickerError;
let profileReading = false;
let savesRefreshing = false;
let autoSaveReadFailed = false;
let profileReadError;
const profileRenderErrors = new Set();
const profileSections = {
  settings: '技能修正', idle: '挂机收益', shop: '商店升级', experience: '经验收益',
  combat: '战斗收益', production: '连锁产线', queue: '定时挂机', statistics: '数据统计', quests: '任务材料'
};
let runtimeStatus;
let updateActionPending = false;
let updateMessage;
let reportedBrowserError = false;

function reportBrowserError(event) {
  if (webMode || reportedBrowserError) return;
  reportedBrowserError = true;
  const script = event?.filename?.split('/').pop();
  const source = ['language.js', 'rank.js', 'production.js', 'action-queue.js', 'statistics.js', 'ui.js', 'shop.js', 'quests.js', 'item-lookup.js', 'experience.js', 'xp-progress.js', 'combat.js', 'combat-model.js', 'combat-training.js', 'skill-training.js', 'preferences.js', 'choices.js'].includes(script)
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
  if (webMode) return webMode.get(route);
  const response = await fetch(route);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}

function manualProfile() {
  return { name: '', levels: { Woodcutting: 1 }, stock: {}, currencies: {}, keep: [] };
}

function configureProfile(data, automatic = false) {
  const edits = characterEdits(data);
  profile = { ...data, levels: { ...data.levels, ...edits.levels }, stock: { ...data.stock, ...edits.stock },
    bonuses: edits.bonuses, confirmed: [...edits.confirmed], excluded: [...edits.excluded],
    sacrificialAnvil: edits.sacrificialAnvil === true, astralOfferings: edits.astralOfferings === true };
  renderProfile(automatic, automatic);
  queuePreferences();
}

function renderProfile(keepCount = false, automatic = false) {
  const previousErrors = new Set(profileRenderErrors);
  profileRenderErrors.clear();
  const sections = {
    settings: () => renderProfileSettings(automatic),
    idle: () => calculate(keepCount),
    shop: () => updateShop(profile),
    experience: () => updateExperience(profile, automatic),
    combat: () => updateCombat(profile),
    production: renderProduction,
    queue: refreshActionQueue,
    statistics: () => { void renderStatistics(); },
    quests: () => { if (!byId('questsPage').hidden) renderQuest(); }
  };
  for (const [section, render] of Object.entries(sections)) {
    try {
      render();
    } catch (error) {
      profileRenderErrors.add(section);
      if (!webMode && !previousErrors.has(section)) {
        const kind = ['TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'].includes(error?.name) ? error.name : 'Error';
        fetch('diagnostics/profile-render/' + section + '/' + kind, { method: 'POST', keepalive: true }).catch(() => {});
      }
    }
  }
  renderProfileNotice();
}

function renderProfileSettings(automatic) {
  const anvil = byId('sacrificialAnvil');
  const anvilStatus = byId('sacrificialAnvilStatus');
  const canUseAnvil = canUseSacrificialAnvil(catalog, profile);
  byId('sacrificialAnvilSettings').hidden = !catalog.sacrificialAnvil;
  anvil.checked = canUseAnvil && profile.sacrificialAnvil;
  anvil.disabled = !canUseAnvil;
  anvilStatus.hidden = canUseAnvil;
  anvilStatus.textContent = canUseAnvil ? '' : t('存档尚未解锁献祭砧台。');
  const offering = byId('astralOfferings');
  byId('astralOfferingsSettings').hidden = !catalog.astralOfferings;
  offering.disabled = !canUseAstralOfferings(catalog, profile);
  offering.checked = !offering.disabled && profile.astralOfferings;
  if (!automatic || !byId('levels').contains(document.activeElement)) {
    renderSkillSettings();
  }
  if (!automatic) byId('editStatus').textContent = '';
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
  const includeRisky = byId('includeRiskyThieving').checked;
  results = rank(catalog, profile, { hours, offlineCap: gpOfflineHours, sell, sellSpecial, metric, keptDrops, includeRisky });
  const now = profile.date && new Date(profile.date).toLocaleString(uiLocale(), { hour12: false });
  const source = now ? t('存档 {name}', { name: profile.name }) + ' · ' + now : t('手动设置');
  byId('status').textContent = [
    source, t('仓库 {count} 种物品', { count: fullNumber(Object.keys(profile.stock).length) }),
    t('{count} 项正收益方案', { count: fullNumber(results.length) }),
    ...(includeRisky ? [t('有风险的偷窃收益未扣除死亡中断。')] : []),
    ...(hours > gpOfflineHours ? [t('离线最多结算 {time}', { time: formatDuration(gpOfflineHours) })] : [])
  ].join(' · ');
  byId('status').classList.remove('error');
  if (keepCount !== true) showCount = 15;
  renderResults();
}

function renderKeptDrops() {
  byId('keptDropCount').textContent = t('（{count} 种）', { count: fullNumber(keptDrops.size) });
  byId('keptDropList').replaceChildren(...[...keptDrops].map(id => {
    const name = gameName(catalog.items[id]) ?? t('未知物品');
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
    event: '事件掉落', collectable: '献祭收藏品', offering: '星界献祭'
  };
  const list = create('ul');
  if (result.directSources?.length) {
    for (const row of result.directSources) {
      const label = row.source === 'sacrifice' ? '献祭砧台折现' :
        row.source === 'sacrificeBonus' ? '献祭砧台额外金币' : '直接获得金币';
      list.append(create('li', t('{source} · {value} GP', {
        source: [row.target && gameName(row.target), t(label)].filter(Boolean).join(' · '), value: fullNumber(row.value)
      })));
    }
  } else if (result.direct) {
    const label = result.action.kind === 'Fishing' ? '杂物兑换金币' : '直接获得金币';
    list.append(create('li', t('{source} · {value} GP', { source: t(label), value: fullNumber(result.direct) })));
  }
  for (const row of result.drops) {
    list.append(create('li', t('{source} · {item} × {quantity} · {value}', {
      source: [gameName(row.target), t(labels[row.source])].filter(Boolean).join(' · '),
      item: gameName(catalog.items[row.id]) ?? t('未知物品'),
      quantity: expectedQuantity(row.quantity),
      value: row.sold ? t('{price} GP／件，共 {total} GP', {
        price: fullNumber(row.unitPrice), total: fullNumber(row.value)
      }) : t('保留，不计出售收入')
    })));
  }
  for (const row of result.inputs) {
    const item = row.currency ? shopCurrencyName(row.id) : gameName(catalog.items[row.id]) ?? t('未知物品');
    list.append(create('li', t('消耗 · {item} × {quantity} · {value}', {
      item, quantity: row.currency && row.id === 'GoldPieces' ? fullNumber(row.quantity) : decimals.format(row.quantity),
      value: row.currency && !row.unitPrice ? t('不折算为 GP') : '−' + formatGp(row.value)
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
  renderProfileNotice();
  if (webMode) return webMode.renderStatus();
  const status = byId('saveRefreshStatus');
  status.hidden = byId('save').value === '';
  status.textContent = t(autoSaveReadFailed ? '存档暂无法读取，15 秒后重试' :
    profile?.saveFallback ? '已切回自动识别的存档，每 15 秒刷新' : '存档每 15 秒刷新');
  const notice = byId('savePickerNotice');
  notice.hidden = !savePickerError;
  notice.textContent = savePickerError ? t(savePickerError) : '';
}

function renderProfileNotice() {
  const notice = byId('profileNotice');
  notice.hidden = !profileReadError && !profileRenderErrors.size;
  const panels = [...profileRenderErrors].map(section => t(profileSections[section])).join(' · ');
  notice.textContent = profileReadError
    ? [
      t(profileReadError),
      profile?.characterId && t('当前仍显示上次读取的角色：{name}。', { name: profile.name })
    ].filter(Boolean).join(' ')
    : panels ? t(profile?.characterId ? '角色已读取，部分板块显示失败：{panels}' : '部分板块显示失败：{panels}', { panels }) : '';
}

function noteProfileReadFailure(error, automatic) {
  autoSaveReadFailed = true;
  profileReadError = typeof error?.message === 'string' && Object.hasOwn(english, error.message)
    ? error.message : '角色存档暂无法读取，请重试。';
  if (!automatic && !profile) configureProfile(manualProfile());
}

async function loadProfile(automatic = false) {
  const selected = byId('save').value;
  if (automatic && (!selected || profileReading || savesRefreshing)) return;
  const current = ++profileRequest;
  profileReading = true;
  try {
    const data = selected === '' ? manualProfile() : await get('profile/character/' + selected);
    if (current !== profileRequest) return;
    if (selected && data.characterId !== selected) throw new Error('角色存档已变化，请重新读取存档。');
    autoSaveReadFailed = false;
    profileReadError = undefined;
    if (automatic && data.characterId === profile?.characterId && data.date === profile.date &&
      data.saveFallback === profile.saveFallback) {
      if (profileRenderErrors.size) renderProfile(true, true);
      else if (statisticsState.failed) void renderStatistics();
      return;
    }
    configureProfile(data, automatic);
  } catch (error) {
    if (current !== profileRequest) return;
    noteProfileReadFailure(error, automatic);
  } finally {
    if (current === profileRequest) {
      profileReading = false;
      renderSaveRefreshStatus();
    }
  }
}

async function refreshSaves(preferredCharacter) {
  if (savesRefreshing) return;
  savesRefreshing = true;
  const select = byId('save');
  const selectedId = select.options.length && (!profileReadError || select.value)
    ? (select.value === '' ? 'manual' : select.selectedOptions[0]?.dataset.characterId)
    : profile?.characterId ?? preferences.character;
  const target = typeof preferredCharacter === 'string' ? preferredCharacter : selectedId;
  try {
    const saves = await get('saves');
    select.replaceChildren(...saves.map(({ index, name, unknown, characterId, manuallySelected }) => {
      const label = unknown ? t('存档 {count}（格式未知）', { count: index + 1 }) :
        manuallySelected ? t('{name}（手动选择）', { name }) : name;
      const option = new Option(label,
        characterId ?? 'unknown-' + index);
      if (unknown) {
        option.dataset.unknown = index + 1;
        option.disabled = true;
      }
      if (characterId) option.dataset.characterId = characterId;
      if (manuallySelected) option.dataset.selectedFileName = name;
      return option;
    }), new Option(t('手动设置'), ''));
    const previous = target && Array.from(select.options).find(option => option.dataset.characterId === target);
    if (target === 'manual') select.value = '';
    else if (previous) select.value = previous.value;
    else select.value = Array.from(select.options).find(option => !option.disabled).value;
    byId('forgetSaveFile').hidden = !saves.some(save => save.manuallySelected);
    await loadProfile();
  } catch (error) {
    if (!select.options.length) select.add(new Option(t('手动设置'), ''));
    noteProfileReadFailure(error, false);
  } finally {
    savesRefreshing = false;
    renderSaveRefreshStatus();
  }
}

async function changeSelectedSave(operation) {
  const choose = byId('chooseSaveFile');
  const forget = byId('forgetSaveFile');
  if (savesRefreshing || choose.disabled) return;
  const reload = byId('reload');
  reload.disabled = true;
  choose.disabled = forget.disabled = true;
  savePickerError = undefined;
  renderSaveRefreshStatus();
  try {
    const response = await fetch('saves/' + operation, {
      method: 'POST', headers: { 'X-Calculator-Save-Picker': '1' }
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error);
    if (operation === 'forget' || result.characterId) await refreshSaves(result.characterId);
  } catch (error) {
    savePickerError = Object.hasOwn(english, error.message) ? error.message : '无法打开存档选择窗口。';
  } finally {
    reload.disabled = false;
    choose.disabled = forget.disabled = false;
    renderSaveRefreshStatus();
  }
}

function findItem(text = byId('item').value) {
  const value = text.trim();
  if (Object.hasOwn(catalog.items, value)) return value;
  const choice = suggestionKey(byId('items').options, value);
  if (choice) return choice;
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
  const choice = suggestionKey(byId('actions').options, value);
  if (choice) return catalog.actions.find(action => action.id === choice);
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
  if (!location.hash && ['#combat', '#shop', '#quests', '#experience', '#ranking-page', '#production', '#statistics', '#action-queue', '#item-lookup'].includes(preferences.page)) {
    history.replaceState(null, '', preferences.page);
  }
  initTheme();
  function showPage() {
    const page = { '#shop': 'shop', '#quests': 'quests', '#experience': 'xp', '#combat': 'combat', '#production': 'production',
      '#statistics': 'statistics', '#action-queue': 'queue', '#item-lookup': 'itemLookup' }[location.hash] ?? 'rank';
    showExperienceSection();
    for (const key of ['rank', 'xp', 'shop', 'combat', 'quests', 'production', 'statistics', 'queue', 'itemLookup']) {
      byId(key + 'Page').hidden = key !== page;
      const link = byId(key + 'Link');
      if (key === page) {
        link.setAttribute('aria-current', 'page');
        byId('activePage').textContent = t({ rank: '挂机收益', xp: '经验收益', shop: '商店升级', combat: '战斗收益',
          quests: '任务材料', production: '连锁产线', statistics: '数据统计', queue: '定时挂机', itemLookup: '物品检索' }[page]);
      } else link.removeAttribute('aria-current');
    }
    if (page === 'xp' && experienceSection === 'combat') updateCombatTraining();
    if (page === 'xp' && experienceSection === 'skills') renderExperience();
  }
  for (const [id, section] of [['xpSkillsButton', 'skills'], ['xpCombatButton', 'combat']]) {
    byId(id).addEventListener('click', () => {
      experienceSection = section;
      showExperienceSection();
      updateCombatTraining();
      if (section === 'skills') renderExperience();
      queuePreferences();
    });
  }
  function localizeControls() {
    applyLanguage();
    for (const option of byId('save').querySelectorAll('[data-selected-file-name]')) {
      option.textContent = t('{name}（手动选择）', { name: option.dataset.selectedFileName });
    }
    for (const button of document.querySelectorAll('[data-duration-step]')) {
      button.title = t(Number(button.dataset.durationStep) > 0 ? '增加 30 分钟' : '减少 30 分钟');
      button.setAttribute('aria-label', button.title);
    }
    renderSaveRefreshStatus();
    renderTheme();
    renderRuntimeStatus();
    numbers = new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: 0 });
    decimals = new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: 2 });
    fractionalXp = new Intl.NumberFormat(uiLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    const itemFields = [byId('item'), byId('keptDropItem')].map(input => [input, findItem(input.value)]);
    const actionField = byId('action');
    const actionId = findAction(actionField.value)?.id;
    const itemOptions = localizedSuggestions(Object.entries(catalog.items).map(([id, item]) => ({
      key: id, name: gameName(item) ?? t('未知物品'), aliases: ['MelvorBase:' + id, ...Object.values(item.names ?? {})]
    })));
    const actionOptions = localizedSuggestions(catalog.actions.map(action => ({
      key: action.id, name: [skillName(action.skill, catalog.skills), gameName(action), actionArea(action)].filter(Boolean).join(' · '),
      aliases: [action.recipe, ...Object.values(action.names ?? {})]
    })));
    byId('items').replaceChildren(...itemOptions);
    byId('actions').replaceChildren(...actionOptions);
    for (const [input, id] of [...itemFields, [actionField, actionId]]) {
      const options = input === actionField ? actionOptions : itemOptions;
      const selected = options.find(option => option.dataset.key === id);
      if (selected) input.value = selected.value;
    }
    renderKeptDrops();
    localizeExperience();
    localizeShop();
    localizeCombat();
    localizeQuests();
    localizeItemLookup();
    localizeProduction();
    localizeActionQueue();
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
  byId('installUpdate')?.addEventListener('click', startUpdate);
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
  if (!webMode) {
    loadRuntimeStatus();
  }
  try {
    catalog = await get('catalog');
    initStatistics();
    initProduction(catalog);
    initExperience(catalog);
    initCombat(catalog);
    initQuests(catalog.questGuide);
    initItemLookup();
    const shopLoad = get('shop').then(shop => {
      initShop(shop, catalog.items);
      if (profile) updateShop(profile);
    }).catch(error => {
      if (webMode) throw error;
      byId('shopStatus').textContent = t('商店数据读取失败。请重新启动计算器。');
    });
    const filter = byId('filter');
    for (const [id, name] of Object.entries(catalog.skills)) filter.append(new Option(name, id));
    restorePreferences();
    initActionQueue(catalog);
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
    byId('sacrificialAnvil').addEventListener('change', event => {
      if (!profile || !canUseSacrificialAnvil(catalog, profile)) return;
      characterEdits().sacrificialAnvil = profile.sacrificialAnvil = event.currentTarget.checked;
      renderProfile(true);
      queuePreferences();
    });
    byId('astralOfferings').addEventListener('change', event => {
      if (!profile || !canUseAstralOfferings(catalog, profile)) return;
      characterEdits().astralOfferings = profile.astralOfferings = event.currentTarget.checked;
      renderProfile(true);
      queuePreferences();
    });
    for (const button of document.querySelectorAll('[data-hours]')) {
      button.addEventListener('click', () => applyIdleDuration(byId('hours'), Number(button.dataset.hours)));
    }
    for (const id of ['filter', 'search']) {
      byId(id).addEventListener('input', () => { showCount = 15; renderResults(); });
    }
    byId('more').addEventListener('click', () => { showCount += 30; renderResults(); });
    byId('save').addEventListener('change', () => loadProfile());
    byId('reload').addEventListener('click', refreshSaves);
    if (!webMode) {
      byId('chooseSaveFile').hidden = false;
      byId('chooseSaveFile').addEventListener('click', () => changeSelectedSave('choose'));
      byId('forgetSaveFile').addEventListener('click', () => changeSelectedSave('forget'));
    }
    byId('item').addEventListener('input', () => {
      const id = findItem();
      if (id && profile) byId('quantity').value = profile.stock[id] ?? 0;
    });
    byId('setItem').addEventListener('click', editItem);
    byId('confirmAction').addEventListener('click', () => setAction(true));
    byId('excludeAction').addEventListener('click', () => setAction(false));
    if (webMode) await shopLoad;
    await refreshSaves();
    if (!webMode) await shopLoad;
    preferencesReady = true;
    renderRuntimeStatus();
    if (webMode) webMode.enableImport();
    else setInterval(() => loadProfile(true), 15000);
  } catch {
    if (webMode) webMode.initFailed();
    else byId('empty').textContent = t('初始化失败。请检查启动窗口。');
  }
}

if (webMode) void init().catch(() => webMode.initFailed());
else init();
