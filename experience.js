function compareExperience(catalog, character, hours) {
  const groups = Object.fromEntries(Object.keys(catalog.xpSkills).map(skill => [skill, []]));
  const rows = rank(catalog, character, { hours, offlineCap: 24, sell: false, metric: 'xp' });
  for (const row of rows) groups[row.action.skill]?.push(row);
  return groups;
}

let xpView;

function initExperience(catalog) {
  xpView = { catalog, character: null, bonusesByCharacter: new Map() };
  const skillInput = byId('xpSkill');
  skillInput.replaceChildren(...Object.keys(catalog.xpSkills).map(id => new Option(skillName(id, catalog.xpSkills), id)));
  skillInput.addEventListener('change', setExperienceSkill);
  byId('xpHours').addEventListener('input', renderExperience);
  for (const button of document.querySelectorAll('[data-xp-hours]')) {
    button.addEventListener('click', () => {
      byId('xpHours').value = button.dataset.xpHours;
      renderExperience();
    });
  }
  byId('xpBonus').addEventListener('input', () => {
    const input = byId('xpBonus');
    if (!input.value || !input.checkValidity()) return;
    experienceBonuses()[skillInput.value] = input.valueAsNumber;
    renderExperience();
  });
  byId('xpBonus').addEventListener('blur', () => { byId('xpBonus').value = experienceBonuses()[skillInput.value] ?? 0; });
}

function localizeExperience() {
  if (!xpView) return;
  for (const option of byId('xpSkill').options) option.text = skillName(option.value, xpView.catalog.xpSkills);
}

function experienceBonuses() {
  const key = xpView.character?.characterId ?? 'manual';
  if (!xpView.bonusesByCharacter.has(key)) xpView.bonusesByCharacter.set(key, {});
  return xpView.bonusesByCharacter.get(key);
}

function updateExperience(character) {
  if (!xpView) return;
  xpView.character = character;
  setExperienceSkill();
}

function setExperienceSkill() {
  const skill = byId('xpSkill').value;
  byId('xpBonus').value = experienceBonuses()[skill] ?? 0;
  renderExperience();
}

function renderExperience() {
  if (!xpView?.character) return;
  const input = byId('xpHours');
  if (!input.checkValidity() || !input.value) return;
  const { catalog, character } = xpView;
  const hours = input.valueAsNumber;
  const skillInput = byId('xpSkill');
  const groups = compareExperience(catalog, { ...character, xpBonuses: experienceBonuses() }, hours);
  const recommendations = Object.values(groups).filter(rows => rows.length).length;
  byId('xpStatus').textContent = t('{count} / {total} 个技能有可比较的行动 · 按所选时长内的总经验排序', {
    count: recommendations, total: Object.keys(groups).length
  });
  const supportedSkills = new Set(catalog.xpActions.map(action => action.skill));
  byId('xpBest').replaceChildren(...Object.entries(groups).map(([skill, rows]) => {
    const card = create('button', undefined, 'xp-card');
    card.type = 'button';
    card.setAttribute('aria-pressed', String(skill === skillInput.value));
    const top = rows[0];
    const heading = create('span', undefined, 'xp-card-heading');
    heading.append(create('span', skillName(skill, catalog.xpSkills), 'muted'));
    if (top?.risky) heading.append(create('span', t('受伤风险'), 'xp-risk'));
    const actionName = gameName(top?.action) ?? t(supportedSkills.has(skill) ? '暂无可用行动' : '暂未支持');
    const actionLabel = create('strong', actionName);
    actionLabel.title = actionName;
    card.append(heading, actionLabel, create('span', top ? t('{value} XP / 小时', { value: fullNumber(top.xpPerHour) }) : '', 'xp-rate'));
    card.addEventListener('click', () => { skillInput.value = skill; setExperienceSkill(); });
    return card;
  }));

  const rows = groups[skillInput.value];
  byId('xpDetailHeading').textContent = t('{skill}行动排行', { skill: skillName(skillInput.value, catalog.xpSkills) });
  byId('xpTable').hidden = !rows.length;
  byId('xpEmpty').hidden = !!rows.length;
  byId('xpEmpty').textContent = t(supportedSkills.has(skillInput.value)
    ? '没有同时满足等级、解锁条件和库存的行动。'
    : '这项技能暂未支持经验排行。');
  byId('xpRows').replaceChildren(...rows.slice(0, 20).map(row => {
    const item = create('tr');
    const note = [t('识别加成 {value}%', { value: decimals.format(row.knownXpPercent) })];
    if (row.manualXpPercent) note.push(t('额外 {value}%', { value: decimals.format(row.manualXpPercent) }));
    if (row.wood) {
      const percent = value => decimals.format(value * 100) + '%';
      note.push(t('双倍伤害 {value}', { value: percent(row.wood.doubleDamage) }), t('弱点 {value}', { value: percent(row.wood.weak) }),
        t('直接砍倒 {value}', { value: percent(row.wood.instant) }), t('产出翻倍 {value}', { value: percent(row.wood.output) }),
        t('每击 {value} 秒', { value: decimals.format(row.wood.interval) }),
        t('固定经验 {value}', { value: decimals.format(row.flatXp) }), t('砍倒经验 {value}', { value: decimals.format(row.xpPerCycle) }));
    }
    if (row.limit) note.push(t('{time}后缺{item}', { time: formattedHours(row.activeHours), item: limitName(row) }));
    if (row.risky) note.push(t('失败可受伤，未计生存时间'));
    item.append(create('td', gameName(row.action)), create('td', fullNumber(row.xp), 'number'),
      create('td', fullNumber(row.xpPerHour), 'number gold'), create('td', note.join(' · ')));
    return item;
  }));
}
