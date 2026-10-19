import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerScript } from "../shared/lab.js";

test("downloaded runner preserves binary bodies, duplicate query values, and excludes captured secrets", async (t) => {
  const calls: { url: string; body: Buffer; authorization?: string; fixture?: string }[] = [];
  const receiver = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push({
      url: req.url!,
      body: Buffer.concat(chunks),
      authorization: req.headers.authorization,
      fixture: String(req.headers["x-fixture"] ?? ""),
    });
    res.end("ok");
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(
    () => new Promise<void>((resolve) => receiver.close(() => resolve())),
  );
  const dir = await mkdtemp(join(tmpdir(), "webhook-lab-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/local`;
  const bytes = Buffer.from([0, 255, 1, 128, 13, 10]);
  const records = [
    {
      label: "binary",
      method: "POST",
      query: "tag=a&tag=b&signed=a%2Bb",
      headers: [
        ["Authorization", "secret"],
        ["X-Fixture", "one"],
        ["X-Fixture", "two"],
        ["Content-Type", "application/octet-stream"],
      ] as [string, string][],
      bodyBase64: bytes.toString("base64"),
      receivedAt: new Date().toISOString(),
    },
    {
      label: "workflow",
      method: "POST",
      query: "",
      headers: [["Content-Type", "application/json"]] as [string, string][],
      bodyBase64: Buffer.from('{"data":{"status":"new"}}').toString("base64"),
      receivedAt: new Date().toISOString(),
      changes: [{ path: "data.status", value: "done" }],
      delayMs: 10,
    },
  ];
  const file = join(dir, "runner.mjs");
  await writeFile(file, runnerScript(records, target));
  const child = spawn(process.execPath, [file], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const [code] = await once(child, "close");
  assert.equal(code, 0, output);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, bytes);
  assert.equal(calls[0].url, "/local?tag=a&tag=b&signed=a%2Bb");
  assert.equal(calls[0].authorization, undefined);
  assert.equal(calls[0].fixture, "one, two");
  assert.deepEqual(JSON.parse(calls[1].body.toString()), {
    data: { status: "done" },
  });
});

test("workflow listener transforms each incoming local event before forwarding", async (t) => {
  const calls: unknown[] = [];
  const receiver = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.end("ok");
  });
  receiver.listen(0, "127.0.0.1");
  await once(receiver, "listening");
  t.after(
    () => new Promise<void>((resolve) => receiver.close(() => resolve())),
  );
  const reserve = http.createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const dir = await mkdtemp(join(tmpdir(), "workflow-listener-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`;
  const file = join(dir, "workflow.mjs");
  await writeFile(
    file,
    runnerScript(
      [
        {
          label: "Trigger step",
          method: "POST",
          query: "",
          headers: [["Content-Type", "application/json"]],
          bodyBase64: Buffer.from('{"id":"fallback"}').toString("base64"),
          receivedAt: new Date().toISOString(),
          useTrigger: true,
          changes: [{ path: "data.status", value: "processed" }],
        },
      ],
      target,
      { listenPort: port },
    ),
  );
  const child = spawn(process.execPath, [file], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill();
  });
  await once(child.stdout, "data");
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"id":"triggered","data":{"status":"new"}}',
  });
  assert.equal(response.status, 202);
  for (let i = 0; i < 20 && !calls.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, [{ id: "triggered", data: { status: "processed" } }]);
});
