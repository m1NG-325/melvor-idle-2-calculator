const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: wait } = require('node:timers/promises');
const { createCharacterSync } = require('../character-sync.cjs');

test('character synchronization requires opt-in and uploads only changed snapshots', async t => {
  const posted = [];
  let cookie;
  let stamp = 'first';
  const sync = createCharacterSync({
    accountCookie: () => cookie,
    readSnapshot(previous) {
      return previous === stamp ? { stamp } : { stamp, snapshot: { profile: { name: stamp } } };
    },
    fetchSync: async (url, options) => {
      assert.equal(url, 'https://melvor2calc.pages.dev/api/sync');
      assert.equal(options.headers.Cookie, 'session=private');
      posted.push(JSON.parse(options.body));
      return Response.json({ ok: true });
    },
    interval: 5
  });
  t.after(() => sync.disable());
  sync.enable();
  assert.deepEqual(sync.status(), { active: false, state: 'sign-in' });
  cookie = 'session=private';
  assert.deepEqual(posted, []);
  sync.enable();
  for (let attempt = 0; attempt < 20 && sync.status().state !== 'synced'; attempt++) await wait(5);
  await wait(15);
  assert.deepEqual(posted, [{ profile: { name: 'first' } }]);
  stamp = 'second';
  for (let attempt = 0; attempt < 20 && posted.length < 2; attempt++) await wait(5);
  sync.disable();
  stamp = 'third';
  await wait(15);
  assert.deepEqual(posted, [{ profile: { name: 'first' } }, { profile: { name: 'second' } }]);
  assert.deepEqual(sync.status(), { active: false, state: 'disabled' });
});
