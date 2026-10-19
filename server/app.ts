import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { limits, RequestStore, requestDetail } from './store.js';
import type { HeaderPair } from '../shared/types.js';

export interface AppOptions { captureToken: string; adminUser?: string; adminPassword?: string; clientDirectory?: string }
const equal = (left: string, right: string) => timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest());

export async function buildApp(options: AppOptions) {
  const store = new RequestStore();
  const app = Fastify({ logger: false, bodyLimit: limits.maxBodyBytes, requestTimeout: 30000, routerOptions: { maxParamLength: 256 }, http: { maxHeaderSize: 16384 } });
  const capture = /^\/hooks(?:\/|$)/;

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    const path = (request.raw.url ?? '/').split('?')[0];
    if ((request.raw.url ?? '').length > 8192) return reply.code(414).send({ error: 'URL exceeds 8 KiB limit' });
    if (capture.test(path) || path === '/healthz') return;
    if (options.adminPassword) {
      let credentials = '';
      const authorization = request.headers.authorization;
      if (authorization?.startsWith('Basic ')) credentials = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      if (!equal(credentials, `${options.adminUser ?? 'owner'}:${options.adminPassword}`)) {
        return reply.header('WWW-Authenticate', 'Basic realm="Webhook Inbox", charset="UTF-8"').code(401).send({ error: 'Sign in to view your inbox' });
      }
    }
    // A custom header forces cross-origin browser callers to preflight; no CORS is enabled on management routes.
    if (request.method === 'DELETE' && request.headers['x-inbox-action'] !== 'clear') return reply.code(403).send({ error: 'Missing action header' });
    const origin = request.headers.origin;
    if (request.method === 'DELETE' && origin) {
      try { if (new URL(origin).host !== request.headers.host) return reply.code(403).send({ error: 'Cross-origin action rejected' }); }
      catch { return reply.code(403).send({ error: 'Invalid origin' }); }
    }
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
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
      store.add({ method: request.method, path: question < 0 ? rawUrl : rawUrl.slice(0, question), query: question < 0 ? '' : rawUrl.slice(question + 1), headers, contentType: request.headers['content-type'] ?? '', body });
      return request.method === 'HEAD' ? reply.code(200).send() : reply.code(200).send({ received: true });
    }
  });

  if (options.clientDirectory) await app.register(staticFiles, { root: resolve(options.clientDirectory) });
  return app;
}
