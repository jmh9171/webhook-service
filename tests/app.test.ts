import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../server/app.js';
import { limits, RequestStore, requestDetail } from '../server/store.js';

const options = { captureToken: 'capture-test-fixture', adminUser: 'owner', adminPassword: 'test-only-password' };
async function signIn(app: Awaited<ReturnType<typeof buildApp>>) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-inbox-action': 'login' }, payload: { username: options.adminUser, password: options.adminPassword } });
  assert.equal(response.statusCode, 200);
  return { cookie: String(response.headers['set-cookie']).split(';')[0] };
}

test('public capture stores original JSON bytes, duplicates in the query, and incoming headers', async (t) => {
  const app = await buildApp(options); t.after(() => app.close());
  const auth = await signIn(app);
  const body = '{\n  "event": "payment.created", "value": "O\'Reilly 🚀"\n}\n';
  const received = await app.inject({ method: 'POST', url: `/hooks/${options.captureToken}/payments?tag=a&tag=b&signed=a%2Bb`, headers: { 'content-type': 'application/json', 'x-signature': 'fixture' }, payload: body });
  assert.equal(received.statusCode, 200);
  const snapshot = (await app.inject({ url: '/api/inbox', headers: auth })).json();
  assert.equal(snapshot.requests.length, 1);
  const detail = (await app.inject({ url: `/api/requests/${snapshot.requests[0].id}`, headers: auth })).json();
  assert.equal(detail.bodyText, body);
  assert.equal(detail.query, 'tag=a&tag=b&signed=a%2Bb');
  assert.ok(detail.headers.some(([name, value]: [string, string]) => name === 'x-signature' && value === 'fixture'));
  const download = await app.inject({ url: `/api/requests/${detail.id}/body`, headers: auth });
  assert.equal(download.headers['content-disposition'], 'attachment; filename="webhook-body.bin"');
  assert.deepEqual(download.rawPayload, Buffer.from(body));
});

test('authentication protects every inspection endpoint; a capture token is not a read credential', async (t) => {
  const app = await buildApp(options); t.after(() => app.close());
  const auth = await signIn(app);
  for (const url of ['/api/inbox', '/api/requests/unknown', '/api/requests/unknown/body']) assert.equal((await app.inject({ url })).statusCode, 401);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/requests' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/inbox', headers: { authorization: `Bearer ${options.captureToken}` } })).statusCode, 401);
  const frontend = await app.inject({ url: '/' });
  assert.notEqual(frontend.statusCode, 401);
  assert.equal(frontend.headers['www-authenticate'], undefined);
  assert.equal((await app.inject({ url: '/healthz' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/hooks/wrong', payload: 'x', headers: { 'content-type': 'text/plain' } })).statusCode, 404);
});

test('capture handles malformed JSON, empty requests, common methods, and byte-preserving binary download', async (t) => {
  const app = await buildApp(options); t.after(() => app.close());
  const auth = await signIn(app);
  const url = `/hooks/${options.captureToken}`;
  assert.equal((await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload: '{broken json' })).statusCode, 200);
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'DELETE', 'PUT', 'PATCH'] as const) {
    const response = await app.inject({ method, url });
    assert.equal(response.statusCode, 200, method);
    if (method === 'HEAD') assert.equal(response.body, '');
  }
  for (const method of ['GET', 'HEAD'] as const) {
    await app.inject({ method, url, headers: { 'content-type': 'text/plain' }, payload: 'unusual but valid body' });
    const history = (await app.inject({ url: '/api/inbox', headers: auth })).json();
    assert.equal((await app.inject({ url: `/api/requests/${history.requests[0].id}`, headers: auth })).json().bodyText, 'unusual but valid body');
  }
  const body = Buffer.from([0, 255, 128, 13, 10, 1]);
  await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/octet-stream' }, payload: body });
  const snapshot = (await app.inject({ url: '/api/inbox', headers: auth })).json();
  const id = snapshot.requests[0].id;
  const detail = (await app.inject({ url: `/api/requests/${id}`, headers: auth })).json();
  assert.equal(detail.binary, true);
  assert.equal(detail.bodyText, null);
  assert.deepEqual((await app.inject({ url: `/api/requests/${id}/body`, headers: auth })).rawPayload, body);
});

test('oversized bodies and URLs are rejected, and clearing requires an explicit same-origin action', async (t) => {
  const app = await buildApp(options); t.after(() => app.close());
  const auth = await signIn(app);
  const url = `/hooks/${options.captureToken}`;
  assert.equal((await app.inject({ method: 'POST', url, headers: { 'content-type': 'text/plain' }, payload: 'x'.repeat(limits.maxBodyBytes + 1) })).statusCode, 413);
  assert.equal((await app.inject({ url: `${url}?${'x'.repeat(8192)}` })).statusCode, 414);
  await app.inject({ method: 'POST', url });
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/requests', headers: auth })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/requests', headers: { ...auth, 'x-inbox-action': 'clear', origin: 'https://unrelated.invalid' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/requests', headers: { ...auth, 'x-inbox-action': 'clear' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/inbox', headers: auth })).json().requests.length, 0);
});

test('count and byte budgets evict oldest requests, and a fresh store resets history', () => {
  const store = new RequestStore(2, 5);
  const add = (body: string) => store.add({ method: 'POST', path: '/', query: '', headers: [], contentType: 'text/plain', body: Buffer.from(body) });
  const oldest = add('ab'); add('cd'); add('ef');
  assert.equal(store.get(oldest.id), undefined);
  assert.equal(store.list().length, 2);
  assert.equal(store.storedBytes, 4);
  add('12345');
  assert.equal(store.list().length, 1);
  assert.equal(store.storedBytes, 5);
  assert.throws(() => add('123456'));
  const fresh = new RequestStore();
  assert.equal(fresh.list().length, 0);
  assert.notEqual(fresh.instanceId, store.instanceId);
});

test('compressed, multipart, and invalid UTF-8 are file bodies; plain Unicode round-trips', () => {
  const store = new RequestStore();
  const detail = (body: Buffer, contentType = 'text/plain', headers: [string, string][] = []) => requestDetail(store.add({ method: 'POST', path: '/', query: '', headers, contentType, body }));
  assert.equal(detail(Buffer.from('hello 🌎')).bodyText, 'hello 🌎');
  assert.equal(detail(Buffer.from([255])).binary, true);
  assert.equal(detail(Buffer.from('ascii'), 'application/json', [['Content-Encoding', 'gzip']]).binary, true);
  assert.equal(detail(Buffer.from('--boundary'), 'multipart/form-data; boundary=boundary').binary, true);
});
