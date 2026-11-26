const accountOrigin = 'https://melvor2calc.pages.dev';
const sessionCookie = '__Secure-melvor2calc.session_token';
const bodyLimit = 8192;
const actions = new Map([
  ['GET session', 'get-session'],
  ['POST login', 'sign-in/username'],
  ['POST register', 'sign-up/username'],
  ['POST claim', 'claim-username'],
  ['POST logout', 'sign-out'],
  ['GET preferences', 'preferences'],
  ['POST preferences', 'preferences']
]);

async function readAccountJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) return;
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > bodyLimit) {
      request.resume();
      return;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return; }
}

async function accountFields(request, route) {
  const fields = await readAccountJson(request);
  const username = typeof fields?.username === 'string' ? fields.username.trim() : '';
  if (!username || username.length > 254) return;
  if (route === 'claim') return { username };
  const password = fields?.password;
  if (typeof password !== 'string' || !password.length || password.length > 128 || route === 'register' && password.length < 8) return;
  return route === 'login' && username.includes('@') ? { email: username, password } : { username, password };
}

function createDesktopAccount(fetchAccount = globalThis.fetch, onAccountChange = () => {}) {
  let cookie;
  let pending = false;
  async function handleAccount(route, host, request, response, json) {
    let remoteRoute = actions.get(request.method + ' ' + route);
    if (!remoteRoute) return json(response, { error: 'not-found' }, 404);
    const origin = 'http://' + host;
    if (request.headers['x-calculator-account'] !== '1' ||
        (request.method === 'POST' || request.headers.origin) && request.headers.origin !== origin) {
      return json(response, { error: 'origin' }, 403);
    }
    if (pending) return json(response, { error: 'busy' }, 429);
    if (!cookie && route === 'session') return json(response, { user: null });
    if (!cookie && route === 'logout') {
      onAccountChange();
      return json(response, { ok: true });
    }
    if (route === 'preferences') {
      const session = cookie;
      if (!session) return json(response, { error: 'sign-in' }, 401);
      try {
        const body = request.method === 'POST' ? await readAccountJson(request) : undefined;
        if (request.method === 'POST' && !body) return json(response, { error: 'invalid' }, 400);
        if (cookie !== session) return json(response, { error: 'sign-in' }, 401);
        const upstream = await fetchAccount(accountOrigin + '/api/preferences', {
          method: request.method,
          headers: { Cookie: session, ...(body ? { Origin: accountOrigin, 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(10000)
        });
        const result = await upstream.json().catch(() => null);
        if (cookie !== session) return json(response, { error: 'sign-in' }, 401);
        if (!upstream.ok) return json(response, { error: 'preferences-unavailable' }, upstream.status);
        return json(response, { account: result?.account, settings: result?.settings ?? {} });
      } catch {
        return json(response, { error: 'unavailable' }, 503);
      }
    }

    pending = true;
    try {
      let body;
      if (['login', 'register', 'claim'].includes(route)) {
        body = await accountFields(request, route);
        if (!body) return json(response, { error: 'invalid' }, 400);
        if (route === 'login' && body.email) remoteRoute = 'sign-in/email';
      } else if (route === 'logout') {
        request.resume();
        body = {};
      }
      const upstream = await fetchAccount(accountOrigin + '/api/auth/' + remoteRoute, {
        method: request.method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body ? { Origin: accountOrigin, 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(10000)
      });
      const data = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        if (upstream.status === 401 && route !== 'login' && route !== 'register') {
          onAccountChange();
          cookie = undefined;
        }
        return json(response, { code: typeof data?.code === 'string' ? data.code : undefined }, upstream.status);
      }
      if (route === 'logout') {
        onAccountChange();
        cookie = undefined;
        return json(response, { ok: true });
      }
      if (data === null && route !== 'session') return json(response, { error: 'unavailable' }, 503);
      const setCookie = upstream.headers.get('set-cookie') ?? '';
      const session = setCookie.split(/,(?=\s*[^;,=\s]+=)/).map(part => part.trim().split(';')[0])
        .find(pair => pair.startsWith(sessionCookie + '='));
      if (session) cookie = session.length > sessionCookie.length + 1 ? session : undefined;
      const user = data?.user;
      if (!user) {
        if (cookie) onAccountChange();
        cookie = undefined;
      }
      if (route !== 'session' && (!cookie || !user)) {
        return json(response, { error: 'unavailable' }, 503);
      }
      if (route === 'login' || route === 'register') onAccountChange();
      return json(response, { user: user ? { username: user.username ?? null, name: user.name } : null });
    } catch {
      return json(response, { error: 'unavailable' }, 503);
    } finally {
      pending = false;
    }
  }
  handleAccount.cookie = () => cookie;
  return handleAccount;
}

module.exports = { accountOrigin, createDesktopAccount, readAccountJson };
