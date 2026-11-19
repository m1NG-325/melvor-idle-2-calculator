function compareExperience(catalog, character, hours) {
  const groups = Object.fromEntries(Object.keys(catalog.xpSkills)
    .filter(skill => !COMBAT_XP_SKILLS.includes(skill)).map(skill => [skill, []]));
  const rows = rank(catalog, character, { hours, offlineCap: 24, sell: false, metric: 'xp' });
  for (const row of rows) groups[row.action.skill]?.push(row);
  return groups;
}

let xpView;

function initExperience(catalog) {
  const saved = preferences.fields?.xpSkill;
  const skill = Object.hasOwn(catalog.xpSkills, saved) && !COMBAT_XP_SKILLS.includes(saved) ? saved :
    Object.keys(catalog.xpSkills).find(id => !COMBAT_XP_SKILLS.includes(id));
  xpView = { catalog, character: null, bonusesByCharacter: new Map(), goalsByCharacter: new Map(),
    actionsByCharacter: new Map(), skill };
  byId('xpHours').addEventListener('input', renderExperience);
  for (const button of document.querySelectorAll('[data-xp-hours]')) {
    button.addEventListener('click', () => {
      byId('xpHours').value = button.dataset.xpHours;
      renderExperience();
      queuePreferences();
    });
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
    slider.value = goal.value;
    renderExperience();
  });
  slider.addEventListener('input', () => {
    setExperienceGoal(xpView.character, xpView.skill, slider.valueAsNumber);
    goal.value = slider.value;
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

function selectExperienceAction(rows) {
  const input = byId('xpActionChoice');
  const saved = experienceActionChoices()[xpView.skill];
  const best = rows[0];
  const selected = rows.find(row => row.action.id === saved);
  const options = [new Option(best ? t('最高收益 · {action}', { action: gameName(best.action) }) :
    t('暂无可用行动'), '')];
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
  byId('xpGoalSlider').value = selectedExperienceGoal().level;
}

function renderExperienceGoal(goal, row, enoughStock, unavailable) {
  const container = byId('xpGoalOverview');
  if (!goal) {
    container.textContent = t('暂无等级进度');
    return;
  }
  const timing = goal.remaining === 0 ? t('已达到目标') : formatXpDuration(goal.hours);
  const metrics = create('dl', undefined, 'xp-goal-metrics');
  const labels = [
    ['等级', t('{current} → {target}', { current: goal.level, target: goal.target })],
    ['剩余 XP', fullNumber(Math.ceil(goal.remaining))],
    ['预计剩余时间', timing]
  ];
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
    row && goal.remaining > 0 && t('按「{action}」当前每小时经验估算', { action: gameName(row.action) }),
    unavailable && t('所选行动暂不可用，当前按最高收益行动估算'),
    !enoughStock && goal.remaining > 0 && t('当前库存不足'),
    !goal.exact && t('按所设等级的起始经验计算')
  ].filter(Boolean);
  container.replaceChildren(metrics, progress);
  if (note.length) container.append(create('p', note.join(' · '), 'muted'));
}

function renderExperience() {
  if (!xpView?.character) return;
  const input = byId('xpHours');
  if (!input.checkValidity() || !input.value) return;
  const { catalog, character } = xpView;
  const hours = input.valueAsNumber;
  const selected = xpView.skill;
  const groups = compareExperience(catalog, { ...character, xpBonuses: experienceBonuses() }, hours);
  const recommendations = Object.values(groups).filter(rows => rows.length).length;
  byId('xpStatus').textContent = t('{count} / {total} 个技能有可比较的行动 · 按所选时长内的总经验排序', {
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
    card.append(heading, actionLabel, create('span', top ? t('{value} XP / 小时', { value: fullNumber(top.xpPerHour) }) : '', 'xp-rate'));
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
  const choice = selectExperienceAction(rows);
  const target = selectedExperienceGoal();
  const goalFor = row => xpGoalProgress(character.levels[selected], character.skillXp?.[selected],
    target.level, row?.sustainableXpPerHour, target.startingXp);
  const goal = goalFor(choice.row);
  renderExperienceGoal(goal, choice.row, !choice.row || choice.row.stockXp >= (goal?.remaining ?? 0), choice.unavailable);
  byId('xpTable').hidden = !rows.length;
  byId('xpEmpty').hidden = !!rows.length;
  byId('xpEmpty').textContent = t(supportedSkills.has(selected)
    ? '没有同时满足等级、解锁条件和库存的行动。'
    : '这项技能暂未支持经验排行。');
  const displayed = rows.slice(0, 20);
  if (choice.row && !displayed.includes(choice.row)) displayed.push(choice.row);
  byId('xpRows').replaceChildren(...displayed.map(row => {
    const item = create('tr');
    item.classList.toggle('xp-estimate-action', row === choice.row);
    const note = [t('基础经验 {value}', { value: decimals.format(row.action.baseXp) }),
      t('识别加成 {value}%', { value: decimals.format(row.knownXpPercent) })];
    const percent = value => decimals.format(value * 100) + '%';
    if (row.manualXpPercent) note.push(t('额外 {value}%', { value: decimals.format(row.manualXpPercent) }));
    if (row.knowledge != null) {
      note.push(t('每次研究 {value} 知识', { value: decimals.format(row.knowledge) }),
        t('{value} 知识／小时', { value: decimals.format(row.knowledge * row.cycles / hours) }));
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
    if (!row.wood) note.push(t('平均每次 {value} 秒', { value: decimals.format(row.seconds) }),
      t('固定经验 {value}', { value: decimals.format(row.flatXp) }));
    if (row.limit) note.push(t('{time}后缺{item}', { time: formattedHours(row.activeHours), item: limitName(row) }));
    if (row.risky) note.push(t('失败可受伤，未计生存时间'));
    const plan = goalFor(row);
    const eta = create('td', plan?.remaining === 0 ? t('已达到目标') : formatXpDuration(plan?.hours));
    if (plan && row.stockXp < plan.remaining) eta.append(create('small', t('当前库存不足')));
    if (row.risky) eta.append(create('small', t('受伤风险'), 'xp-risk'));
    const details = create('details', undefined, 'xp-action-details');
    details.dataset.action = row.action.id;
    details.open = expanded.has(row.action.id);
    details.append(create('summary', t('计算明细')), create('p', note.join(' · '), 'muted'));
    const data = create('td');
    data.append(details);
    item.append(create('td', gameName(row.action)), create('td', fullNumber(row.xp), 'number'),
      create('td', fullNumber(row.xpPerHour), 'number gold'), eta, data);
    return item;
  }));
}
