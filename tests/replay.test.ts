import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCurl, replayHeaders, replayUrl, shellQuote } from '../shared/replay.js';

test('local destinations retain duplicate and encoded queries without capture routing', () => {
  assert.equal(replayUrl('http://localhost:8080/local?mode=test', 'tag=a&tag=b&v=a%2Bb'), 'http://localhost:8080/local?mode=test&tag=a&tag=b&v=a%2Bb');
  assert.equal(replayUrl('http://localhost:8080/local', ''), 'http://localhost:8080/local');
  for (const target of ['file:///tmp/body', 'javascript:alert(1)', 'http://user:password@localhost/', 'http://localhost/#fragment', 'localhost:3000']) assert.throws(() => replayUrl(target, ''));
});

test('exports filter hop-by-hop and proxy headers and allow sensitive headers only when selected', () => {
  const headers: [string, string][] = [['Host', 'public.example'], ['Connection', 'X-Hop'], ['X-Hop', 'remove-me'], ['Content-Length', '12'], ['CF-Ray', 'edge'], ['X-Forwarded-For', '1.2.3.4'], ['Cookie', 'session=private'], ['Authorization', 'Bearer private'], ['X-Api-Key', 'private'], ['Content-Type', 'application/json'], ['X-Signature', 'provider-signature']];
  assert.deepEqual(replayHeaders(headers).map(([name]) => name), ['Content-Type', 'X-Signature']);
  assert.deepEqual(replayHeaders(headers, true).map(([name]) => name), ['Cookie', 'Authorization', 'X-Api-Key', 'Content-Type', 'X-Signature']);
});

test('shell quoting round-trips apostrophes, newlines, Unicode, and literal shell syntax', () => {
  const body = "O'Reilly\n\"hello\" 🚀 $(printf should-not-expand) `printf nope`";
  const result = execFileSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(body)}`], { encoding: 'utf8' });
  assert.equal(result, body);
});

test('text cURL uses the configured destination and raw body; binary cURL requires an attached file', () => {
  const request = { method: 'POST', query: 'a=1&a=2', headers: [['Host', 'remote.example'], ['Content-Type', 'application/json']] as [string, string][], bodyText: '{ "x": "a" }\n', size: 13, binary: false };
  const curl = createCurl(request, 'http://localhost:4000/hooks');
  assert.ok(curl.includes("'http://localhost:4000/hooks?a=1&a=2'"));
  assert.ok(curl.includes('--data-raw'));
  assert.ok(!curl.includes('remote.example'));
  assert.ok(curl.includes(shellQuote(request.bodyText)));
  assert.ok(createCurl({ ...request, bodyText: null, binary: true }, 'http://localhost:4000/hooks').includes("--data-binary '@webhook-body.bin'"));
});
