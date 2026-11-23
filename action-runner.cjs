const { setTimeout: delay } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const { directQueueSkills } = require('./game-bridge.cjs');

function createActionRunner(bridge, targets, { wait = delay, checkEvery = 1500 } = {}) {
  let controller;
  let status = { state: 'idle', skills: directQueueSkills };
  const setStatus = (state, detail = {}) => { status = { state, skills: directQueueSkills, ...detail }; };

  async function run(steps, character, characterId, repeat, signal) {
    setStatus('connecting');
    await bridge.connect(signal);
    let ranStep;
    do {
      ranStep = false;
      for (const [index, step] of steps.entries()) {
        const stepNumber = index + 1;
        const lease = randomUUID();
        let mayOwnAction = false;
        let started = false;
        try {
          setStatus('switching', { step: stepNumber });
          while (true) {
            signal.throwIfAborted();
            mayOwnAction = true;
            const result = await bridge.send('start', { ...step, character, characterId, lease }, signal);
            if (result === 'started') {
              started = ranStep = true;
              break;
            }
            mayOwnAction = false;
            if (result === 'completed') break;
            setStatus(result, { step: stepNumber });
            if (!['character-required', 'character-mismatch', 'paused'].includes(result)) return;
            await wait(2000, undefined, { signal });
          }
          if (!started) continue;
          setStatus('running', { step: stepNumber, remaining: step.minutes ? step.minutes * 60000 : -1 });
          while (true) {
            await wait(checkEvery, undefined, { signal });
            const next = await bridge.send('inspect', { lease }, signal);
            const progress = /^(running|paused):(-?\d+)(?::(\d+):(\d+))?$/.exec(next);
            if (progress) {
              setStatus(progress[1], { step: stepNumber, remaining: Number(progress[2]),
                current: progress[3] == null ? undefined : Number(progress[3]),
                target: progress[4] == null ? undefined : Number(progress[4]) });
              continue;
            }
            if (['completed', 'action-changed', 'goal-timeout', 'goal-product-unavailable'].includes(next)) mayOwnAction = false;
            if (next === 'completed') break;
            setStatus(next, { step: stepNumber });
            return;
          }
        } finally {
          if (mayOwnAction) {
            if (signal.aborted) setStatus('cancelling', { step: stepNumber });
            const result = await bridge.send('stop', { lease }, AbortSignal.timeout(5000), 4500)
              .catch(() => 'bridge-unavailable');
            if (signal.aborted && result !== 'stopped' && result !== 'action-changed') {
              setStatus('cancel-unconfirmed', { step: stepNumber });
            }
          }
        }
      }
    } while (repeat && ranStep);
    setStatus('completed');
  }

  return {
    status: () => status,
    start(steps, character, repeat, characterId) {
      if (controller) throw new Error('busy');
      if (typeof character !== 'string' || !character.trim() || character.length > 120 ||
          !Array.isArray(steps) || !steps.length || steps.length > 200) {
        throw new Error('invalid-queue');
      }
      const actions = steps.map(step => {
        const definition = targets.get(step?.key);
        if (!definition || !Number.isInteger(step.minutes) || step.minutes < 0 || step.minutes > 1440) {
          throw new Error('invalid-queue');
        }
        let goal;
        if (step.goal != null) {
          const { type, value, item } = step.goal;
          const max = type === 'level' ? 120 : 1000000000;
          const items = type === 'item' || type === 'owned' ? definition.items :
            type === 'spent' || type === 'remaining' ? definition.materials : null;
          const itemGoal = ['item', 'owned', 'spent', 'remaining'].includes(type);
          const min = type === 'remaining' ? 0 : 1;
          if (!['level', 'item', 'owned', 'spent', 'remaining', 'recipes'].includes(type) ||
              !Number.isInteger(value) || value < min || value > max ||
              (type === 'recipes' && !definition.crafting) || (itemGoal && !items?.includes(item))) throw new Error('invalid-queue');
          goal = itemGoal ? { type, value, item } : { type, value };
        }
        const { skill, target } = definition;
        return { skill, target, minutes: step.minutes, ...(goal && { goal }) };
      });
      controller = new AbortController();
      const { signal } = controller;
      void run(actions, character, characterId, repeat === true, signal).catch(error => {
        const known = ['game-already-open', 'bridge-unavailable', 'bridge-build', 'bridge-override-conflict', 'direct-link-failed'];
        if (status.state !== 'cancel-unconfirmed') {
          setStatus(signal.aborted ? 'cancelled' : known.includes(error.message) ? error.message : 'failed');
        }
      }).finally(() => { controller = undefined; });
      return status;
    },
    cancel() { controller?.abort(); }
  };
}

module.exports = { createActionRunner };
