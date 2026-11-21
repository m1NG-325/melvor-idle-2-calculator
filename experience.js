function compareExperience(catalog, character, hours, targets) {
  const groups = Object.fromEntries(Object.keys(catalog.xpSkills)
    .filter(skill => !COMBAT_XP_SKILLS.includes(skill)).map(skill => [skill, []]));
  const rows = rank(catalog, character, { hours, offlineCap: 24, sell: false, metric: 'xp' });
  for (const row of rows) groups[row.action.skill]?.push(row);
  if (targets) for (const [skill, actions] of Object.entries(groups)) {
    const remaining = targets[skill]?.remaining;
    if (!(remaining > 0)) continue;
    for (const row of actions) row.targetPlan = row.planXp(remaining);
    actions.sort(compareUpgradePlans);
  }
  return groups;
}

function compareUpgradePlans(a, b) {
  const first = a.targetPlan;
  const second = b.targetPlan;
  const reachable = Number(Boolean(second?.reaches)) - Number(Boolean(first?.reaches));
  if (reachable) return reachable;
  if (first?.reaches && second?.reaches) return first.hours - second.hours;
  return (second?.xp ?? 0) - (first?.xp ?? 0) || (first?.hours ?? 0) - (second?.hours ?? 0);
}

let xpView;
let experienceSection = 'skills';

function showExperienceSection(isExperiencePage) {
  const showCombat = experienceSection === 'combat';
  byId('xpSkillsButton').setAttribute('aria-pressed', String(!showCombat));
  byId('xpCombatButton').setAttribute('aria-pressed', String(showCombat));
  byId('xpSkillsSection').hidden = showCombat;
  const combatSection = byId('xpCombatSection');
  combatSection.hidden = !showCombat;
  const panel = byId('combatXp');
  // Share one panel so both pages show the same estimate and editable targets.
  const destination = isExperiencePage && showCombat ? combatSection : byId('combatPage');
  if (panel.parentElement !== destination) destination.append(panel);
}

function initExperience(catalog) {
  const saved = preferences.fields?.xpSkill;
  const skill = Object.hasOwn(catalog.xpSkills, saved) && !COMBAT_XP_SKILLS.includes(saved) ? saved :
    Object.keys(catalog.xpSkills).find(id => !COMBAT_XP_SKILLS.includes(id));
  xpView = { catalog, character: null, bonusesByCharacter: new Map(), goalsByCharacter: new Map(),
    actionsByCharacter: new Map(), skill };
  byId('xpHours').addEventListener('input', renderExperience);
  byId('xpMode').addEventListener('change', renderExperience);
  for (const button of document.querySelectorAll('[data-xp-hours]')) {
    button.addEventListener('click', () => applyIdleDuration(byId('xpHours'), Number(button.dataset.xpHours)));
  }
  byId('xpBonus').addEventListener('input', () => {
    const input = byId('xpBonus');
    if (!input.value || !input.checkValidity()) return;
    experienceBonuses()[xpView.skill] = input.valueAsNumber;
    renderExperience();
  });
  byId('xpBonus').addEventListener('blur', () => { byId('xpBonus').value = experienceBonuses()[xpView.skill] ?? 0; });
  const goal = byId('xpGoalLevel');
  const slider = byId('xpGoalSlider');
  goal.addEventListener('input', () => {
    if (!goal.value || !goal.checkValidity()) return;
    setExperienceGoal(xpView.character, xpView.skill, goal.valueAsNumber);
    renderXpGoalSlider(slider, goal.valueAsNumber);
    renderExperience();
  });
  slider.addEventListener('input', () => {
    setExperienceGoal(xpView.character, xpView.skill, slider.valueAsNumber);
    goal.value = slider.value;
    renderXpGoalSlider(slider, slider.valueAsNumber);
    renderExperience();
  });
  goal.addEventListener('blur', () => { goal.value = selectedExperienceGoal().level; });
  byId('xpNextLevel').addEventListener('click', () => {
    delete experienceGoals()[xpView.skill];
    syncExperienceInputs();
    renderExperience();
    queuePreferences();
  });
  byId('xpResetGoals').addEventListener('click', () => {
    resetExperienceGoals(Object.keys(xpView.catalog.xpSkills).filter(skill => !COMBAT_XP_SKILLS.includes(skill)));
    syncExperienceInputs();
    renderExperience();
  });
  byId('xpActionChoice').addEventListener('change', event => {
    const choices = experienceActionChoices();
    if (event.target.value) choices[xpView.skill] = event.target.value;
    else delete choices[xpView.skill];
    renderExperience();
    queuePreferences();
  });
}

function localizeExperience() {
  if (!xpView) return;
  byId('xpDetailHeading').textContent = t('{skill}行动排行', { skill: skillName(xpView.skill, xpView.catalog.xpSkills) });
}

function experienceBonuses() {
  const key = xpView.character?.characterId ?? 'manual';
  if (!xpView.bonusesByCharacter.has(key)) xpView.bonusesByCharacter.set(key, {});
  return xpView.bonusesByCharacter.get(key);
}

function experienceGoals(character = xpView.character) {
  const key = character?.characterId ?? 'manual';
  if (!xpView.goalsByCharacter.has(key)) xpView.goalsByCharacter.set(key, {});
  return xpView.goalsByCharacter.get(key);
}

function resetExperienceGoals(skills, character) {
  const goals = experienceGoals(character);
  for (const skill of skills) delete goals[skill];
  queuePreferences();
}

function experienceActionChoices() {
  const key = xpView.character?.characterId ?? 'manual';
  if (!xpView.actionsByCharacter.has(key)) xpView.actionsByCharacter.set(key, {});
  return xpView.actionsByCharacter.get(key);
}

function selectExperienceAction(rows, goalMode, target) {
  const input = byId('xpActionChoice');
  const saved = experienceActionChoices()[xpView.skill];
  const best = rows[0];
  const selected = rows.find(row => row.action.id === saved);
  const label = !goalMode ? '最高收益 · {action}' : target?.remaining === 0 ? '已达到目标' :
    best?.targetPlan?.reaches ? '最快升级 · {action}' : '当前库存经验最多 · {action}';
  const options = [new Option(best ? t(label, { action: gameName(best.action) }) : t('暂无可用行动'), '')];
  for (const row of rows) options.push(new Option(gameName(row.action), row.action.id));
  if (saved && !selected) {
    const previous = xpView.catalog.xpActions.find(action => action.id === saved);
    const unavailable = new Option(t('{action}（暂不可用）', { action: gameName(previous) ?? saved }), saved);
    unavailable.disabled = true;
    options.push(unavailable);
  }
  const changed = input.options.length !== options.length || options.some((option, index) => {
    const current = input.options[index];
    return current.value !== option.value || current.text !== option.text || current.disabled !== option.disabled;
  });
  if (changed) input.replaceChildren(...options);
  if (input.value !== (saved ?? '')) input.value = saved ?? '';
  input.disabled = !best;
  return { row: selected ?? best, unavailable: Boolean(saved && !selected && best) };
}

function selectedExperienceGoal(character = xpView.character, skill = xpView.skill) {
  const saved = experienceGoals(character)[skill];
  if (Number.isInteger(saved?.level) && saved.level >= 1 && saved.level <= XP_LEVEL_CAP) return saved;
  return { level: Math.min(XP_LEVEL_CAP, (character?.levels[skill] || 1) + 1) };
}

function setExperienceGoal(character, skill, target) {
  const goals = experienceGoals(character);
  if (goals[skill]?.level === target) return;
  const state = xpGoalProgress(character?.levels?.[skill] ?? 1, character?.skillXp?.[skill], target);
  goals[skill] = { level: target, startingXp: state?.xp };
  queuePreferences();
}

function updateExperience(character, preserveDraft = false) {
  if (!xpView) return;
  const sameCharacter = xpView.character?.characterId === character?.characterId;
  xpView.character = character;
  syncExperienceInputs(preserveDraft && sameCharacter);
  renderExperience();
}

function syncExperienceInputs(preserveDraft = false) {
  localizeExperience();
  if (!preserveDraft || document.activeElement !== byId('xpBonus')) byId('xpBonus').value = experienceBonuses()[xpView.skill] ?? 0;
  if (!preserveDraft || document.activeElement !== byId('xpGoalLevel')) byId('xpGoalLevel').value = selectedExperienceGoal().level;
  renderXpGoalSlider(byId('xpGoalSlider'), selectedExperienceGoal().level);
}

function renderExperienceGoal(goal, row, unavailable, plannedHours) {
  const container = byId('xpGoalOverview');
  const { items } = xpView.catalog;
  if (!goal) {
    container.textContent = t('暂无等级进度');
    return;
  }
  const plan = row?.targetPlan ?? row?.planXp(goal.remaining);
  const blocked = plan && !plan.reaches;
  const timing = goal.remaining === 0 ? t('已达到目标') :
    blocked ? t(plan.reason ?? '当前库存不足') : formatXpDuration(plan?.hours);
  const metrics = create('dl', undefined, 'xp-goal-metrics');
  const labels = [
    ['等级', t('{current} → {target}', { current: goal.level, target: goal.target })],
    ['剩余 XP', fullNumber(Math.ceil(goal.remaining))],
    ['预计剩余时间', timing]
  ];
  if (blocked) labels.push([plan.reason && plan.reason !== '当前库存不足' ? '时段内可获 XP' : '库存可获 XP', fullNumber(plan.xp)]);
  for (const [label, value] of labels) {
    const field = create('div');
    field.append(create('dt', t(label)), create('dd', value));
    metrics.append(field);
  }
  const progress = create('progress');
  progress.max = 1;
  progress.value = goal.progress;
  progress.setAttribute('aria-label', t('目标等级进度'));
  const note = [
    row && goal.remaining > 0 && t('按「{action}」的经验收益估算', { action: gameName(row.action) }),
    unavailable && t('所选行动暂不可用，当前按推荐行动估算'),
    blocked && row.stockLimit && t('{time}后缺{item}', {
      time: formatDuration(plan.hours, true), item: limitName({ limit: row.stockLimit })
    }),
    blocked && plan.limit && t('缺少 {item}', { item: gameName(items[plan.limit]) ?? shopCurrencyName(plan.limit) }),
    row?.action.kind === 'Farming' && t('目标时间按手动种植和及时收获估算。'),
    row?.action.kind === 'GrainMill' && t('目标时间允许先把仓库原料装入磨坊。'),
    plan?.reaches && plan.hours > plannedHours && t('超过本次挂机时长'),
    row?.risky && t('失败可受伤，未计生存时间'),
    !goal.exact && t('按所设等级的起始经验计算')
  ].filter(Boolean);
  container.replaceChildren(metrics, progress);
  if (note.length) container.append(create('p', note.join(' · '), 'muted'));
}

function renderExperience() {
  if (!xpView?.character) return;
  const input = byId('xpHours');
  const goalMode = byId('xpMode').value === 'goal';
  byId('xpIdleControls').hidden = goalMode;
  byId('xpTotalHeading').textContent = t(goalMode ? '预计可获 XP' : '预计 XP');
  byId('xpAverageHeading').hidden = goalMode;
  if (!goalMode && (!input.checkValidity() || !input.value)) return;
  const { catalog, character } = xpView;
  const hours = goalMode ? 24 : input.valueAsNumber;
  const selected = xpView.skill;
  const goalForSkill = skill => {
    const goal = selectedExperienceGoal(character, skill);
    return xpGoalProgress(character.levels[skill], character.skillXp?.[skill], goal.level, null, goal.startingXp);
  };
  const targets = goalMode ? Object.fromEntries(Object.keys(catalog.xpSkills).map(skill => [skill, goalForSkill(skill)])) : null;
  const groups = compareExperience(catalog, { ...character, xpBonuses: experienceBonuses() }, hours, targets);
  const recommendations = Object.values(groups).filter(rows => rows.length).length;
  byId('xpStatus').textContent = t(goalMode ? '按达到各技能目标等级的时间排序，默认目标为下一级。' :
    '{count} / {total} 个技能有可比较的行动 · 按所选时长内的总经验排序', {
    count: recommendations, total: Object.keys(groups).length
  });
  const supportedSkills = new Set(catalog.xpActions.map(action => action.skill));
  const focusedSkill = byId('xpBest').contains(document.activeElement) ? document.activeElement.dataset.skill : null;
  const expanded = new Set([...byId('xpRows').querySelectorAll('details[open]')].map(details => details.dataset.action));
  byId('xpBest').replaceChildren(...Object.entries(groups).map(([skill, rows]) => {
    const card = create('button', undefined, 'xp-card');
    card.type = 'button';
    card.setAttribute('aria-pressed', String(skill === selected));
    const top = rows[0];
    const heading = create('span', undefined, 'xp-card-heading');
    heading.append(create('strong', skillName(skill, catalog.xpSkills)));
    if (character.levels[skill]) heading.append(create('span', t('等级 {level}', { level: character.levels[skill] }), 'xp-card-level'));
    const actionName = gameName(top?.action) ?? t(supportedSkills.has(skill) ? '暂无可用行动' : '暂未支持');
    const actionLabel = create('span', actionName, 'xp-card-action muted');
    actionLabel.title = actionName;
    const plan = top?.targetPlan;
    const summary = goalMode ? targets[skill]?.remaining === 0 ? t('已达到目标') :
      plan?.reaches ? t('到目标约 {time}', { time: formatXpDuration(plan.hours) }) :
        plan ? t(plan.reason && plan.reason !== '当前库存不足' ? '时段内可获 {xp} XP' : '库存可获 {xp} XP',
          { xp: fullNumber(plan.xp) }) : '' :
      top ? (top.passive?.needsHarvest && top.xp === 0 ? t('需要手动收获') :
        t('整段 {xp} XP', { xp: fullNumber(top.xp) })) : '';
    card.append(heading, actionLabel, create('span', summary, 'xp-rate'));
    card.dataset.skill = skill;
    card.addEventListener('click', () => {
      xpView.skill = skill;
      syncExperienceInputs();
      renderExperience();
      byId('xpBest').querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
      queuePreferences();
    });
    return card;
  }));
  if (focusedSkill) [...byId('xpBest').children].find(card => card.dataset.skill === focusedSkill)?.focus({ preventScroll: true });

  const rows = groups[selected];
  const goal = targets?.[selected] ?? goalForSkill(selected);
  const choice = selectExperienceAction(rows, goalMode, goal);
  renderExperienceGoal(goal, choice.row, choice.unavailable, goalMode ? Infinity : hours);
  updateSkillTraining({ ...character, xpBonuses: experienceBonuses() }, {
    skill: selected, hours, goal, goalMode, actionId: choice.unavailable ? '' : experienceActionChoices()[selected]
  });
  byId('xpTable').hidden = !rows.length;
  byId('xpEmpty').hidden = !!rows.length;
  const noAction = {
    Farming: '没有可用地块或符合条件的作物。请读取农务存档。',
    Ranching: '没有正在生产的畜群。请先在游戏内饲养动物。',
    Hunting: '没有可用的狩猎方案。请检查等级、陷阱库存和存档中的选择。'
  };
  byId('xpEmpty').textContent = t(supportedSkills.has(selected) ?
    noAction[selected] ?? '没有同时满足等级、解锁条件和库存的行动。' : '这项技能暂未支持经验排行。');
  const displayed = rows.slice(0, 20);
  if (choice.row && !displayed.includes(choice.row)) displayed.push(choice.row);
  byId('xpRows').replaceChildren(...displayed.map(row => {
    const item = create('tr');
    item.classList.toggle('xp-estimate-action', row === choice.row);
    const note = row.passive ? [] : [t('基础经验 {value}', { value: decimals.format(row.action.baseXp) }),
      t('识别加成 {value}%', { value: decimals.format(row.knownXpPercent) })];
    const percent = value => decimals.format(value * 100) + '%';
    if (row.agility) note.push(t('每圈平均 {time} · 已计失败重试和入场消耗', {
      time: formatXpDuration(row.seconds / 3600)
    }));
    if (row.skillCharges?.length) note.push(t('道具预计消耗 {items}，耗尽后按剩余加成计算。', {
      items: row.skillCharges.map(charge => (gameName(catalog.items[charge.id]) ?? charge.id) +
        ' × ' + fullNumber(Math.ceil(charge.quantity))).join(' · ')
    }));
    if (row.hunting) {
      note.push(t('平均捕获几率 {value} · 已计调查和追踪', { value: percent(row.hunting.success) }));
      if (row.hunting.trap) note.push(t('使用陷阱 {item}', { item: gameName(catalog.items[row.hunting.trap]) }));
      if (row.hunting.bait) note.push(t('使用诱饵 {item}，耗尽后按无诱饵计算', { item: gameName(catalog.items[row.hunting.bait]) }));
      if (row.hunting.firstExtra) note.push(t('已计首次发现的额外追踪时间'));
    }
    if (row.action.kind === 'Farming') {
      note.push(t('可用地块 {count}', { count: fullNumber(row.passive.plots) }),
        t(goalMode ? '按手动种植和及时收获估算，最多预测 7 天。' : '假设空地已播种，挂机经验按存档里的自动收获和补种设置结算。'));
      if (!goalMode && row.passive.needsHarvest) note.push(t('需要手动收获'));
    }
    if (row.passive?.mill) note.push(t(goalMode ?
      '按磨坊和仓库中可用的原料估算，最多预测 7 天。' : '挂机只计算存档里已启动的磨坊配方和已装入的原料。'));
    if (row.action.kind === 'Ranching') note.push(t('当前饲养 {count} 只 · 按生产周期、年龄、饲料及状态估算接下来 24 小时。', {
      count: fullNumber(row.passive.animals)
    }));
    if (row.manualXpPercent) note.push(t('额外 {value}%', { value: decimals.format(row.manualXpPercent) }));
    if (row.cooking) {
      const { proficiency, difficulty, success, preserveOnFail } = row.cooking;
      note.push(t('烹饪精通 {value}', { value: decimals.format(proficiency) }),
        t('产品难度 {value}', { value: decimals.format(difficulty) }),
        t('成功几率 {value}', { value: percent(success) }),
        t('烹饪失败时无经验和产物'));
      if (!goalMode) note.push(t('每次尝试平均 {value} XP', { value: decimals.format(row.xpPerCycle) }));
      if (preserveOnFail) note.push(t('失败时额外保留材料几率 {value}', { value: percent(preserveOnFail) }));
      if (row.cooking.charges.length) {
        for (const { item, quantity } of row.cooking.charges) {
          note.push(t('{item} 可用 {count} 次', { item: gameName(catalog.items[item]) ?? item, count: fullNumber(quantity) }));
        }
        if (!goalMode) note.push(t('计入加成耗尽后，本次平均成功率 {value}', { value: percent(row.cooking.sessionSuccess) }));
      }
    }
    if (row.thieving) {
      note.push(t('成功几率 {value}', { value: percent(row.thieving.success) }),
        t('每次尝试平均 {value} XP', { value: decimals.format(row.xpPerCycle) }));
    }
    if (row.fishing) {
      note.push(t('杂物几率 {value}，仍可获得经验', { value: percent(row.fishing.junkChance) }));
      if (row.fishing.priority) note.push(t('优先鱼获 {item}', {
        item: gameName(catalog.items[row.fishing.priority]) ?? row.fishing.priority
      }));
    }
    if (row.brewing) note.push(t('每轮准备 {setup} 秒，每瓶 {bottle} 秒，最多装瓶 {count} 次', {
      setup: decimals.format(row.brewing.setup), bottle: decimals.format(row.brewing.bottling), count: row.brewing.batchSize
    }));
    if (row.craftingSteps?.steps > 1) note.push(t('制作步数 {steps}，跳步几率 {chance}', {
      steps: row.craftingSteps.steps, chance: percent(row.craftingSteps.skip)
    }));
    if (row.consumption < 1) note.push(t('平均保留材料几率 {value}', { value: percent(1 - row.consumption) }));
    if (row.knowledge != null) {
      note.push(t('每次研究 {value} 知识', { value: decimals.format(row.knowledge) }));
      if (!goalMode) note.push(t('{value} 知识／小时', { value: decimals.format(row.knowledge * row.cycles / hours) }));
    }
    if (row.wood) {
      note.push(t('双倍伤害 {value}', { value: percent(row.wood.doubleDamage) }), t('弱点 {value}', { value: percent(row.wood.weak) }),
        t('直接砍倒 {value}', { value: percent(row.wood.instant) }), t('产出翻倍 {value}', { value: percent(row.wood.output) }),
        t('每击 {value} 秒', { value: decimals.format(row.wood.interval) }),
        t('固定经验 {value}', { value: decimals.format(row.flatXp) }), t('砍倒经验 {value}', { value: decimals.format(row.xpPerCycle) }));
    }
    if (row.mining) {
      note.push(t('每击碎裂几率 {value}', { value: percent(row.mining.chance) }),
        t('触发破碎 {value}', { value: percent(row.mining.shatter) }),
        t('碎裂进度下限 {value}', { value: percent(row.mining.prospecting) }),
        t('产出翻倍 {value}', { value: percent(row.doubleOutput) }));
    }
    if (!row.wood && !row.passive && !row.agility) note.push(t('平均每次 {value} 秒', { value: decimals.format(row.seconds) }),
      t('固定经验 {value}', { value: decimals.format(row.flatXp) }));
    const plan = row.targetPlan ?? row.planXp(goal?.remaining);
    if (goalMode && plan && !plan.reaches && row.stockLimit) note.push(t('{time}后缺{item}', {
      time: formatDuration(plan.hours, true), item: limitName({ limit: row.stockLimit })
    }));
    if (!goalMode && row.limit) note.push(t('{time}后缺{item}', { time: formatDuration(row.activeHours), item: limitName(row) }));
    if (row.risky) note.push(t('失败可受伤，未计生存时间'));
    const eta = create('td', goal?.remaining === 0 ? t('已达到目标') : plan && !plan.reaches ?
      t(plan.reason ?? '当前库存不足') : formatXpDuration(plan?.hours));
    const passiveLimit = (goalMode ? plan?.limit : row.passive?.limit);
    if (passiveLimit) note.push(t('缺少 {item}', { item: gameName(catalog.items[passiveLimit]) ?? shopCurrencyName(passiveLimit) }));
    if (!goalMode && plan?.reaches && plan.hours > hours) eta.append(create('small', t('超过本次挂机时长')));
    if (row.risky) eta.append(create('small', t('受伤风险'), 'xp-risk'));
    const details = create('details', undefined, 'xp-action-details');
    details.dataset.action = row.action.id;
    details.open = expanded.has(row.action.id);
    details.append(create('summary', t('计算明细')), create('p', note.join(' · '), 'muted'));
    if (!goalMode && row.drops.length) {
      const quantities = new Map();
      for (const drop of row.drops) quantities.set(drop.id, (quantities.get(drop.id) ?? 0) + drop.quantity);
      const products = [...quantities].map(([id, quantity]) =>
        (gameName(catalog.items[id]) ?? id) + ' × ' + decimals.format(quantity));
      details.append(create('p', t('本次预计产物 {items}', { items: products.join(' · ') }), 'muted'));
    }
    const data = create('td');
    data.append(details);
    const amount = goalMode ? plan?.xp : row.xp;
    const activeRate = goalMode ? plan?.rate : row.activeXpPerHour;
    const average = create('td', fullNumber(row.xpPerHour), 'number');
    average.hidden = goalMode;
    const active = create('td', activeRate == null ? '—' : fullNumber(activeRate), 'number gold');
    if (!goalMode && row.limit) active.append(create('small', t('{time}后缺{item}', {
      time: formatDuration(row.activeHours), item: limitName(row)
    }), 'muted'));
    item.append(create('td', gameName(row.action)), create('td', amount == null ? '—' : fullNumber(amount), 'number'),
      average, active, eta, data);
    return item;
  }));
}

