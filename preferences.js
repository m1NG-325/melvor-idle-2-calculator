const preferenceFields = [
  'hours', 'metric', 'sell', 'sellFishingSpecial', 'includeRiskyThieving', 'filter', 'search', 'item', 'quantity', 'action',
  'shopScope', 'shopPurchaseFilter', 'shopSearch', 'shopShortages', 'questChoice',
  'productionTarget', 'productionMode', 'productionHours', 'productionQuantity', 'productionReserve',
  'productionStock', 'productionSellByproducts', 'productionComparisonItems',
  'statisticsSearch', 'itemLookupSort',
  'xpIgnoreStock',
  'queueDraft', 'queueLibrary', 'queueName', 'queueRepeat', 'queueSkill', 'queueCategory', 'queueQuestActions',
  'combatTrainingSkill',
  'combatTarget', 'combatAreaChoice', 'combatRateMode', 'combatKillRate', 'combatHours', 'combatCap', 'combatCollect', 'combatSell'
];
const preferenceDetails = ['levelSettings', 'inventorySettings', 'calculationScope', 'keptDropSettings', 'combatLoadout', 'combatAttributes', 'combatBreakdown'];
let preferences = {};
let preferencesReady = false;
let preferencesTimer;
let lastSettings = '';
let settingsRequest = Promise.resolve(true);
const profileEdits = new Map();
const defaultTheme = { hue: 173, lightness: 68 };
const themePresets = [343, 12, 35, 53, 94, 146, 173, 195, 220, 252, 277, 313];
let theme = defaultTheme;

function initTheme() {
  const saved = preferences.theme;
  if (saved && Number.isInteger(saved.hue) && saved.hue >= 0 && saved.hue < 360 &&
      Number.isInteger(saved.lightness) && saved.lightness >= 55 && saved.lightness <= 83) theme = saved;
  const hue = byId('themeHue');
  const lightness = byId('themeLightness');
  function select(next) {
    theme = next;
    renderTheme();
    queuePreferences();
  }
  byId('themePresets').replaceChildren(...themePresets.map(color => {
    const button = create('button', undefined, 'theme-swatch');
    button.type = 'button';
    button.dataset.hue = color;
    button.style.setProperty('--swatch', `hsl(${color} 72% 68%)`);
    button.addEventListener('click', () => select({ hue: color, lightness: 68 }));
    return button;
  }));
  for (const input of [hue, lightness]) {
    input.addEventListener('input', () => select({ hue: hue.valueAsNumber, lightness: lightness.valueAsNumber }));
  }
  byId('themeReset').addEventListener('click', () => select(defaultTheme));
  const control = byId('themeControl');
  document.addEventListener('click', event => { if (!control.contains(event.target)) control.open = false; });
  control.addEventListener('keydown', event => {
    if (event.key === 'Escape') { control.open = false; control.querySelector('summary').focus(); }
  });
}

function renderTheme() {
  const { hue, lightness } = theme;
  const root = document.documentElement;
  const original = hue === defaultTheme.hue && lightness === defaultTheme.lightness;
  root.toggleAttribute('data-custom-theme', !original);
  root.style.setProperty('--theme-hue', hue);
  root.style.setProperty('--theme-lightness', lightness + '%');
  byId('themeHue').value = hue;
  byId('themeLightness').value = lightness;
  for (const button of byId('themePresets').children) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.hue) === hue && lightness === 68));
    button.setAttribute('aria-label', t('预设色相 {value}°', { value: button.dataset.hue }));
  }
}

function characterEdits(data = profile) {
  const key = data?.characterId ?? 'manual';
  if (!profileEdits.has(key)) profileEdits.set(key, { levels: {}, stock: {}, bonuses: {}, confirmed: [], excluded: [] });
  return profileEdits.get(key);
}

function validCharacterEdits(value) {
  const record = data => data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const list = data => Array.isArray(data) ? data.filter(id => typeof id === 'string') : [];
  return { ...record(value), levels: record(value?.levels), stock: record(value?.stock), bonuses: record(value?.bonuses),
    confirmed: list(value?.confirmed), excluded: list(value?.excluded) };
}

function restorePreferences() {
  for (const id of preferenceFields) {
    const input = byId(id);
    const saved = preferences.fields?.[id];
    if (!input) continue;
    if (input.type === 'checkbox') {
      if (typeof saved === 'boolean') input.checked = saved;
    } else if (typeof saved === 'string' && (input.tagName !== 'SELECT' || [...input.options].some(option => option.value === saved))) {
      input.value = saved;
    }
  }
  for (const input of document.querySelectorAll('[data-idle-duration]')) {
    if (!input.checkValidity()) input.value = Math.min(Number(input.max), Math.max(Number(input.min),
      Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : Number(input.defaultValue)));
  }
  for (const id of preferenceDetails) {
    if (byId(id) && typeof preferences.details?.[id] === 'boolean') byId(id).open = preferences.details[id];
  }
  for (const [key, value] of Object.entries(preferences.profileEdits ?? {})) {
    profileEdits.set(key, validCharacterEdits(value));
  }
  xpView.bonusesByCharacter = new Map(Object.entries(preferences.xpBonuses ?? {}));
  xpView.goalsByCharacter = new Map(Object.entries(preferences.xpGoals ?? {}));
  xpView.actionsByCharacter = new Map(Object.entries(preferences.xpActions ?? {}));
  keptDrops = new Set(Array.isArray(preferences.keptDrops) ? preferences.keptDrops.filter(id => typeof id === 'string') : []);
  combatView.kept = new Set(preferences.combatKept ?? []);
  combatView.suppressed = new Set(preferences.combatSuppressed ?? []);
  combatView.samples = new Map(Object.entries(preferences.combatSamples ?? {}));
  for (const supply of preferences.combatSupplies ?? []) {
    const id = combatSupplyId(supply.item ?? '');
    const role = exclusiveSupplyRole(id);
    if (id && !combatView.supplies.some(row => row.item.value === id || (role && exclusiveSupplyRole(row.item.value) === role))) {
      addCombatSupply(supply);
    }
  }
}

function savePreferences() {
  clearTimeout(preferencesTimer);
  if (!preferencesReady) return Promise.resolve(false);
  const settings = JSON.stringify({
    version: 1, language: uiLanguage, page: location.hash.split('/')[0], theme,
    character: profile?.characterId ?? (profileReadError || byId('save').value ? preferences.character : 'manual'),
    fields: { xpSkill: xpView.skill, xpSection: experienceSection, statisticsScope: statisticsScope(),
      ...Object.fromEntries(preferenceFields.filter(id => byId(id)).map(id => {
      const input = byId(id);
      return [id, input.type === 'checkbox' ? input.checked : input.value];
    })) },
    details: Object.fromEntries(preferenceDetails.filter(id => byId(id)).map(id => [id, byId(id).open])),
    profileEdits: Object.fromEntries(profileEdits),
    xpBonuses: Object.fromEntries(xpView.bonusesByCharacter),
    xpGoals: Object.fromEntries(xpView.goalsByCharacter),
    xpActions: Object.fromEntries(xpView.actionsByCharacter),
    shopSelected: shopView ? [...shopView.selected] : preferences.shopSelected,
    keptDrops: [...keptDrops],
    combatKept: [...combatView.kept],
    combatSuppressed: [...combatView.suppressed],
    combatSamples: Object.fromEntries(combatView.samples),
    combatSupplies: combatView.supplies.map(({ item, use, stock, automatic }) =>
      ({ item: item.value, use: use.value, stock: stock.value, automatic }))
  });
  if (settings === lastSettings) return settingsRequest;
  lastSettings = settings;
  settingsRequest = settingsRequest.then(() => webMode ? webMode.savePreferences(settings) : fetch('preferences', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: settings, keepalive: new Blob([settings]).size < 60 * 1024
  })).then(response => {
    if (!response.ok) throw Error('settings_write_failed');
    byId('settingsNotice').hidden = true;
    return true;
  }).catch(() => {
    if (lastSettings === settings) lastSettings = '';
    byId('settingsNotice').textContent = t(webMode ? '浏览器无法保存偏好设置。' : '无法保存工具设置。请检查工具目录的写入权限。');
    byId('settingsNotice').hidden = false;
    return false;
  });
  return settingsRequest;
}

function queuePreferences() {
  if (!preferencesReady) return;
  clearTimeout(preferencesTimer);
  preferencesTimer = setTimeout(savePreferences, 120);
}
