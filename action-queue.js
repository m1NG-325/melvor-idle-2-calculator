'use strict';

const maxQueueSteps = 200;
const maxQueueMinutes = 1440;
const maxSavedQueues = 16;
const actionQueue = { targets: new Map(), steps: [], queues: [], status: { state: 'unavailable' } };
let queueCommandPending = false;
let queueCommandVersion = 0;
let queueStatusPending = false;
const validQueueMinutes = value => Number.isInteger(value) && value >= 0 && value <= maxQueueMinutes;
const queueItemName = id => gameName(catalog.items[id]) ?? t('未知物品');
const productGoal = type => type === 'item' || type === 'owned';
const materialGoal = type => type === 'spent' || type === 'remaining';
const recipeGoalAvailable = target => ['Artisan', 'Cooking', 'Firemaking'].includes(target?.action.kind);
function queueGoalItems(type, target) {
  return productGoal(type) ? target?.action.outputItems ?? [] :
    materialGoal(type) ? [...new Set(target?.action.costs?.map(([id]) => id) ?? [])] : [];
}
function validQueueGoal(goal, target) {
  if (!goal) return true;
  const { type, value, item } = goal;
  if (!Number.isInteger(value) || value < (type === 'remaining' ? 0 : 1) || value > (type === 'level' ? 120 : 1000000000)) return false;
  return type === 'level' || (type === 'recipes' && recipeGoalAvailable(target)) || queueGoalItems(type, target).includes(item);
}
function validQueueStep(step) {
  const target = actionQueue.targets.get(step.key);
  return target && validQueueMinutes(step.minutes) && validQueueGoal(step.goal, target);
}

function queueTargets(catalog) {
  const targets = new Map();
  for (const action of catalog.xpActions ?? catalog.actions) {
    if (!action.recipe || action.recipe === 'CurrentHerd') continue;
    const key = action.kind === 'GrainMill' ? action.id : action.skill + ':' + action.recipe;
    if (!targets.has(key)) targets.set(key, { skill: action.skill, id: action.recipe, action,
      category: action.location ?? action.category, areaLabel: action.area,
      areaNames: action.areaNames, groups: action.requirementGroups,
      questOnly: action.category === 'Quests' || action.requirementGroups?.flat()
        .some(req => ['QuestStepActive', 'QuestTaskGoalActive'].includes(req.type))
    });
  }
  for (const enemy of catalog.combatTargets ?? []) {
    for (const area of enemy.areas) {
      targets.set('Combat:' + area.id + ':' + enemy.id, { skill: 'Combat', id: enemy.id, action: enemy,
        category: area.id, areaLabel: area.name, areaNames: area.names,
        groups: [...area.requirements, ...enemy.requirements] });
    }
  }
  const guide = catalog.questGuide;
  for (const [id, sources] of Object.entries(guide?.queueSources ?? {})) {
    for (const source of sources) {
      const area = guide.names[source.area];
      const category = source.area?.split(':').at(-1);
      const recipe = id.split(':').at(-1);
      const key = id.startsWith('Combat:') ? 'Combat:' + category + ':' + recipe : id;
      const existing = targets.get(key);
      if (existing) {
        existing.questOnly ||= source.questOnly;
        continue;
      }
      const action = guide.names[source.target];
      if (!action) continue;
      targets.set(key, { skill: source.skill, id: recipe, action, category,
        areaLabel: area?.name, areaNames: area?.names, groups: source.requirementGroups, questOnly: source.questOnly });
    }
  }
  return targets;
}

function queueArea(target) {
  return localizedName(target.areaNames, target.areaLabel) ?? t('其他行动');
}

function queueSkillLabel(skill) {
  return skill === 'Combat' ? t('战斗') : skillName(skill, catalog.xpSkills);
}

function queueLabel(target, scope = 'full') {
  const skill = queueSkillLabel(target.skill);
  const area = target.areaLabel && queueArea(target);
  const title = gameName(target.action) ?? t('未知行动');
  const name = target.skill === 'Agility' ? title.split(' · ')[0] : title;
  const parts = scope === 'full' ? [skill, area, name] : scope === 'all' ? [area, name] : [name];
  return parts.filter((part, index) => part && parts.indexOf(part) === index).join(' · ');
}

function queueAccess(target, character = profile) {
  if (!target) return { state: 'locked', description: t('游戏数据中找不到此行动。') };
  if (!character?.characterId) return { state: 'unknown', description: t('读取角色存档后查看解锁条件') };
  const groups = requirementClauses(target.groups ?? []);
  const unmet = [];
  let uncertain = false;
  for (const clause of groups) {
    const checks = clause.map(req => questSourceRequirementMet(req, character));
    if (checks.includes(true)) continue;
    if (checks.includes(null)) uncertain = true;
    else unmet.push([...new Set(clause.map(questSourceRequirementText))].join(' / '));
  }
  if (character.excluded?.includes(target.action.id)) unmet.push(t('此行动已排除'));
  if (unmet.length) return { state: 'locked', description: [t('未解锁'), ...new Set(unmet)].join(' · ') };
  if (uncertain || (target.questOnly && !character.questProgress)) {
    return { state: 'unknown', description: t('部分解锁条件待确认') };
  }
  if (target.skill !== 'Combat' && !(character.levels[target.skill] > 0)) {
    return { state: 'unknown', description: t('存档缺少此技能的等级信息') };
  }
  return { state: 'unlocked', description: t('已满足解锁条件') };
}

function queueButton(text, action) {
  const button = create('button', t(text));
  button.type = 'button';
  button.addEventListener('click', action);
  return button;
}

function queueStatus(message = '', args = {}) {
  byId('queueStatus').hidden = !message;
  byId('queueStatus').textContent = t(message, args);
}

async function queueRequest(action, body) {
  const response = await fetch('action-runner/' + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Calculator-Action-Runner': '1' },
    body: body ? JSON.stringify(body) : undefined
  });
  return response.json();
}

function saveActionQueue() {
  const active = actionQueue.queues.find(row => row.id === actionQueue.selected);
  if (active) {
    active.name = byId('queueName').value.trim();
    active.repeat = byId('queueRepeat').checked;
  }
  byId('queueDraft').value = JSON.stringify(actionQueue.steps);
  byId('queueLibrary').value = JSON.stringify({ selected: actionQueue.selected, queues: actionQueue.queues });
  renderQueueLibrary();
  updateQueueTotal();
  queuePreferences();
}

function renderQueueLibrary() {
  const select = byId('queueSelect');
  select.replaceChildren(...actionQueue.queues.map((queue, index) =>
    new Option(queue.name || t('队列 {number}', { number: index + 1 }), queue.id)));
  select.value = actionQueue.selected;
  byId('queueCreate').disabled = queueBusy() || actionQueue.queues.length >= maxSavedQueues;
}

function selectSavedQueue(queue) {
  actionQueue.selected = queue.id;
  actionQueue.steps = queue.steps;
  byId('queueName').value = queue.name;
  byId('queueRepeat').checked = queue.repeat;
  saveActionQueue();
  renderActionQueue();
}

function appendQueuePlan(steps) {
  if (queueBusy() || !steps.length || actionQueue.steps.length + steps.length > maxQueueSteps ||
      !steps.every(validQueueStep)) return false;
  actionQueue.steps.push(...steps);
  saveActionQueue();
  renderActionQueue();
  byId('queueLink').click();
  return true;
}

const queueBusy = () => ['connecting', 'switching', 'running', 'paused', 'cancelling',
  'character-required', 'character-mismatch', 'busy'].includes(actionQueue.status.state);
function queueCanRun(step) {
  const target = actionQueue.targets.get(step.key);
  // The game checks unlocks at the start of each step, after earlier steps may have met them.
  return validQueueStep(step) && profile?.characterId && actionQueue.status.skills?.includes(target?.skill);
}

function selectedQueueTarget() {
  const input = byId('queueAction');
  const options = byId('queueActions').options;
  const direct = suggestionKey(options, input.value);
  if (direct) return direct;
  const matches = suggestionMatches(options, input.value, 2);
  if (matches.length === 1 && input.value.trim()) return matches[0].dataset.key;
}

function syncQueueGoalFields(prefix, selectedTarget, locked = false) {
  const field = suffix => byId(prefix + suffix);
  const condition = field('Goal');
  condition.disabled = locked;
  for (const option of condition.options) {
    option.disabled = Boolean(selectedTarget) && (option.value === 'recipes' ? !recipeGoalAvailable(selectedTarget) :
      (productGoal(option.value) || materialGoal(option.value)) && !queueGoalItems(option.value, selectedTarget).length);
  }
  if (condition.selectedOptions[0]?.disabled) condition.value = 'time';
  const goal = condition.value;
  const goalItem = field('GoalItem');
  const goalValue = field('GoalValue');
  const items = queueGoalItems(goal, selectedTarget);
  const itemOptions = items.map(id => ({ id, name: queueItemName(id) }));
  const optionKey = JSON.stringify(itemOptions);
  if (goalItem.dataset.options !== optionKey) {
    const previous = goalItem.value;
    goalItem.replaceChildren(...itemOptions.map(option => new Option(option.name, option.id)));
    if (items.includes(previous)) goalItem.value = previous;
    goalItem.dataset.options = optionKey;
  }
  field('GoalItemField').hidden = !productGoal(goal) && !materialGoal(goal);
  goalItem.disabled = locked || field('GoalItemField').hidden;
  field('GoalItemLabel').textContent = t(materialGoal(goal) ? '目标材料' : '目标物品');
  field('GoalValueField').hidden = goal === 'time' || goal === 'none';
  goalValue.disabled = locked || field('GoalValueField').hidden;
  field('GoalValueLabel').textContent = t(goal === 'level' ? '目标等级' : goal === 'recipes' ? '制作次数' : '目标数量');
  goalValue.max = goal === 'level' ? 120 : 1000000000;
  goalValue.min = goal === 'remaining' ? 0 : 1;
  if (goal === 'level') {
    const level = profile?.characterId ? profile.levels?.[selectedTarget?.skill] : null;
    const next = Number.isInteger(level) && level > 0 ? Math.min(120, level < XP_LEVEL_CAP ? level + 1 : level) : 1;
    if (goalValue.dataset.levelManual !== 'true') goalValue.value = next;
    goalValue.dataset.levelManual ??= 'false';
  } else if (goalValue.dataset.levelManual !== undefined) {
    goalValue.value = 1;
    delete goalValue.dataset.levelManual;
  }
  field('MinutesField').hidden = goal === 'none';
  field('Minutes').disabled = locked || goal === 'none';
  field('Minutes').min = goal === 'time' ? 1 : 0;
  field('MinutesLabel').textContent = t(goal === 'time' ? '挂机时长（分钟）' : '最长等待（分钟，0 为不限时）');
}

function updateQueueTotal() {
  const steps = actionQueue.steps;
  const valid = steps.length && steps.every(validQueueStep);
  const selected = selectedQueueTarget();
  const busy = queueBusy();
  syncQueueGoalFields('queue', actionQueue.targets.get(selected), busy);
  const draft = queueStepFromForm(selected);
  byId('queueAppend').disabled = busy || Boolean(selected && !validQueueStep(draft));
  for (const id of ['queueSelect', 'queueName', 'queueDelete', 'queueRepeat', 'queueClear',
    'queueSkill', 'queueCategory', 'queueAction', 'queueQuestActions']) byId(id).disabled = busy;
  byId('queueCreate').disabled = busy || actionQueue.queues.length >= maxSavedQueues;
  for (const control of byId('queueSteps').querySelectorAll('button, input')) {
    control.disabled = busy || (control.matches('.queue-handle') && steps.length < 2) ||
      (control.matches('.queue-goal-button') && control.dataset.unavailable === 'true');
  }
  if (busy) {
    cancelQueueDrag?.();
    if (byId('queueEditDialog').open) byId('queueEditDialog').close();
  }
  const access = selected && queueAccess(actionQueue.targets.get(selected));
  const hint = byId('queueSelectionAccess');
  hint.hidden = !access;
  hint.textContent = access?.description ?? '';
  hint.dataset.access = access?.state ?? '';
  byId('queueStart').disabled = busy || (steps.length ? !valid || !steps.every(queueCanRun) : !queueCanRun(draft));
  byId('queueTotal').hidden = !valid;
  if (valid) byId('queueTotal').textContent = t(steps.some(step => step.minutes === 0) ? '队列包含无时限步骤' :
    steps.some(step => step.goal) ? '每轮最多 {duration}' : '每轮计划时长 {duration}', {
    duration: formatDuration(steps.reduce((sum, step) => sum + step.minutes, 0) / 60, true)
  });
}

function queueStepFromForm(key = selectedQueueTarget(), prefix = 'queue') {
  const type = byId(prefix + 'Goal').value;
  const minutes = byId(prefix + 'Minutes').valueAsNumber;
  const step = { key, minutes: type === 'none' ? 0 : type === 'time' && minutes === 0 ? NaN : minutes };
  if (type !== 'time' && type !== 'none') {
    step.goal = { type, value: byId(prefix + 'GoalValue').valueAsNumber };
    if (productGoal(type) || materialGoal(type)) step.goal.item = byId(prefix + 'GoalItem').value;
  }
  return step;
}

function showQueueRun() {
  const { state, step, remaining, current, target } = actionQueue.status;
  const available = !webMode && Boolean(actionQueue.status.skills?.length);
  byId('queueNative').hidden = !available;
  byId('queueWebNote').hidden = !webMode;
  byId('queueBridgeUnavailable').hidden = webMode || available || state !== 'unavailable';
  byId('queueCancel').hidden = !queueBusy();
  byId('queueCancel').disabled = queueCommandPending || state === 'cancelling';
  const messages = {
    connecting: '正在启动并连接游戏。',
    switching: '正在启动第 {step} 步。',
    running: remaining === -1 ? '第 {step} 步进行中，无时限。' : '第 {step} 步进行中，剩余 {seconds} 秒。',
    paused: '游戏已暂停，队列正在等待继续。',
    cancelling: '正在等待游戏确认停止。',
    'cancel-unconfirmed': '队列已终止，未能确认游戏行动是否已停止。请查看游戏。',
    'action-in-use': '此行动已在游戏中运行。请先在游戏中停止，再启动队列。',
    'character-required': '请在工具启动的游戏里打开所选角色。',
    'character-mismatch': '游戏中打开的角色与工具所选角色不同。',
    'game-already-open': '请先关闭已打开的游戏，再由工具启动并连接。',
    'bridge-unavailable': '游戏连接未响应。请检查游戏是否已启动。',
    'bridge-build': '此游戏版本尚不支持直接挂机。',
    'direct-link-failed': '无法链接已安装的游戏。请检查游戏目录权限；跨盘符号链接可能需要 Windows 开发人员模式。',
    'action-changed': '游戏中的行动已停止或被切换，队列已结束。',
    'game-error': '游戏未能执行第 {step} 步。',
    locked: '游戏判定第 {step} 步尚未解锁。',
    materials: '第 {step} 步缺少开工材料，队列已结束。',
    'goal-timeout': '第 {step} 步已到最长等待时间，目标尚未达成。',
    unsupported: '第 {step} 步暂不支持直接控制。',
    completed: '队列已完成。',
    cancelled: '队列已取消。',
    failed: '队列执行失败。',
    busy: '已经有队列正在运行。',
    'invalid-queue': '队列包含无法直接执行的步骤。'
  };
  queueStatus(messages[state], { step, seconds: Math.max(0, Math.ceil((remaining ?? 0) / 1000)) });
  if (current != null && target != null) {
    byId('queueStatus').append(' · ' + t('目标进度 {current} / {target}', { current, target }));
  }
  updateQueueTotal();
}

async function pollQueueRun() {
  if (queueCommandPending || queueStatusPending) return;
  queueStatusPending = true;
  const version = queueCommandVersion;
  try {
    const status = await get('action-runner/status');
    if (version !== queueCommandVersion) return;
    actionQueue.status = status;
    showQueueRun();
  } catch {
    if (version === queueCommandVersion && !queueBusy()) {
      actionQueue.status = { state: 'unavailable' };
      showQueueRun();
    }
  } finally {
    queueStatusPending = false;
  }
}

function refreshActionQueue() {
  for (const option of byId('queueActions').options) {
    const access = queueAccess(actionQueue.targets.get(option.dataset.key));
    option.dataset.suggestionHint = access.description;
    option.dataset.access = access.state;
  }
  for (const row of byId('queueSteps').rows) {
    const message = row.querySelector('[data-queue-restriction]');
    const access = queueAccess(actionQueue.targets.get(actionQueue.steps[row.dataset.queueIndex].key));
    message.textContent = access.description;
    message.dataset.access = access.state;
  }
  updateQueueTotal();
}

let cancelQueueDrag;

function openQueueStepEditor(step) {
  const target = actionQueue.targets.get(step.key);
  if (queueBusy() || !target) return;
  actionQueue.editing = step;
  byId('queueEditAction').textContent = queueLabel(target);
  const select = byId('queueEditGoal');
  select.replaceChildren(...[...byId('queueGoal').options].map(option => new Option(option.text, option.value)));
  select.value = step.goal?.type ?? (step.minutes === 0 ? 'none' : 'time');
  if (!select.value) select.value = 'time';
  const goalValue = byId('queueEditGoalValue');
  goalValue.value = step.goal?.value ?? 1;
  if (step.goal?.type === 'level') goalValue.dataset.levelManual = 'true';
  else delete goalValue.dataset.levelManual;
  byId('queueEditMinutes').value = step.goal ? step.minutes ?? 0 : step.minutes || 10;
  syncQueueStepEditor();
  if (step.goal?.item && [...byId('queueEditGoalItem').options].some(option => option.value === step.goal.item)) {
    byId('queueEditGoalItem').value = step.goal.item;
    syncQueueStepEditor();
  }
  byId('queueEditDialog').showModal();
}

function syncQueueStepEditor() {
  const key = actionQueue.editing?.key;
  syncQueueGoalFields('queueEdit', actionQueue.targets.get(key));
  byId('queueEditSave').disabled = queueBusy() || !validQueueStep(queueStepFromForm(key ?? '', 'queueEdit'));
}

function liftQueueRow(event, row, handle, move) {
  if (cancelQueueDrag || handle.disabled || !event.isPrimary || event.button !== 0) return;
  const body = row.parentElement;
  const { pointerId } = event;
  const bounds = row.getBoundingClientRect();
  const offsetX = event.clientX - bounds.left;
  const offsetY = event.clientY - bounds.top;
  const index = Number(row.dataset.queueIndex);
  const overlay = create('table', undefined, 'production-table queue-drag-preview');
  const preview = row.cloneNode(true);
  overlay.inert = true;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.width = bounds.width + 'px';
  const columns = overlay.createTBody();
  [...row.cells].forEach((cell, i) => {
    preview.cells[i].style.width = cell.getBoundingClientRect().width + 'px';
  });
  columns.append(preview);
  let destination = index;
  let lastY = event.clientY;
  let pointer = event;
  let frame = 0;
  function positionPreview() {
    overlay.style.transform = `translate(${pointer.clientX - offsetX}px, ${pointer.clientY - offsetY}px)`;
  }
  function positionSlot(direction) {
    const sibling = direction > 0 ? 'nextElementSibling' : 'previousElementSibling';
    for (let next = row[sibling]; next; next = row[sibling]) {
      const box = next.getBoundingClientRect();
      const middle = box.top + box.height / 2;
      if (direction * (pointer.clientY - middle) < -1) break;
      if (direction > 0) next.after(row);
      else next.before(row);
      destination += direction;
    }
  }
  function autoScroll() {
    const margin = 48;
    const { top, bottom } = body.getBoundingClientRect();
    const y = pointer.clientY;
    const delta = y < margin && top < 0 ? Math.max(-16, y - margin) :
      y > innerHeight - margin && bottom > innerHeight ? Math.min(16, y - innerHeight + margin) : 0;
    if (delta) {
      const before = scrollY;
      window.scrollBy(0, delta);
      if (scrollY !== before) positionSlot(Math.sign(delta));
    }
    frame = requestAnimationFrame(autoScroll);
  }
  function onMove(next) {
    if (next.pointerId !== pointerId) return;
    pointer = next;
    positionPreview();
    if (next.clientY !== lastY) positionSlot(Math.sign(next.clientY - lastY));
    lastY = next.clientY;
  }
  function finish(commit) {
    cancelQueueDrag = null;
    listeners.abort();
    cancelAnimationFrame(frame);
    if (body.hasPointerCapture(pointerId)) body.releasePointerCapture(pointerId);
    overlay.remove();
    row.classList.remove('queue-drag-slot');
    if (destination !== index) {
      const original = body.rows[index];
      if (destination > index) original.before(row);
      else original.after(row);
      if (commit) move(destination);
    }
  }
  const listeners = new AbortController();
  const { signal } = listeners;
  cancelQueueDrag = () => finish(false);
  body.setPointerCapture(pointerId);
  document.body.append(overlay);
  row.classList.add('queue-drag-slot');
  positionPreview();
  frame = requestAnimationFrame(autoScroll);
  body.addEventListener('pointermove', onMove, { signal });
  body.addEventListener('pointerup', next => {
    if (next.pointerId === pointerId) finish(true);
  }, { signal });
  for (const type of ['pointercancel', 'lostpointercapture']) body.addEventListener(type, next => {
    if (next.target === body && next.pointerId === pointerId) finish(false);
  }, { signal });
  document.addEventListener('keydown', next => {
    if (next.key === 'Escape') finish(false);
  }, { signal });
}

function renderActionQueue() {
  cancelQueueDrag?.();
  const { steps, targets } = actionQueue;
  byId('queueStepsWrap').hidden = !steps.length;
  byId('queueEmpty').hidden = !!steps.length;
  byId('queueClear').hidden = !steps.length;
  const body = byId('queueSteps');
  body.replaceChildren(...steps.map((step, index) => {
    const row = create('tr');
    row.dataset.queueIndex = index;
    const title = targets.has(step.key) ? queueLabel(targets.get(step.key)) : t('未知行动');
    const target = create('td', title);
    const message = create('small', '', 'production-restriction queue-restriction');
    message.dataset.queueRestriction = '';
    target.append(message);
    const goalLabels = { level: '达到等级 {value}', item: '获得 {item} × {value}', owned: '拥有 {item} × {value}',
      spent: '花费 {item} × {value}', remaining: '{item} 剩余 {value} 或更少', recipes: '制作 {value} 次' };
    const goalLabel = step.goal ? t(goalLabels[step.goal.type] ?? '未知行动', {
      item: step.goal.item ? queueItemName(step.goal.item) : '', value: fullNumber(step.goal.value)
    }) : t(step.minutes === 0 ? '无时限' : '按时长');
    const edit = create('button', goalLabel, 'queue-goal-button');
    edit.type = 'button';
    edit.addEventListener('click', () => openQueueStepEditor(step));
    edit.dataset.unavailable = String(!targets.has(step.key));
    edit.title = t('修改结束条件');
    edit.setAttribute('aria-label', t('修改第 {number} 步的结束条件', { number: index + 1 }));
    const condition = create('td');
    condition.append(edit);
    const duration = create('input');
    Object.assign(duration, { type: 'number', min: step.goal ? 0 : 1, max: maxQueueMinutes, step: 1,
      required: true, value: step.minutes ?? '' });
    duration.setAttribute('aria-label', t('第 {number} 步的挂机分钟数', { number: index + 1 }));
    duration.addEventListener('input', () => {
      if (queueBusy()) return;
      step.minutes = duration.validity.valid ? duration.valueAsNumber : null;
      saveActionQueue();
    });
    const time = create('td', undefined, 'queue-duration');
    time.append(step.minutes === 0 && !step.goal ? t('无时限') : duration);
    const controls = create('td', undefined, 'queue-row-controls');
    const handle = create('button', '☰', 'queue-handle');
    handle.type = 'button';
    handle.title = t('拖动排序，也可使用上下方向键');
    handle.setAttribute('aria-label', handle.title);
    handle.disabled = steps.length < 2;
    const move = destination => {
      if (queueBusy() || !steps[destination] || destination === index) return;
      steps.splice(destination, 0, steps.splice(index, 1)[0]);
      saveActionQueue();
      renderActionQueue();
      body.rows[destination]?.querySelector('.queue-handle')?.focus();
    };
    handle.addEventListener('keydown', event => {
      if (cancelQueueDrag || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      move(index + (event.key === 'ArrowUp' ? -1 : 1));
    });
    handle.addEventListener('pointerdown', event => liftQueueRow(event, row, handle, move));
    const remove = queueButton('移除', () => {
      if (queueBusy()) return;
      steps.splice(index, 1);
      saveActionQueue();
      renderActionQueue();
      (body.rows[Math.min(index, steps.length - 1)]?.querySelector('.queue-remove') ?? byId('queueAction')).focus();
    });
    remove.className = 'queue-remove';
    remove.title = t('移除');
    remove.setAttribute('aria-label', remove.title);
    remove.textContent = '×';
    controls.append(handle, remove);
    row.append(target, condition, time, controls);
    return row;
  }));
  refreshActionQueue();
  showQueueRun();
}

function localizeQueueTargets(category = byId('queueCategory').value) {
  const showQuests = byId('queueQuestActions').checked;
  const input = byId('queueAction');
  const previous = [...byId('queueActions').options].find(option => option.value === input.value)?.dataset.key;
  const targets = [...actionQueue.targets].filter(([, target]) =>
    target.skill === byId('queueSkill').value && (showQuests || !target.questOnly));
  const categories = new Map(targets.map(([, target]) => [target.category ?? 'other', queueArea(target)]));
  const groupOrder = new Map([...categories.keys()].map((id, index) => [id, index]));
  const select = byId('queueCategory');
  select.replaceChildren(new Option(t('全部分类'), 'all'), ...[...categories].map(([id, label]) => new Option(label, id)));
  select.value = categories.has(category) ? category : 'all';
  const options = localizedSuggestions(targets
    .filter(([, target]) => select.value === 'all' || (target.category ?? 'other') === select.value)
    .sort(([, a], [, b]) => groupOrder.get(a.category ?? 'other') - groupOrder.get(b.category ?? 'other')).map(([key, target]) => ({
    key, name: queueLabel(target, select.value), aliases: [target.id, gameName(target.action),
      ...(target.skill === 'Woodcutting' && target.id === 'YewTree' ? ['紫杉树', '紫杉樹'] : []),
      ...Object.values(target.action.names ?? {}), ...Object.values(target.areaNames ?? {})]
  })));
  byId('queueActions').replaceChildren(...options);
  const selected = options.find(option => option.dataset.key === previous);
  input.value = selected?.value ?? '';
  input.setCustomValidity('');
  refreshActionQueue();
}

function localizeActionQueue(skill = byId('queueSkill').value, category = byId('queueCategory').value) {
  const select = byId('queueSkill');
  const skills = [...new Set([...actionQueue.targets.values()].map(target => target.skill))];
  select.replaceChildren(...skills.map(id => new Option(queueSkillLabel(id), id)));
  if (skills.includes(skill)) select.value = skill;
  renderQueueLibrary();
  localizeQueueTargets(category);
  renderActionQueue();
}

function initActionQueue(catalog) {
  actionQueue.targets = queueTargets(catalog);
  const readSteps = steps => Array.isArray(steps) ? steps.slice(0, maxQueueSteps).filter(step =>
    typeof step?.key === 'string' && (step.minutes === null || validQueueMinutes(step.minutes)))
    .map(({ key, minutes, goal }) => ({ key, minutes, ...(goal && { goal }) })) : [];
  let library;
  try {
    library = JSON.parse(byId('queueLibrary').value);
  } catch { /* Older installations have one draft. */ }
  const loaded = Array.isArray(library?.queues) ? library.queues.slice(0, maxSavedQueues) : [];
  const ids = new Set();
  for (const row of loaded) {
    if (typeof row?.id !== 'string' || !row.id || ids.has(row.id)) continue;
    ids.add(row.id);
    actionQueue.queues.push({ id: row.id, name: typeof row.name === 'string' ? row.name.slice(0, 40) : '',
      repeat: row.repeat === true, steps: readSteps(row.steps) });
  }
  if (!actionQueue.queues.length) {
    let draft;
    try { draft = JSON.parse(byId('queueDraft').value); } catch { /* Empty draft. */ }
    actionQueue.queues.push({ id: 'initial', name: byId('queueName').value,
      repeat: byId('queueRepeat').checked, steps: readSteps(draft) });
  }
  selectSavedQueue(actionQueue.queues.find(row => row.id === library?.selected) ?? actionQueue.queues[0]);
  localizeActionQueue(preferences.fields?.queueSkill, preferences.fields?.queueCategory);
  byId('queueSelect').addEventListener('change', event => {
    if (queueBusy()) return;
    const queue = actionQueue.queues.find(row => row.id === event.currentTarget.value);
    if (queue) selectSavedQueue(queue);
  });
  byId('queueCreate').addEventListener('click', () => {
    if (queueBusy() || actionQueue.queues.length >= maxSavedQueues) return;
    let index = actionQueue.queues.length + 1;
    while (actionQueue.queues.some(row => row.id === 'queue-' + index)) index++;
    const queue = { id: 'queue-' + index, name: '', repeat: false, steps: [] };
    actionQueue.queues.push(queue);
    selectSavedQueue(queue);
    byId('queueName').focus();
  });
  byId('queueDelete').addEventListener('click', () => {
    if (queueBusy()) return;
    const index = actionQueue.queues.findIndex(queue => queue.id === actionQueue.selected);
    if (index < 0) return;
    const queue = actionQueue.queues[index];
    const name = queue.name || t('队列 {number}', { number: index + 1 });
    if (!window.confirm(t('删除队列「{name}」？', { name }))) return;
    actionQueue.queues.splice(index, 1);
    if (!actionQueue.queues.length) actionQueue.queues.push({ id: 'initial', name: '', repeat: false, steps: [] });
    selectSavedQueue(actionQueue.queues[Math.min(index, actionQueue.queues.length - 1)]);
    byId('queueSelect').focus();
  });
  byId('queueName').addEventListener('input', saveActionQueue);
  byId('queueRepeat').addEventListener('change', saveActionQueue);
  byId('queueClear').addEventListener('click', () => {
    if (queueBusy()) return;
    actionQueue.steps.length = 0;
    saveActionQueue();
    renderActionQueue();
    byId('queueAction').focus();
  });
  byId('queueSkill').addEventListener('change', () => {
    delete byId('queueGoalValue').dataset.levelManual;
    localizeQueueTargets('all');
  });
  byId('queueCategory').addEventListener('change', () => localizeQueueTargets());
  byId('queueQuestActions').addEventListener('change', () => localizeQueueTargets());
  byId('queueMinutes').addEventListener('input', updateQueueTotal);
  for (const prefix of ['queue', 'queueEdit']) {
    byId(prefix + 'GoalValue').addEventListener('input', event => {
      if (byId(prefix + 'Goal').value === 'level') event.target.dataset.levelManual = 'true';
    });
  }
  for (const id of ['queueGoal', 'queueGoalItem', 'queueGoalValue']) byId(id).addEventListener('input', updateQueueTotal);
  const input = byId('queueAction');
  input.addEventListener('input', () => {
    input.setCustomValidity('');
    updateQueueTotal();
  });
  byId('queueAdd').addEventListener('submit', async event => {
    event.preventDefault();
    if (queueBusy()) return;
    const key = selectedQueueTarget();
    if (!key) {
      input.setCustomValidity(t('请从搜索结果中选择一个行动。'));
      input.reportValidity();
      return;
    }
    const step = queueStepFromForm(key);
    if (!validQueueStep(step)) return;
    if (actionQueue.steps.length >= maxQueueSteps) {
      queueStatus('队列最多可添加 200 步。');
      return;
    }
    actionQueue.steps.push(step);
    input.value = '';
    delete byId('queueGoalValue').dataset.levelManual;
    input.focus();
    saveActionQueue();
    renderActionQueue();
  });
  const editor = byId('queueEditDialog');
  byId('queueEditCancel').addEventListener('click', () => editor.close());
  byId('queueEditForm').addEventListener('input', syncQueueStepEditor);
  byId('queueEditForm').addEventListener('submit', event => {
    event.preventDefault();
    const index = actionQueue.steps.indexOf(actionQueue.editing);
    if (queueBusy() || index < 0) return;
    const step = queueStepFromForm(actionQueue.editing.key, 'queueEdit');
    if (!validQueueStep(step)) return;
    actionQueue.steps[index] = step;
    editor.close();
    saveActionQueue();
    renderActionQueue();
    byId('queueSteps').rows[index]?.querySelector('.queue-goal-button')?.focus();
  });
  if (webMode) return;
  byId('queueStart').addEventListener('click', () => {
    const steps = actionQueue.steps;
    void startQueue(steps.length ? steps : [queueStepFromForm()], steps.length > 0 && byId('queueRepeat').checked);
  });
  byId('queueCancel').addEventListener('click', () => {
    if (queueBusy() && !queueCommandPending) void sendQueueCommand('cancel');
  });
  if (!byId('queuePage').hidden) void pollQueueRun();
  setInterval(() => { if (!byId('queuePage').hidden || queueBusy()) void pollQueueRun(); }, 700);
}

async function startQueue(steps, repeat) {
  if (queueBusy() || !steps.length || !steps.every(queueCanRun)) return;
  actionQueue.status = { ...actionQueue.status, state: 'switching', step: 1 };
  await sendQueueCommand('start', { steps, character: profile.name, characterId: profile.characterId, repeat });
}

async function sendQueueCommand(command, payload) {
  queueCommandVersion++;
  queueCommandPending = true;
  showQueueRun();
  try {
    actionQueue.status = { ...actionQueue.status, ...await queueRequest(command, payload) };
  } catch {
    // The command may have reached the runner. Let its next status determine whether editing is safe.
  } finally {
    queueCommandPending = false;
  }
  showQueueRun();
}
