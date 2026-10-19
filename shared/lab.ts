import type { CapturedRequest, HeaderPair } from "./types.js";
import { replayHeaders, replayUrl } from "./replay.js";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export interface Difference {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
}
export function diffValues(
  before: unknown,
  after: unknown,
  path = "$",
  depth = 0,
): Difference[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    depth < 16 &&
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after)
  ) {
    const a = before as Record<string, unknown>,
      b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .flatMap((key) =>
        !Object.hasOwn(a, key)
          ? [
              {
                path: `${path}[${JSON.stringify(key)}]`,
                kind: "added" as const,
                after: b[key],
              },
            ]
          : !Object.hasOwn(b, key)
            ? [
                {
                  path: `${path}[${JSON.stringify(key)}]`,
                  kind: "removed" as const,
                  before: a[key],
                },
              ]
            : diffValues(
                a[key],
                b[key],
                `${path}[${JSON.stringify(key)}]`,
                depth + 1,
              ),
      )
      .slice(0, 500);
  }
  return [{ path, kind: "changed", before, after }];
}
export function setJsonPath(
  value: Json,
  path: string,
  replacement: Json,
): Json {
  if (!path.trim()) return replacement;
  const parts = path.split(".");
  if (
    parts.some(
      (key) => !key || ["__proto__", "prototype", "constructor"].includes(key),
    )
  )
    throw Error(
      "Use a dot-separated field path without reserved property names.",
    );
  const result = structuredClone(value);
  let current: Json = result;
  for (const [i, key] of parts.entries()) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    )
      throw Error(
        `Field ${parts.slice(0, i).join(".") || "$"} must be an object.`,
      );
    if (i === parts.length - 1) current[key] = replacement;
    else {
      if (!Object.hasOwn(current, key))
        Object.defineProperty(current, key, {
          value: {},
          enumerable: true,
          writable: true,
          configurable: true,
        });
      current = current[key];
    }
  }
  return result;
}
export interface Mutation {
  name: string;
  body: string;
}
export function mutatePayload(text: string): Mutation[] {
  const value = JSON.parse(text) as Json;
  const results: Mutation[] = [
    { name: "Original (control)", body: text },
    { name: "Null root", body: "null" },
    { name: "Empty object", body: "{}" },
    { name: "Unexpected array", body: "[]" },
  ];
  function walk(node: Json, parts: string[] = []) {
    if (
      !node ||
      typeof node !== "object" ||
      Array.isArray(node) ||
      parts.length > 4
    )
      return;
    for (const [key, child] of Object.entries(node).slice(0, 12)) {
      if (
        ["__proto__", "constructor", "prototype"].includes(key) ||
        key.includes(".")
      )
        continue;
      const path = [...parts, key].join(".");
      const clone = structuredClone(value);
      let parent = clone as Record<string, Json>;
      for (const segment of parts)
        parent = parent[segment] as Record<string, Json>;
      delete parent[key];
      results.push({
        name: `Remove ${path}`,
        body: JSON.stringify(clone, null, 2),
      });
      for (const [label, replacement] of [
        ["null", null],
        ["wrong type", typeof child === "string" ? 42 : "unexpected"],
        ["Unicode", "こんにちは 🚀 e\u0301"],
        ["long string", "x".repeat(8192)],
      ] as const) {
        results.push({
          name: `${path}: ${label}`,
          body: JSON.stringify(setJsonPath(value, path, replacement), null, 2),
        });
      }
      if (results.length < 80) walk(child, [...parts, key]);
      if (results.length >= 100) return;
    }
  }
  walk(value);
  return results.slice(0, 100);
}
export interface Shape {
  type: string[];
  properties?: Record<string, Shape>;
  required?: string[];
  items?: Shape;
}
const typeOf = (v: unknown) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
export function inferShape(values: unknown[], depth = 0): Shape {
  if (!values.length) return { type: [] };
  if (depth > 12) throw Error("Payload nesting exceeds 12 levels.");
  const shape: Shape = { type: [...new Set(values.map(typeOf))].sort() };
  const objects = values.filter(
    (v) => v && !Array.isArray(v) && typeof v === "object",
  ) as Record<string, unknown>[];
  if (objects.length) {
    const keys = [...new Set(objects.flatMap(Object.keys))];
    if (keys.length > 500)
      throw Error("Too many fields to learn (maximum 500 per object).");
    shape.properties = Object.fromEntries(
      keys.map((key) => [
        key,
        inferShape(
          objects.filter((o) => Object.hasOwn(o, key)).map((o) => o[key]),
          depth + 1,
        ),
      ]),
    );
    shape.required = keys.filter((key) =>
      objects.every((o) => Object.hasOwn(o, key)),
    );
  }
  const elements = values.filter(Array.isArray).flat();
  if (elements.length) shape.items = inferShape(elements, depth + 1);
  return shape;
}
export function checkShape(
  shape: Shape,
  value: unknown,
  path = "$",
  depth = 0,
): string[] {
  if (depth > 12) return [`${path}: nesting exceeds 12 levels`];
  if (!shape || !Array.isArray(shape.type))
    throw Error(
      "Invalid contract file. Learn a baseline or import an exported contract.",
    );
  if (!shape.type.includes(typeOf(value)))
    return [
      `${path}: expected ${shape.type.join(" or ")}, received ${typeOf(value)}`,
    ];
  const issues: string[] = [];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of shape.required ?? [])
      if (!Object.hasOwn(object, key))
        issues.push(`${path}.${key}: required field is missing`);
    for (const [key, child] of Object.entries(object)) {
      if (!shape.properties || !Object.hasOwn(shape.properties, key))
        issues.push(`${path}.${key}: new field`);
      else
        issues.push(
          ...checkShape(
            shape.properties[key],
            child,
            `${path}.${key}`,
            depth + 1,
          ),
        );
      if (issues.length >= 200) break;
    }
  } else if (Array.isArray(value) && shape.items)
    value
      .slice(0, 100)
      .forEach((item, i) =>
        issues.push(
          ...checkShape(shape.items!, item, `${path}[${i}]`, depth + 1),
        ),
      );
  return issues.slice(0, 200);
}
export interface ReplayRecord {
  label: string;
  method: string;
  query: string;
  headers: HeaderPair[];
  bodyBase64: string;
  receivedAt: string;
  delayMs?: number;
  destination?: string;
  useTrigger?: boolean;
  changes?: { path: string; value: Json }[];
}
export function sequencePlan(
  records: ReplayRecord[],
  options: {
    order: "original" | "reverse" | "shuffle";
    seed?: number;
    duplicates?: number;
    omitEvery?: number;
    speed?: number;
    burst?: boolean;
  },
): ReplayRecord[] {
  if (
    options.duplicates !== undefined &&
    (!Number.isInteger(options.duplicates) ||
      options.duplicates < 1 ||
      options.duplicates > 10)
  )
    throw Error("Choose 1–10 copies of each event.");
  if (
    options.omitEvery !== undefined &&
    (!Number.isInteger(options.omitEvery) ||
      options.omitEvery < 0 ||
      options.omitEvery > 100)
  )
    throw Error("Omission interval must be an integer from 0 to 100.");
  if (options.seed !== undefined && !Number.isInteger(options.seed))
    throw Error("Shuffle seed must be an integer.");
  let list = [...records].sort(
    (a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt),
  );
  if (options.omitEvery && options.omitEvery > 0)
    list = list.filter((_, i) => (i + 1) % options.omitEvery! !== 0);
  if (options.order === "reverse") list.reverse();
  if (options.order === "shuffle") {
    let seed = options.seed ?? 42;
    for (let i = list.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const j = seed % (i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  const speed = options.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0)
    throw Error("Replay speed must be greater than zero.");
  return list.flatMap((entry, i) =>
    Array.from(
      { length: Math.min(10, Math.max(1, options.duplicates ?? 1)) },
      (_, copy) => ({
        ...entry,
        label: copy ? `${entry.label} (copy ${copy + 1})` : entry.label,
        delayMs:
          copy || !i || options.burst
            ? 0
            : Math.min(
                3600000,
                Math.abs(
                  Date.parse(entry.receivedAt) -
                    Date.parse(list[i - 1].receivedAt),
                ) / speed,
              ),
      }),
    ),
  );
}
export function runnerScript(
  records: ReplayRecord[],
  destination: string,
  options: { burst?: boolean; listenPort?: number } = {},
): string {
  replayUrl(destination, "");
  if (!records.length || records.length > 1000)
    throw Error("Choose between 1 and 1,000 requests.");
  for (const record of records) {
    replayUrl(record.destination || destination, record.query);
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(record.method))
      throw Error("Unsupported request method.");
  }
  const config = {
    destination,
    records: records.map((r) => ({
      ...r,
      headers: replayHeaders(r.headers),
      url: replayUrl(r.destination || destination, r.query),
    })),
    burst: !!options.burst,
    listenPort: options.listenPort,
  };
  return `// Webhook Lab local runner. Requires Node.js 22+.\n// Review the destination below, then run: node webhook-replay.mjs\nimport http from 'node:http';\nimport https from 'node:https';\nimport { setTimeout as sleep } from 'node:timers/promises';\nconst config = ${JSON.stringify(config, null, 2)};\nasync function send(entry, trigger) {\n  let body = entry.useTrigger && trigger ? trigger : Buffer.from(entry.bodyBase64, 'base64');\n  if(entry.changes?.length) { let value=JSON.parse(body.toString('utf8')); for(const change of entry.changes) { const parts=change.path.split('.'); if(parts.some(p=>!p||['__proto__','constructor','prototype'].includes(p))) throw Error('Invalid field path'); let current=value;for(const key of parts.slice(0,-1)){if(!current||typeof current!=='object'||Array.isArray(current))throw Error('Field parent must be an object');if(!Object.hasOwn(current,key))current[key]={};current=current[key];}if(!current||typeof current!=='object'||Array.isArray(current))throw Error('Field parent must be an object');current[parts.at(-1)]=change.value;}body=Buffer.from(JSON.stringify(value)); }\n  const started = Date.now();\n  await new Promise(resolve => {\n    const headers = {};\n    for (const [name, value] of entry.headers) { const key=name.toLowerCase(); if(headers[key]===undefined) headers[key]=value; else headers[key]=[].concat(headers[key],value); }\n    if (body.length) headers['content-length'] = String(body.length);\n    const request = (entry.url.startsWith('https:') ? https : http).request(entry.url, { method:entry.method,headers,timeout:15000 }, response => {\n      response.resume(); response.on('end', () => { console.log(entry.label + ' → ' + response.statusCode + ' (' + (Date.now()-started) + 'ms)'); if(response.statusCode >= 400) process.exitCode = 1; resolve(); });\n      response.on('error', error => { console.error(entry.label + ': ' + error.message);process.exitCode=1;resolve(); });\n    });\n    request.on('timeout', () => request.destroy(new Error('15 second timeout')));\n    request.on('error', error => { console.error(entry.label + ': ' + error.message); process.exitCode=1; resolve(); });\n    request.end(body);\n  });\n}\nasync function run(trigger) {\n  if(config.burst) await Promise.all(config.records.map(entry => send(entry,trigger)));\n  else for(const entry of config.records) { await sleep(entry.delayMs || 0); await send(entry,trigger); }\n}\n${options.listenPort ? `const server = http.createServer(async (request,response) => {\n  const chunks=[];let size=0;for await (const chunk of request) {size+=chunk.length;if(size>1048576){response.writeHead(413).end();return;}chunks.push(chunk);}\n  response.writeHead(202).end('Workflow accepted');\n  try { await run(Buffer.concat(chunks)); } catch(error) { console.error(error.message);process.exitCode=1; }\n});\nserver.listen(config.listenPort,'127.0.0.1',()=>console.log('Waiting for a local trigger at http://localhost:'+config.listenPort));` : "await run();"}\n`;
}
export function fromCapture(
  request: CapturedRequest,
  bodyBase64: string,
): ReplayRecord {
  return {
    label: `${request.method} ${request.path}`,
    method: request.method,
    query: request.query,
    headers: replayHeaders(request.headers),
    bodyBase64,
    receivedAt: request.receivedAt,
  };
}
