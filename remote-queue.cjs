const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { accountOrigin } = require('./desktop-account.cjs');

function readRemoteInstallation(file) {
  try {
    const id = fs.readFileSync(file, 'utf8').trim();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) {
      throw new Error('invalid-remote-installation');
    }
    return id;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const id = randomUUID();
  try {
    fs.writeFileSync(file, id + '\n', { flag: 'wx' });
    return id;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return readRemoteInstallation(file);
  }
}

function createRemoteQueue({ runner, readQueues, readCharacter, accountCookie, installationFile, fetchRemote = globalThis.fetch, interval = 4000 }) {
  let device;
  let timer;
  let enabling = false;
  let generation = 0;
  let state = 'disabled';

  async function api(route, body, credentials, signal) {
    const response = await fetchRemote(accountOrigin + '/api/remote/' + route, {
      method: 'POST', redirect: 'error', signal: signal ?? AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', ...credentials }, body: JSON.stringify(body)
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  }

  function localQueues() {
    const { characterId, queues, manualSave } = readQueues();
    return { characterId, queues: queues.map(queue => ({ ...queue,
      revision: createHash('sha256').update(JSON.stringify([characterId, queue.steps, queue.repeat,
        ...(manualSave ? [manualSave] : [])]))
        .digest('hex').slice(0, 32)
    })) };
  }

  function execute(command) {
    if (!Number.isSafeInteger(command.expires) || command.expires <= Date.now()) return 'expired';
    if (command.kind === 'stop') {
      runner.cancel();
      return 'accepted';
    }
    if (command.kind !== 'start') return 'failed';
    const { characterId, queues } = localQueues();
    const queue = queues.find(item => item.id === command.queue && item.revision === command.revision);
    if (!queue) return 'queue-changed';
    const selected = readCharacter(characterId);
    if (!selected) return 'character-unavailable';
    try {
      runner.start(queue.steps, selected.name, queue.repeat, characterId, selected.saveHash);
      return 'accepted';
    } catch (error) {
      return ['busy', 'invalid-queue'].includes(error.message) ? error.message : 'failed';
    }
  }

  function schedule(connection, ms) {
    if (device !== connection) return;
    timer = setTimeout(() => void poll(connection), ms);
    timer.unref();
  }

  async function poll(connection) {
    try {
      const { characterId, queues } = localQueues();
      const { state: runnerState, step, remaining, current, target } = runner.status();
      const result = await api('poll', {
        queues: queues.map(({ id, name, revision }) => ({ id, name, revision })),
        ready: /^[a-f0-9]{32}$/.test(characterId ?? ''),
        busy: runner.active(),
        run: { state: runnerState, step, remaining, current, target }, ack: connection.ack
      }, connection.headers, AbortSignal.any([connection.abort.signal, AbortSignal.timeout(10000)]));
      if (device !== connection) return;
      if (result.status === 401) {
        disable(false);
        state = 'unbound';
        return;
      }
      if (result.status !== 200 || !result.data) throw new Error('remote-unavailable');
      state = 'online';
      connection.ack = undefined;
      const { command } = result.data;
      if (command) connection.ack = { id: command.id, result: execute(command) };
      schedule(connection, interval);
    } catch {
      if (device !== connection) return;
      state = 'offline';
      schedule(connection, Math.max(interval, 10000));
    }
  }

  function disable(disconnect = true) {
    generation++;
    clearTimeout(timer);
    const connection = device;
    device = undefined;
    state = 'disabled';
    connection?.abort.abort();
    if (disconnect && connection) void api('disconnect', {}, connection.headers).catch(() => {});
  }

  async function enable(name = 'Windows') {
    if (!runner) return 'unavailable';
    if (device) return state;
    if (enabling) return 'connecting';
    const cookie = accountCookie();
    if (!cookie) return 'sign-in';
    enabling = true;
    const started = ++generation;
    try {
      const installation = installationFile ? readRemoteInstallation(installationFile) : undefined;
      const item = await api('devices', { name, installation }, { Cookie: cookie, Origin: accountOrigin });
      if (item.status !== 201 || typeof item.data?.token !== 'string') {
        return item.status === 401 ? 'sign-in' : item.data?.error === 'device-limit' ? 'device-limit' : 'unavailable';
      }
      const connection = { headers: { Authorization: 'Bearer ' + item.data.token }, abort: new AbortController() };
      if (started !== generation) {
        void api('disconnect', {}, connection.headers).catch(() => {});
        return state;
      }
      device = connection;
      state = 'connecting';
      void poll(connection);
      return state;
    } catch {
      return 'unavailable';
    } finally {
      enabling = false;
    }
  }

  return { enable, disable, status: () => runner ? enabling ? 'connecting' : state : 'unavailable' };
}

module.exports = { createRemoteQueue };
