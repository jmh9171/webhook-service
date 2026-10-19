import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildApp } from '../server/app.js';
import { createCurl } from '../shared/replay.js';

test('captured text and binary requests replay through real cURL to a local HTTP receiver', { timeout: 15000 }, async (t) => {
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString('base64') }));
  });
  await new Promise<void>((resolve, reject) => { receiver.once('error', reject); receiver.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise<void>((resolve) => receiver.close(() => resolve())));
  const address = receiver.address() as { port: number };
  const directory = await mkdtemp(join(tmpdir(), 'webhook-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = await buildApp({ captureToken: 'local' }); t.after(() => app.close());
  const text = Buffer.from('{\n "message": "O\'Reilly 🚀", "literal": "$(printf nope) `printf nope`"\n}\n');
  for (const body of [text, Buffer.from([0, 255, 128, 13, 10, 42])]) {
    const binary = body !== text;
    await app.inject({ method: 'POST', url: '/hooks/local/original?tag=a&tag=b&signed=a%2Bb', headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json', authorization: 'Bearer private-fixture', 'x-provider-event': 'created' }, payload: body });
    const snapshot = (await app.inject({ url: '/api/inbox' })).json();
    const detail = (await app.inject({ url: `/api/requests/${snapshot.requests[0].id}` })).json();
    if (binary) await writeFile(join(directory, 'webhook-body.bin'), (await app.inject({ url: `/api/requests/${detail.id}/body` })).rawPayload);
    const command = createCurl(detail, `http://127.0.0.1:${address.port}/local-webhook?test=1`);
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', command], { cwd: directory, timeout: 5000 });
    const replay = JSON.parse(stdout);
    assert.equal(replay.method, 'POST');
    assert.equal(replay.url, '/local-webhook?test=1&tag=a&tag=b&signed=a%2Bb');
    assert.equal(replay.headers['x-provider-event'], 'created');
    assert.equal(replay.headers.authorization, undefined);
    assert.deepEqual(Buffer.from(replay.body, 'base64'), body);
  }
});
