const STATISTIC_LABELS = {
  CharacterCreationDate: ['角色创建时间', 'Character created'],
  TotalPlaytime: ['总游玩时长', 'Total playtime'],
  OnlinePlaytime: ['在线游玩时长', 'Online playtime'],
  OfflinePlaytime: ['离线游玩时长', 'Offline playtime'],
  TotalTrainingTime: ['总训练时长', 'Total training time'],
  OnlineTrainingTime: ['在线训练时长', 'Online training time'],
  OfflineTrainingTime: ['离线训练时长', 'Offline training time'],
  TotalNothingTime: ['总空闲时长', 'Total idle time'],
  OnlineNothingTime: ['在线空闲时长', 'Online idle time'],
  OfflineNothingTime: ['离线空闲时长', 'Offline idle time'],
  TotalTimeSpent: ['总行动时长', 'Total activity time'],
  OnlineTimeSpent: ['在线行动时长', 'Online activity time'],
  OfflineTimeSpent: ['离线行动时长', 'Offline activity time'],
  TotalItemsBuried: ['掩埋物品总数', 'Total items buried'],
  ItemFound: ['获得物品', 'Items found'],
  ItemSold: ['出售物品', 'Items sold'],
  ItemOpened: ['打开物品', 'Items opened'],
  ItemBuried: ['掩埋物品', 'Items buried'],
  ItemGained: ['产出物品', 'Items produced'],
  ItemSpent: ['消耗物品', 'Items spent'],
  ItemBought: ['购买物品', 'Items bought'],
  ItemGiven: ['交付物品', 'Items turned in'],
  ItemRewarded: ['奖励物品', 'Item rewards'],
  CurrencyFromSale: ['出售获得的货币', 'Currency from sales'],
  CurrencyFromBurying: ['掩埋获得的货币', 'Currency from burying'],
  CurrencySpent: ['消耗货币', 'Currency spent'],
  CurrencyGained: ['获得货币', 'Currency gained'],
  CurrencyGiven: ['交付货币', 'Currency turned in'],
  CurrencyRewarded: ['奖励货币', 'Currency rewards'],
  PurchasesMade: ['购买次数', 'Purchases made'],
  Actions: ['行动次数', 'Actions performed'],
  DamageDealt: ['造成伤害', 'Damage dealt'],
  Cuts: ['砍击次数', 'Cutting hits'],
  Fells: ['砍倒次数', 'Trees felled'],
  WeakSpots: ['弱点命中', 'Weak spots hit'],
  RocksHit: ['矿石敲击次数', 'Rock hits'],
  RocksBroken: ['矿石碎裂次数', 'Rocks broken'],
  RocksShattered: ['触发破碎次数', 'Rocks shattered'],
  TotalCatches: ['总钓获次数', 'Total catches'],
  FishCaught: ['钓获鱼类', 'Fish caught'],
  JunkCaught: ['钓获杂物', 'Junk caught'],
  SpecialItemsCaught: ['钓获特殊物品', 'Special items caught'],
  FiresLit: ['点火次数', 'Fires lit'],
  BonfireTime: ['篝火时长', 'Bonfire time'],
  BonfireTimeFromLogs: ['原木增加的篝火时长', 'Bonfire time added by logs'],
  BonfireTimeFromFires: ['点火增加的篝火时长', 'Bonfire time added by fires'],
  BonfireLogsAdded: ['添加的篝火原木', 'Logs added to bonfires'],
  RecipesCreated: ['制作完成次数', 'Recipes completed'],
  RecipesAttempted: ['尝试烹饪次数', 'Cooking attempts'],
  RecipesCooked: ['成功烹饪次数', 'Successful cooking attempts'],
  RecipesBurnt: ['烧焦次数', 'Recipes burnt'],
  CurrencySpentAutomating: ['自动化花费的货币', 'Currency spent on automation'],
  ProductHarvested: ['各产物收获统计', 'Harvests by product'],
  RecipeHarvested: ['各作物收获统计', 'Harvests by crop'],
  CurrencySpentOnAnimals: ['购买牲畜花费的货币', 'Currency spent on animals'],
  AnimalPurchased: ['动物购买次数', 'Animals purchased'],
  AnimalDied: ['动物死亡次数', 'Animal deaths'],
  AnimalYeeted: ['动物放逐次数', 'Animals released'],
  AnimalPet: ['动物抚摸次数', 'Animals petted'],
  AnimalNotFed: ['喂食失败次数', 'Missed feedings'],
  AnimalDiedWithoutPet: ['未被抚摸便死亡的动物', 'Animals that died without being petted'],
  AnimalTimeSpentAliveStatistic: ['动物累计存活时长', 'Cumulative animal lifespan'],
  AnimalTrapped: ['捕获次数', 'Animals trapped'],
  AnimalTrappedWithoutFail: ['无失败捕获次数', 'Animals trapped without failing'],
  AnimalTrappedUsingBait: ['使用诱饵捕获次数', 'Animals trapped with bait'],
  AnimalEscaped: ['猎物逃脱次数', 'Escapes'],
  AnimalSpeciesTrapped: ['按物种统计捕获次数', 'Traps by species'],
  TotalDamageDealt: ['造成总伤害', 'Total damage dealt'],
  TotalWardDamageDealt: ['造成总护盾伤害', 'Total ward damage dealt'],
  TotalDamageNegatedByWard: ['护盾抵消的总伤害', 'Total damage blocked by ward'],
  TotalDamageNegatedByArmour: ['护甲抵消的总伤害', 'Total damage blocked by armour'],
  TotalDamageTaken: ['受到总伤害', 'Total damage taken'],
  TotalHitpointsStolenByEnemies: ['被敌人吸取的生命值', 'Total HP stolen by enemies'],
  TotalAttacksMade: ['攻击总次数', 'Total attacks made'],
  TotalAttacksHit: ['攻击命中总次数', 'Total hits landed'],
  TotalAttacksMissed: ['攻击未命中总次数', 'Total missed attacks'],
  TotalTimesAttacked: ['受到攻击总次数', 'Total attacks received'],
  TotalTimesHit: ['被命中总次数', 'Total times hit'],
  TotalAttacksEvaded: ['闪避总次数', 'Total attacks evaded'],
  PlayerDeaths: ['角色死亡次数', 'Player deaths'],
  TotalAmmoUsed: ['弹药消耗总数', 'Total ammunition used'],
  TotalRunesUsed: ['符文消耗总数', 'Total runes used'],
  TimeSpentFighting: ['实际战斗时长', 'Time spent fighting'],
  TimeSpentSpawning: ['等待刷新时长', 'Time spent waiting for respawns'],
  TimeSpentPaused: ['战斗暂停时长', 'Time spent paused'],
  FoodItemEaten: ['食用的食物', 'Food eaten'],
  HitpointsGainedFromItem: ['物品恢复的生命值', 'HP restored by item'],
  DamageDealtWithItem: ['各装备造成的伤害', 'Damage dealt by item'],
  AttacksMadeWithItem: ['各装备的攻击次数', 'Attacks made by item'],
  AttacksHitWithItem: ['各装备的命中次数', 'Hits landed by item'],
  AttacksMissedWithItem: ['各装备的未命中次数', 'Misses by item'],
  ItemUsed: ['战斗消耗物品', 'Items consumed in combat'],
  DamageTakenWithItem: ['穿戴各装备时受到的伤害', 'Damage taken while using each item'],
  EnemiesKilledWithItem: ['各装备的击杀数', 'Kills by item'],
  PrayerTotalCurrencyConsumed: ['祝祭消耗的货币', 'Currency spent on prayers'],
  PrayerTotalCurrencyPreserved: ['祝祭保留的货币', 'Currency preserved by prayers'],
  EnemyKilled: ['击杀次数', 'Enemy kills'],
  DamageDealtToEnemy: ['对各敌人造成的伤害', 'Damage dealt to each enemy'],
  DamageTakenFromEnemy: ['受到各敌人的伤害', 'Damage taken from each enemy'],
  KilledByEnemy: ['被各敌人击杀的次数', 'Deaths by enemy'],
  EnemyHit: ['对各敌人的命中次数', 'Hits landed by enemy'],
  EnemyMissed: ['对各敌人的未命中次数', 'Misses by enemy'],
  HitByEnemy: ['被各敌人命中的次数', 'Hits received by enemy'],
  EvadedEnemy: ['闪避各敌人的次数', 'Evades by enemy'],
  EncounteredEnemy: ['遇敌次数', 'Encounters by enemy'],
  RanAwayFromEnemy: ['逃离各敌人的次数', 'Escapes by enemy'],
  HitpointsStolenByEnemy: ['被各敌人吸取的生命值', 'HP stolen by each enemy'],
  WardDamageDealtToEnemy: ['对各敌人造成的护盾伤害', 'Ward damage dealt to each enemy'],
  EnemyWardDamageNegated: ['各敌人的护盾抵消量', 'Damage blocked by enemy ward'],
  EnemyArmourNegation: ['各敌人的护甲抵消量', 'Damage blocked by enemy armour'],
  DungeonCompleted: ['地牢通关次数', 'Dungeon completions'],
  AttacksMadeWithCombatStyle: ['各战斗风格的攻击次数', 'Attacks by combat style'],
  AttacksHitWithCombatStyle: ['各战斗风格的命中次数', 'Hits by combat style'],
  AttacksMissedWithCombatStyle: ['各战斗风格的未命中次数', 'Misses by combat style'],
  DamageDealtWithCombatStyle: ['各战斗风格造成的伤害', 'Damage dealt by combat style'],
  EffectApplied: ['施加战斗效果次数', 'Combat effects applied'],
  EffectSelfApplied: ['对自身施加效果次数', 'Effects applied to self'],
  AffectedByEffect: ['受到战斗效果次数', 'Combat effects received'],
  CurrencyConsumedByPrayer: ['各祝祭的货币消耗', 'Currency spent by prayer'],
  CurrencyPreservedByPrayer: ['各祝祭保留的货币', 'Currency preserved by prayer'],
  DamageDealtWithPrayer: ['各祝祭启用时造成的伤害', 'Damage dealt while using each prayer'],
  DamageTakenWithPrayer: ['各祝祭启用时受到的伤害', 'Damage taken while using each prayer'],
  CourseCompleted: ['灵巧课程完成次数', 'Agility course completions'],
  StunnedTimeSpent: ['眩晕时长', 'Time spent stunned'],
  SuccessfulAction: ['偷窃成功次数', 'Successful pickpockets'],
  FailedAction: ['偷窃失败次数', 'Failed pickpockets'],
  StunnedCount: ['眩晕次数', 'Times stunned'],
  StunAvoided: ['避免眩晕次数', 'Stuns avoided'],
  DamageTaken: ['受到伤害', 'Damage taken'],
  DamageAvoided: ['避免伤害', 'Damage avoided'],
  DamageDealtToTasks: ['对屠杀目标造成的伤害', 'Damage dealt to Slayer targets'],
  DamageTakenFromTasks: ['受到屠杀目标的伤害', 'Damage taken from Slayer targets'],
  DeathsToTasks: ['屠杀任务中死亡次数', 'Deaths during Slayer tasks'],
  TotalTaskEnemiesKilled: ['屠杀任务击杀总数', 'Total Slayer task kills'],
  MasterTasksCompleted: ['完成的屠杀任务', 'Slayer tasks completed'],
  MasterTasksRerolled: ['重选的屠杀任务', 'Slayer tasks rerolled'],
  MasterTasksExtended: ['延长的屠杀任务', 'Slayer tasks extended'],
  MasterCurrencySpentRerollingTasks: ['重选任务的货币消耗', 'Currency spent rerolling tasks'],
  MasterCurrencySpentBlockingTasks: ['屏蔽任务的货币消耗', 'Currency spent blocking tasks'],
  MasterCurrencySpentExtendingTasks: ['延长任务的货币消耗', 'Currency spent extending tasks'],
  EnemyTasksCompleted: ['各目标的屠杀任务完成数', 'Tasks completed by enemy'],
  TotalStudyActions: ['总研究次数', 'Total constellation studies'],
  TotalEventsObserved: ['总观测事件数', 'Total events observed'],
  TotalEventsSkipped: ['总跳过事件数', 'Total events skipped'],
  TotalEventsActivated: ['总激活事件数', 'Total events activated'],
  TotalEventsFinished: ['总完成事件数', 'Total events completed'],
  TimesConstellationStudied: ['各星座的研究次数', 'Studies by constellation'],
  ContellationEventsObserved: ['各星座的事件观测次数', 'Events observed by constellation'],
  TimesEventObserved: ['各事件的观测次数', 'Observations by event'],
  TimesEventActivated: ['各事件的激活次数', 'Activations by event'],
  TimesEventSkipped: ['各事件的跳过次数', 'Skips by event'],
  TimesEventFinished: ['各事件的完成次数', 'Completions by event']
};

let statisticsState = {};

function statisticKey(section, id) {
  const prefix = section === 'Quests' ? 'Quest' : section;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function statisticLabel(section, id) {
  const words = STATISTIC_LABELS[statisticKey(section, id)];
  return words ? localizedName({ zh: words[0], en: words[1] }) : id.replace(/([a-z\d])([A-Z])/g, '$1 $2');
}

function statisticUnit(section, id) {
  const key = statisticKey(section, id);
  if (key === 'CharacterCreationDate') return 'date';
  if (key === 'AnimalTimeSpentAliveStatistic') return 'hours';
  return /TimeSpent|^(?:Online|Offline|Total)(?:Playtime|TrainingTime|NothingTime)$|^BonfireTime/.test(key)
    ? 'milliseconds' : 'number';
}

function formatStatistic(value, unit) {
  if (unit === 'date') {
    const date = new Date((value - 621355968000000000) / 10000);
    return Number.isFinite(date.getTime()) ? date.toLocaleString(uiLocale()) : '—';
  }
  if (unit === 'hours' || unit === 'milliseconds') return formatXpDuration(unit === 'hours' ? value : value / 3600000);
  return decimals.format(value);
}

function statisticCategory(id) {
  const names = { CharacterStatistics: '角色', Bank: '仓库', Quests: '任务', Shop: '商店', Combat: '战斗' };
  return names[id] ? t(names[id]) : skillName(id, catalog.xpSkills);
}

function statisticSubject(section, kind, id) {
  const label = kind === 'currency' ? shopCurrencyName(id) : kind === 'item' ? gameName(catalog.items[id]) :
    gameName(catalog.statisticSubjects[id] ?? statisticsState.actions.get(section + ':' + id));
  return typeof label === 'string' && label ? label : id;
}

function initStatistics() {
  statisticsState.actions = new Map(catalog.xpActions.map(action => [action.skill + ':' + action.recipe, action]));
  byId('statisticsScope').addEventListener('change', event => selectStatisticCategory(event.currentTarget.value));
  byId('statisticsSearch').addEventListener('input', renderStatisticsContent);
}

function selectStatisticCategory(id) {
  statisticsState.scope = id;
  renderStatisticsContent();
  queuePreferences();
}

function statisticsProfileKey() {
  return profile?.characterId ? profile.characterId + ':' + profile.date : '';
}

function statisticsScope() {
  return statisticsState.scope ?? preferences.fields?.statisticsScope ?? '';
}

async function renderStatistics() {
  if (byId('statisticsPage').hidden) return;
  const key = statisticsProfileKey();
  if (!key) {
    statisticsState.data = null;
    renderStatisticsContent();
    return;
  }
  if (statisticsState.key === key && statisticsState.data && !statisticsState.failed) {
    renderStatisticsContent();
    return;
  }
  if (statisticsState.pending === key) return;
  statisticsState.pending = key;
  if (statisticsState.data?.characterId !== profile.characterId) statisticsState.data = null;
  statisticsState.failed = false;
  renderStatisticsContent();
  try {
    const data = await get('statistics/character/' + profile.characterId);
    if (statisticsProfileKey() !== key || statisticsState.pending !== key) return;
    statisticsState.data = data;
    statisticsState.key = key;
  } catch {
    if (statisticsProfileKey() !== key || statisticsState.pending !== key) return;
    statisticsState.failed = true;
  } finally {
    if (statisticsState.pending === key) {
      statisticsState.pending = null;
      renderStatisticsContent();
    }
  }
}

function renderStatisticsContent() {
  const { data, failed } = statisticsState;
  const status = byId('statisticsStatus');
  const wrapper = byId('statisticsResults');
  wrapper.hidden = !data;
  if (!data) {
    status.textContent = t(!profile?.characterId ? '选择角色存档后可查看数据统计。' :
      failed ? '暂时无法读取统计，请重新读取存档。' : '正在读取存档统计…');
    return;
  }
  const { sections, unavailable } = data;
  const missing = unavailable.length + sections.reduce((sum, section) => sum + section.unavailable.length, 0);
  status.textContent = [t('存档 {name}', { name: data.name }), new Date(data.date).toLocaleString(uiLocale()),
    missing > 0 && t('{count} 项统计暂无法读取', { count: fullNumber(missing) }),
    failed && t('暂时无法读取统计，请重新读取存档。')].filter(Boolean).join(' · ');
  const primaryCategories = ['CharacterStatistics', 'Combat', 'Bank', 'Shop', 'Quests'];
  const categoryOrder = new Map(primaryCategories.map((id, index) => [id, index]));
  const groups = [...sections].sort((a, b) =>
    (categoryOrder.get(a.id) ?? primaryCategories.length) - (categoryOrder.get(b.id) ?? primaryCategories.length));
  const overview = groups.find(group => group.id === 'CharacterStatistics')?.statistics ?? [];
  const kills = groups.find(group => group.id === 'Combat')?.statistics.find(stat => stat.id === 'CombatEnemyKilled');
  const summary = ['TotalPlaytime', 'TotalTrainingTime', 'OfflinePlaytime'].flatMap(id => {
    const stat = overview.find(row => row.id === id);
    return stat ? [[statisticLabel('CharacterStatistics', id), formatStatistic(stat.value, 'milliseconds')]] : [];
  });
  if (kills) summary.push([t('累计击杀'), fullNumber(kills.rows.reduce((sum, row) => sum + row.value, 0))]);
  const metrics = byId('statisticsMetrics');
  metrics.hidden = !summary.length;
  metrics.replaceChildren(...summary.map(([label, value]) => {
    const card = create('div');
    card.append(create('dt', label), create('dd', value));
    return card;
  }));
  const query = byId('statisticsSearch').value.trim().toLocaleLowerCase();
  const matches = text => typeof text === 'string' && text.toLocaleLowerCase().includes(query);
  const categories = groups.flatMap(group => {
    const name = statisticCategory(group.id);
    const entries = group.statistics.flatMap(stat => {
      const label = statisticLabel(group.id, stat.id);
      const full = !query || matches(name) || matches(group.id) || matches(label) || matches(stat.id);
      const rows = stat.rows?.filter(row => full || matches(row.id) || matches(statisticSubject(group.id, stat.kind, row.id)));
      return full || rows?.length ? [{ ...stat, label, rows, subjectMatch: !full }] : [];
    });
    return entries.length ? [{ id: group.id, name, entries }] : [];
  });
  const selected = categories.find(category => category.id === statisticsScope()) ?? categories[0];
  byId('statisticsSections').hidden = !selected;
  byId('statisticsEmpty').hidden = Boolean(selected);
  if (!selected) return;

  const nav = byId('statisticsCategories');
  const focus = nav.contains(document.activeElement) ? document.activeElement.dataset.section : undefined;
  const scrollTop = nav.scrollTop;
  nav.replaceChildren(...categories.map(category => {
    const button = create('button');
    button.type = 'button';
    button.dataset.section = category.id;
    button.setAttribute('aria-pressed', String(category === selected));
    button.setAttribute('aria-controls', 'statisticsDetail');
    button.append(create('span', category.name), create('span', fullNumber(category.entries.length), 'statistics-count'));
    button.addEventListener('click', () => selectStatisticCategory(category.id));
    return button;
  }));
  nav.scrollTop = scrollTop;
  if (focus) [...nav.children].find(button => button.dataset.section === focus)?.focus({ preventScroll: true });
  const select = byId('statisticsScope');
  const options = categories.map(category => new Option(category.name, category.id));
  if (options.length !== select.options.length || options.some((option, index) =>
    option.value !== select.options[index].value || option.text !== select.options[index].text)) select.replaceChildren(...options);
  select.value = selected.id;
  renderStatisticCategory(selected);
}

function renderStatisticCategory(category) {
  const content = byId('statisticsDetail');
  const openMetrics = new Set([...content.querySelectorAll('.statistics-metric[open]')].map(panel => panel.dataset.metric));
  const title = create('h2', category.name);
  title.id = 'statisticsDetailTitle';
  const totals = create('dl', undefined, 'statistics-totals');
  const breakdowns = create('div', undefined, 'statistics-breakdowns');
  for (const stat of category.entries) {
    const unit = statisticUnit(category.id, stat.id);
    if (stat.kind === 'value') {
      const pair = create('div');
      pair.append(create('dt', stat.label), create('dd', formatStatistic(stat.value, unit)));
      totals.append(pair);
      continue;
    }
    const metric = create('details', undefined, 'statistics-metric');
    metric.dataset.metric = category.id + ':' + stat.id;
    metric.open = stat.subjectMatch || openMetrics.has(metric.dataset.metric);
    const heading = create('summary');
    heading.append(create('span', stat.label), create('span', t('{count} 条记录', { count: fullNumber(stat.rows.length) }), 'statistics-count'));
    metric.append(heading);
    function showRows() {
      if (!metric.open || metric.childElementCount > 1) return;
      const values = create('dl', undefined, 'statistics-values');
      for (const row of [...stat.rows].sort((a, b) => b.value - a.value)) {
        values.append(create('dt', statisticSubject(category.id, stat.kind, row.id)), create('dd', formatStatistic(row.value, unit)));
      }
      metric.append(stat.rows.length ? values : create('p', t('存档没有该项明细。'), 'muted'));
    }
    metric.addEventListener('toggle', showRows);
    showRows();
    breakdowns.append(metric);
  }
  content.replaceChildren(title);
  if (totals.childElementCount) content.append(create('h3', t('汇总数据')), totals);
  if (breakdowns.childElementCount) content.append(create('h3', t('分类明细')), breakdowns);
}

if (typeof module !== 'undefined') module.exports = { statisticKey, statisticUnit };
