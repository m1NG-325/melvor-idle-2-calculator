const { accountOrigin } = require('./desktop-account.cjs');

function createCharacterSync({ accountCookie, readSnapshot, fetchSync = globalThis.fetch, interval = 15000 }) {
  let session;
  let timer;
  let state = 'disabled';

  function disable() {
    session?.abort.abort();
    session = undefined;
    clearTimeout(timer);
    state = 'disabled';
  }

  async function sync(current) {
    try {
      const result = readSnapshot(current.stamp);
      if (!result) state = 'no-character';
      else if (result.snapshot) {
        const body = JSON.stringify(result.snapshot);
        if (Buffer.byteLength(body) > 512 * 1024) {
          state = 'too-large';
        } else {
          const response = await fetchSync(accountOrigin + '/api/sync', {
            method: 'POST', redirect: 'error', body,
            headers: { Cookie: accountCookie() ?? '', Origin: accountOrigin, 'Content-Type': 'application/json' },
            signal: AbortSignal.any([current.abort.signal, AbortSignal.timeout(10000)])
          });
          if (session !== current) return;
          if (response.status === 401) {
            disable();
            state = 'sign-in';
            return;
          }
          if (!response.ok) throw new Error('sync-failed');
          current.stamp = result.stamp;
          state = 'synced';
        }
      } else state = 'synced';
    } catch {
      if (session === current) state = 'failed';
    } finally {
      if (session === current) {
        timer = setTimeout(() => void sync(current), interval);
        timer.unref();
      }
    }
  }

  function enable() {
    if (session) return;
    if (!accountCookie()) {
      state = 'sign-in';
      return;
    }
    session = { abort: new AbortController(), stamp: undefined };
    state = 'syncing';
    void sync(session);
  }

  return { enable, disable, status: () => ({ active: !!session, state }) };
}

module.exports = { createCharacterSync };
