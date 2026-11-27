const { setTimeout: delay } = require('node:timers/promises');
const { randomUUID } = require('node:crypto');
const { directQueueSkills } = require('./game-bridge.cjs');

function createActionRunner(bridge, targets, { wait = delay, checkEvery = 1500,
  characterTimeout = 90000, now = () => performance.now() } = {}) {
  let controller;
  let queueTask;
  let restartTask;
  let status = { state: 'idle', skills: directQueueSkills };
  const setStatus = (state, detail = {}) => { status = { state, skills: directQueueSkills, ...detail }; };

  async function run(steps, character, characterId, saveHash, repeat, signal) {
    const totalSteps = steps.length;
    let round = 0;
    setStatus('connecting', { totalSteps });
    await bridge.connect(signal);
    let ranStep;
    do {
      round++;
      ranStep = false;
      for (const [index, step] of steps.entries()) {
        const stepNumber = index + 1;
        const runStep = { step: stepNumber, totalSteps, round, stepKey: step.key, goalType: step.goal?.type };
        const lease = randomUUID();
        let mayOwnAction = false;
        let started = false;
        let characterDeadline;
        try {
          setStatus('switching', runStep);
          while (true) {
            signal.throwIfAborted();
            if (characterDeadline !== undefined && now() >= characterDeadline) {
              setStatus('character-timeout', { step: stepNumber });
              return;
            }
            mayOwnAction = true;
            const { key, ...command } = step;
            const result = await bridge.send('start', { ...command, character, characterId, lease,
              ...(saveHash && { saveHash }) }, signal);
            if (result === 'started') {
              started = ranStep = true;
              break;
            }
            mayOwnAction = false;
            if (result === 'completed') break;
            setStatus(result, runStep);
            if (!['character-required', 'character-loading', 'character-mismatch', 'paused'].includes(result)) return;
            if (result === 'paused') {
              characterDeadline = undefined;
              await wait(2000, undefined, { signal });
            } else {
              characterDeadline ??= now() + characterTimeout;
              const remaining = characterDeadline - now();
              await wait(Math.max(0, Math.min(2000, remaining)), undefined, { signal });
            }
          }
          if (!started) continue;
          const duration = step.minutes * 60000;
          let initial;
          setStatus('running', { ...runStep, duration, remaining: duration || -1 });
          while (true) {
            await wait(checkEvery, undefined, { signal });
            const next = await bridge.send('inspect', { lease }, signal);
            const progress = /^(running|paused):(-?\d+)(?::(\d+):(\d+))?$/.exec(next);
            if (progress) {
              const current = progress[3] == null ? undefined : Number(progress[3]);
              initial ??= ['item', 'spent', 'recipes'].includes(step.goal?.type) ? 0 : current;
              setStatus(progress[1], { ...runStep, duration, remaining: Number(progress[2]),
                initial, current,
                target: progress[4] == null ? undefined : Number(progress[4]) });
              continue;
            }
            if (['completed', 'action-changed', 'goal-timeout', 'goal-product-unavailable'].includes(next)) mayOwnAction = false;
            if (next === 'completed') break;
            setStatus(next, runStep);
            return;
          }
        } finally {
          if (mayOwnAction) {
            if (signal.aborted) setStatus('cancelling', runStep);
            const result = await bridge.send('stop', { lease }, AbortSignal.timeout(5000), 4500)
              .catch(() => 'bridge-unavailable');
            if (signal.aborted && result !== 'stopped' && result !== 'action-changed') {
              setStatus('cancel-unconfirmed', runStep);
            }
          }
        }
      }
    } while (repeat && ranStep);
    setStatus('completed', { totalSteps, round });
  }

  return {
    status: () => restartTask ? { state: 'restarting', skills: directQueueSkills } : status,
    active: () => Boolean(controller || restartTask),
    restart: typeof bridge.restart === 'function' ? () => {
      if (restartTask) throw new Error('busy');
      controller?.abort();
      restartTask = Promise.resolve(queueTask).then(() => bridge.restart(AbortSignal.timeout(100000)))
        .then(() => setStatus('game-restarted'), () => setStatus('restart-failed'))
        .finally(() => { restartTask = undefined; });
    } : undefined,
    start(steps, character, repeat, characterId, saveHash) {
      if (controller || restartTask) throw new Error('busy');
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
        return { key: step.key, skill, target, minutes: step.minutes, ...(goal && { goal }) };
      });
      controller = new AbortController();
      const { signal } = controller;
      queueTask = run(actions, character, characterId, saveHash, repeat === true, signal).catch(error => {
        const known = ['game-already-open', 'bridge-unavailable', 'bridge-build', 'bridge-override-conflict', 'direct-link-failed'];
        if (status.state !== 'cancel-unconfirmed') {
          setStatus(signal.aborted ? 'cancelled' : known.includes(error.message) ? error.message : 'failed');
        }
      }).finally(() => { controller = undefined; queueTask = undefined; });
      return status;
    },
    cancel() { controller?.abort(); }
  };
}

module.exports = { createActionRunner };
