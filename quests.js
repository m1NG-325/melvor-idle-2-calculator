let questGuide;
let questActions;
let questProjections;

function initQuests(guide) {
  questGuide = guide;
  questActions = new Map([...catalog.actions, ...catalog.xpActions].map(action => [action.id, action]));
  byId('questChoice').addEventListener('change', renderQuest);
  localizeQuests();
}

function questName(ref) {
  return gameName(questGuide.names[ref]);
}

function questItem(id) {
  return gameName(catalog.items[id]) ?? t('未知物品');
}

function questSkill(id) {
  if (id === 'Combat') return t('战斗');
  if (id === 'Shop') return t('商店');
  if (id === 'Quests') return t('任务');
  return id && skillName(id, catalog.xpSkills);
}

function localizeQuests() {
  if (!questGuide) return;
  const select = byId('questChoice');
  const selected = select.value;
  const groups = new Map();
  for (const quest of questGuide.quests) {
    if (!groups.has(quest.category)) {
      const group = create('optgroup');
      group.label = questName(quest.category) ?? t('任务');
      groups.set(quest.category, group);
    }
    const option = new Option(gameName(quest), quest.id);
    option.dataset.questName = option.text;
    groups.get(quest.category).append(option);
  }
  select.replaceChildren(new Option(t('当前任务（自动）'), ''), ...groups.values());
  if (questGuide.quests.some(quest => quest.id === selected)) select.value = selected;
  select.disabled = !questGuide.quests.length;
  byId('questEmpty').hidden = !select.disabled;
  renderQuest();
}

function updateQuestCompletion(select, progress) {
  const styledPicker = CSS.supports('appearance', 'base-select') && CSS.supports('selector(select::picker(select))');
  for (const option of select.options) {
    if (!option.value) continue;
    const completed = progress?.[option.value]?.status === 3;
    const name = option.dataset.questName;
    option.toggleAttribute('data-completed', completed);
    if (completed) option.setAttribute('aria-label', name + ' · ' + t('已完成'));
    else option.removeAttribute('aria-label');
    if (!styledPicker) {
      const text = completed ? name + '  √' : name;
      if (option.text !== text) option.text = text;
    }
  }
}

function questSourcePath(where) {
  const target = questName(where.target);
  const area = questName(where.area);
  return [questSkill(where.skill), area === target ? null : area, target, questName(where.variant)]
    .filter(Boolean).join(' › ');
}

function questSourcesFor(item, skill) {
  return (questGuide.sources[item] ?? [])
    .filter(where => !skill || where.skill === skill)
    .sort((a, b) => Number(a.questOnly) - Number(b.questOnly));
}

function questSourceLabel(where) {
  const prefix = {
    open: '打开 {name}', reward: '任务奖励 · {name}', purchase: '购买 · {name}',
    drop: '掉落 · {name}', clear: '通关奖励 · {name}', modifierDrop: '需额外掉落加成 · {name}',
    upgrade: '升级 · {name}', event: '特殊事件 · {name}', timedReward: '限时通关奖励 · {name}',
    offering: '星界献祭 · {name}'
  }[where.kind];
  const path = questSourcePath(where);
  return prefix ? t(prefix, { name: path }) : path;
}

function questSourceStage(quest, step) {
  const name = gameName(questGuide.quests.find(row => row.id === quest)) ?? t('未知名称');
  return name && Number.isInteger(step) ? t('{name} · 第 {step} 步', { name, step: step + 1 }) : name;
}

function questSourceNotes(where, restrictions) {
  const stages = where.stages.map(({ quest, step }) => questSourceStage(quest, step)).filter(Boolean);
  const level = { skill: questSkill(where.skill), level: fullNumber(where.level) };
  const stage = where.questOnly && t('任务阶段限定') + (stages.length ? ' · ' + stages.join(' / ') : '');
  return [
    where.level && !restrictions.includes(t('需{skill} {level} 级', level)) && t('{skill} {level} 级', level),
    stage && !restrictions.includes(stage) && stage
  ].filter(Boolean);
}

function questSourceRequirementMet(req, character = profile) {
  switch (req.type) {
    case 'Level':
      return meetsShopCondition(req, character);
    case 'ShopPurchase':
      return meetsShopCondition({ ...req, id: req.purchase }, character);
    case 'DungeonStatistic':
    case 'SlayerMasterStatistic':
      return meetsShopCondition({ ...req, id: req.statisticTarget, amount: req.statisticValue }, character);
    case 'QuestComplete':
      return character.questProgress ? character.questProgress[req.quest]?.status === 3 : null;
    case 'QuestStepActive':
    case 'QuestTaskGoalActive':
      return character.questProgress ? meetsRequirements([req], character) : null;
    case 'ToolbeltItemEquipped':
      return character.equipped?.[req.skill]?.includes(req.item) ?? null;
    case 'MasteryGuildRank':
      return character.ranks?.[req.skill]?.includes(req.rank) ?? null;
    case 'AstrologyMajorNodeUnlocked':
    case 'AstrologyMinorNodeUnlocked':
      return character.astrologyNodes?.includes(req.node) ?? null;
    case 'AgilityCourseStatistic':
    case 'AstrologyEventStatistic':
    case 'ItemStatistic':
      return character.recipeStatistics?.[req.statistic] ? meetsRequirements([req], character) : null;
    default:
      return null;
  }
}

function questSourceRequirementText(req) {
  if (req.type === 'QuestComplete') return t('完成任务「{name}」', { name: questSourceStage(req.quest) });
  if (req.type === 'QuestStepActive' || req.type === 'QuestTaskGoalActive') {
    const stage = questSourceStage(req.quest, req.questStep);
    return stage ? t('任务阶段限定') + ' · ' + stage : t('任务阶段限定');
  }
  if (req.type === 'ToolbeltItemEquipped' && req.item) return t('需要装备 {item}', { item: questItem(req.item) });
  return productionRestrictionText({ type: 'requirement', clause: [req] }, catalog);
}

function questSourceRestrictions(where) {
  if (!profile?.characterId) return [];
  const action = questActions.get(where.actionId);
  const confirmed = action && profile.confirmed?.includes(action.id);
  const restrictions = requirementClauses(where.requirementGroups ?? [])
    .filter(clause => clause.every(req => questSourceRequirementMet(req) === false &&
      (!confirmed || ['Level', 'QuestComplete', 'QuestStepActive', 'QuestTaskGoalActive'].includes(req.type))))
    .map(clause => [...new Set(clause.map(questSourceRequirementText))].join(' / '));
  if (action && profile.excluded?.includes(action.id)) restrictions.push(t('此行动已排除'));
  return [...new Set(restrictions)];
}

function appendQuestRestrictions(entry, restrictions) {
  if (restrictions.length) entry.append(create('small',
    t('限制：{conditions}', { conditions: restrictions.join(' · ') }), 'quest-source-restriction'));
}

function appendQuestContainerOrigins(entry, where) {
  if (!where.container) return;
  for (const origin of questSourcesFor(where.container).filter(source => source.kind !== 'open')) {
    entry.append(create('small', t('容器来源 {items}', { items: questSourcePath(origin) })));
    appendQuestRestrictions(entry, questSourceRestrictions(origin));
  }
}

function questProduction(item, where, remaining, projections) {
  const action = questActions.get(where.actionId);
  if (!action) return { note: t('此来源暂无效率估算') };
  if (!profile?.characterId) return { note: t('读取存档后可估算产量') };
  if (!projections.has(action.id)) {
    projections.set(action.id, projectHourlyProduction(action, profile, catalog));
  }
  const result = projections.get(action.id);
  if (result?.locked) return { restriction: t('当前未满足行动条件') };
  if (!result) return { note: t('此来源暂无效率估算') };
  const rate = result.drops.filter(row => row.id === item && !row.target)
    .reduce((sum, row) => sum + row.quantity, 0);
  const limit = result.limit && (action.currencyCosts?.some(([id]) => id === result.limit)
    ? shopCurrencyName(result.limit) : questItem(result.limit));
  const time = remaining > 0 ? result.timeForItems?.(item, remaining) : null;
  const notes = [
    limit && result.activeHours && t('约 {time}后用完{item}', { time: formatDuration(result.activeHours), item: limit }),
    result.risky && t('有受伤风险'),
    !rate && !limit && time == null && t('当前未估出产量')
  ].filter(Boolean);
  const restriction = limit && !result.activeHours ? t('所需材料或货币不足 · {item}', { item: limit }) :
    remaining > 0 && rate > 0 && time == null ? t('按现有材料无法凑齐') : null;
  return { rate, time, note: notes.join(' · '), restriction };
}

function questSourceList(locations, item, remaining, projections = new Map(), material = false) {
  const container = create('div', undefined, 'quest-source-list');
  if (!locations.length) {
    container.append(create('p', t('本机游戏数据中未找到产出位置。'), 'muted'));
    return container;
  }
  const list = create('ul', undefined, material ? 'quest-material-sources' : 'quest-source-paths');
  const extra = create('ul', undefined, 'quest-source-paths');
  const direct = where => Number(where.kind === 'action' && where.target?.endsWith(':' + item));
  const rows = locations.map(where => {
    const restrictions = questSourceRestrictions(where);
    const production = item && !material && !restrictions.length ? questProduction(item, where, remaining, projections) : {};
    if (production.restriction) restrictions.push(production.restriction);
    return { where, production, restrictions };
  })
    .sort((a, b) => {
      const timeA = a.production.time ?? Infinity;
      const timeB = b.production.time ?? Infinity;
      return (timeA === timeB ? 0 : timeA - timeB) || (b.production.rate ?? 0) - (a.production.rate ?? 0) ||
        (material ? direct(b.where) - direct(a.where) : 0);
    });
  for (const [index, { where, production, restrictions }] of rows.entries()) {
    const entry = create('li', questSourceLabel(where));
    const notes = questSourceNotes(where, restrictions);
    if (production.note) notes.push(production.note);
    if (production.rate > 0) {
      const quantity = production.rate < 0.01 ? '<' + decimals.format(0.01) : decimals.format(production.rate);
      entry.append(' ', create('strong', t('约 {quantity} 件／小时', { quantity }), 'quest-yield'));
    }
    if (production.time != null) {
      notes.push(t('约 {time} 可凑齐', { time: formatDuration(production.time, true) }));
    }
    if (notes.length) entry.append(create('small', notes.join(' · ')));
    const minutes = Math.ceil(production.time * 60);
    if (!material && !restrictions.length && minutes > 0 && actionQueue.targets.has(where.actionId) &&
        actionQueue.steps.length < maxQueueSteps) {
      const goal = Number.isInteger(remaining) && remaining > 0 && remaining <= 1000000000 &&
        actionQueue.targets.get(where.actionId)?.action.outputItems?.includes(item)
        ? { type: 'item', item, value: remaining } : null;
      const step = { key: where.actionId, minutes: goal ? 0 : minutes, ...(goal && { goal }) };
      if (validQueueStep(step)) entry.append(' ', queueButton('加入定时挂机', () => appendQueuePlan([step])));
    }
    appendQuestRestrictions(entry, restrictions);
    if (!material && where.ingredients.length) {
      const materialList = create('ul', undefined, 'quest-recipe-inputs');
      for (const { item, quantity } of where.ingredients) {
        const input = create('li', t('每次所需 {item} × {quantity}', { item: questItem(item), quantity: fullNumber(quantity) }));
        input.append(questSourceList(questSourcesFor(item), item, 0, projections, true));
        materialList.append(input);
      }
      entry.append(materialList);
    }
    appendQuestContainerOrigins(entry, where);
    (item && index >= (material ? 2 : 4) ? extra : list).append(entry);
  }
  container.append(list);
  if (extra.childElementCount) {
    const details = create('details', undefined, 'quest-more');
    details.append(create('summary', t('查看另外 {count} 个来源', { count: fullNumber(extra.childElementCount) })), extra);
    container.append(details);
  }
  return container;
}

function questObjectiveProgress(objective, savedTask, completed) {
  const { kind, item, currency, quantity, goalId } = objective;
  if (completed) return { remaining: 0, note: t('已完成') };
  if (kind === 'submit' && profile?.characterId) {
    const available = item ? profile.stock[item] ?? 0 : profile.currencies[currency] ?? 0;
    const remaining = Math.max(0, quantity - available);
    return { remaining, note: remaining
      ? t('已有 {available} · 还缺 {remaining}', { available: fullNumber(available), remaining: fullNumber(remaining) })
      : t('库存已足够交付') };
  }
  const state = goalId == null ? null : savedTask?.goals[goalId];
  if (state?.complete) return { remaining: 0, note: t('已完成') };
  if (Number.isFinite(state?.progress) && Number.isFinite(quantity)) {
    const remaining = Math.max(0, Math.ceil(quantity - state.progress));
    return { remaining, note: t('进度 {progress} / {total} · 还需 {remaining}', {
      progress: decimals.format(state.progress), total: fullNumber(quantity), remaining: fullNumber(remaining)
    }) };
  }
  return { remaining: quantity };
}

function renderQuestObjective(objective, savedTask, completed) {
  const { kind, item, currency, target, skill, quantity, variant, style } = objective;
  const labels = {
    submit: '交付 {item} × {quantity}', collect: '通过指定行动获得 {item} × {quantity}',
    cut: '砍倒 {item} × {quantity}', mine: '敲碎 {item} × {quantity}',
    make: objective.itemCount ? '制作 {item}，产出 {quantity} 件' : '制作 {item} × {quantity} 次',
    burn: '燃烧 {item} × {quantity}', plant: '种植 {item} × {quantity}', trap: '捕获 {item} × {quantity}',
    pickpocket: '偷窃 {item} × {quantity}', kill: '击败 {item} × {quantity}', clear: '完成 {item} × {quantity}',
    observe: '观测 {item} × {quantity}', level: '{item} 达到 {quantity} 级', nodes: '解锁 {item} 的 {quantity} 个主要节点',
    unknown: '请在游戏内查看此目标。'
  };
  const name = item ? questItem(item) : currency ? shopCurrencyName(currency) : questName(target) ?? t('未知名称');
  const what = [name, questName(variant)].filter(Boolean).join(' · ');
  const card = create('div', undefined, 'quest-objective');
  card.append(create('h3', t(labels[kind], { item: what, quantity: fullNumber(quantity ?? 0) })));
  const { remaining, note } = questObjectiveProgress(objective, savedTask, completed);
  if (note) card.append(create('p', note, 'quest-objective-progress'));
  if (style) card.append(create('p', t('需使用 {style} 战斗', {
    style: gameName(catalog.combatModel.styles[style]) ?? t('未知名称')
  }), 'muted'));
  if (item || objective.locations) {
    const locations = (item ? questSourcesFor(item, skill) : objective.locations)
      .map(where => kind === 'kill' || kind === 'clear' ? { ...where, kind: 'action' } : where);
    card.append(questSourceList(locations, item, remaining, questProjections));
  }
  return card;
}

function renderQuest() {
  if (!questGuide) return;
  questProjections = new Map();
  const select = byId('questChoice');
  const progress = profile?.questProgress;
  updateQuestCompletion(select, progress);
  const current = questGuide.quests.find(row => [1, 2].includes(progress?.[row.id]?.status));
  select.options[0].text = current ? t('当前任务（自动）') + ' · ' + gameName(current) : t('当前任务（自动）');
  const quest = questGuide.quests.find(row => row.id === select.value) ?? current ??
    questGuide.quests.find(row => progress?.[row.id]?.status !== 3) ?? questGuide.quests[0];
  const savedQuest = progress?.[quest?.id];
  const activeStep = quest?.steps.findIndex(step => savedQuest?.steps[step.id]?.status === 1) ?? -1;
  const container = byId('questSteps');
  const sameQuest = container.dataset.quest === quest?.id;
  const sameStep = container.dataset.activeStep === String(activeStep);
  const openSteps = new Set([...container.querySelectorAll('details.quest-step[open]')].map(step => step.dataset.index));
  const openSources = [...container.querySelectorAll('.quest-more')].map(details => details.open);
  container.dataset.quest = quest?.id ?? '';
  container.dataset.activeStep = String(activeStep);
  container.replaceChildren(...(quest?.steps ?? []).map(({ id, tasks }, index) => {
    const savedStep = savedQuest?.steps[id];
    const completed = savedQuest?.status === 3 || savedStep?.status === 2;
    const step = create('details', undefined, 'panel quest-step');
    step.dataset.index = String(index);
    step.open = sameQuest && sameStep ? openSteps.has(step.dataset.index) : index === Math.max(0, activeStep);
    const status = completed ? t('已完成') : index === activeStep ? t('当前步骤') : '';
    const heading = create('summary', [t('任务步骤 {step} / {total}', {
      step: index + 1, total: quest.steps.length
    }), status].filter(Boolean).join(' · '));
    const body = create('div', undefined, 'quest-objectives');
    for (const { id, objectives } of tasks) {
      if (!objectives.length) continue;
      const savedTask = savedStep?.tasks[id];
      const entries = create('div', undefined, 'quest-task');
      entries.append(...objectives.map(objective => renderQuestObjective(objective, savedTask, completed || savedTask?.status === 2)));
      body.append(entries);
    }
    if (!body.childElementCount) body.append(create('p', t('此步骤没有可列出的材料或行动。'), 'muted'));
    step.append(heading, body);
    return step;
  }));
  if (sameQuest) [...container.querySelectorAll('.quest-more')].forEach((details, index) => {
    details.open = openSources[index] ?? false;
  });
}
