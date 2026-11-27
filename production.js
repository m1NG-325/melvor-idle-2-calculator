const productionKinds = new Set(['Mining', 'Woodcutting', 'Fishing', 'Artisan', 'Cooking', 'Firemaking', 'Herblore', 'Hunting', 'ItemUpgrade']);

function indexProduction(catalog) {
  const producers = new Map();
  const products = new Map();
  const externalSources = new Map();
  const actions = new Map([...catalog.actions, ...(catalog.xpActions ?? []), ...(catalog.itemUpgrades ?? [])]
    .map(action => [action.id, action]));
  for (const action of actions.values()) {
    const outputs = new Set([
      ...(action.rewards ?? []).map(([id]) => id),
      ...(action.fish ?? []).map(([id]) => id),
      ...(action.special ?? []).map(([id]) => id),
      ...(action.hitRewards ?? []).map(([id]) => id),
      ...(action.events ?? []).map(event => event.item),
      ...(action.modeProducts ?? []),
      action.ore?.[0], action.bar, action.stone, action.essence, action.junk
    ]);
    for (const id of outputs) {
      if (!id || !catalog.items[id]) continue;
      if (!productionKinds.has(action.kind) || (action.kind === 'Hunting' && !action.hunt)) {
        if (!externalSources.has(id)) externalSources.set(id, action);
        continue;
      }
      if (!producers.has(id)) producers.set(id, []);
      producers.get(id).push(action);
      const main = action.costs[0]?.[0];
      if (!main) continue;
      if (!products.has(main)) products.set(main, new Set());
      products.get(main).add(id);
    }
  }
  return { producers, products, externalSources };
}

function productionFamily(index, target) {
  const upstream = new Set([target]);
  let root = target;
  while (root) {
    const next = index.producers.get(root)?.[0]?.costs[0]?.[0];
    if (!index.producers.has(next) || upstream.has(next)) break;
    upstream.add(next);
    root = next;
  }
  // Compare the selected product, its ore or other primary material, bars and other products of those inputs.
  const siblings = [...upstream].flatMap(id => [...(index.products.get(id) ?? [])]);
  const directChildren = [...(index.products.get(target) ?? [])];
  const nextStage = directChildren.flatMap(id => [...(index.products.get(id) ?? [])]);
  return [...new Set([...upstream, ...siblings, ...nextStage])];
}

function independentProductionBatches(sources, missing, costOf) {
  const goal = Math.ceil(missing);
  const candidates = sources.filter(({ amount, model }) => Number.isSafeInteger(amount) &&
    !model.inputs.length && !['Hunting', 'Herblore'].includes(model.action.kind));
  if (candidates.length < 2) return [];
  const limit = goal + Math.max(...candidates.map(source => source.amount)) - 1;
  if (limit * candidates.length > 50000) return [];
  const times = new Float64Array(limit + 1).fill(Infinity);
  const costs = new Float64Array(limit + 1).fill(Infinity);
  const previous = new Int32Array(limit + 1).fill(-1);
  const batches = candidates.map(({ model }) => ({ seconds: model.duration(1), cost: costOf(model) }));
  times[0] = costs[0] = 0;
  for (let amount = 0; amount < goal; amount++) {
    if (!Number.isFinite(times[amount])) continue;
    for (const [index, source] of candidates.entries()) {
      const next = amount + source.amount;
      const time = times[amount] + batches[index].seconds;
      const cost = costs[amount] + batches[index].cost;
      if (time < times[next] || (time === times[next] && cost < costs[next])) {
        times[next] = time;
        costs[next] = cost;
        previous[next] = index;
      }
    }
  }
  let best = goal;
  for (let amount = goal + 1; amount <= limit; amount++) {
    if (times[amount] < times[best] || (times[amount] === times[best] && costs[amount] < costs[best])) best = amount;
  }
  if (previous[best] < 0) return [];
  const counts = new Map();
  for (let amount = best; amount > 0;) {
    const source = candidates[previous[amount]];
    counts.set(source.model, (counts.get(source.model) ?? 0) + 1);
    amount -= source.amount;
  }
  return [...counts];
}

function planProduction(catalog, profile, index, target, hours, useStock, evaluateCycle,
  { preview = false, items, sellByproducts = false, keptItems = new Set(), targetQuantity, reservePercent = 0, shopping } = {}) {
  const byQuantity = targetQuantity != null || Boolean(shopping);
  if (target && !index.producers.has(target)) return [];
  if (!shopping && (byQuantity ? !Number.isSafeInteger(targetQuantity) || targetQuantity < 1 || (!target && !items) :
    !Number.isFinite(hours) || hours <= 0)) return [];
  const budget = byQuantity ? Infinity : hours * 3600;
  const models = new Map();
  const modelFor = action => {
    if (!models.has(action.id)) {
      const row = evaluateCycle(action, profile, catalog, { preview });
      if (!row || (!(row.activeHours > 0) && action.kind !== 'ItemUpgrade')) models.set(action.id, null);
      else {
        const output = new Map();
        const randomItems = new Set();
        for (const drop of row.drops) {
          output.set(drop.id, (output.get(drop.id) ?? 0) + drop.quantity);
          if (drop.random ?? !Number.isInteger(drop.quantity)) randomItems.add(drop.id);
        }
        models.set(action.id, { action, output, randomItems, seconds: row.seconds, duration: row.durationForCycles, direct: row.direct,
          inputs: row.inputs, restrictions: row.restrictions ?? [], sacrifice: row.sacrifice, xpForCycles: row.xpForCycles });
      }
    }
    return models.get(action.id);
  };
  const price = id => catalog.items[id]?.price ?? 0;
  const canSell = id => sellByproducts && !profile.keep?.includes(id) && !keptItems.has(id);
  const initial = new Map(useStock ? Object.entries(profile.stock ?? {})
    .filter(([id, count]) => Number.isFinite(count) && count > 0 && !profile.keep?.includes(id)) : []);
  function newState() {
    return { seconds: 0, made: new Map(), supplied: new Map(), bank: new Map(initial), bankUsed: new Map(),
      wallet: new Map(Object.entries(profile.currencies ?? {})), direct: 0, goldCost: 0, bankCost: 0, externalCost: 0, steps: [] };
  }
  function copy(state) {
    return { ...state, made: new Map(state.made), supplied: new Map(state.supplied), bank: new Map(state.bank),
      bankUsed: new Map(state.bankUsed), wallet: new Map(state.wallet), steps: [...state.steps] };
  }
  const roundUp = value => Math.ceil(value - Math.abs(value) * Number.EPSILON * 4);
  const enough = (available, required) => available >= required - Math.abs(required) * Number.EPSILON * 4;
  const inventory = (state, id) => (state.made.get(id) ?? 0) + (state.bank.get(id) ?? 0) + (state.supplied.get(id) ?? 0);
  const saleValue = (state, except) => {
    let total = 0;
    for (const [id, quantity] of state.made) {
      if (id !== except && canSell(id)) total += quantity * price(id);
    }
    return total;
  };
  const bestSource = (state, id, missing, trail, timeLimit, strategy) => {
    if (trail.has(id)) return null;
    const nextTrail = new Set([...trail, id]);
    const needed = inventory(state, id) + missing;
    let best;
    let bestScore = Infinity;
    let bestCost = Infinity;
    const sources = [];
    function consider(candidate) {
      if (!enough(inventory(candidate, id), needed)) return;
      const cost = candidate.bankCost + candidate.goldCost + candidate.externalCost - candidate.direct -
        (sellByproducts ? saleValue(candidate, id) : 0);
      const score = strategy.rate == null ? candidate.seconds : candidate.seconds * strategy.rate + cost;
      const winsTie = strategy.quantityMix ? cost < bestCost : candidate.seconds < best?.seconds;
      if (!best || score < bestScore || (score === bestScore && winsTie)) {
        best = candidate;
        bestScore = score;
        bestCost = cost;
      }
    }
    for (const action of index.producers.get(id) ?? []) {
      const model = modelFor(action);
      const quantity = model?.output.get(id);
      const amount = strategy.quantityMix && model?.randomItems.has(id) ? quantity / (1 + reservePercent / 100) : quantity;
      if (!(amount > 0)) continue;
      sources.push({ model, amount });
      const cycles = Math.max(1, roundUp(missing / amount));
      if (!Number.isSafeInteger(cycles)) continue;
      if (strategy.rate == null && best && state.seconds + model.duration(cycles) > best.seconds) continue;
      const candidate = copy(state);
      if (run(candidate, model, cycles, nextTrail, timeLimit, strategy)) consider(candidate);
    }
    if (strategy.quantityMix && sources.length > 1) {
      const sorted = sources.sort((a, b) => a.model.seconds / a.amount - b.model.seconds / b.amount);
      if (strategy.quantityTrials) {
        const batches = independentProductionBatches(sorted, missing, model => -model.direct -
          [...model.output].reduce((sum, [outputId, amount]) =>
            sum + (outputId !== id && canSell(outputId) ? amount * price(outputId) : 0), 0));
        if (batches.length > 1) {
          const candidate = copy(state);
          if (batches.every(([model, count]) => run(candidate, model, count, nextTrail, timeLimit, strategy))) consider(candidate);
        }
      }
      function fill(candidate, choices, outstanding, trial) {
        for (const { model, amount } of choices) {
          if (enough(missing - outstanding, missing)) break;
          const max = roundUp(outstanding / amount);
          if (!Number.isSafeInteger(max) || max <= 0) continue;
          let low = 1;
          let high = max;
          let partial;
          let cycles = 0;
          while (low <= high) {
            const count = low === 1 && high === max ? max : Math.floor((low + high) / 2);
            const probe = copy(candidate);
            if (run(probe, model, count, nextTrail, timeLimit, trial)) {
              partial = probe;
              cycles = count;
              low = count + 1;
            } else high = count - 1;
          }
          if (!partial) continue;
          Object.assign(candidate, partial);
          outstanding -= cycles * amount;
        }
        if (enough(missing - outstanding, missing)) consider(candidate);
      }
      for (const first of sorted) {
        const others = sorted.filter(source => source !== first);
        fill(copy(state), [first, ...others], missing, strategy);
        const max = roundUp(missing / first.amount) - 1;
        if (!Number.isSafeInteger(max) || max < 1 || !strategy.quantityTrials?.remaining) continue;
        const probes = new Set();
        for (let offset = 0; offset < Math.min(8, max); offset++) {
          probes.add(max - offset);
          probes.add(offset + 1);
        }
        const trial = { ...strategy, quantityTrials: undefined };
        for (const count of probes) {
          if (strategy.quantityTrials.remaining <= 0) break;
          if (best && state.seconds + first.model.duration(count) > best.seconds) continue;
          strategy.quantityTrials.remaining--;
          const candidate = copy(state);
          if (run(candidate, first.model, count, nextTrail, timeLimit, trial)) {
            fill(candidate, others, missing - count * first.amount, trial);
          }
        }
      }
    }
    strategy.alternatives ||= sources.length > 1;
    if (strategy.mix && sources.length > 1) {
      const secondsPerItem = source => source.model.seconds / source.amount;
      const costPerItem = source => (source.model.inputs.reduce((sum, input) => sum + input.value, 0) -
        source.model.direct) / source.amount;
      const fast = sources.reduce((a, b) => secondsPerItem(a) <= secondsPerItem(b) ? a : b);
      const slower = sources.filter(source => source !== fast)
        .sort((a, b) => costPerItem(a) - costPerItem(b)).slice(0, 2);
      const single = { ...strategy, mix: false };
      for (const other of slower) {
        const { model, amount } = other;
        const max = roundUp(missing / amount) - 1;
        const extra = model.seconds - amount * secondsPerItem(fast);
        const fit = extra > 0 ? Math.floor((timeLimit - state.seconds - missing * secondsPerItem(fast)) / extra) : max;
        const samples = new Set([1, Math.floor(max / 2), max, fit, fit - 1]);
        for (const cycles of samples) {
          if (cycles < 1 || cycles > max) continue;
          const candidate = copy(state);
          if (!run(candidate, model, cycles, nextTrail, timeLimit, single)) continue;
          const remaining = needed - inventory(candidate, id);
          if (remaining <= 0 || run(candidate, fast.model, roundUp(remaining / fast.amount), nextTrail, timeLimit, single)) {
            consider(candidate);
          }
        }
      }
    }
    return best;
  };
  function run(state, model, cycles, trail, timeLimit, strategy) {
    const seconds = model.duration(cycles);
    if (!Number.isFinite(seconds) || state.seconds + seconds > timeLimit && !enough(timeLimit, state.seconds + seconds)) return false;
    const used = [];
    const held = [];
    const restrictions = [...model.restrictions];
    // Reserve ingredients already on hand before a nested recipe can spend them.
    const inputs = model.inputs.map(input => ({
      input, ready: enough(input.currency ? state.wallet.get(input.id) ?? 0 : inventory(state, input.id),
        input.qty + input.quantity * (cycles - 1))
    })).sort((a, b) => Number(b.ready) - Number(a.ready));
    for (const { input } of inputs) {
      const { id, qty, currency } = input;
      const consumed = input.quantity * cycles;
      // A full ingredient batch must be available for the final start, even with preservation.
      const required = qty + input.quantity * (cycles - 1);
      if (currency) {
        let available = state.wallet.get(id) ?? 0;
        if (!enough(available, required)) {
          if (!preview) return false;
          restrictions.push({ type: 'currency', id, quantity: required - available });
          available = required;
        }
        state.wallet.set(id, Math.max(0, available - required));
        if (required > consumed) held.push({ id, wallet: required - consumed });
        if (id === 'GoldPieces') state.goldCost += consumed;
      } else {
        const free = () => inventory(state, id);
        if (!enough(free(), required)) {
          const missing = required - free();
          // Keep the cheapest route intact so the search can reduce its batch size to fit the deadline.
          const sourceLimit = strategy.unbounded ? Infinity : timeLimit - seconds;
          const supply = bestSource(state, id, missing, trail, sourceLimit, strategy);
          if (supply) {
            Object.assign(state, supply);
          } else if (preview && (!index.producers.has(id) || (timeLimit === Infinity && strategy.rate == null)) && catalog.items[id]) {
            state.supplied.set(id, (state.supplied.get(id) ?? 0) + missing);
            state.externalCost += missing * price(id);
            const sacrificedBy = index.producers.get(id)?.find(source =>
              modelFor(source)?.sacrifice?.items.some(row => row.id === id));
            const action = index.externalSources?.get(id) ?? sacrificedBy;
            const source = action && evaluateCycle(action, profile, catalog, { requirementsOnly: true });
            state.steps.push({ item: id, action, seconds: null, used: [],
              output: [{ id, quantity: missing }], restrictions: [{ type: 'external' },
                ...(source?.restrictions ?? []), ...(sacrificedBy ? [{ type: 'sacrifice' }] : [])] });
          } else return false;
          if (!enough(free(), required)) return false;
        }
        const generated = Math.min(state.made.get(id) ?? 0, required);
        const fromBank = Math.min(state.bank.get(id) ?? 0, required - generated);
        const fromSupply = Math.max(0, required - generated - fromBank);
        if (generated) state.made.set(id, (state.made.get(id) ?? 0) - generated);
        if (fromBank) state.bank.set(id, (state.bank.get(id) ?? 0) - fromBank);
        if (fromSupply) state.supplied.set(id, Math.max(0, (state.supplied.get(id) ?? 0) - fromSupply));
        const usedFromBank = Math.max(0, Math.min(fromBank, consumed - generated));
        if (usedFromBank) {
          state.bankUsed.set(id, (state.bankUsed.get(id) ?? 0) + usedFromBank);
          state.bankCost += usedFromBank * price(id);
        }
        held.push({ id, made: Math.max(0, generated - consumed), bank: fromBank - usedFromBank,
          supplied: Math.min(fromSupply, Math.max(0, required - consumed)) });
      }
      if (consumed > 0) used.push({ id, quantity: consumed, currency });
    }
    if (state.seconds + seconds > timeLimit && !enough(timeLimit, state.seconds + seconds)) return false;
    for (const { id, made, bank, supplied, wallet } of held) {
      if (made) state.made.set(id, (state.made.get(id) ?? 0) + made);
      if (bank) state.bank.set(id, (state.bank.get(id) ?? 0) + bank);
      if (supplied) state.supplied.set(id, (state.supplied.get(id) ?? 0) + supplied);
      if (wallet) state.wallet.set(id, (state.wallet.get(id) ?? 0) + wallet);
    }
    const output = [...model.output].map(([id, quantity]) => ({ id, quantity: quantity * cycles }));
    for (const row of output) state.made.set(row.id, (state.made.get(row.id) ?? 0) + row.quantity);
    const direct = model.direct * cycles;
    state.direct += direct;
    state.wallet.set('GoldPieces', (state.wallet.get('GoldPieces') ?? 0) + direct);
    state.seconds += seconds;
    state.steps.push({ action: model.action, cycles, seconds, used, output, restrictions, randomOutput: model.randomItems.size > 0,
      xp: model.xpForCycles?.(cycles) ?? 0,
      sacrificeGp: (model.sacrifice?.gp ?? 0) * cycles });
    return true;
  }
  function solve(item, action) {
    const model = action && modelFor(action);
    const sacrificed = model?.sacrifice?.items.find(row => row.id === item);
    const output = model?.output.get(item);
    if (!byQuantity && !(output > 0) && !sacrificed) return null;
    let result;
    let bestNet = -Infinity;
    let bestCycles;
    const fastest = { rate: null, alternatives: false };
    function search(strategy) {
      const maximum = model.seconds > 0 ? Math.floor(budget / model.seconds) : preview ? 1 : Number.MAX_SAFE_INTEGER;
      const tested = new Map();
      function assess(cycles) {
        if (cycles < 1 || cycles > maximum) return false;
        if (tested.has(cycles)) return tested.get(cycles);
        const state = newState();
        const fits = run(state, model, cycles, new Set([item]), budget, strategy);
        tested.set(cycles, fits);
        if (!fits) return false;
        const net = (state.made.get(item) ?? 0) * price(item) + state.direct - state.goldCost -
          state.bankCost - state.externalCost + (sellByproducts ? saleValue(state, item) : 0);
        if (net > bestNet || (net === bestNet && state.seconds < result.seconds)) {
          result = state;
          bestNet = net;
          bestCycles = cycles;
        }
        return true;
      }
      if (maximum <= 128) {
        for (let cycles = 1; cycles <= maximum; cycles++) assess(cycles);
        return;
      }
      let low = 1;
      let high = maximum;
      if (model.seconds === 0) {
        high = 1;
        while (high < maximum && assess(high)) high = Math.min(maximum, high * 2);
        low = Math.max(1, Math.floor(high / 2));
      }
      while (low <= high) {
        const cycles = low + Math.floor((high - low) / 2);
        if (assess(cycles)) low = cycles + 1;
        else high = cycles - 1;
      }
      // Maximum throughput and maximum net GP can differ when inventory runs out.
      for (const input of model.inputs) {
        if (!(input.quantity > 0)) continue;
        const available = input.currency ? profile.currencies?.[input.id] ?? 0 : initial.get(input.id) ?? 0;
        const lastStockBatch = 1 + Math.floor((available - input.qty) / input.quantity);
        for (const offset of [-2, -1, 0, 1, 2]) assess(lastStockBatch + offset);
      }
      for (let cycles = 1; cycles <= high; cycles *= 2) assess(cycles);
      for (let fraction = 1; fraction < 16; fraction++) assess(Math.floor(high * fraction / 16));
      if (target || items) {
        const center = bestCycles;
        for (let offset = -8; center != null && offset <= 8; offset++) assess(center + offset);
      }
    }
    if (byQuantity) {
      result = bestSource(newState(), item, targetQuantity, new Set(), budget, {
        ...fastest, quantityMix: true, quantityTrials: { remaining: 256 }
      });
    } else {
      search(fastest);
      if (fastest.alternatives) {
        search({ rate: 0, unbounded: true });
        const grossPerSecond = (sacrificed ? model.sacrifice.gp : output * price(item)) / model.seconds;
        if (Number.isFinite(grossPerSecond) && grossPerSecond > 0) search({ rate: grossPerSecond / 4 });
        search({ rate: 0, mix: true });
      }
    }
    if (!result && preview && !byQuantity) {
      const oneBatch = newState();
      if (run(oneBatch, model, 1, new Set([item]), Infinity, fastest)) result = oneBatch;
    }
    if (!result) return null;
    const finalStep = result.steps.at(-1);
    const sacrifice = !byQuantity && sacrificed && { quantity: sacrificed.quantity * finalStep.cycles, gp: finalStep.sacrificeGp };
    const quantity = sacrifice?.quantity ?? (result.made.get(item) ?? 0);
    const sales = sacrifice ? 0 : quantity * price(item);
    const materials = result.bankCost;
    const byproducts = [...result.made].filter(([id, amount]) => id !== item && amount > 0 && price(id) > 0)
      .map(([id, quantity]) => ({ id, quantity, value: canSell(id) ? quantity * price(id) : 0 }));
    const byproductSales = byproducts.reduce((sum, row) => sum + row.value, 0);
    const net = sales + byproductSales + result.direct - result.goldCost - materials - result.externalCost;
    if (result.seconds > budget && !enough(budget, result.seconds)) {
      let elapsed = 0;
      for (const step of result.steps) {
        elapsed += step.seconds ?? 0;
        if (elapsed > budget && !enough(budget, elapsed)) step.restrictions.push({ type: 'time' });
      }
    }
    const elapsedHours = byQuantity ? result.seconds / 3600 : Math.max(hours, result.seconds / 3600);
    return { item, quantity, targetQuantity, reservePercent, budgetSeconds: byQuantity ? null : budget,
      sales, byproducts, byproductSales, materials, net, sacrifice,
      netPerHour: elapsedHours > 0 ? net / elapsedHours : null, seconds: result.seconds,
      direct: result.direct, goldCost: result.goldCost, steps: result.steps, bankUsed: result.bankUsed, externalCost: result.externalCost, preview };
  }
  if (shopping) {
    let state = newState();
    const missing = [];
    const demand = new Map();
    for (const [id, quantity] of shopping) {
      const reserved = Math.min(quantity, profile.stock?.[id] ?? 0);
      state.bank.set(id, Math.max(0, (state.bank.get(id) ?? 0) - reserved));
      if (quantity > reserved) demand.set(id, quantity - reserved);
    }
    for (const [id, quantity] of demand) {
      const shortfall = quantity - inventory(state, id);
      const next = shortfall > 1e-9 ? bestSource(state, id, shortfall, new Set(), Infinity, { quantityMix: true }) : state;
      if (!next) { missing.push(id); continue; }
      state = next;
      const made = Math.min(state.made.get(id) ?? 0, quantity);
      state.made.set(id, (state.made.get(id) ?? 0) - made);
      state.bank.set(id, Math.max(0, (state.bank.get(id) ?? 0) - (quantity - made)));
    }
    return { steps: state.steps, missing, shoppingTargets: [...demand.keys()], targetQuantity: 0 };
  }
  const targets = items ?? (target ? (preview || byQuantity ? [target] : productionFamily(index, target)) : [...index.producers]
    .filter(([, actions]) => actions.some(action => action.costs.length)).map(([id]) => id));
  const results = [];
  for (const item of targets) {
    let best = byQuantity ? solve(item) : null;
    for (const action of byQuantity ? [] : index.producers.get(item) ?? []) {
      const plan = solve(item, action);
      if (plan && (!best || plan.net > best.net || (plan.net === best.net && plan.seconds < best.seconds))) best = plan;
    }
    if (best || target || items) results.push(best ?? { item });
  }
  return results.sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity) || Number(b.item === target) - Number(a.item === target));
}

function compareProduction(catalog, profile, index, items, hours, useStock, evaluateCycle, existing = [], saleOptions = {}) {
  const unique = [...new Set(items)].filter(id => index.producers.has(id));
  const plans = new Map(existing.filter(plan => plan.steps).map(plan => [plan.item, plan]));
  const missing = unique.filter(id => !plans.has(id));
  const actual = planProduction(catalog, profile, index, '', hours, useStock, evaluateCycle, { ...saleOptions, items: missing });
  for (const plan of actual) if (plan.steps) plans.set(plan.item, plan);
  const remaining = missing.filter(id => !plans.has(id));
  const previews = planProduction(catalog, profile, index, '', hours, useStock, evaluateCycle,
    { ...saleOptions, items: remaining, preview: true });
  for (const plan of previews) if (plan.steps) plans.set(plan.item, plan);
  const status = plan => !plan.steps ? 2 : plan.preview ? 1 : 0;
  return unique.map(item => plans.get(item) ?? { item }).sort((a, b) =>
    status(a) - status(b) || (saleOptions.targetQuantity != null ? (a.seconds ?? Infinity) - (b.seconds ?? Infinity) : 0) ||
    (b.net ?? -Infinity) - (a.net ?? -Infinity));
}

if (typeof module !== 'undefined') module.exports = { indexProduction, planProduction, compareProduction, productionTimedQueueSteps };

let productionView;

function initProduction(catalog) {
  productionView = { index: indexProduction(catalog), catalog, plans: [] };
  const target = byId('productionTarget');
  target.replaceChildren(new Option('', ''), ...[...productionView.index.producers.keys()].map(id => new Option(id, id)));
  localizeProduction();
  const input = byId('productionTargetInput');
  input.addEventListener('focus', () => input.select());
  input.addEventListener('click', () => {
    if (input.value === productionTargetName(target.value)) input.select();
  });
  input.addEventListener('input', event => {
    if (event.isComposing) return;
    const id = suggestionKey(byId('productionTargets').options, input.value);
    if (id === undefined) return;
    target.value = id;
    syncProductionTarget(id);
    productionView.detail = undefined;
    renderProduction();
  });
  input.addEventListener('blur', () => syncProductionTarget(target.value));
  byId('productionOptions').addEventListener('submit', event => event.preventDefault());
  for (const id of ['productionMode', 'productionHours', 'productionQuantity', 'productionReserve',
    'productionStock', 'productionSellByproducts']) byId(id).addEventListener('input', () => {
    productionView.detail = undefined;
    renderProduction();
  });
  byId('productionPlan').addEventListener('change', event => {
    productionView.detail = event.currentTarget.value;
    renderProductionDetail(productionView.plans.find(plan => plan.item === productionView.detail));
  });
  byId('addProductionComparison').addEventListener('click', () => {
    if (productionView.index.producers.has(target.value)) setProductionComparison([...productionComparisonItems(), target.value]);
  });
  byId('clearProductionComparison').addEventListener('click', () => setProductionComparison([]));
}

function productionComparisonItems() {
  try {
    const saved = JSON.parse(byId('productionComparisonItems').value);
    return Array.isArray(saved) ? [...new Set(saved)].filter(id => productionView.index.producers.has(id)) : [];
  } catch {
    return [];
  }
}

function setProductionComparison(items) {
  byId('productionComparisonItems').value = JSON.stringify([...new Set(items)]);
  renderProduction();
  queuePreferences();
}

function productionTargetName(id) {
  return id ? gameName(productionView.catalog.items[id]) ?? t('未知物品') : t('自动推荐');
}

function syncProductionTarget(id) {
  const input = byId('productionTargetInput');
  const option = [...byId('productionTargets').options].find(choice => choice.dataset.key === id);
  input.value = option?.value ?? productionTargetName(id);
  input.dataset.selectedSuggestion = input.value;
}

function localizeProduction() {
  if (!productionView) return;
  const options = [...productionView.index.producers.keys()].map(id => ({ name: productionTargetName(id), id }));
  options.sort((a, b) => a.name.localeCompare(b.name, uiLocale()));
  options.unshift({ name: productionTargetName(''), id: '' });
  byId('productionTargets').replaceChildren(...localizedSuggestions(options.map(({ name, id }) => {
    const item = productionView.catalog.items[id];
    return { key: id, name, aliases: [id && 'MelvorBase:' + id, item?.name,
      ...Object.values(item?.names ?? {}), traditionalText(item?.names?.zh ?? item?.name)] };
  })));
  syncProductionTarget(byId('productionTarget').value);
}

function renderProduction() {
  if (!productionView || byId('productionPage').hidden) return;
  const status = byId('productionStatus');
  const results = byId('productionResults');
  const hours = byId('productionHours');
  const quantity = byId('productionQuantity');
  const reserve = byId('productionReserve');
  const byQuantity = byId('productionMode').value === 'quantity';
  byId('productionHoursField').hidden = hours.disabled = byQuantity;
  byId('productionQuantityField').hidden = quantity.disabled = !byQuantity;
  byId('productionReserveField').hidden = reserve.disabled = !byQuantity;
  const detail = byId('productionDetail');
  const target = byId('productionTarget').value;
  const comparisonItems = productionComparisonItems();
  byId('addProductionComparison').disabled = !target || comparisonItems.includes(target);
  const comparison = byId('productionComparison');
  comparison.hidden = !comparisonItems.length;
  byId('productionComparisonBasis').textContent = t(byQuantity ? '各方案按同一目标数量计算，分别使用相同的起始库存。' :
    '各方案使用同一挂机时长，并分别从相同的起始库存计算。');
  if (!profile?.characterId || !(byQuantity ? quantity : hours).checkValidity() || !reserve.checkValidity()) {
    status.textContent = t(!profile?.characterId ? '选择角色存档后可估算连锁产线。' :
      !reserve.checkValidity() ? '请输入 0 到 100 的备料余量。' :
        byQuantity ? '请输入有效的目标数量。' : '请输入有效的挂机时长。');
    status.hidden = false;
    results.hidden = detail.hidden = true;
    renderProductionComparison(comparisonItems.map(item => ({ item })), false, byQuantity);
    return;
  }
  const { catalog, index } = productionView;
  const useStock = byId('productionStock').checked;
  const saleOptions = { sellByproducts: byId('productionSellByproducts').checked, keptItems: keptDrops,
    targetQuantity: byQuantity ? quantity.valueAsNumber : undefined, reservePercent: byQuantity ? reserve.valueAsNumber : 0 };
  const { date, name, combat, ...planningProfile } = profile;
  const autoKey = !target && !byQuantity ? JSON.stringify([
    planningProfile, hours.valueAsNumber, useStock, saleOptions.sellByproducts, [...keptDrops].sort()
  ]) : null;
  const matches = autoKey && productionView.auto?.key === autoKey;
  const plans = matches ? productionView.auto.plans :
    planProduction(catalog, profile, index, target, hours.valueAsNumber, useStock, productionCycle, saleOptions)
      .filter(plan => plan.steps);
  if (autoKey && !matches) productionView.auto = { key: autoKey, plans };
  let selected = target ? plans.find(plan => plan.item === target) : plans[0];
  if (target && !selected) {
    selected = planProduction(catalog, profile, index, target, hours.valueAsNumber, useStock, productionCycle,
      { ...saleOptions, preview: true })
      .find(plan => plan.steps);
    if (selected) plans.unshift(selected);
  }
  const compared = compareProduction(catalog, profile, index, comparisonItems, hours.valueAsNumber, useStock, productionCycle, plans, saleOptions);
  const detailPlans = [...new Map([...compared.filter(plan => plan.steps), ...plans].map(plan => [plan.item, plan])).values()];
  productionView.plans = detailPlans;
  const active = detailPlans.find(plan => plan.item === productionView.detail) ?? selected;
  status.textContent = !selected ? t(target ? '当前无法估算所选物品的完整产线。' :
    byQuantity ? '请选择要生产的目标物品。' : '在所选时长和库存下暂无可行产线。') : '';
  status.hidden = !status.textContent;
  results.hidden = !selected;
  if (selected) {
    byId('productionHeading').textContent = t(selected.preview ? '目标产线 · 条件预估' : target ? '目标物品产线' : '已比较产线中的最高收益');
    byId('productionWinner').textContent = gameName(catalog.items[selected.item]);
    const totalXp = selected.steps.reduce((sum, step) => sum + (step.xp ?? 0), 0);
    byId('productionMetrics').replaceChildren(...[
      ['预计净收益', formatGp(selected.net)], ['净 GP/小时', selected.netPerHour == null ? '—' : fullNumber(selected.netPerHour)],
      [selected.sacrifice ? '预计献祭数量' : '预计数量', decimals.format(selected.quantity)],
      ['产线耗时', formatDuration(selected.seconds / 3600)],
      ...(totalXp > 0 && selected.seconds > 0 && selected.steps.every(step => step.seconds != null)
        ? [['产线总 XP／小时', formatXp(totalXp * 3600 / selected.seconds)]] : [])
    ].map(([label, value]) => {
      const metric = create('div', t(label));
      metric.append(create('strong', value));
      return metric;
    }));
    byId('productionTimeRows').replaceChildren(...selected.steps.map(step => {
      const row = create('li');
      row.append(create('strong', productionStepName(step)), productionStepTiming(step));
      return row;
    }));
  }
  const options = byId('productionPlan');
  options.replaceChildren(...detailPlans.map(({ item, net, preview }) => new Option(
    [gameName(catalog.items[item]), formatGp(net), preview && t('条件预估')].filter(Boolean).join(' · '), item)));
  options.value = active?.item ?? '';
  byId('productionAlternatives').hidden = detailPlans.length < 2 && (Boolean(selected) || !detailPlans.length);
  renderProductionComparison(compared, true, byQuantity);
  renderProductionDetail(active);
}

function renderProductionComparison(plans, canCalculate, byQuantity) {
  const hint = byId('productionComparisonHint');
  hint.hidden = plans.length >= 2;
  const best = plans.length >= 2 ? plans.find(plan => plan.steps && !plan.preview) : undefined;
  byId('productionComparisonRows').replaceChildren(...plans.map(plan => {
    const row = create('tr');
    const name = productionTargetName(plan.item);
    const item = create('th', name);
    item.scope = 'row';
    if (plan === best) item.append(create('small', t(byQuantity ? '可执行方案中耗时最短' : '可执行方案中收益最高'), 'production-compare-best'));
    const hasPlan = Boolean(plan.steps);
    const state = hasPlan ? (plan.preview ? '条件预估' : '当前可执行') : (canCalculate ? '暂无完整预估' : '待计算');
    row.append(item, create('td', [t(state), plan.sacrifice && t('献祭砧台')].filter(Boolean).join(' · '),
      plan.preview ? 'production-restriction' : undefined),
      ...[hasPlan ? decimals.format(plan.quantity) : '—', hasPlan ? formatDuration(plan.seconds / 3600) : '—',
        hasPlan && plan.netPerHour != null ? fullNumber(plan.netPerHour) : '—', hasPlan ? formatGp(plan.net) : '—']
        .map(value => create('td', value)));
    const actions = create('td');
    if (hasPlan) {
      const show = create('button', t('查看步骤'), 'production-compare-action');
      show.type = 'button';
      show.setAttribute('aria-label', t('查看{name}的步骤', { name }));
      show.addEventListener('click', () => {
        productionView.detail = plan.item;
        byId('productionPlan').value = plan.item;
        renderProductionDetail(plan);
        byId('productionDetail').scrollIntoView?.({ block: 'nearest' });
      });
      actions.append(show);
    }
    const remove = create('button', t('移除'), 'production-compare-action');
    remove.type = 'button';
    remove.setAttribute('aria-label', t('从对比中移除{name}', { name }));
    remove.addEventListener('click', () => setProductionComparison(productionComparisonItems().filter(id => id !== plan.item)));
    actions.append(remove);
    row.append(actions);
    return row;
  }));
}

function productionRestrictionText(restriction, catalog) {
  const skill = id => skillName(id, catalog.xpSkills ?? catalog.skills);
  switch (restriction.type) {
    case 'excluded': return t('此行动已排除');
    case 'external': return t('需另行取得材料');
    case 'sacrifice': return t('开启献祭砧台时，此成品不会入库');
    case 'time': return t('超过所选时长');
    case 'currency': return t('缺少 {quantity} {currency}', {
      quantity: fullNumber(restriction.quantity), currency: shopCurrencyName(restriction.id)
    });
    case 'skill': return t('{skill}尚不可用', { skill: skill(restriction.skill) });
    case 'requirement':
      return restriction.clause.map(req => req.type === 'Level'
        ? t('需{skill} {level} 级', { skill: skill(req.skill), level: fullNumber(req.level) })
        : t('未满足解锁条件')).join(' / ');
  }
}

function productionStepName({ action, item }) {
  if (!action) return t('准备 {item}', { item: questItem(item) });
  if (action.kind === 'ItemUpgrade') return t('升级 {item}', { item: questItem(action.item) });
  return skillName(action.skill, productionView.catalog.xpSkills) + ' · ' + gameName(action);
}

function productionStepTiming(step) {
  const body = create('div', undefined, 'production-step-time');
  if (step.seconds == null) {
    body.append(create('small', t('另行准备，耗时未计入')));
    return body;
  }
  const time = step.seconds ? formatXpDuration(step.seconds / 3600) : t('即时');
  body.append(create('small', t('本步骤耗时 {time}', { time })));
  if (step.cycles > 0) {
    body.append(create('small', t('预计执行 {count} 次 · 平均每次 {time}', {
      count: fullNumber(step.cycles), time: t('{value} 秒', { value: expectedQuantity(step.seconds / step.cycles) })
    })));
    const products = scale => step.output.map(({ id, quantity }) => t('{item} × {quantity}', {
      item: questItem(id), quantity: expectedQuantity(quantity * scale)
    })).join(' · ');
    if (step.output.length) {
      body.append(create('small', t('平均每次产出 {items}', { items: products(1 / step.cycles) })));
      if (step.seconds > 0) body.append(create('small', t('预计每小时产出 {items}', { items: products(3600 / step.seconds) })));
    }
    if (step.xp > 0) body.append(create('small', t('本步骤 {xp} XP · 每小时 {rate} XP', {
      xp: formatXp(step.xp), rate: step.seconds > 0 ? formatXp(step.xp * 3600 / step.seconds) : '—'
    })));
  }
  return body;
}

function productionTimedQueueSteps(plan) {
  const { steps, budgetSeconds, seconds } = plan;
  if (!(seconds > 0) || !Number.isFinite(seconds) || !Number.isFinite(budgetSeconds) || !steps.length ||
    steps.some(step => !(step.seconds > 0) || !Number.isFinite(step.seconds))) return [];
  const budget = Math.floor(budgetSeconds / 60 + 1e-9);
  if (steps.length > budget) return [];
  const minutes = Math.min(budget, Math.max(steps.length, Math.round(seconds / 60)));
  const shares = steps.map(step => {
    const ideal = step.seconds / 60;
    return { key: step.action?.id, minutes: Math.max(1, Math.round(ideal)), ideal };
  });
  let unassigned = minutes - shares.reduce((sum, step) => sum + step.minutes, 0);
  while (unassigned) {
    const change = Math.sign(unassigned);
    let best;
    let lowestError = Infinity;
    for (const step of shares) {
      if (step.minutes + change < 1) continue;
      const error = Math.abs(step.minutes + change - step.ideal) - Math.abs(step.minutes - step.ideal);
      if (error < lowestError) {
        best = step;
        lowestError = error;
      }
    }
    best.minutes += change;
    unassigned -= change;
  }
  return shares.map(({ key, minutes }) => ({ key, minutes }));
}

function productionQueueSteps(plan) {
  if (!plan) return [];
  if (plan.targetQuantity == null) return productionTimedQueueSteps(plan);
  const consumedTarget = plan.steps.reduce((total, step) => total + step.used.reduce((used, row) =>
    used + (!row.currency && row.id === plan.item ? row.quantity : 0), 0), 0);
  let remaining = plan.targetQuantity + Math.ceil(consumedTarget);
  return plan.steps.flatMap((step, index) => {
    const key = step.action?.id;
    const target = actionQueue.targets.get(key);
    const minutes = Math.ceil(step.seconds / 60);
    const needed = new Set(plan.steps.slice(index + 1).flatMap(next => next.used.map(row => row.id)));
    for (const id of plan.shoppingTargets ?? [plan.item]) needed.add(id);
    const products = step.output.filter(row => needed.has(row.id));
    if (products.length === 1 && queueGoalItems('item', target).includes(products[0].id)) {
      const { id, quantity } = products[0];
      let value = Math.ceil(quantity - Math.abs(quantity) * Number.EPSILON * 4);
      if (id === plan.item) {
        value = Math.min(remaining, value);
        remaining -= value;
        if (!value) return [];
      }
      return [{ key, minutes: 0, goal: { type: 'item', item: id, value } }];
    }
    const output = products.find(row => row.id === plan.item);
    if (output) remaining = Math.max(0, remaining - Math.floor(output.quantity));
    if (recipeGoalAvailable(target) && Number.isInteger(step.cycles)) {
      return [{ key, minutes: 0, goal: { type: 'recipes', value: step.cycles } }];
    }
    return [{ key, minutes: minutes || NaN }];
  });
}

function renderProductionDetail(plan) {
  const queueButton = byId('productionToQueue');
  const queueSteps = productionQueueSteps(plan);
  queueButton.hidden = plan?.preview || !queueSteps.length || !queueSteps.every(validQueueStep);
  const queueNote = byId('productionQueueNote');
  let queueNotice = '';
  if (!queueButton.hidden && plan.targetQuantity == null) {
    const minutes = queueSteps.reduce((sum, step) => sum + step.minutes, 0);
    queueNotice = t('队列按整分钟执行，合计 {time}。各步骤到时切换。', { time: formatDuration(minutes / 60) });
  } else if (!queueButton.hidden && plan.reservePercent > 0) {
    queueNotice = t('含备料的预计产量为 {expected}，队列目标为 {target}。耗时和收益按预计产量计算。', {
      expected: expectedQuantity(plan.quantity), target: fullNumber(plan.targetQuantity)
    });
  } else if (plan && !plan.preview && plan.targetQuantity == null && plan.steps.every(step => step.seconds > 0) &&
    plan.steps.length > Math.floor(plan.budgetSeconds / 60 + 1e-9)) {
    queueNotice = t('时长不足以给队列的每一步分配至少 1 分钟。');
  }
  queueNote.textContent = queueNotice;
  queueNote.hidden = !queueNotice;
  queueButton.onclick = () => {
    if (!appendQueuePlan(queueSteps)) byId('productionStatus').textContent =
      t(queueBusy() ? '挂机中，队列已锁定。' : '队列最多可添加 200 步。');
  };
  const detail = byId('productionDetail');
  detail.hidden = !plan && byId('productionAlternatives').hidden;
  byId('productionPlanBody').hidden = !plan;
  if (!plan) return;
  const { catalog } = productionView;
  const itemName = id => gameName(catalog.items[id]) ?? t('未知物品');
  const quantities = rows => rows.map(({ id, quantity, currency }) => t('{item} × {quantity}', {
    item: currency ? shopCurrencyName(id) : itemName(id),
    quantity: currency && id === 'GoldPieces' ? fullNumber(quantity) : expectedQuantity(quantity)
  })).join(' · ');
  byId('productionDetailTitle').textContent = t('{name}的产线', { name: itemName(plan.item) });
  const chainXp = new Map();
  for (const step of plan.steps) if (step.xp > 0 && step.action?.skill) {
    const skill = step.action.skill;
    chainXp.set(skill, (chainXp.get(skill) ?? 0) + step.xp);
  }
  byId('productionXp').hidden = !chainXp.size || !(plan.seconds > 0) || plan.steps.some(step => step.seconds == null);
  byId('productionXp').textContent = plan.seconds > 0 ? t('按整条产线耗时计算经验／小时：{rates}', {
    rates: [...chainXp].map(([skill, xp]) => skillName(skill, catalog.xpSkills) + ' ' + formatXp(xp * 3600 / plan.seconds)).join(' · ')
  }) : '';
  const notice = byId('productionPreview');
  const external = plan.steps.some(step => step.restrictions.some(r => r.type === 'external'));
  const overTime = plan.steps.some(step => step.restrictions.some(r => r.type === 'time'));
  notice.hidden = !plan.preview;
  byId('productionRandomNotice').hidden = !plan.steps.some(step => step.randomOutput);
  byId('productionRandomNotice').textContent = t('随机步骤按平均产量和耗时估算，实际结果会波动。');
  notice.textContent = [
    t('以下收益以解除标注限制为前提。'),
    external && t('另行取得的材料按游戏售价扣除，取得时间未计入。'),
    overTime && t('一批所需时间超过所选时长，以下显示最小一批。')
  ].filter(Boolean).join(' ');
  byId('productionRevenue').textContent = [
    plan.direct > 0 && t('直接 GP {value}', { value: fullNumber(plan.direct) }),
    plan.goldCost > 0 && t('金币消耗 {value} GP', { value: fullNumber(plan.goldCost) }),
    t('已用仓库材料价值 {value} GP', { value: fullNumber(plan.materials) }),
    external && t('另需材料价值 {value} GP', { value: fullNumber(plan.externalCost) }),
    plan.byproductSales > 0 && t('副产物收入 {value} GP', { value: fullNumber(plan.byproductSales) })
  ].filter(Boolean).join(' · ');
  const supplies = [...plan.bankUsed].map(([id, quantity]) => ({ id, quantity }));
  byId('productionBank').textContent = supplies.length
    ? t('取自仓库：{items}', { items: quantities(supplies) }) : '';
  const byproducts = byId('productionByproducts');
  byproducts.hidden = !plan.byproducts.length;
  byId('productionByproductRows').replaceChildren(...plan.byproducts.map(row => create('li',
    quantities([row]) + ' · ' + (row.value > 0 ? formatGp(row.value) : t('保留')))));
  const sale = create('tr', undefined, 'production-sale');
  sale.append(...[t(plan.sacrifice ? '献祭 {item}' : '出售 {item}', { item: itemName(plan.item) }), '—', '—',
    quantities([{ id: plan.item, quantity: plan.quantity }]),
    formatGp(plan.sacrifice?.gp ?? plan.sales)].map(value => create('td', value)));
  const steps = byId('productionSteps');
  const expanded = new Set([...steps.querySelectorAll('details[open]')].map(row => row.dataset.step));
  steps.replaceChildren(...plan.steps.map((step, index) => {
    const row = create('tr');
    const time = create('td', '—');
    if (step.seconds != null) {
      const breakdown = create('details', undefined, 'production-step-details');
      breakdown.dataset.step = [plan.item, step.action?.id, index].join(':');
      breakdown.open = expanded.has(breakdown.dataset.step);
      const duration = step.seconds === 0 ? t('即时') : formatDuration(step.seconds / 3600);
      breakdown.append(create('summary', duration), productionStepTiming(step));
      time.replaceChildren(breakdown);
    }
    const flags = [...new Set(step.restrictions.map(restriction => productionRestrictionText(restriction, catalog)))];
    row.append(create('td', productionStepName(step)), create('td', flags.join(' · ') || '—', flags.length ? 'production-restriction' : undefined), time,
      create('td', quantities(step.used) || '—'), create('td', [
        step.sacrificeGp > 0 && t('献祭折现 {value} GP', { value: fullNumber(step.sacrificeGp) }),
        quantities(step.output)
      ].filter(Boolean).join(' · ') || '—'));
    return row;
  }), sale);
}
