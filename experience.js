const experienceCandidateHours = 24;

function compareExperience(catalog, character, targets) {
  const groups = Object.fromEntries(Object.keys(catalog.xpSkills)
    .filter(skill => !COMBAT_XP_SKILLS.includes(skill)).map(skill => [skill, []]));
  const rows = rank(catalog, character, { hours: experienceCandidateHours, offlineCap: 24, sell: false, metric: 'xp' });
  for (const row of rows) groups[row.action.skill]?.push(row);
  for (const [skill, actions] of Object.entries(groups)) {
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

function showExperienceSection() {
  const showCombat = experienceSection === 'combat';
  byId('xpSkillsButton').setAttribute('aria-pressed', String(!showCombat));
  byId('xpCombatButton').setAttribute('aria-pressed', String(showCombat));
  byId('xpSkillsSection').hidden = showCombat;
  byId('xpCombatSection').hidden = !showCombat;
}

function initExperience(catalog) {
  const saved = preferences.fields?.xpSkill;
  const skill = Object.hasOwn(catalog.xpSkills, saved) && !COMBAT_XP_SKILLS.includes(saved) ? saved :
    Object.keys(catalog.xpSkills).find(id => !COMBAT_XP_SKILLS.includes(id));
  xpView = { catalog, character: null, bonusesByCharacter: new Map(), goalsByCharacter: new Map(),
    actionsByCharacter: new Map(), skill };
  byId('xpBonus').addEventListener('input', () => {
    const input = byId('xpBonus');
    if (!input.value || !input.checkValidity()) return;
    experienceBonuses()[xpView.skill] = input.valueAsNumber;
    renderExperience();
  });
  byId('xpBonus').addEventListener('blur', () => { byId('xpBonus').value = experienceBonuses()[xpView.skill] ?? 0; });
  bindExperienceGoalInputs('xp', () => xpView, renderExperience);
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

function bindExperienceGoalInputs(prefix, selection, render) {
  const input = byId(prefix + 'GoalLevel');
  const slider = byId(prefix + 'GoalSlider');
  function setGoal(level) {
    const { character, skill } = selection();
    setExperienceGoal(character, skill, level);
    input.value = level;
    renderXpGoalSlider(slider, level);
    render();
  }
  input.addEventListener('input', () => {
    if (input.value && input.checkValidity()) setGoal(input.valueAsNumber);
  });
  slider.addEventListener('input', () => setGoal(slider.valueAsNumber));
  input.addEventListener('blur', () => {
    const { character, skill } = selection();
    input.value = selectedExperienceGoal(character, skill).level;
  });
  byId(prefix + 'NextLevel').addEventListener('click', () => {
    const { character, skill } = selection();
    resetExperienceGoals([skill], character);
    const { level } = selectedExperienceGoal(character, skill);
    input.value = level;
    renderXpGoalSlider(slider, level);
    render();
  });
}

function experienceCard(grid, skill, selected, name, level, action, summary, select) {
  const card = create('button', undefined, 'xp-card');
  card.type = 'button';
  card.dataset.skill = skill;
  card.setAttribute('aria-pressed', String(skill === selected));
  const heading = create('span', undefined, 'xp-card-heading');
  heading.append(create('strong', name));
  if (level) heading.append(create('span', t('等级 {level}', { level }), 'xp-card-level'));
  const actionLabel = create('span', action, 'xp-card-action muted');
  actionLabel.title = action;
  card.append(heading, actionLabel, create('span', summary, 'xp-rate'));
  card.addEventListener('click', () => {
    select(skill);
    grid.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
    queuePreferences();
  });
  return card;
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

function experienceActionChoices(character = xpView.character) {
  const key = character?.characterId ?? 'manual';
  if (!xpView.actionsByCharacter.has(key)) xpView.actionsByCharacter.set(key, {});
  return xpView.actionsByCharacter.get(key);
}

function selectExperienceAction(rows, target) {
  const input = byId('xpActionChoice');
  const saved = experienceActionChoices()[xpView.skill];
  const best = rows[0];
  const selected = rows.find(row => row.action.id === saved);
  const label = target?.remaining === 0 ? '已达到目标' :
    best?.targetPlan?.reaches ? '最快升级 · {action}' : '当前库存经验最多 · {action}';
  const options = [new Option(best ? t(label, { action: gameName(best.action) }) : t('暂无可用行动'), '')];
  for (const row of rows) options.push(new Option(gameName(row.action), row.action.id));
  if (saved && !selected) {
    const previous = xpView.catalog.xpActions.find(action => action.id === saved);
    const unavailable = new Option(t('{action}（暂不可用）', { action: gameName(previous) ?? t('未知行动') }), saved);
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

function renderExperienceGoal(goal, row, unavailable) {
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
  const labels = [
    ['等级', t('{current} → {target}', { current: goal.level, target: goal.target })],
    ['剩余 XP', fullNumber(Math.ceil(goal.remaining))],
    ['预计剩余时间', timing]
  ];
  if (blocked) labels.push([plan.reason && plan.reason !== '当前库存不足' ? '时段内可获 XP' : '库存可获 XP', fullNumber(plan.xp)]);
  const note = [
    row && goal.remaining > 0 && t('按「{action}」的经验收益估算', { action: gameName(row.action) }),
    unavailable && t('所选行动暂不可用，当前按推荐行动估算'),
    blocked && row.stockLimit && t('{time}后缺{item}', {
      time: formatDuration(plan.hours, true), item: limitName({ limit: row.stockLimit })
    }),
    blocked && plan.limit && t('缺少 {item}', { item: gameName(items[plan.limit]) ?? shopCurrencyName(plan.limit) }),
    row?.action.kind === 'Farming' && t('目标时间按手动种植和及时收获估算。'),
    row?.action.kind === 'GrainMill' && t('目标时间允许先把仓库原料装入磨坊。'),
    row?.risky && t('失败可受伤，未计生存时间'),
    !goal.exact && t('按所设等级的起始经验计算')
  ].filter(Boolean);
  renderExperienceGoalSummary(container, goal, labels, note);
}

function renderExperienceGoalSummary(container, goal, labels, notes) {
  const metrics = create('dl', undefined, 'xp-goal-metrics');
  for (const [label, value] of labels) {
    const field = create('div');
    field.append(create('dt', t(label)), create('dd', value));
    metrics.append(field);
  }
  const progress = create('progress');
  progress.max = 1;
  progress.value = goal.progress;
  progress.setAttribute('aria-label', t('目标等级进度'));
  container.replaceChildren(metrics, progress);
  if (notes.length) container.append(create('p', notes.join(' · '), 'muted'));
}

function renderExperience() {
  if (!xpView?.character) return;
  const { catalog, character } = xpView;
  const selected = xpView.skill;
  const goalForSkill = skill => {
    const goal = selectedExperienceGoal(character, skill);
    return xpGoalProgress(character.levels[skill], character.skillXp?.[skill], goal.level, null, goal.startingXp);
  };
  const targets = Object.fromEntries(Object.keys(catalog.xpSkills).map(skill => [skill, goalForSkill(skill)]));
  const groups = compareExperience(catalog, { ...character, xpBonuses: experienceBonuses() }, targets);
  byId('xpStatus').textContent = t('按达到各技能目标等级的时间排序，默认目标为下一级。');
  const supportedSkills = new Set(catalog.xpActions.map(action => action.skill));
  const grid = byId('xpBest');
  const focusedSkill = grid.contains(document.activeElement) ? document.activeElement.dataset.skill : null;
  const expanded = new Set([...byId('xpRows').querySelectorAll('details[open]')].map(details => details.dataset.action));
  grid.replaceChildren(...Object.entries(groups).map(([skill, rows]) => {
    const top = rows[0];
    const actionName = gameName(top?.action) ?? t(supportedSkills.has(skill) ? '暂无可用行动' : '暂未支持');
    const plan = top?.targetPlan;
    const summary = targets[skill]?.remaining === 0 ? t('已达到目标') :
      plan?.reaches ? t('到目标约 {time}', { time: formatXpDuration(plan.hours) }) :
        plan ? t(plan.reason && plan.reason !== '当前库存不足' ? '时段内可获 {xp} XP' : '库存可获 {xp} XP',
          { xp: fullNumber(plan.xp) }) : '';
    return experienceCard(grid, skill, selected, skillName(skill, catalog.xpSkills), character.levels[skill], actionName, summary, () => {
      xpView.skill = skill;
      syncExperienceInputs();
      renderExperience();
    });
  }));
  if (focusedSkill) grid.querySelector(`[data-skill="${focusedSkill}"]`)?.focus({ preventScroll: true });

  const rows = groups[selected];
  const goal = targets[selected];
  const choice = selectExperienceAction(rows, goal);
  renderExperienceGoal(goal, choice.row, choice.unavailable);
  updateSkillTraining({ ...character, xpBonuses: experienceBonuses() }, {
    skill: selected, hours: experienceCandidateHours, goal, actionId: choice.unavailable ? '' : experienceActionChoices()[selected]
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
      items: row.skillCharges.map(charge => (gameName(catalog.items[charge.id]) ?? t('未知物品')) +
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
        t('按手动种植和及时收获估算，最多预测 7 天。'));
    }
    if (row.passive?.mill) note.push(t('按磨坊和仓库中可用的原料估算，最多预测 7 天。'));
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
      if (preserveOnFail) note.push(t('失败时额外保留材料几率 {value}', { value: percent(preserveOnFail) }));
      if (row.cooking.charges.length) {
        for (const { item, quantity } of row.cooking.charges) {
          note.push(t('{item} 可用 {count} 次', { item: gameName(catalog.items[item]) ?? t('未知物品'), count: fullNumber(quantity) }));
        }
      }
    }
    if (row.thieving) {
      note.push(t('成功几率 {value}', { value: percent(row.thieving.success) }),
        t('每次尝试平均 {value} XP', { value: decimals.format(row.xpPerCycle) }));
    }
    if (row.fishing) {
      note.push(t('杂物几率 {value}，仍可获得经验', { value: percent(row.fishing.junkChance) }));
      if (row.fishing.priority) note.push(t('优先鱼获 {item}', {
        item: gameName(catalog.items[row.fishing.priority]) ?? t('未知物品')
      }));
    }
    if (row.brewing) note.push(t('每轮准备 {setup} 秒，每瓶 {bottle} 秒，最多装瓶 {count} 次', {
      setup: decimals.format(row.brewing.setup), bottle: decimals.format(row.brewing.bottling), count: row.brewing.batchSize
    }));
    if (row.craftingSteps?.steps > 1) note.push(t('制作步数 {steps}，跳步几率 {chance}', {
      steps: row.craftingSteps.steps, chance: percent(row.craftingSteps.skip)
    }));
    if (row.sacrifice) note.push(t('献祭砧台平均额外经验 {value}', { value: percent(row.sacrifice.xpFactor - 1) }));
    if (row.consumption < 1) note.push(t('平均保留材料几率 {value}', { value: percent(1 - row.consumption) }));
    if (row.knowledge != null) {
      note.push(t('每次研究 {value} 知识', { value: decimals.format(row.knowledge) }));
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
    if (plan && !plan.reaches && row.stockLimit) note.push(t('{time}后缺{item}', {
      time: formatDuration(plan.hours, true), item: limitName({ limit: row.stockLimit })
    }));
    if (row.risky) note.push(t('失败可受伤，未计生存时间'));
    const eta = create('td', goal?.remaining === 0 ? t('已达到目标') : plan && !plan.reaches ?
      t(plan.reason ?? '当前库存不足') : formatXpDuration(plan?.hours));
    const passiveLimit = plan?.limit;
    if (passiveLimit) note.push(t('缺少 {item}', { item: gameName(catalog.items[passiveLimit]) ?? shopCurrencyName(passiveLimit) }));
    if (row.risky) eta.append(create('small', t('受伤风险'), 'xp-risk'));
    const details = create('details', undefined, 'xp-action-details');
    details.dataset.action = row.action.id;
    details.open = expanded.has(row.action.id);
    details.append(create('summary', t('计算明细')), create('p', note.join(' · '), 'muted'));
    const data = create('td');
    data.append(details);
    const amount = plan?.xp;
    const activeRate = plan?.rate;
    const active = create('td', activeRate == null ? '—' : fullNumber(activeRate), 'number gold');
    item.append(create('td', gameName(row.action)), create('td', amount == null ? '—' : fullNumber(amount), 'number'),
      active, eta, data);
    return item;
  }));
}

