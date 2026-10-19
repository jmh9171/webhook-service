import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../server/app.js";
import { LabStore, publicIPv4 } from "../server/lab.js";
import {
  checkShape,
  diffValues,
  inferShape,
  mutatePayload,
  sequencePlan,
  setJsonPath,
} from "../shared/lab.js";

const options = {
  captureToken: "lab-test-token",
  adminPassword: "lab-test-password",
};
async function session(app: Awaited<ReturnType<typeof buildApp>>) {
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { "x-inbox-action": "login" },
    payload: { username: "owner", password: options.adminPassword },
  });
  return {
    cookie: String(r.headers["set-cookie"]).split(";")[0],
    "x-inbox-action": "manage",
  };
}
const mockRoute = {
  method: "GET",
  path: "/items",
  status: 200,
  contentType: "application/json",
  headers: [["X-Fixture", "test"]],
  body: '[{"id":1},{"id":2},{"id":3}]',
  delayMs: 0,
  paginated: true,
  requiredBearer: "fixture-token",
  perMinute: 1,
};
test("lab management requires a session and same-origin action, including encoded route segments", async (t) => {
  const app = await buildApp(options);
  t.after(() => app.close());
  assert.equal((await app.inject("/api/lab")).statusCode, 401);
  assert.equal((await app.inject("/a%70i/lab")).statusCode, 401);
  const auth = await session(app);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/lab/chaos",
        headers: { cookie: auth.cookie },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/lab/chaos",
        headers: { ...auth, origin: "https://foreign.example" },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/a%70i/lab/chaos",
        headers: { cookie: auth.cookie },
        payload: {},
      })
    ).statusCode,
    403,
  );
});
test("chaos endpoints fail predictably, reset counters, retain bounded calls, and disappear on deletion", async (t) => {
  const app = await buildApp(options);
  t.after(() => app.close());
  const auth = await session(app);
  const create = await app.inject({
    method: "POST",
    url: "/api/lab/chaos",
    headers: auth,
    payload: {
      name: "Retry test",
      mode: "first",
      failures: 2,
      errorStatus: 503,
      delayMs: 0,
      jitterMs: 0,
    },
  });
  assert.equal(create.statusCode, 200);
  const { id } = create.json();
  const statuses = [];
  for (let i = 0; i < 3; i++)
    statuses.push(
      (
        await app.inject({
          method: "POST",
          url: "/chaos/" + id,
          payload: "original payload",
        })
      ).statusCode,
    );
  assert.deepEqual(statuses, [503, 503, 200]);
  await app.inject({
    method: "POST",
    url: `/api/lab/chaos/${id}/reset`,
    headers: auth,
    payload: {},
  });
  assert.equal((await app.inject("/chaos/" + id)).statusCode, 503);
  for (let i = 0; i < 35; i++) await app.inject("/chaos/" + id);
  const state = (await app.inject({ url: "/api/lab", headers: auth })).json();
  assert.equal(state.chaos[0].calls.length, 30);
  await app.inject({
    method: "DELETE",
    url: "/api/lab/chaos/" + id,
    headers: auth,
  });
  assert.equal((await app.inject("/chaos/" + id)).statusCode, 404);
});
test("mock APIs implement auth, parameter routes, pagination, CORS, and bounded rate limits", async (t) => {
  const app = await buildApp(options);
  t.after(() => app.close());
  const auth = await session(app);
  const created = await app.inject({
    method: "POST",
    url: "/api/lab/mocks",
    headers: auth,
    payload: {
      name: "Fixtures",
      routes: [
        mockRoute,
        {
          ...mockRoute,
          path: "/items/:id",
          requiredBearer: "",
          perMinute: 0,
          paginated: false,
          body: '{"id":1}',
        },
      ],
    },
  });
  assert.equal(created.statusCode, 200);
  const root = "/mock/" + created.json().id;
  assert.equal((await app.inject(root + "/items")).statusCode, 401);
  const one = await app.inject({
    url: root + "/items?page=2&limit=1",
    headers: { authorization: "Bearer fixture-token" },
  });
  assert.equal(one.statusCode, 200);
  assert.equal(one.headers["x-fixture"], "test");
  assert.deepEqual(one.json(), {
    items: [{ id: 2 }],
    page: 2,
    limit: 1,
    total: 3,
    pages: 3,
  });
  assert.equal(one.headers["access-control-allow-origin"], "*");
  const rate = await app.inject({
    url: root + "/items",
    headers: { authorization: "Bearer fixture-token" },
  });
  assert.equal(rate.statusCode, 429);
  assert.ok(Number(rate.headers["retry-after"]) > 0);
  assert.equal((await app.inject(root + "/items/123")).statusCode, 200);
  assert.equal((await app.inject(root + "/absent")).statusCode, 404);
  assert.equal(
    (await app.inject({ method: "OPTIONS", url: root + "/items" })).statusCode,
    204,
  );
  assert.match(String(one.headers["content-security-policy"]), /sandbox/);
});
test("simulator configuration rejects unsafe headers, oversized payloads, invalid statuses, and private alert destinations", async (t) => {
  const app = await buildApp(options);
  t.after(() => app.close());
  const auth = await session(app);
  for (const headers of [
    [["Set-Cookie", "inbox_session=bad"]],
    [["Content-Type", "text/html"]],
    [["X-Test", "newline\r\ninjected"]],
  ]) {
    const r = await app.inject({
      method: "POST",
      url: "/api/lab/mocks",
      headers: auth,
      payload: { name: "Invalid", routes: [{ ...mockRoute, headers }] },
    });
    assert.equal(r.statusCode, 400);
  }
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/lab/mocks",
        headers: auth,
        payload: {
          name: "Invalid",
          routes: [{ ...mockRoute, body: "x".repeat(17000) }],
        },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/lab/chaos",
        headers: auth,
        payload: {
          name: "Invalid",
          mode: "first",
          failures: 2,
          errorStatus: 999,
          delayMs: 0,
          jitterMs: 0,
        },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/lab/watchdogs",
        headers: auth,
        payload: {
          name: "Unsafe",
          intervalSeconds: 5,
          graceSeconds: 0,
          alertUrl: "http://localhost:3000",
        },
      })
    ).statusCode,
    400,
  );
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "192.168.1.4",
    "169.254.169.254",
    "100.64.0.1",
    "172.31.1.1",
    "0.0.0.0",
    "::1",
  ])
    assert.equal(publicIPv4(ip), false, ip);
  assert.equal(publicIPv4("8.8.8.8"), true);
});
test("heartbeat state transitions emit one missed alert and one recovery alert without a database", async () => {
  let now = Date.now();
  const alerts: unknown[] = [];
  const lab = new LabStore(
    () => now,
    async (_url, payload) => {
      alerts.push(payload);
    },
  );
  const w = lab.createWatchdog({
    name: "Fixture job",
    intervalSeconds: 5,
    graceSeconds: 2,
    alertUrl: "https://public.example/hook",
  });
  assert.equal(w.status, "waiting");
  now += 8000;
  await lab.tick();
  await lab.tick();
  assert.equal(w.status, "missed");
  assert.equal(alerts.length, 1);
  assert.equal(w.delivery, "Delivered");
  await lab.ping(w);
  assert.equal(w.status, "healthy");
  assert.equal(alerts.length, 2);
  assert.deepEqual(
    lab.events.map((e) => e.status),
    ["recovered", "missed"],
  );
  const fresh = new LabStore();
  assert.equal(fresh.watchdogs.length, 0);
});
test("public heartbeat and event ingress correlate with capture events while history stays private", async (t) => {
  const app = await buildApp(options);
  t.after(() => app.close());
  const auth = await session(app);
  await app.inject({
    method: "POST",
    url: "/hooks/" + options.captureToken,
    headers: { "x-correlation-id": "order_001" },
    payload: { event: "order.created", data: { id: "another" } },
  });
  const event = await app.inject({
    method: "POST",
    url: "/events/" + options.captureToken,
    payload: {
      event: "notification.delivered",
      correlationId: "order_001",
      status: "delivered",
      detail: "Email accepted",
    },
  });
  assert.equal(event.statusCode, 202);
  assert.equal(
    (await app.inject({ method: "POST", url: "/events/wrong", payload: {} }))
      .statusCode,
    404,
  );
  const w = (
    await app.inject({
      method: "POST",
      url: "/api/lab/watchdogs",
      headers: auth,
      payload: {
        name: "Ping",
        intervalSeconds: 5,
        graceSeconds: 0,
        alertUrl: "",
      },
    })
  ).json();
  assert.equal(
    (await app.inject({ method: "POST", url: "/heartbeat/" + w.id }))
      .statusCode,
    200,
  );
  const state = (await app.inject({ url: "/api/lab", headers: auth })).json();
  assert.equal(state.watchdogs[0].status, "healthy");
  assert.equal(
    state.events.filter(
      (e: { correlation: string }) => e.correlation === "order_001",
    ).length,
    2,
  );
  assert.equal((await app.inject("/api/lab")).statusCode, 401);
});
test("contract learning identifies optional fields, nested array changes, and prototype-named JSON fields", () => {
  const shape = inferShape([
    { id: "a", optional: 1, items: [{ price: 5 }] },
    { id: "b", items: [{ price: 9 }] },
  ]);
  assert.deepEqual(checkShape(shape, { id: "c", items: [{ price: 10 }] }), []);
  const issues = checkShape(shape, {
    id: 1,
    items: [{ price: "wrong" }],
    newField: true,
  });
  assert.ok(issues.some((s) => s.includes("$.id")));
  assert.ok(issues.some((s) => s.includes("$.items[0].price")));
  assert.ok(issues.some((s) => s.includes("new field")));
  const proto = JSON.parse('{"__proto__":{"safe":true}}');
  assert.deepEqual(checkShape(inferShape([proto]), proto), []);
  assert.throws(() => setJsonPath({}, "__proto__.polluted", true));
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});
test("payload mutation and comparisons preserve the original and describe nested changes", () => {
  const original = '{"data":{"id":"one","count":4}}';
  const variants = mutatePayload(original);
  assert.equal(variants[0].body, original);
  assert.ok(variants.some((v) => v.name === "Remove data.id"));
  assert.ok(variants.some((v) => v.name === "data.id: null"));
  assert.ok(variants.length <= 100);
  assert.deepEqual(
    diffValues({ a: { id: 1 } }, { a: { id: 2, extra: true } }).map(
      (v) => v.kind,
    ),
    ["changed", "added"],
  );
});
test("replay ordering, omissions, duplicates, and seeded shuffles are deterministic", () => {
  const records = Array.from({ length: 4 }, (_, i) => ({
    label: String(i),
    method: "POST",
    headers: [] as [string, string][],
    query: "",
    bodyBase64: "",
    receivedAt: new Date(i * 1000).toISOString(),
  }));
  assert.deepEqual(
    sequencePlan(records, { order: "reverse", speed: 10 }).map((r) => r.label),
    ["3", "2", "1", "0"],
  );
  assert.equal(
    sequencePlan(records, { order: "original", speed: 10 })[1].delayMs,
    100,
  );
  assert.deepEqual(
    sequencePlan(records, {
      order: "original",
      duplicates: 2,
      omitEvery: 2,
    }).map((r) => r.label),
    ["0", "0 (copy 2)", "2", "2 (copy 2)"],
  );
  assert.deepEqual(
    sequencePlan(records, { order: "shuffle", seed: 3 }),
    sequencePlan(records, { order: "shuffle", seed: 3 }),
  );
});

test("server metadata is bounded and expired resource IDs are removed from lookup state", () => {
  const lab = new LabStore();
  for (let i = 0; i < 350; i++) lab.event("external", "Test", "same-id");
  assert.equal(lab.events.length, 300);
  for (let i = 0; i < 10; i++)
    lab.createChaos({
      name: "Limit test",
      mode: "every",
      failures: 2,
      errorStatus: 500,
      delayMs: 0,
      jitterMs: 0,
    });
  assert.throws(() =>
    lab.createChaos({
      name: "Overflow",
      mode: "first",
      failures: 1,
      errorStatus: 500,
      delayMs: 0,
      jitterMs: 0,
    }),
  );
});
