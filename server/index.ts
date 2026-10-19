import { buildApp } from './app.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const production = process.env.NODE_ENV === 'production';
const captureToken = process.env.CAPTURE_TOKEN || (production ? '' : 'local');
const adminPassword = process.env.ADMIN_PASSWORD;
if (production && (!captureToken || !adminPassword)) throw new Error('Production requires CAPTURE_TOKEN and ADMIN_PASSWORD. Supply them privately in hosting settings.');
if (production && (captureToken.length < 20 || adminPassword!.length < 16)) throw new Error('Use at least 20 characters for CAPTURE_TOKEN and 16 for ADMIN_PASSWORD.');
const app = await buildApp({ captureToken, adminUser: process.env.ADMIN_USER, adminPassword, clientDirectory: production ? fileURLToPath(new URL('../client', import.meta.url)) : undefined });

if (!production) {
  const { createServer } = await import('vite');
  const vite = await createServer({ root: resolve('.'), server: { middlewareMode: true, hmr: { server: app.server } }, appType: 'spa' });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/hooks/')) return reply.code(404).send({ error: 'Not found' });
    reply.hijack();
    vite.middlewares(request.raw, reply.raw, () => { reply.raw.statusCode = 404; reply.raw.end('Not found'); });
  });
  app.addHook('onClose', async () => { await vite.close(); });
}

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1') });
console.log(`Webhook Inbox running at http://localhost:${port}`);
if (!production) console.log('Development mode: history is temporary; dashboard access is local and unauthenticated unless ADMIN_PASSWORD is set.');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { app.close().then(() => process.exit(0)); });
