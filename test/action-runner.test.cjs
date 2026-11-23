const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: turn } = require('node:timers/promises');
const { createActionRunner } = require('../action-runner.cjs');
const { prepareLinkedGame } = require('../game-bridge.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const targets = new Map([
  ['Woodcutting:YewTree', { skill: 'Woodcutting', target: 'MelvorBase:YewTree' }],
  ['Fishing:ShallowPools', { skill: 'Fishing', target: 'MelvorBase:ShallowPools' }]
]);
const steps = [...targets.keys()].map(key => ({ key, minutes: 10 }));

test('the runner waits for the selected character, then starts and stops each action by ID', async () => {
  const commands = [];
  const waited = [];
  const bridge = {
    connect: async () => {},
    send: async (operation, params) => {
      commands.push([operation, params]);
      if (commands.length === 1) return 'character-mismatch';
      return operation === 'start' ? 'started' : 'completed';
    }
  };
  const runner = createActionRunner(bridge, targets, { wait: async duration => waited.push(duration) });
  assert.throws(() => runner.start([{ key: 'Ranching:Chicken', minutes: 10 }], 'Player', false), /invalid-queue/);
  runner.start(steps, 'Player', false);
  await turn();
  assert.deepEqual(commands.map(([operation, { target, character }]) => [operation, target, character]), [
    ['start', 'MelvorBase:YewTree', 'Player'], ['start', 'MelvorBase:YewTree', 'Player'], ['inspect', undefined, undefined],
    ['start', 'MelvorBase:ShallowPools', 'Player'], ['inspect', undefined, undefined]
  ]);
  assert.deepEqual(waited, [2000, 1500, 1500]);
  assert.equal(runner.status().state, 'completed');
});

test('cancelling stops only the owned action after the game confirms the stop', async () => {
  let activeLease;
  const commands = [];
  const bridge = {
    connect: async () => {},
    send: async (operation, { lease }, signal) => {
      signal.throwIfAborted();
      commands.push(operation);
      if (operation === 'start') {
        activeLease = lease;
        return 'started';
      }
      assert.equal(operation, 'stop');
      assert.equal(lease, activeLease);
      activeLease = null;
      return 'stopped';
    }
  };
  const runner = createActionRunner(bridge, targets);
  runner.start(steps, 'Player', false);
  await turn();
  runner.cancel();
  await turn();
  assert.deepEqual(commands, ['start', 'stop']);
  assert.equal(activeLease, null);
  assert.equal(runner.status().state, 'cancelled');
});

test('remaining time comes from the game and stays visible while it is paused', async () => {
  const replies = ['started', 'paused:550000', 'running:540000', 'completed', 'locked'];
  const snapshots = [];
  const bridge = { connect: async () => {}, send: async () => replies.shift() };
  const runner = createActionRunner(bridge, targets, {
    wait: async () => snapshots.push(runner.status())
  });
  runner.start(steps, 'Player', false);
  await turn();
  assert.deepEqual(snapshots.map(({ state, step, remaining }) => [state, step, remaining]), [
    ['running', 1, 600000], ['paused', 1, 550000], ['running', 1, 540000]
  ]);
  assert.equal(runner.status().state, 'locked');
  assert.equal(replies.length, 0);
});

test('a truly paused game retries the same queue step once processing resumes', async () => {
  const replies = ['paused', 'started', 'running:590000', 'completed'];
  const requests = [];
  const snapshots = [];
  const runner = createActionRunner({
    connect: async () => {},
    send: async (operation, payload) => {
      requests.push([operation, payload.lease]);
      return replies.shift();
    }
  }, targets, { wait: async () => snapshots.push(runner.status().state) });
  runner.start([steps[0]], 'Player', false);
  await turn();
  assert.deepEqual(snapshots, ['paused', 'running', 'running']);
  assert.deepEqual(requests.map(([operation]) => operation), ['start', 'start', 'inspect', 'inspect']);
  assert.equal(new Set(requests.map(([, lease]) => lease)).size, 1);
  assert.equal(runner.status().state, 'completed');
});

test('goal mode validates the expected product and stops at the time limit', async () => {
  const targets = new Map([['Woodcutting:YewTree',
    { skill: 'Woodcutting', target: 'MelvorBase:YewTree', items: ['YewLog'] }]]);
  const snapshots = [];
  const commands = [];
  const bridge = { connect: async () => {}, send: async (operation, payload) => {
    commands.push({ operation, payload });
    return operation === 'start' ? 'started' : commands.length === 2 ? 'running:540000:4:8' : 'goal-timeout';
  } };
  const runner = createActionRunner(bridge, targets, { wait: async () => snapshots.push(runner.status()) });
  const step = { ...steps[0], goal: { type: 'item', item: 'YewLog', value: 8 } };
  assert.throws(() => runner.start([{ ...step, goal: { ...step.goal, item: 'OakLog' } }], 'Player'), /invalid-queue/);
  runner.start([step], 'Player', true);
  await turn();
  assert.deepEqual(commands[0].payload.goal, step.goal);
  assert.equal(snapshots.at(-1).current, 4);
  assert.deepEqual(commands.map(row => row.operation), ['start', 'inspect', 'inspect']);
  assert.equal(runner.status().state, 'goal-timeout');
});

test('queue accepts crafting, stock and spending goals, including zero remaining', async () => {
  const key = 'Smithing:CopperBar';
  const targets = new Map([[key, { skill: 'Smithing', target: 'MelvorBase:CopperBar',
    crafting: true, items: ['CopperBar'], materials: ['CopperOre'] }]]);
  const sent = [];
  const runner = createActionRunner({ connect: async () => {}, send: async (operation, payload) => {
    if (operation === 'start') sent.push(payload);
    return operation === 'start' ? 'started' : 'completed';
  } }, targets, { wait: async () => {} });
  const goals = [{ type: 'recipes', value: 2 }, { type: 'owned', item: 'CopperBar', value: 12 },
    { type: 'spent', item: 'CopperOre', value: 2 }, { type: 'remaining', item: 'CopperOre', value: 0 }];
  assert.throws(() => runner.start([{ key, minutes: 1, goal: { type: 'spent', item: 'CopperBar', value: 4 } }],
    'Player', false), /invalid-queue/);
  runner.start([...goals.map(goal => ({ key, minutes: 1, goal })), { key, minutes: 0 }], 'Player', false);
  await turn();
  assert.deepEqual(sent.map(row => row.goal), [...goals, undefined]);
  assert.equal(sent.at(-1).minutes, 0);
  assert.equal(runner.status().state, 'completed');
});

test('a completed product target advances to the next condition and uses a new lease', async () => {
  const stone = 'Mining:Stone';
  const bar = 'Smithing:AdamantiteBar';
  const targets = new Map([
    [stone, { skill: 'Mining', target: 'MelvorBase:Stone', items: ['Stone'] }],
    [bar, { skill: 'Smithing', target: 'MelvorBase:AdamantiteBar', crafting: true, materials: ['AdamantiteOre'] }]
  ]);
  const replies = ['started', 'running:595000:2:3', 'completed', 'completed'];
  const requests = [];
  const progress = [];
  const runner = createActionRunner({ connect: async () => {}, send: async (operation, request) => {
    requests.push({ operation, request });
    return replies.shift();
  } }, targets, { wait: async () => progress.push(runner.status()) });
  runner.start([
    { key: stone, minutes: 0, goal: { type: 'item', item: 'Stone', value: 3 } },
    { key: bar, minutes: 10, goal: { type: 'remaining', item: 'AdamantiteOre', value: 1946 } }
  ], 'Player', false);
  await turn();
  assert.equal(progress.at(-1).current, 2);
  assert.equal(progress.at(-1).target, 3);
  assert.deepEqual(requests.map(({ operation }) => operation), ['start', 'inspect', 'inspect', 'start']);
  assert.equal(requests[0].request.minutes, 0);
  assert.notEqual(requests[0].request.lease, requests.at(-1).request.lease);
  assert.equal(runner.status().state, 'completed');
});

test('a game-side unlock failure or manual action change stops the queue', async () => {
  for (const [replies, state] of [[['locked'], 'locked'], [['started', 'action-changed'], 'action-changed']]) {
    const bridge = {
      connect: async () => {},
      send: async () => {
        assert(replies.length > 0);
        return replies.shift();
      }
    };
    const runner = createActionRunner(bridge, targets, { wait: async () => {} });
    runner.start(steps, 'Player', true);
    await turn();
    assert.equal(runner.status().state, state);
    assert.equal(replies.length, 0);
  }
});

test('the managed runtime is staged with the first-party assembly without changing installed settings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melvor-bridge-fixture-'));
  const game = path.join(root, 'install');
  const runtime = path.join(game, 'data_GamesByMalcs.Melvor2_windows_x86_64');
  const gameAssembly = 'GamesByMalcs.Melvor2';
  const bridge = 'CalculatorQueueBridge';
  const runtimeId = '.NETCoreApp,Version=v10.0/win-x64';
  const module = path.join(root, bridge + '.dll');
  try {
    await fs.mkdir(runtime, { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(game, 'Melvor2.exe'), 'original executable'),
      fs.writeFile(path.join(game, 'override.cfg'), 'original overrides'),
      fs.writeFile(path.join(runtime, gameAssembly + '.dll'), 'original assembly'),
      fs.writeFile(path.join(runtime, gameAssembly + '.runtimeconfig.json'), '{}'),
      fs.writeFile(path.join(runtime, gameAssembly + '.deps.json'),
        JSON.stringify({ runtimeTarget: { name: runtimeId }, targets: { [runtimeId]: {} }, libraries: {} })),
      fs.writeFile(module, 'first-party bridge')
    ]);
    const linked = [];
    const stage = await prepareLinkedGame(game, { assemblyFile: module, link: async (from, to) => {
      linked.push([from, to]);
      await fs.copyFile(from, to);
    } });
    const { directory, executable } = stage;
    assert.equal(linked[0][0], path.join(await fs.realpath(game), 'Melvor2.exe'));
    assert.equal(linked.length, 4);
    assert.equal(await fs.readFile(executable, 'utf8'), 'original executable');
    assert.equal(await fs.readFile(path.join(game, 'override.cfg'), 'utf8'), 'original overrides');
    assert.match(await fs.readFile(path.join(directory, 'override.cfg'), 'utf8'), /CalculatorQueueBridge/);
    const stagedRuntime = path.join(directory, 'data_CalculatorQueueBridge_windows_x86_64');
    const metadata = JSON.parse(await fs.readFile(path.join(stagedRuntime, bridge + '.deps.json'), 'utf8'));
    assert.deepEqual(metadata.targets[runtimeId][bridge + '/1.0.0'].runtime, { [bridge + '.dll']: {} });
    await stage.cleanup();
    const attempted = [];
    await assert.rejects(prepareLinkedGame(game, { assemblyFile: module, link: async (from, to) => {
      attempted.push([from, to]);
      throw Object.assign(new Error('links unavailable'), { code: 'EPERM' });
    } }), { code: 'EPERM' });
    assert.equal(attempted.length, 1);
    assert.equal(attempted[0][0], path.join(await fs.realpath(game), 'Melvor2.exe'));
    await assert.rejects(fs.stat(attempted[0][1]), { code: 'ENOENT' });
    assert.deepEqual((await fs.readdir(root)).sort(), [bridge + '.dll', 'install'].sort());
  } finally {
    if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('melvor-bridge-fixture-')) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
