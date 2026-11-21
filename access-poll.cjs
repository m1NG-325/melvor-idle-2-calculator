const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const choices = new Set(['local', 'website']);
const endpoint = 'https://wordstudyasst.com/melvor-poll/vote';

function createAccessPoll(root, submit = fetch) {
  const file = path.join(root, 'calculator-access-poll.json');
  let pending;
  let confirmed;

  async function readState() {
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8'));
      return /^[0-9a-f-]{36}$/.test(state.voter) ? state : {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async function writeState(state) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(state), { flag: 'wx' });
      await fs.rename(temporary, file);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  async function sendVote(choice) {
    const state = await readState();
    if (choices.has(state.choice)) return state.choice;
    if (!state.voter) {
      state.voter = randomUUID();
      await writeState(state);
    }
    const response = await submit(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voter: state.voter, choice }),
      signal: AbortSignal.timeout(8000),
      redirect: 'error'
    });
    if (!response.ok) throw Error('poll-unavailable');
    const result = await response.json();
    if (!choices.has(result.choice)) throw Error('poll-unavailable');
    await writeState({ ...state, choice: result.choice });
    confirmed = result.choice;
    return confirmed;
  }

  return async function handleAccessPoll(request, response, json, origin) {
    try {
      if (request.method === 'GET') {
        const choice = confirmed ?? (await readState()).choice;
        return json(response, { voted: choices.has(choice) });
      }
      if (request.method !== 'POST' || request.headers.origin !== origin ||
          request.headers['content-type'] !== 'application/json') return json(response, {}, 403);
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 128) return json(response, {}, 413);
      }
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json(response, {}, 400); }
      if (!choices.has(parsed?.choice)) return json(response, {}, 400);
      if (!pending) pending = sendVote(parsed.choice).finally(() => { pending = undefined; });
      return json(response, { choice: await pending });
    } catch {
      return json(response, {}, 503);
    }
  };
}

module.exports = { createAccessPoll };
