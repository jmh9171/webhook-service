import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { FastifyInstance } from "fastify";
import type {
  ChaosConfig,
  HeaderPair,
  LabEvent,
  LabState,
  MockRoute,
  MockService,
  Watchdog,
} from "../shared/types.js";
import { secretsEqual } from "./auth.js";

const bad = (message: string): never => {
  throw Object.assign(new Error(message), { statusCode: 400 });
};
function text(v: unknown, label: string, max = 100, fallback?: string) {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== "string" || v.length > max || !v.trim())
    return bad(`${label} must contain 1–${max} characters.`);
  return v;
}
function integer(v: unknown, label: string, min: number, max: number) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    return bad(`${label} must be an integer from ${min} to ${max}.`);
  return v;
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    return bad("Send a JSON object.");
  return v as Record<string, unknown>;
}
export function publicIPv4(ip: string) {
  const parts = ip.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  )
    return false;
  const [a, b] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 168].includes(b)) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0)
  );
}
export async function sendAlert(url: string, payload: unknown) {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.hash ||
    (target.port && target.port !== "443")
  )
    throw Error(
      "Alert destinations require HTTPS on port 443, without credentials or fragments.",
    );
  const addresses = await lookup(target.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some((a) => !publicIPv4(a.address)))
    throw Error("Alert destination must resolve to a public IPv4 address.");
  const body = JSON.stringify(payload);
  await new Promise<void>((resolve, reject) => {
    // Pin the validated address for this request; never follow redirects.
    const req = httpsRequest(
      target,
      {
        method: "POST",
        family: 4,
        lookup: ((
          _host: unknown,
          _options: unknown,
          callback: (error: null, address: string, family: number) => void,
        ) => callback(null, addresses[0].address, 4)) as never,
        timeout: 5000,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          res.statusCode && res.statusCode >= 200 && res.statusCode < 300
            ? resolve()
            : reject(Error(`Alert receiver returned ${res.statusCode}.`)),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(Error("Alert receiver timed out.")));
    req.on("error", reject);
    req.end(body);
  });
}
export class LabStore {
  chaos: ChaosConfig[] = [];
  mocks: MockService[] = [];
  watchdogs: Watchdog[] = [];
  events: LabEvent[] = [];
  private rate = new Map<string, { minute: number; count: number }>();
  private notifying = new Set<string>();
  constructor(
    private now = () => Date.now(),
    private notify = sendAlert,
  ) {}
  event(
    source: LabEvent["source"],
    title: string,
    correlation = "",
    status = "received",
    detail = "",
  ) {
    this.events.unshift({
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      source,
      title: title.slice(0, 160),
      correlation: correlation.slice(0, 160),
      status: status.slice(0, 60),
      detail: detail.slice(0, 1000),
    });
    this.events.length = Math.min(this.events.length, 300);
  }
  snapshot(token: string): LabState {
    return {
      chaos: this.chaos,
      mocks: this.mocks,
      watchdogs: this.watchdogs,
      events: this.events,
      eventPath: `/events/${token}`,
    };
  }
  createChaos(input: unknown) {
    if (this.chaos.length >= 10)
      return bad("Delete a chaos endpoint before creating another (limit 10).");
    const b = object(input);
    if (!["first", "every", "random"].includes(String(b.mode)))
      return bad("Choose a supported failure mode.");
    const config: ChaosConfig = {
      id: randomUUID(),
      name: text(b.name, "Name"),
      mode: b.mode as ChaosConfig["mode"],
      failures: integer(
        b.failures,
        "Failure setting",
        1,
        b.mode === "random" ? 100 : 1000,
      ),
      errorStatus: integer(b.errorStatus, "Error status", 400, 599),
      delayMs: integer(b.delayMs, "Delay", 0, 10000),
      jitterMs: integer(b.jitterMs, "Jitter", 0, 10000),
      attempts: 0,
      calls: [],
    };
    this.chaos.push(config);
    return config;
  }
  chaosResponse(config: ChaosConfig) {
    const attempt = ++config.attempts;
    const fail =
      config.mode === "first"
        ? attempt <= config.failures
        : config.mode === "every"
          ? attempt % config.failures === 0
          : Math.random() * 100 < config.failures;
    const status = fail ? config.errorStatus : 200;
    const delayMs = Math.min(
      10000,
      config.delayMs + Math.floor(Math.random() * (config.jitterMs + 1)),
    );
    config.calls.unshift({
      at: new Date(this.now()).toISOString(),
      status,
      delayMs,
    });
    config.calls.length = Math.min(config.calls.length, 30);
    this.event(
      "chaos",
      config.name,
      config.id,
      String(status),
      `Attempt ${attempt} · ${delayMs}ms delay`,
    );
    return { status, delayMs, attempt };
  }
  createMock(input: unknown) {
    if (this.mocks.length >= 10)
      return bad("Delete a mock API before creating another (limit 10).");
    const b = object(input);
    if (!Array.isArray(b.routes) || b.routes.length < 1 || b.routes.length > 10)
      return bad("Add 1–10 API routes.");
    const routes: MockRoute[] = b.routes.map((value) => {
      const r = object(value);
      const path = text(r.path, "Route path", 160);
      if (!/^\/(?:[\w.:-]+\/?)*$/.test(path))
        return bad(
          "Route paths use letters, numbers, slashes, hyphens, and :parameter names.",
        );
      if (
        !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
          String(r.method),
        )
      )
        return bad("Unsupported method.");
      const headers = r.headers ?? [];
      if (!Array.isArray(headers) || headers.length > 10)
        return bad("Use at most 10 response headers.");
      const pairs: HeaderPair[] = headers.map((pair) => {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== "string" ||
          typeof pair[1] !== "string" ||
          !/^[-\w]+$/.test(pair[0]) ||
          /[\r\n]/.test(pair[1]) ||
          pair[1].length > 1000 ||
          /^(content-|set-cookie$|location$|connection$|transfer-encoding$|access-control-|cache-control$|x-frame-options$|x-content-type-options$)/i.test(
            pair[0],
          )
        )
          return bad(
            "Use simple custom headers, such as X-Test-Id. Content, cookie, redirect, transport, and security headers are managed by the app.",
          );
        return [pair[0], pair[1]];
      });
      if (!["application/json", "text/plain"].includes(String(r.contentType)))
        return bad("Choose JSON or plain text.");
      if (typeof r.body !== "string" || Buffer.byteLength(r.body) > 16384)
        return bad("Response body must be at most 16 KiB.");
      if (r.contentType === "application/json") {
        try {
          JSON.parse(r.body);
        } catch {
          return bad("The response body must be valid JSON.");
        }
      }
      if (r.paginated) {
        try {
          if (!Array.isArray(JSON.parse(r.body)))
            return bad("Pagination requires a JSON array.");
        } catch {
          return bad("Pagination requires a JSON array.");
        }
      }
      if (
        typeof r.requiredBearer !== "string" ||
        r.requiredBearer.length > 200 ||
        /[\r\n]/.test(r.requiredBearer)
      )
        return bad("Bearer token must be at most 200 characters.");
      return {
        method: String(r.method),
        path,
        status: integer(r.status, "Response status", 200, 599),
        contentType: r.contentType as MockRoute["contentType"],
        headers: pairs,
        body: r.body,
        delayMs: integer(r.delayMs, "Delay", 0, 10000),
        paginated: !!r.paginated,
        requiredBearer: r.requiredBearer,
        perMinute: integer(r.perMinute, "Requests per minute", 0, 1000),
      };
    });
    if (
      new Set(routes.map((r) => r.method + " " + r.path)).size !== routes.length
    )
      return bad("Each method and path must be unique.");
    const service: MockService = {
      id: randomUUID(),
      name: text(b.name, "Name"),
      routes,
      calls: [],
    };
    this.mocks.push(service);
    return service;
  }
  mockResponse(
    service: MockService,
    method: string,
    path: string,
    query: URLSearchParams,
    authorization?: string,
  ) {
    const route = service.routes.find(
      (r) =>
        (r.method === method || (method === "HEAD" && r.method === "GET")) &&
        matchPath(r.path, path),
    );
    let status = route?.status ?? 404,
      body =
        route?.body ??
        JSON.stringify({
          error: "No mock route matches this method and path.",
        });
    let retryAfter = 0;
    if (
      route?.requiredBearer &&
      !secretsEqual(authorization ?? "", `Bearer ${route.requiredBearer}`)
    ) {
      status = 401;
      body = JSON.stringify({ error: "Missing or invalid bearer token" });
    }
    if (route?.perMinute && status !== 401) {
      const key = service.id + ":" + service.routes.indexOf(route);
      const minute = Math.floor(this.now() / 60000);
      let rate = this.rate.get(key);
      if (!rate || rate.minute !== minute) {
        rate = { minute, count: 0 };
        this.rate.set(key, rate);
      }
      if (++rate.count > route.perMinute) {
        status = 429;
        retryAfter = 60 - (Math.floor(this.now() / 1000) % 60);
        body = JSON.stringify({ error: "Mock rate limit exceeded" });
      }
    }
    if (route?.paginated && status === route.status) {
      const items = JSON.parse(route.body) as unknown[];
      const page = Math.max(
          1,
          Math.min(100000, parseInt(query.get("page") || "1", 10) || 1),
        ),
        limit = Math.max(
          1,
          Math.min(100, parseInt(query.get("limit") || "10", 10) || 10),
        );
      body = JSON.stringify({
        items: items.slice((page - 1) * limit, page * limit),
        page,
        limit,
        total: items.length,
        pages: Math.ceil(items.length / limit),
      });
    }
    service.calls.unshift({
      at: new Date(this.now()).toISOString(),
      method,
      path,
      status,
    });
    service.calls.length = Math.min(service.calls.length, 30);
    this.event(
      "mock",
      service.name,
      service.id,
      String(status),
      `${method} ${path}`,
    );
    return { status, body, route, retryAfter };
  }
  deleteMock(id: string) {
    this.mocks = this.mocks.filter((m) => m.id !== id);
    for (const key of this.rate.keys())
      if (key.startsWith(id + ":")) this.rate.delete(key);
  }
  createWatchdog(input: unknown) {
    if (this.watchdogs.length >= 10)
      return bad("Delete a watchdog before creating another (limit 10).");
    const b = object(input);
    const alertUrl = typeof b.alertUrl === "string" ? b.alertUrl.trim() : "";
    if (alertUrl) {
      try {
        const url = new URL(alertUrl);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.hash ||
          (url.port && url.port !== "443")
        )
          throw Error();
      } catch {
        return bad(
          "Alert URL must be HTTPS on port 443, without credentials or fragments.",
        );
      }
      if (alertUrl.length > 2000) return bad("Alert URL is too long.");
    }
    const watch: Watchdog = {
      id: randomUUID(),
      name: text(b.name, "Name"),
      intervalSeconds: integer(b.intervalSeconds, "Interval", 5, 86400),
      graceSeconds: integer(b.graceSeconds, "Grace period", 0, 86400),
      createdAt: new Date(this.now()).toISOString(),
      lastPing: null,
      status: "waiting",
      alertUrl,
      delivery: alertUrl ? "Not sent yet" : "Timeline only",
    };
    this.watchdogs.push(watch);
    return watch;
  }
  async alert(watch: Watchdog, event: string) {
    if (!watch.alertUrl || this.notifying.has(watch.id)) return;
    this.notifying.add(watch.id);
    watch.delivery = "Sending…";
    try {
      await this.notify(watch.alertUrl, {
        event,
        source: "webhook-lab",
        correlationId: watch.id,
        watchdog: {
          name: watch.name,
          status: watch.status,
          lastPing: watch.lastPing,
          intervalSeconds: watch.intervalSeconds,
        },
        at: new Date(this.now()).toISOString(),
      });
      watch.delivery = "Delivered";
    } catch {
      watch.delivery =
        "Delivery failed. Check the receiver URL and its expected payload.";
    } finally {
      this.notifying.delete(watch.id);
    }
  }
  async ping(watch: Watchdog) {
    const recovered = watch.status === "missed";
    watch.lastPing = new Date(this.now()).toISOString();
    watch.status = "healthy";
    this.event(
      "heartbeat",
      watch.name,
      watch.id,
      recovered ? "recovered" : "healthy",
      "Heartbeat received",
    );
    if (recovered) await this.alert(watch, "heartbeat.recovered");
  }
  async tick() {
    await Promise.all(
      this.watchdogs.map(async (watch) => {
        if (
          watch.status !== "missed" &&
          this.now() - Date.parse(watch.lastPing ?? watch.createdAt) >
            (watch.intervalSeconds + watch.graceSeconds) * 1000
        ) {
          watch.status = "missed";
          this.event(
            "heartbeat",
            watch.name,
            watch.id,
            "missed",
            "Expected heartbeat did not arrive",
          );
          await this.alert(watch, "heartbeat.missed");
        }
      }),
    );
  }
}
function matchPath(pattern: string, path: string) {
  const a = pattern.replace(/\/$/, "").split("/"),
    b = path.replace(/\/$/, "").split("/");
  return (
    a.length === b.length &&
    a.every((part, i) => (part.startsWith(":") ? !!b[i] : part === b[i]))
  );
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function registerLab(app: FastifyInstance, token: string) {
  const lab = new LabStore();
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void lab.tick().finally(() => {
      ticking = false;
    });
  }, 1000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
  app.get("/api/lab", async () => lab.snapshot(token));
  app.post("/api/lab/chaos", async (req) => lab.createChaos(req.body));
  app.post<{ Params: { id: string } }>(
    "/api/lab/chaos/:id/reset",
    async (req, reply) => {
      const item = lab.chaos.find((c) => c.id === req.params.id);
      if (!item)
        return reply.code(404).send({ error: "Endpoint no longer exists" });
      item.attempts = 0;
      item.calls = [];
      return { reset: true };
    },
  );
  app.delete<{ Params: { id: string } }>("/api/lab/chaos/:id", async (req) => {
    lab.chaos = lab.chaos.filter((c) => c.id !== req.params.id);
    return { deleted: true };
  });
  app.post("/api/lab/mocks", async (req) => lab.createMock(req.body));
  app.delete<{ Params: { id: string } }>("/api/lab/mocks/:id", async (req) => {
    lab.deleteMock(req.params.id);
    return { deleted: true };
  });
  app.post("/api/lab/watchdogs", async (req) => lab.createWatchdog(req.body));
  app.delete<{ Params: { id: string } }>(
    "/api/lab/watchdogs/:id",
    async (req) => {
      lab.watchdogs = lab.watchdogs.filter((w) => w.id !== req.params.id);
      return { deleted: true };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/lab/watchdogs/:id/test-alert",
    async (req, reply) => {
      const watch = lab.watchdogs.find((w) => w.id === req.params.id);
      if (!watch)
        return reply.code(404).send({ error: "Watchdog no longer exists" });
      await lab.alert(watch, "heartbeat.test");
      return { delivery: watch.delivery };
    },
  );
  app.delete("/api/lab/events", async () => {
    lab.events = [];
    return { cleared: true };
  });
  app.post<{ Params: { token: string } }>(
    "/events/:token",
    { bodyLimit: 8192 },
    async (req, reply) => {
      if (!secretsEqual(req.params.token, token))
        return reply.code(404).send({ error: "Unknown event URL" });
      const b = object(req.body);
      lab.event(
        "external",
        text(b.event, "Event", 160),
        text(b.correlationId, "Correlation ID", 160),
        text(b.status, "Status", 60, "received"),
        typeof b.detail === "string" ? b.detail.slice(0, 1000) : "",
      );
      return reply.code(202).send({ received: true });
    },
  );
  app.route<{ Params: { id: string } }>({
    method: ["GET", "HEAD", "POST"],
    url: "/heartbeat/:id",
    handler: async (req, reply) => {
      const watch = lab.watchdogs.find((w) => w.id === req.params.id);
      if (!watch)
        return reply.code(404).send({ error: "Unknown heartbeat URL" });
      await lab.ping(watch);
      return { received: true, status: watch.status };
    },
  });
  await app.register(async (endpoints) => {
    endpoints.removeAllContentTypeParsers();
    endpoints.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      (_req, payload, done) => done(null, payload),
    );
    for (const url of ["/chaos/:id", "/chaos/:id/*"])
      endpoints.route<{ Params: { id: string } }>({
        method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        url,
        handler: async (req, reply) => {
          const config = lab.chaos.find((c) => c.id === req.params.id);
          if (!config)
            return reply.code(404).send({ error: "Unknown chaos URL" });
          const result = lab.chaosResponse(config);
          await sleep(result.delayMs);
          return reply
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Headers", "*")
            .header(
              "Access-Control-Allow-Methods",
              "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
            )
            .code(result.status)
            .send({
              simulated: true,
              attempt: result.attempt,
              status: result.status,
              delayMs: result.delayMs,
            });
        },
      });
    for (const url of ["/mock/:id", "/mock/:id/*"])
      endpoints.route<{ Params: { id: string } }>({
        method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        url,
        handler: async (req, reply) => {
          const service = lab.mocks.find((m) => m.id === req.params.id);
          if (!service)
            return reply.code(404).send({ error: "Unknown mock API" });
          reply
            .header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Headers", "*")
            .header(
              "Access-Control-Allow-Methods",
              "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
            );
          if (req.method === "OPTIONS") return reply.code(204).send();
          const target = new URL(req.raw.url!, "http://localhost");
          const path =
            target.pathname.slice(("/mock/" + req.params.id).length) || "/";
          const result = lab.mockResponse(
            service,
            req.method,
            path,
            target.searchParams,
            req.headers.authorization,
          );
          await sleep(result.route?.delayMs ?? 0);
          reply.header(
            "Content-Security-Policy",
            "default-src 'none'; sandbox",
          );
          for (const [name, value] of result.route?.headers ?? [])
            reply.header(name, value);
          if (result.retryAfter) reply.header("Retry-After", result.retryAfter);
          return reply
            .type(result.route?.contentType ?? "application/json")
            .code(result.status)
            .send(result.body);
        },
      });
  });
  return lab;
}
