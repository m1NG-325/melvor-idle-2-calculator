const { localId } = require('./game-ids.cjs');
const { levelFor } = require('./xp-progress.js');

const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
const SAVE_VERSION = 31;
const MAX_SAVE_BYTES = 32 * 1024 * 1024;

class SaveCursor {
  constructor(buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.offset = 0;
  }
  take(length) {
    if (!Number.isInteger(length) || length < 0 || length > this.buffer.length - this.offset) {
      throw new Error('存档区域不完整');
    }
    const bytes = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }
  byte() { return this.take(1)[0]; }
  int() {
    this.take(4);
    return this.view.getInt32(this.offset - 4, true);
  }
  long() {
    this.take(8);
    return this.view.getBigInt64(this.offset - 8, true);
  }
  double() {
    this.take(8);
    return this.view.getFloat64(this.offset - 8, true);
  }
  count(maximum = 100000) {
    const value = this.int();
    if (value < 0 || value > maximum) throw new Error('存档列表长度无效');
    return value;
  }
  string() {
    let length = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      length += (byte & 127) * 2 ** shift;
      if (byte < 128) return textDecoder.decode(this.take(length));
    }
    throw new Error('存档字符串长度无效');
  }
  region() { return new SaveCursor(this.take(this.int())); }
  regions() {
    const count = this.count();
    const out = new Map();
    for (let index = 0; index < count; index++) out.set(this.string(), this.region());
    return out;
  }
}

function parseHeader(data) {
  const reader = new SaveCursor(data);
  if (reader.int() !== SAVE_VERSION) {
    const error = new Error('此存档版本暂不支持。请先用当前游戏保存一次。');
    error.code = 'UNSUPPORTED_SAVE_VERSION';
    throw error;
  }
  const characterId = Array.from(reader.take(16), byte => byte.toString(16).padStart(2, '0')).join('');
  const name = reader.string();
  reader.string();
  reader.take(8);
  for (let i = 0; i < 4; i++) reader.string();
  const totalLevel = reader.int();
  const gp = Number(reader.long());
  const slayerCoins = Number(reader.long());
  reader.byte();
  return { name, characterId, totalLevel, currencies: { GoldPieces: gp, SlayerCoins: slayerCoins }, reader };
}

function readBank(reader) {
  const stock = Object.create(null);
  const keep = new Set();
  reader.int();
  const tabs = reader.count(100);
  for (let tab = 0; tab < tabs; tab++) {
    reader.take(14);
    const stacks = reader.count();
    for (let stack = 0; stack < stacks; stack++) {
      const quantity = reader.int();
      reader.byte(); // Placeholder
      const locked = reader.byte();
      const id = localId(reader.string());
      if (locked) keep.add(id);
      if (quantity > 0) stock[id] = (stock[id] ?? 0) + quantity;
    }
    reader.string();
    const tags = reader.count();
    for (let tag = 0; tag < tags; tag++) {
      reader.take(2);
      reader.string();
    }
  }
  const locked = reader.count();
  for (let i = 0; i < locked; i++) keep.add(localId(reader.string()));
  return { stock, keep: [...keep] };
}

function readShopPurchases(reader) {
  if (!reader) return { purchases: null, shopShowLocked: null };
  reader.byte(); // Show purchased
  const shopShowLocked = !!reader.byte();
  reader.take(9); // Hold to buy, quantity and quantity mode.
  const count = reader.count();
  const purchases = Object.create(null);
  for (let i = 0; i < count; i++) {
    const quantity = reader.count(Number.MAX_SAFE_INTEGER);
    purchases[localId(reader.string())] = quantity;
  }
  return { purchases, shopShowLocked };
}

function readShopStatistic(reader, precedingLists, statistic) {
  if (!reader) return null;
  try {
    for (let i = 0; i < precedingLists; i++) reader.regions();
    const region = reader.regions().get('MelvorBase:' + statistic);
    if (!region) return null;
    const values = Object.create(null);
    const count = region.count();
    for (let i = 0; i < count; i++) {
      const value = region.double();
      values[localId(region.string())] = value;
    }
    return values;
  } catch {
    return null;
  }
}

function readStatisticsComponent(reader) {
  const groups = ['value', 'item', 'currency'];
  const statistics = [];
  const unavailable = [];
  for (let index = 0; reader.offset < reader.buffer.length; index++) {
    const kind = groups[index] ?? 'subject';
    for (const [name, region] of reader.regions()) {
      const id = localId(name);
      try {
        if (kind === 'value') {
          const value = region.double();
          if (region.offset !== region.buffer.length || !Number.isFinite(value)) throw Error('invalid statistic');
          statistics.push({ id, kind, value });
        } else {
          const rows = [];
          const count = region.count();
          for (let i = 0; i < count; i++) {
            const value = region.double();
            const key = localId(region.string());
            if (!key || !Number.isFinite(value)) throw Error('invalid statistic entry');
            rows.push({ id: key, value });
          }
          if (region.offset !== region.buffer.length) throw Error('unsupported statistic format');
          statistics.push({ id, kind, rows });
        }
      } catch {
        unavailable.push(id);
      }
    }
  }
  return { statistics, unavailable };
}

function parseCharacterStatistics(data, date) {
  const { characterId, name, reader } = parseHeader(data);
  const sections = [];
  const unavailable = [];
  for (const [entity, region] of reader.regions()) {
    const id = localId(entity);
    try {
      const source = region.regions().get('Statistics');
      if (!source) continue;
      const result = readStatisticsComponent(source);
      if (result.statistics.length || result.unavailable.length) sections.push({ id, ...result });
    } catch {
      unavailable.push(id);
    }
  }
  return { characterId, name, sections, unavailable, date };
}

function readCurrencies(reader, fallback) {
  if (!reader) return fallback;
  const currencies = Object.assign(Object.create(null), fallback);
  const count = reader.count();
  for (let i = 0; i < count; i++) {
    const quantity = Number(reader.long());
    currencies[localId(reader.string())] = quantity;
  }
  return currencies;
}

function readAstrologyNodes(reader) {
  if (!reader) return [];
  // Action started flag, tick timer, and two constellation display flags.
  reader.take(16);
  const unlocked = [];
  for (const constellation of reader.regions().values()) {
    constellation.double(); // Accumulated knowledge.
    for (let kind = 0; kind < 2; kind++) {
      const count = constellation.count();
      for (let i = 0; i < count; i++) unlocked.push(localId(constellation.string()));
    }
  }
  return unlocked;
}

function readMastery(components, levels, description, unlockedPets, astrologyNodes, constellations) {
  const reader = components?.get('MasteryGuild');
  if (!description || !reader) return [];
  if (reader.byte()) reader.string();
  const saved = new Map();
  for (const [key, task] of reader.regions()) {
    let goal;
    if (task.byte()) {
      const id = task.string();
      const region = task.region();
      goal = { id, progress: region.double(), complete: !!region.byte() };
    }
    saved.set(localId(key), { goal, triggered: !!task.byte() });
  }
  const statistics = components.get('Statistics');
  const regions = new Map();
  while (statistics && statistics.offset < statistics.buffer.length) {
    for (const [id, region] of statistics.regions()) regions.set(id, region.buffer);
  }
  const minor = astrologyNodes.filter(id => constellations.some(row => row.minorNodes.includes(id)));
  const major = astrologyNodes.filter(id => !minor.includes(id));
  function conditionMet(condition) {
    if (!condition) return true;
    const { Type, Data } = condition;
    if (Type === 'MelvorBase:Level') return (levels[localId(Data.Component.Entity)] ?? 0) >= Data.Level;
    if (Type === 'MelvorBase:PetUnlocked') return unlockedPets.includes(localId(Data.Pet));
    if (Type === 'MelvorBase:AstrologyMinorNodeUnlockCount') {
      const row = constellations.find(row => row.recipe === localId(Data.Constellation));
      return (row?.minorNodes.filter(id => minor.includes(id)).length ?? 0) >= Data.Count;
    }
    if (Type === 'MelvorBase:AstrologyMajorNodeUnlockCount') {
      const row = constellations.find(row => row.recipe === localId(Data.Constellation));
      return (row?.majorNodes.filter(id => major.includes(id)).length ?? 0) >= Data.Count;
    }
    if (Data.Statistic === 'MelvorBase:AstrologyTotalMinorNodesUnlocked') return minor.length >= Data.Value;
    if (Data.Statistic === 'MelvorBase:AstrologyTotalMajorNodesUnlocked') return major.length >= Data.Value;
    const buffer = regions.get(Data.Statistic);
    if (buffer && Type === 'MelvorBase:ValueStatistic') return new SaveCursor(buffer).double() >= Data.Value;
    const key = Data.Item ?? Data.Event ?? Data.Species ?? Data.Animal ?? Data.Course ?? Data.Master;
    if (buffer && key) {
      const stat = new SaveCursor(buffer);
      const count = stat.count();
      for (let i = 0; i < count; i++) {
        const value = stat.double();
        if (stat.string() === key) return value >= Data.Value;
      }
    }
    return false;
  }
  const total = description.tasks.reduce((sum, task) => sum + task.points, 0);
  let earned = 0;
  const lookup = new Map(description.tasks.map(task => [task.id, task]));
  function progressFor(task) {
    let max = 0;
    for (let current = task; current; current = lookup.get(current.linked)) {
      const goal = saved.get(current.id)?.goal;
      if (goal?.id === current.goal) max = Math.max(max, goal?.progress ?? 0);
    }
    return max;
  }
  for (const task of description.tasks) {
    const state = saved.get(task.id);
    const complete = !task.goal || (state?.goal?.id === task.goal && state.goal.complete) ||
      progressFor(task) >= task.max;
    if (complete && conditionMet(task.condition) && (!task.trigger || state?.triggered)) earned += task.points;
  }
  return description.ranks.filter(rank => earned >= Math.ceil(total * rank.percent)).map(rank => rank.id);
}

function readCombatProfile(components, onWarning) {
  if (!components) return null;
  const combat = {};
  try {
    const reader = components.get('Areas');
    if (reader) {
      reader.int();
      reader.int();
      const [area, enemy, dungeon] = Array.from({ length: 3 }, () => reader.byte() ? localId(reader.string()) : null);
      combat.encounter = { area, enemy, dungeon };
    }
  } catch {
    onWarning('Areas', 'Combat');
  }
  for (const [component, key] of [['Equipment', 'equipment'], ['Toolbelt', 'toolbelt']]) {
    try {
      const slots = components.get(component)?.regions();
      if (!slots) continue;
      combat[key] = [...slots].flatMap(([slot, reader]) => {
        const quantity = reader.int();
        if (component === 'Equipment') reader.byte();
        if (!reader.byte()) return [];
        const id = localId(reader.string());
        // Secondary slots occupied by a two-handed item reference it with a quantity of -1.
        return component === 'Equipment' && quantity < 0 ? [] : [{ slot: localId(slot), id, quantity }];
      });
    } catch {
      onWarning(component, 'Combat');
    }
  }
  try {
    const reader = components.get('MagicSpells');
    if (reader) {
      for (const key of ['spell', 'imbuement', 'spellBook', 'activeImbuement']) {
        if (reader.byte()) combat[key] = localId(reader.string());
      }
    }
  } catch {
    onWarning('MagicSpells', 'Combat');
  }
  try {
    const food = components.get('Food');
    if (food?.byte()) combat.food = localId(food.string());
  } catch {
    onWarning('Food', 'Combat');
  }
  try {
    const slots = components.get('Prayer')?.regions();
    if (slots) combat.prayers = [...slots].flatMap(([slot, reader]) => {
      const selected = reader.byte() ? localId(reader.string()) : null;
      const activated = reader.byte();
      const state = activated ? reader.int() : 0;
      const active = activated ? localId(reader.string()) : null;
      return selected || active ? [{ slot: localId(slot), selected, active, state }] : [];
    });
  } catch {
    onWarning('Prayer', 'Combat');
  }
  try {
    const player = components.get('Player');
    if (player) {
      combat.hitpoints = player.region().int();
      player.region(); // Ward
      player.region(); // Turn timer
      const turn = player.int();
      player.byte(); // Executing
      if (turn === 1) {
        player.string(); // Attack
        player.take(13 + 4 * 4); // Hit timer and hit/attack counters
      } else if (turn === 2) {
        player.string(); // Stun effect
        player.int();
      } else if (turn !== 0) throw new Error('Unsupported combat turn');
      player.take(12); // Last attack damage and current tick
      const stancesHit = player.count(100);
      for (let i = 0; i < stancesHit; i++) player.string();
      player.byte(); // Armour broken
      const count = player.count(100);
      combat.stances = Object.fromEntries(Array.from({ length: count }, () => [localId(player.string()), localId(player.string())]));
    }
  } catch {
    onWarning('Player', 'Combat');
  }
  const stats = components.get('Statistics');
  if (stats) try {
    const totals = new SaveCursor(stats.buffer).regions();
    const get = id => totals.get('MelvorBase:Combat' + id)?.double();
    const milliseconds = get('TimeSpentFighting') + get('TimeSpentSpawning');
    const deaths = get('PlayerDeaths');
    const kills = readShopStatistic(new SaveCursor(stats.buffer), 3, 'CombatEnemyKilled');
    if (Number.isFinite(milliseconds) && Number.isFinite(deaths)) {
      const supplies = readShopStatistic(new SaveCursor(stats.buffer), 1, 'CombatItemUsed');
      const foodEaten = readShopStatistic(new SaveCursor(stats.buffer), 1, 'CombatFoodItemEaten');
      combat.totals = { milliseconds, deaths, kills: kills ?? {}, supplies: supplies ?? {}, usageTracked: true,
        foodEaten: foodEaten ?? {} };
    }
  } catch {
    onWarning('Statistics', 'Combat');
  }
  return combat;
}

function readFishingPriorities(reader) {
  const priorities = Object.create(null);
  if (!reader) return priorities;
  reader.take(14); // Started flag and action timer state.
  if (reader.byte()) reader.string(); // Current location.
  if (reader.byte()) reader.string(); // Current recipe.
  reader.regions(); // Per-location state.
  for (const [recipe, state] of reader.regions()) {
    if (state.byte()) priorities[localId(recipe)] = localId(state.string());
  }
  return priorities;
}

function readQuestProgress(reader) {
  if (!reader) return;
  const readGoal = reader => ({ progress: reader.double(), complete: Boolean(reader.byte()) });
  const readTask = reader => {
    const goals = Object.fromEntries([...reader.regions()].map(([id, goal]) => [id, readGoal(goal)]));
    const flags = reader.buffer.length - reader.offset - 4;
    if (flags !== 2 && flags !== 3) throw new Error('无法识别任务进度格式');
    reader.take(flags);
    return { status: reader.int(), goals };
  };
  const readStep = reader => {
    const tasks = Object.fromEntries([...reader.regions()].map(([id, task]) => [id, readTask(task)]));
    reader.byte();
    return { status: reader.int(), tasks };
  };
  return Object.fromEntries([...reader.regions()].map(([id, quest]) => {
    const status = quest.int();
    const steps = Object.fromEntries([...quest.regions()].map(([id, step]) => [id, readStep(step)]));
    return [localId(id), { status, steps }];
  }));
}

function readHuntingState(action, journal) {
  const entries = {};
  if (journal) for (const [id, entry] of journal.regions()) {
    entries[localId(id)] = { discovered: Boolean(entry.byte()), xp: entry.double() };
  }
  if (!action) return { entries };
  action.take(14); // Started flag and action timer
  for (const [id, animal] of action.regions()) {
    animal.take(12); // Tracks, current step, and required steps
    const trap = animal.byte() ? localId(animal.string()) : null;
    animal.byte(); // Species set
    if (animal.byte()) animal.string();
    animal.int(); // State
    const bait = Boolean(animal.byte());
    animal.take(9); // Survey failures, bait already consumed, trap failures
    const trapless = Boolean(animal.byte());
    Object.assign(entries[localId(id)] ??= {}, { trap, bait, trapless });
  }
  action.byte(); // Allow surveying products
  for (let i = 0; i < 3; i++) if (action.byte()) action.string();
  return { entries, autoSwap: Boolean(action.byte()) };
}

function readFarmingPlots(reader) {
  if (!reader) return;
  if (reader.byte()) reader.string();
  const tick = reader.long();
  return [...reader.regions()].flatMap(([id, plot]) => {
    const watered = Boolean(plot.byte());
    const autoPlant = Boolean(plot.byte());
    const autoHarvest = Boolean(plot.byte());
    plot.take(2); // Compost and water automation
    const selected = plot.byte() ? localId(plot.string()) : null;
    if (plot.byte()) plot.string();
    if (plot.byte()) plot.string();
    const state = plot.int();
    if (!state) return [];
    const result = { id: localId(id), selected, autoPlant, autoHarvest, watered, state };
    if (state > 1 && plot.offset < plot.buffer.length) {
      result.crop = localId(plot.string());
      if (state === 2 || state === 4) {
        plot.take(9);
        result.seconds = Math.max(0, Number(plot.long() - tick) / 60);
        if (state === 4) {
          plot.int(); // Paused ticks
          result.regrows = plot.int();
        }
      } else if (state === 3) {
        result.seconds = 0;
        result.regrows = plot.view.getInt32(plot.buffer.length - 4, true);
      }
    }
    return [result];
  });
}

function readRanchingState(reader) {
  if (!reader) return;
  const timer = () => {
    reader.byte();
    const state = reader.int();
    const interval = reader.int() / 60;
    return { state, interval, first: reader.int() / 60 };
  };
  const maintenance = timer();
  const food = timer();
  const production = timer();
  timer(); // Treat schedule
  reader.take(9);
  reader.long(); // Land timer queue
  const lands = [...reader.regions()].flatMap(([id, land]) => {
    if (!land.byte() || !land.byte()) return [];
    const enclosure = localId(land.string());
    const region = land.region();
    region.take(21); // Breeding timer
    const safety = region.double();
    const animals = Array.from({ length: region.count(100) }, () => {
      const type = localId(region.string());
      const animal = region.region();
      const sick = Boolean(animal.byte());
      const hunger = animal.double();
      const safety = animal.double();
      const satisfaction = animal.double();
      animal.take(5); // Wants pets and pet count
      const variant = localId(animal.string());
      for (let i = animal.count(100); i > 0; i--) {
        animal.byte();
        animal.string();
      }
      const lifeSeconds = animal.double() * 60;
      const variantSeconds = animal.double() * 60;
      return { type, sick, hunger, safety, satisfaction, variant, lifeSeconds, variantSeconds };
    });
    for (let i = region.count(100); i > 0; i--) region.string(); // Auto-purchase selections
    region.take(21); // Animal custom tick timer
    const upgrades = Array.from({ length: region.count(100) }, () => localId(region.string()));
    return [{ id: localId(id), enclosure, safety, animals, upgrades }];
  });
  return { maintenance, food, production, lands };
}

function readGrainMill(reader, inventory) {
  if (!reader || !inventory) return;
  const active = Boolean(reader.byte());
  reader.take(9); // Timer restart flag, state, and duration
  const first = reader.int() / 60;
  const recipe = reader.byte() ? localId(reader.string()) : null;
  const stock = Object.create(null);
  inventory.take(14);
  for (let i = inventory.count(); i > 0; i--) {
    const quantity = inventory.int();
    inventory.byte(); // Placeholder
    const locked = inventory.byte();
    const item = localId(inventory.string());
    if (!locked && quantity > 0) stock[item] = (stock[item] ?? 0) + quantity;
  }
  return { active, first, recipe, stock };
}

function readBonfire(reader) {
  if (!reader) return;
  reader.int(); // Maximum ticks
  const ticks = reader.int();
  const paused = reader.byte();
  const id = reader.byte() ? localId(reader.string()) : null;
  const active = reader.byte();
  return id && active && !paused && ticks > 0 ? { id, seconds: ticks / 60 } : undefined;
}

function parseProfile(data, date, skills, shopSkills = [], mastery = {}, constellations = [], onWarning = () => {}, items = {}) {
  const { reader, ...header } = parseHeader(data);
  const entities = reader.regions();
  const componentMaps = new Map();
  const componentsFor = id => {
    if (!componentMaps.has(id)) componentMaps.set(id, entities.get('MelvorBase:' + id)?.regions());
    return componentMaps.get(id);
  };
  const levels = {};
  const skillXp = {};
  const equipped = {};
  const skillToolbelt = {};
  const cookingCharges = [];
  const unlockedPets = [];
  const bankComponents = componentsFor('Bank');
  const bank = bankComponents?.get('Inventory');
  if (!bank) throw new Error('存档里找不到仓库');
  for (const skill of new Set([...Object.keys(skills), ...shopSkills])) {
    const components = componentsFor(skill);
    const xp = components?.get('Experience');
    if (xp) {
      skillXp[skill] = xp.double();
      levels[skill] = levelFor(skillXp[skill]);
    }
    if (!Object.hasOwn(skills, skill)) continue;
    const pets = components?.get('Pets')?.regions();
    for (const [id, pet] of pets ?? []) {
      if (pet.byte()) unlockedPets.push(localId(id));
    }
    const slots = components?.get('Toolbelt')?.regions();
    equipped[skill] = [];
    if (slots) skillToolbelt[skill] = [];
    for (const [id, slot] of slots ?? []) {
      const quantity = slot.int();
      if (!slot.byte()) continue;
      const item = localId(slot.string());
      if (quantity <= 0 && items[item]?.skillTool?.consumable) continue;
      equipped[skill].push(item);
      skillToolbelt[skill].push({ slot: localId(id), id: item, quantity: Math.max(1, quantity) });
      if (skill === 'Cooking' && quantity > 0) cookingCharges.push({ item, quantity });
    }
  }
  if (!levels.Woodcutting) throw new Error('存档里找不到技能经验');
  const shopReader = componentsFor('Shop')?.get('Shop');
  const combatComponents = componentsFor('Combat');
  const combat = readCombatProfile(combatComponents, onWarning);
  const dungeonCompletions = readShopStatistic(combatComponents?.get('Statistics'), 4, 'CombatDungeonCompleted');
  const slayer = componentsFor('Slayer');
  const slayerStats = slayer?.get('Statistics');
  const slayerCompletions = readShopStatistic(slayerStats && new SaveCursor(slayerStats.buffer), 3, 'SlayerMasterTasksCompleted');
  let slayerTasks;
  try {
    const tasks = slayer?.get('Tasks')?.regions();
    if (tasks) slayerTasks = [...tasks].flatMap(([master, reader]) => {
      if (!reader.byte()) return [];
      const monster = localId(reader.string());
      const length = reader.count();
      const progress = reader.count();
      return [{ master: localId(master), monster, remaining: Math.max(0, length - progress) }];
    });
  } catch {
    onWarning('Tasks', 'Slayer');
  }
  const astrologyNodes = readAstrologyNodes(componentsFor('Astrology')?.get('Action'));
  const recipeStatistics = {
    BankItemFound: readShopStatistic(bankComponents.get('Statistics'), 1, 'BankItemFound'),
    AgilityCourseCompleted: readShopStatistic(componentsFor('Agility')?.get('Statistics'), 3, 'AgilityCourseCompleted'),
    AstrologyTimesEventObserved: readShopStatistic(componentsFor('Astrology')?.get('Statistics'), 4, 'AstrologyTimesEventObserved')
  };
  let fishingPriorities;
  try {
    fishingPriorities = readFishingPriorities(componentsFor('Fishing')?.get('Action'));
  } catch {
    onWarning('Action', 'Fishing');
  }
  let questProgress;
  try {
    questProgress = readQuestProgress(componentsFor('Quests')?.get('Quests'));
  } catch {
    onWarning('Quests', 'Quests');
  }
  let bonfire;
  try {
    bonfire = readBonfire(componentsFor('Firemaking')?.get('Bonfire'));
  } catch {
    onWarning('Bonfire', 'Firemaking');
  }
  const xpSkillState = {};
  for (const [skill, component, read] of [
    ['Agility', 'Techniques', techniques => techniques &&
      Object.fromEntries([...techniques.regions()].map(([id, row]) => [localId(id), row.double()]))],
    ['Hunting', 'Action', action => readHuntingState(action, componentsFor('Hunting')?.get('Journal'))],
    ['Farming', 'Passive', readFarmingPlots],
    ['GrainMill', 'GrainMill', reader => readGrainMill(reader, componentsFor('Farming')?.get('GrainMillInventory'))],
    ['Ranching', 'Passive', readRanchingState]
  ]) {
    try {
      xpSkillState[skill] = read(componentsFor(skill === 'GrainMill' ? 'Farming' : skill)?.get(component));
    } catch {
      onWarning(component, skill);
    }
  }
  const ranks = {};
  for (const [skill, description] of Object.entries(mastery)) {
    try {
      ranks[skill] = readMastery(componentsFor(skill), levels, description, unlockedPets, astrologyNodes, constellations);
    } catch {
      onWarning('mastery', skill);
    }
  }
  return {
    ...header, levels, skillXp, equipped, skillToolbelt, cookingCharges, ...readBank(bank), ...readShopPurchases(shopReader),
    dungeonCompletions, slayerCompletions, slayerTasks, astrologyNodes, fishingPriorities, recipeStatistics, unlockedPets, ranks, combat,
    questProgress, bonfire,
    xpSkillState,
    currencies: readCurrencies(bankComponents.get('Wallet'), header.currencies),
    date
  };
}

module.exports = { parseHeader, parseProfile, parseCharacterStatistics, MAX_SAVE_BYTES };
