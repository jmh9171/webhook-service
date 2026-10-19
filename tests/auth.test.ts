import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/app.js';
import { Sessions, sessionLifetime } from '../server/auth.js';

const options = { captureToken: 'auth-test-capture', adminUser: 'owner', adminPassword: 'auth-test-password', secureCookies: true };
const login = { method: 'POST' as const, url: '/api/auth/login', headers: { 'x-inbox-action': 'login' }, payload: { username: options.adminUser, password: options.adminPassword } };

test('login creates an HttpOnly secure session; restore and logout revoke access without a browser auth challenge', async (t) => {
  const app = await buildApp(options); t.after(() => app.close());
  assert.deepEqual((await app.inject({ url: '/api/auth/session' })).json(), { authenticated: false, username: null, loginRequired: true });
  const failed = await app.inject({ ...login, payload: { username: 'owner', password: 'incorrect' } });
  assert.equal(failed.statusCode, 401);
  assert.equal(failed.headers['www-authenticate'], undefined);
  assert.equal(failed.headers['set-cookie'], undefined);
  const response = await app.inject(login);
  assert.equal(response.statusCode, 200);
  const setCookie = String(response.headers['set-cookie']);
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=86400']) assert.ok(setCookie.includes(attribute));
  assert.ok(!response.body.includes(options.adminPassword));
  const cookie = setCookie.split(';')[0];
  assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie } })).json().authenticated, true);
  assert.equal((await app.inject({ url: '/api/inbox', headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/inbox', headers: { cookie: 'inbox_session=forged' } })).statusCode, 401);
  for (const url of ['/a%70i/inbox', '/%61pi/inbox', '/api/%69nbox']) assert.equal((await app.inject({ url })).statusCode, 401, `encoded route must remain protected: ${url}`);
  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-inbox-action': 'logout' } });
  assert.equal(logout.statusCode, 200);
  assert.ok(String(logout.headers['set-cookie']).includes('Max-Age=0'));
  assert.equal((await app.inject({ url: '/api/inbox', headers: { cookie } })).statusCode, 401);
});

test('login and logout reject cross-origin actions and login validates JSON and bounded credentials', async (t) => {
  const app = await buildApp(options); t.after(() => app.close());
  assert.equal((await app.inject({ ...login, headers: {} })).statusCode, 403);
  assert.equal((await app.inject({ ...login, headers: { ...login.headers, origin: 'https://other.invalid' } })).statusCode, 403);
  assert.equal((await app.inject({ ...login, headers: { ...login.headers, 'content-type': 'text/plain' }, payload: 'username=owner&password=invalid' })).statusCode, 415);
  assert.equal((await app.inject({ ...login, payload: { username: {}, password: 'invalid' } })).statusCode, 400);
  assert.equal((await app.inject({ ...login, payload: { username: 'owner', password: 'x'.repeat(5000) } })).statusCode, 413);
  const cookie = String((await app.inject(login)).headers['set-cookie']).split(';')[0];
  const crossOrigin = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-inbox-action': 'logout', origin: 'https://other.invalid' } });
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal((await app.inject({ url: '/api/inbox', headers: { cookie } })).statusCode, 200);
  const freshApp = await buildApp(options); t.after(() => freshApp.close());
  assert.equal((await freshApp.inject({ url: '/api/inbox', headers: { cookie } })).statusCode, 401, 'restart invalidates old sessions');
});

test('failed login attempts are bounded and rate-limited', async (t) => {
  const app = await buildApp(options); t.after(() => app.close());
  for (let index = 0; index < 10; index++) assert.equal((await app.inject({ ...login, payload: { username: 'owner', password: 'incorrect' } })).statusCode, 401);
  const response = await app.inject(login);
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['retry-after'], '60');
});

test('in-memory sessions expire, are revocable, and have a fixed capacity', () => {
  let now = 0;
  const sessions = new Sessions(() => now);
  const token = sessions.create();
  assert.equal(sessions.valid(token), true);
  assert.equal(sessions.valid('forged'), false);
  now = sessionLifetime;
  assert.equal(sessions.valid(token), false);
  const first = sessions.create();
  for (let index = 0; index < 32; index++) sessions.create();
  assert.equal(sessions.valid(first), false);
  const last = sessions.create();
  sessions.revoke(last);
  assert.equal(sessions.valid(last), false);
  for (let index = 0; index < 10; index++) sessions.failed();
  assert.equal(sessions.throttled(), true);
  now += 60000;
  assert.equal(sessions.throttled(), false);
});
