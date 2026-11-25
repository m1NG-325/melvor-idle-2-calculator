const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: wait } = require('node:timers/promises');
const { createRemoteQueue } = require('../remote-queue.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('separate tool processes reuse the same installation identity', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melvor-remote-identity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registrations = [];
  const create = () => createRemoteQueue({
    runner: { active: () => false, status: () => ({ state: 'idle' }) },
    readQueues: () => ({ queues: [] }), accountCookie: () => 'session=private',
    installationFile: path.join(root, 'calculator-remote-installation.txt'),
    fetchRemote: async (url, { body }) => {
      if (url.endsWith('devices')) {
        registrations.push(JSON.parse(body));
        return Response.json({ token: 'device-token' }, { status: 201 });
      }
      return Response.json({}, { status: 401 });
    }
  });
  const first = create();
  await first.enable('Old name');
  first.disable();
  const second = create();
  await second.enable('New name');
  second.disable();
  assert.equal(registrations[0].installation, registrations[1].installation);
  assert.match(registrations[0].installation, /^[a-f0-9-]{36}$/);
  assert.deepEqual(registrations.map(entry => entry.name), ['Old name', 'New name']);
});

test('desktop runs an exact saved queue revision and drops expired and stale commands', async t => {
  const starts = [];
  const replies = [];
  const characterId = 'a'.repeat(32);
  const saveHash = 'b'.repeat(64);
  const steps = [{ key: 'Mining:Stone', minutes: 1 }];
  const queue = { id: 'initial', name: 'Mining', steps, repeat: false };
  let polls = 0;
  let stops = 0;
  const remote = createRemoteQueue({
    runner: { start: (...args) => starts.push(args), active: () => false, status: () => ({ state: 'idle' }), cancel: () => stops++ },
    readQueues: () => ({ characterId, queues: [queue] }),
    readCharacter: id => id === characterId ? { name: 'Player', saveHash } : undefined,
    accountCookie: () => 'session=private',
    interval: 2,
    fetchRemote: async (url, { headers, body }) => {
      if (url.endsWith('devices')) {
        assert.equal(headers.Cookie, 'session=private');
        return Response.json({ token: 'device-token' }, { status: 201 });
      }
      assert.equal(headers.Authorization, 'Bearer device-token');
      assert.equal(headers.Cookie, undefined);
      if (url.endsWith('disconnect')) return Response.json({ ok: true });
      const snapshot = JSON.parse(body);
      assert.deepEqual(Object.keys(snapshot.queues[0]).sort(), ['id', 'name', 'revision']);
      assert.equal(snapshot.ready, true);
      if (snapshot.ack) replies.push(snapshot.ack);
      const command = { id: String(++polls), kind: 'start', queue: queue.id,
        revision: snapshot.queues[0].revision, expires: Date.now() + 1000 };
      if (polls === 2) command.revision = '0'.repeat(32);
      if (polls === 3) command.expires = Date.now() - 1;
      if (polls === 4) command.kind = 'stop';
      return Response.json({ command: polls <= 4 ? command : null });
    }
  });
  t.after(() => remote.disable());
  assert.equal(await remote.enable(), 'connecting');
  for (let index = 0; index < 40 && replies.length < 4; index++) await wait(5);
  assert.deepEqual(replies.map(row => row.result), ['accepted', 'queue-changed', 'expired', 'accepted']);
  assert.deepEqual(starts, [[steps, 'Player', false, characterId, saveHash]]);
  assert.equal(stops, 1);
  remote.disable();
  assert.equal(remote.status(), 'disabled');
});

test('a command arriving after local disable cannot start the game', async () => {
  let finishPoll;
  let stopped = 0;
  const remote = createRemoteQueue({
    runner: { active: () => false, status: () => ({ state: 'idle' }), cancel: () => stopped++ },
    readQueues: () => ({ queues: [] }), accountCookie: () => 'session=private',
    fetchRemote: async url => {
      if (url.endsWith('devices')) return Response.json({ token: 'device-token' }, { status: 201 });
      if (url.endsWith('disconnect')) return Response.json({ ok: true });
      return new Promise(resolve => { finishPoll = resolve; });
    }
  });
  await remote.enable();
  remote.disable();
  finishPoll(Response.json({ command: { id: '1', kind: 'stop', expires: Date.now() + 1000 } }));
  await wait(5);
  assert.equal(stopped, 0);
  assert.equal(remote.status(), 'disabled');
});
