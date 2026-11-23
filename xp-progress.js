const COMBAT_XP_SKILLS = ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Prayer', 'Slayer'];
const XP_LEVEL_CAP = 99;
const xpThresholds = [0, 0];
let xpThresholdTotal = 0;
for (let level = 1; level < XP_LEVEL_CAP; level++) {
  xpThresholdTotal += Math.floor(level + 300 * 2 ** (level / 7));
  xpThresholds.push(Math.floor(xpThresholdTotal / 4));
}

function levelFor(xp) {
  if (!Number.isFinite(xp) || xp < 0) throw new Error('存档技能经验无效');
  const next = xpThresholds.findIndex(threshold => threshold > xp);
  return next === -1 ? XP_LEVEL_CAP : next - 1;
}

function xpProgress(level, savedXp, rate) {
  if (!Number.isInteger(level) || level < 1) return null;
  if (level >= XP_LEVEL_CAP) return { level, cap: true, progress: 1 };
  const start = xpThresholds[level];
  const end = xpThresholds[level + 1];
  const exact = Number.isFinite(savedXp) && savedXp >= start && savedXp < end;
  const xp = exact ? savedXp : start;
  const remaining = end - xp;
  return { level, next: level + 1, remaining, exact, progress: (xp - start) / (end - start),
    hours: rate > 0 ? remaining / rate : null };
}

function xpGoalProgress(level, savedXp, target, rate, startingXp) {
  if (!Number.isInteger(level) || level < 1 || level > XP_LEVEL_CAP ||
      !Number.isInteger(target) || target < 1 || target > XP_LEVEL_CAP) return null;
  const start = xpThresholds[level];
  const exact = Number.isFinite(savedXp) && savedXp >= 0 && levelFor(savedXp) === level;
  const xp = exact ? savedXp : start;
  const end = xpThresholds[target];
  const baseline = Number.isFinite(startingXp) ? Math.min(xp, startingXp) : start;
  const remaining = Math.max(0, end - xp);
  return { level, target, xp, remaining, exact,
    hours: remaining === 0 ? 0 : rate > 0 ? remaining / rate : null,
    progress: remaining === 0 ? 1 : Math.max(0, Math.min(1, (xp - baseline) / (end - baseline))) };
}

function renderXpGoalSlider(slider, level) {
  if (slider.valueAsNumber !== level) slider.valueAsNumber = level;
  const min = Number(slider.min);
  const range = Number(slider.max) - min;
  slider.style.setProperty('--goal-fill', (slider.valueAsNumber - min) / range * 100 + '%');
}

function formatXpDuration(hours) {
  if (!Number.isFinite(hours) || hours < 0) return t('暂无升级时间');
  const exactSeconds = hours * 3600;
  const seconds = Math.ceil(exactSeconds - exactSeconds * Number.EPSILON);
  const units = [
    [Math.floor(seconds / 86400), '{value} 天'],
    [Math.floor(seconds / 3600) % 24, '{value} 小时'],
    [Math.floor(seconds / 60) % 60, '{value} 分钟'],
    [seconds % 60, '{value} 秒']
  ];
  const parts = units.filter(([amount]) => amount > 0);
  return (parts.length ? parts : [units.at(-1)])
    .map(([amount, unit]) => t(unit, { value: fullNumber(amount) }).replace(/ /g, '\u00a0')).join(' ');
}
function renderXpProgress(character, skill, goal, timeForGoal, limitLabel, plannedHours) {
  const view = create('div', undefined, 'xp-progress');
  const state = xpGoalProgress(character?.levels?.[skill], character?.skillXp?.[skill], goal.level, null, goal.startingXp);
  if (!state) {
    view.textContent = t('暂无等级进度');
    return view;
  }
  const level = t('等级 {level}', { level: state.level });
  const { hours, extended } = state.remaining > 0 ? timeForGoal(state.remaining) : { hours: 0 };
  const timing = state.remaining === 0 ? t('已达到目标') :
    hours == null ? t(limitLabel ?? '暂无升级时间') :
      t('约 {time}后达到 {level} 级', { time: formatXpDuration(hours), level: state.target });
  view.append(create('span', level + ' · ' + timing));
  if (state.remaining > 0) {
    view.append(create('span', t('距目标 {xp} XP', { xp: decimals.format(state.remaining) }), 'muted'));
    if (!state.exact) view.title = t('按所设等级的起始经验计算');
  }
  if (hours != null && hours > plannedHours) view.append(create('span', t('超过本次挂机时长'), 'muted'));
  if (hours != null && extended) view.append(create('span', t('额外用时按持续战斗、补给充足估算。'), 'muted'));
  const progress = create('progress');
  progress.max = 1;
  progress.value = state.progress;
  progress.setAttribute('aria-label', t('目标等级进度'));
  view.append(progress);
  return view;
}

if (typeof module !== 'undefined') module.exports = { levelFor, xpProgress, xpGoalProgress, COMBAT_XP_SKILLS };
