import { registerLab } from './lab.js';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { limits, RequestStore, requestDetail } from './store.js';
import type { HeaderPair } from '../shared/types.js';
import { cookieHeader, readSession, secretsEqual as equal, Sessions } from './auth.js';

export interface AppOptions { captureToken: string; adminUser?: string; adminPassword?: string; clientDirectory?: string; secureCookies?: boolean }

export async function buildApp(options: AppOptions) {
  const store = new RequestStore();
  const sessions = new Sessions();
  const authenticated = (cookie?: string) => !options.adminPassword || sessions.valid(readSession(cookie));
  const app = Fastify({ logger: false, bodyLimit: limits.maxBodyBytes, requestTimeout: 30000, routerOptions: { maxParamLength: 256 }, http: { maxHeaderSize: 16384 } });
  const capture = /^\/hooks(?:\/|$)/;

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    // Check the matched route, not just the raw URL: encoded static path
    // segments must not be able to bypass API authentication or CSRF checks.
    const path = request.routeOptions.url ?? (request.raw.url ?? '/').split('?')[0];
    if ((request.raw.url ?? '').length > 8192) return reply.code(414).send({ error: 'URL exceeds 8 KiB limit' });
    if (capture.test(path) || path === '/healthz') return;
    if (path === '/api/auth/login' && request.method === 'POST' && !/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) return reply.code(415).send({ error: 'Send login credentials as JSON' });
    // The frontend is public so it can render the login page. Only the API holds private data.
    if (path.startsWith('/api/') && !['/api/auth/session', '/api/auth/login'].includes(path) && !authenticated(request.headers.cookie)) return reply.code(401).send({ error: 'Sign in to view your inbox' });
    // A custom header forces cross-origin browser callers to preflight; no CORS is enabled on management routes.
    const action = path.startsWith('/api/lab') && !['GET', 'HEAD'].includes(request.method) ? 'manage' : path === '/api/auth/login' ? 'login' : path === '/api/auth/logout' ? 'logout' : request.method === 'DELETE' ? 'clear' : null;
    if (action && request.headers['x-inbox-action'] !== action) return reply.code(403).send({ error: 'Missing action header' });
    const origin = request.headers.origin;
    if (action && origin) {
      try { if (new URL(origin).host !== request.headers.host) return reply.code(403).send({ error: 'Cross-origin action rejected' }); }
      catch { return reply.code(403).send({ error: 'Invalid origin' }); }
    }
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/api/auth/session', async (request) => {
    const signedIn = authenticated(request.headers.cookie);
    return { authenticated: signedIn, username: signedIn ? options.adminUser ?? 'owner' : null, loginRequired: !!options.adminPassword };
  });
  app.post<{ Body: { username: string; password: string } }>('/api/auth/login', {
    bodyLimit: 4096,
    schema: { body: { type: 'object', required: ['username', 'password'], additionalProperties: false, properties: { username: { type: 'string', minLength: 1, maxLength: 255 }, password: { type: 'string', minLength: 1, maxLength: 1024 } } } },
  }, async (request, reply) => {
    if (sessions.throttled()) return reply.header('Retry-After', '60').code(429).send({ error: 'Too many attempts. Wait a minute and try again.' });
    const userMatches = equal(request.body.username, options.adminUser ?? 'owner');
    const passwordMatches = equal(request.body.password, options.adminPassword ?? '');
    if (options.adminPassword && (!userMatches || !passwordMatches)) {
      sessions.failed();
      return reply.code(401).send({ error: 'Those details didn’t match. Please try again.' });
    }
    sessions.revoke(readSession(request.headers.cookie));
    return reply.header('Set-Cookie', cookieHeader(sessions.create(), !!options.secureCookies)).send({ authenticated: true, username: options.adminUser ?? 'owner' });
  });
  app.post('/api/auth/logout', async (request, reply) => {
    sessions.revoke(readSession(request.headers.cookie));
    return reply.header('Set-Cookie', cookieHeader('', !!options.secureCookies, true)).send({ authenticated: false });
  });
  app.get('/api/inbox', async () => ({ requests: store.list(), instanceId: store.instanceId, capturePath: `/hooks/${options.captureToken}`, limits, storedBytes: store.storedBytes }));
  app.delete('/api/requests', async () => { store.clear(); return { cleared: true }; });
  app.get<{ Params: { id: string } }>('/api/requests/:id', async (request, reply) => {
    const entry = store.get(request.params.id);
    return entry ? requestDetail(entry) : reply.code(404).send({ error: 'This request is no longer in the inbox' });
  });
  app.get<{ Params: { id: string } }>('/api/requests/:id/body', async (request, reply) => {
    const entry = store.get(request.params.id);
    if (!entry) return reply.code(404).send({ error: 'This request is no longer in the inbox' });
    return reply.type('application/octet-stream').header('Content-Disposition', 'attachment; filename="webhook-body.bin"').send(entry.body);
  });

  const lab = await registerLab(app, options.captureToken);

  await app.register(async (hooks) => {
    hooks.removeAllContentTypeParsers();
    hooks.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, payload, done) => done(null, payload));
    hooks.route<{ Params: { token: string }; Body: Buffer }>({
      method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      url: '/hooks/:token',
      handler: receive,
    });
    hooks.route<{ Params: { token: string }; Body: Buffer }>({
      method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      url: '/hooks/:token/*',
      handler: receive,
    });
    async function receive(request: import('fastify').FastifyRequest<{ Params: { token: string }; Body: Buffer }>, reply: import('fastify').FastifyReply) {
      if (!equal(request.params.token, options.captureToken)) return reply.code(404).send({ error: 'Unknown capture URL' });
      const rawUrl = request.raw.url ?? '';
      const question = rawUrl.indexOf('?');
      let body = request.body ?? Buffer.alloc(0);
      // Fastify intentionally skips its body parser for GET/HEAD. A capture tool
      // still needs to retain any bytes those methods actually carry.
      if (request.method === 'GET' || request.method === 'HEAD') {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request.raw.iterator({ destroyOnReturn: false })) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += buffer.length;
          if (length > limits.maxBodyBytes) {
            request.raw.resume();
            return reply.code(413).send({ error: 'Body exceeds 1 MiB limit' });
          }
          chunks.push(buffer);
        }
        body = Buffer.concat(chunks);
      }
      const headers: HeaderPair[] = [];
      for (let index = 0; index < request.raw.rawHeaders.length; index += 2) headers.push([request.raw.rawHeaders[index], request.raw.rawHeaders[index + 1]]);
      const entry = store.add({ method: request.method, path: question < 0 ? rawUrl : rawUrl.slice(0, question), query: question < 0 ? '' : rawUrl.slice(question + 1), headers, contentType: request.headers['content-type'] ?? '', body });
      let correlation = request.headers['x-correlation-id'] || request.headers['x-request-id'] || '';
      let eventName = 'Webhook received';
      try { const data = JSON.parse(body.toString('utf8')); correlation = correlation || data.correlationId || data.event_id || data.data?.id || data.id || ''; eventName = typeof data.event === 'string' ? data.event : eventName; } catch { /* Non-JSON requests still appear in the timeline. */ }
      lab.event('capture', eventName, String(correlation).slice(0,160) || entry.id, 'received', `${request.method} ${entry.path}`);
      return request.method === 'HEAD' ? reply.code(200).send() : reply.code(200).send({ received: true });
    }
  });

  if (options.clientDirectory) await app.register(staticFiles, { root: resolve(options.clientDirectory) });
  return app;
}
