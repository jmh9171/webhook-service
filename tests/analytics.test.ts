import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/app.js';
import type { SignalAnalytics } from '../server/signal.js';

const options = { captureToken: 'private-capture-token-fixture', adminUser: 'admin@example.test', adminPassword: 'private-password-fixture' };

test('backend analytics records accepted actions with fixed subjects and no request data', async (t) => {
  const events: Parameters<SignalAnalytics['capture']>[] = [];
  let closed = 0;
  const app = await buildApp({ ...options, analytics: { capture: (...args) => { events.push(args); }, close: async () => { closed++; } } });
  t.after(() => app.close());
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-inbox-action': 'login' }, payload: { username: options.adminUser, password: options.adminPassword } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  assert.equal(login.statusCode, 200);
  const payload = { email: 'person@example.test', phone: '5551234567', event: 'private-event-title', id: 'private-sender-id' };
  assert.equal((await app.inject({ method: 'POST', url: `/hooks/${options.captureToken}/private-path?secret=private-query`, headers: { 'content-type': 'application/json', authorization: 'Bearer private-bearer', 'x-correlation-id': 'private-correlation' }, payload })).statusCode, 200);
  const inbox = (await app.inject({ url: '/api/inbox', headers: { cookie } })).json();
  const id = inbox.requests[0].id;
  assert.equal((await app.inject({ url: `/api/requests/${id}?email=private-query`, headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: `/api/requests/${id}/body`, headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/events/${options.captureToken}`, payload: { event: 'private-external-event', correlationId: 'private-correlation', detail: 'person@example.test' } })).statusCode, 202);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/requests', headers: { cookie, 'x-inbox-action': 'clear' } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-inbox-action': 'logout' } })).statusCode, 200);
  assert.deepEqual(events.map(([name]) => name), ['admin_signed_in', 'webhook_received', 'request_inspected', 'request_body_downloaded', 'external_event_received', 'inbox_cleared', 'admin_signed_out']);
  assert.equal(new Set(events.map(([, , call]) => call.eventId)).size, events.length);
  for (const [name, properties, call] of events) {
    assert.deepEqual(Object.keys(properties).sort(), ['method', 'status_code']);
    assert.equal(call.distinctId, ['webhook_received', 'external_event_received'].includes(name) ? 'webhook-lab:collector' : 'webhook-lab:admin');
    assert.match(call.eventId, /^webhook-lab:/);
  }
  const serialized = JSON.stringify(events);
  for (const value of [options.captureToken, options.adminUser, options.adminPassword, cookie, id, ...Object.values(payload), 'private-query', 'private-path', 'private-bearer', 'private-correlation', 'private-external-event']) assert.ok(!serialized.includes(value), value);
  await app.close();
  assert.equal(closed, 1);
});

test('polling, health checks, rejected actions, and unknown routes emit no analytics', async (t) => {
  const events: unknown[] = [];
  const app = await buildApp({ ...options, analytics: { capture: (...args) => { events.push(args); }, close: async () => {} } });
  t.after(() => app.close());
  await app.inject({ url: '/healthz' });
  await app.inject({ url: '/api/auth/session' });
  await app.inject({ url: '/api/requests/private-id' });
  await app.inject({ method: 'POST', url: '/hooks/wrong' });
  await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-inbox-action': 'login' }, payload: { username: options.adminUser, password: 'wrong' } });
  await app.inject({ url: '/unknown' });
  assert.equal(events.length, 0);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-inbox-action': 'login' }, payload: { username: options.adminUser, password: options.adminPassword } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };
  events.length = 0;
  await app.inject({ url: '/api/inbox', headers });
  await app.inject({ url: '/api/lab', headers });
  await app.inject({ url: '/api/requests/missing', headers });
  await app.inject({ method: 'DELETE', url: '/api/requests', headers });
  await app.inject({ method: 'POST', url: '/api/lab/chaos', headers: { ...headers, 'x-inbox-action': 'manage' }, payload: {} });
  assert.equal(events.length, 0);
});

test('analytics capture and close failures cannot break webhook handling or shutdown', async () => {
  const app = await buildApp({ ...options, analytics: { capture: () => { throw Error('analytics failed'); }, close: async () => { throw Error('analytics failed'); } } });
  const response = await app.inject({ method: 'POST', url: `/hooks/${options.captureToken}` });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { received: true });
  await app.close();
});

test('hosted tool management emits predefined actions while simulator calls stay untracked', async (t) => {
  const names: string[] = [];
  const app = await buildApp({ captureToken: options.captureToken, analytics: { capture: (name) => { names.push(name); }, close: async () => {} } });
  t.after(() => app.close());
  const headers = { 'x-inbox-action': 'manage' };
  const chaos = (await app.inject({ method: 'POST', url: '/api/lab/chaos', headers, payload: { name: 'private-chaos-name', mode: 'first', failures: 1, errorStatus: 503, delayMs: 0, jitterMs: 0 } })).json();
  await app.inject({ method: 'POST', url: `/api/lab/chaos/${chaos.id}/reset`, headers });
  await app.inject({ url: `/chaos/${chaos.id}` });
  await app.inject({ url: `/chaos/${chaos.id}` });
  await app.inject({ method: 'DELETE', url: `/api/lab/chaos/${chaos.id}`, headers });
  const mock = (await app.inject({ method: 'POST', url: '/api/lab/mocks', headers, payload: { name: 'private-mock-name', routes: [{ method: 'GET', path: '/', status: 200, contentType: 'text/plain', headers: [], body: 'private-mock-body', delayMs: 0, paginated: false, requiredBearer: '', perMinute: 0 }] } })).json();
  await app.inject({ url: `/mock/${mock.id}` });
  await app.inject({ method: 'DELETE', url: `/api/lab/mocks/${mock.id}`, headers });
  const watch = (await app.inject({ method: 'POST', url: '/api/lab/watchdogs', headers, payload: { name: 'private-watch-name', intervalSeconds: 60, graceSeconds: 5 } })).json();
  await app.inject({ url: `/heartbeat/${watch.id}` });
  await app.inject({ method: 'POST', url: `/api/lab/watchdogs/${watch.id}/test-alert`, headers });
  await app.inject({ method: 'DELETE', url: `/api/lab/watchdogs/${watch.id}`, headers });
  await app.inject({ method: 'DELETE', url: '/api/lab/events', headers });
  assert.deepEqual(names, ['chaos_endpoint_created', 'chaos_endpoint_reset', 'chaos_endpoint_deleted', 'mock_api_created', 'mock_api_deleted', 'heartbeat_watch_created', 'heartbeat_alert_tested', 'heartbeat_watch_deleted', 'timeline_cleared']);
});
