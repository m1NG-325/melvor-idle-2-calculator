const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createDesktopAccount } = require('../desktop-account.cjs');

test('desktop username authentication keeps credentials and the upstream session out of local responses', async t => {
  const cookie = '__Secure-melvor2calc.session_token=private-signed-value';
  const user = { username: 'sample', name: 'Sample' };
  const calls = [];
  const handle = createDesktopAccount(async (url, options) => {
    calls.push({ url, ...options });
    const route = url.split('/api/auth/')[1];
    if (route === 'get-session') return Response.json({ user, session: { token: 'private-token' } });
    if (route === 'sign-out') return Response.json({ success: true });
    if (route === 'claim-username') return Response.json({ user: { username: 'sample' } });
    return Response.json({ user: { ...user, email: 'internal@accounts.invalid' }, token: 'private-token' }, { headers: {
      'Set-Cookie': 'unrelated=1; Expires=Wed, 25 Nov 2026 00:00:00 GMT, ' + cookie + '; Secure; HttpOnly'
    } });
  });
  const server = createServer((req, res) => {
    void handle(req.url.slice(1), req.headers.host, req, res, (response, body, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  server.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const authHeader = { 'X-Calculator-Account': '1' };
  const request = (route, data, origin = base) => fetch(base + '/' + route, data === undefined
    ? { headers: authHeader } : {
      method: 'POST', body: JSON.stringify(data),
      headers: { ...authHeader, 'Content-Type': 'application/json', Origin: origin }
    });

  assert.deepEqual(await (await request('session')).json(), { user: null });
  assert.equal((await fetch(base + '/session')).status, 403);
  assert.equal((await request('login', { ...user, password: 'password' }, 'https://example.test')).status, 403);
  assert.equal((await request('register', { ...user, password: 'short' })).status, 400);
  assert.equal((await request('register', { ...user, password: 'x'.repeat(9000) })).status, 400);
  assert.equal(calls.length, 0);

  const registration = { ...user, password: 'test-password', save: 'not forwarded', callbackURL: 'https://example.test' };
  const reply = await request('register', registration);
  assert.deepEqual(await reply.json(), { user });
  assert.equal(reply.headers.get('set-cookie'), null);
  assert.deepEqual(JSON.parse(calls[0].body), { username: user.username, password: registration.password });
  assert.equal(calls[0].url, 'https://melvor2calc.pages.dev/api/auth/sign-up/username');
  assert.equal(calls[0].redirect, 'error');
  assert.deepEqual(await (await request('session')).json(), { user });
  assert.equal(calls[1].headers.Cookie, cookie);
  assert.deepEqual(await (await request('logout', {})).json(), { ok: true });
  assert.equal(calls[2].url, 'https://melvor2calc.pages.dev/api/auth/sign-out');
  assert.equal(calls[2].headers.Cookie, cookie);
  assert.deepEqual(await (await request('session')).json(), { user: null });
  assert.deepEqual(await (await request('login', { ...user, password: 'test-password' })).json(), { user });
  assert.equal(calls[3].url, 'https://melvor2calc.pages.dev/api/auth/sign-in/username');
  assert.deepEqual(await (await request('claim', { username: 'sample' })).json(), { user: { username: 'sample' } });
  assert.equal(calls[4].url, 'https://melvor2calc.pages.dev/api/auth/claim-username');
  assert.equal(calls[4].headers.Cookie, cookie);
  await request('login', { username: 'legacy@example.test', password: 'test-password' });
  assert.equal(calls[5].url, 'https://melvor2calc.pages.dev/api/auth/sign-in/email');
  assert.deepEqual(JSON.parse(calls[5].body), { email: 'legacy@example.test', password: 'test-password' });
});
