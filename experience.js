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
  skillInput.replaceChildren(...Object.entries(catalog.xpSkills).map(([id, name]) => new Option(name, id)));
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
  byId('xpStatus').textContent = recommendations + ' / ' + Object.keys(groups).length +
    ' 个技能有可比较的行动 · 按所选时长内的总经验排序';
  const supportedSkills = new Set(catalog.xpActions.map(action => action.skill));
  byId('xpBest').replaceChildren(...Object.entries(groups).map(([skill, rows]) => {
    const card = create('button', undefined, 'xp-card');
    card.type = 'button';
    card.setAttribute('aria-pressed', String(skill === skillInput.value));
    const top = rows[0];
    const heading = create('span', undefined, 'xp-card-heading');
    heading.append(create('span', catalog.xpSkills[skill], 'muted'));
    if (top?.risky) heading.append(create('span', '受伤风险', 'xp-risk'));
    const actionName = top?.action.name ?? (supportedSkills.has(skill) ? '暂无可用行动' : '暂未支持');
    const actionLabel = create('strong', actionName);
    actionLabel.title = actionName;
    card.append(heading, actionLabel, create('span', top ? fullNumber(top.xpPerHour) + ' XP / 小时' : '', 'xp-rate'));
    card.addEventListener('click', () => { skillInput.value = skill; setExperienceSkill(); });
    return card;
  }));

  const rows = groups[skillInput.value];
  byId('xpDetailHeading').textContent = catalog.xpSkills[skillInput.value] + '行动排行';
  byId('xpTable').hidden = !rows.length;
  byId('xpEmpty').hidden = !!rows.length;
  byId('xpEmpty').textContent = supportedSkills.has(skillInput.value)
    ? '没有同时满足等级、解锁条件和库存的行动。'
    : '这项技能暂未支持经验排行。';
  byId('xpRows').replaceChildren(...rows.slice(0, 20).map(row => {
    const item = create('tr');
    const note = ['识别加成 ' + decimals.format(row.knownXpPercent) + '%'];
    if (row.manualXpPercent) note.push('额外 ' + decimals.format(row.manualXpPercent) + '%');
    if (row.wood) {
      const percent = value => decimals.format(value * 100) + '%';
      note.push('双倍伤害 ' + percent(row.wood.doubleDamage), '弱点 ' + percent(row.wood.weak),
        '直接砍倒 ' + percent(row.wood.instant), '产出翻倍 ' + percent(row.wood.output),
        '每击 ' + decimals.format(row.wood.interval) + ' 秒',
        '固定经验 ' + decimals.format(row.flatXp), '砍倒经验 ' + decimals.format(row.xpPerCycle));
    }
    if (row.limit) note.push(formattedHours(row.activeHours) + '后缺' + row.limit);
    if (row.risky) note.push('失败可受伤，未计生存时间');
    item.append(create('td', row.action.name), create('td', fullNumber(row.xp), 'number'),
      create('td', fullNumber(row.xpPerHour), 'number gold'), create('td', note.join(' · ')));
    return item;
  }));
}
