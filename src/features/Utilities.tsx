import { useState } from "react";
import {
  CaptureSelect,
  Code,
  Copy,
  ErrorBox,
  Field,
  fromBase64,
  Note,
  Page,
  Panel,
  toBase64,
} from "../lab-ui";
const decoder = new TextDecoder("utf-8", { fatal: true });
export function JwtPage() {
  const [token, setToken] = useState("");
  let result = "",
    error = "";
  try {
    if (token) {
      const parts = token.trim().split(".");
      if (parts.length !== 3)
        throw Error("A JWT has three dot-separated parts.");
      const header = JSON.parse(decoder.decode(fromBase64(parts[0]))),
        claims = JSON.parse(decoder.decode(fromBase64(parts[1])));
      const times = Object.fromEntries(
        ["iat", "nbf", "exp"]
          .filter((k) => typeof claims[k] === "number")
          .map((k) => [
            k,
            {
              utc: new Date(claims[k] * 1000).toISOString(),
              local: new Date(claims[k] * 1000).toLocaleString(),
              ...(k === "exp"
                ? { expired: Date.now() >= claims[k] * 1000 }
                : {}),
            },
          ]),
      );
      result = JSON.stringify({ header, claims, times }, null, 2);
    }
  } catch (e) {
    error = (e as Error).message;
  }
  return (
    <Page
      eyebrow="UTILITIES"
      title="JWT inspector"
      description="Read a token’s header, claims, and timestamps without sending it to the server."
    >
      <Panel title="Token">
        <textarea
          rows={5}
          aria-label="JWT token"
          placeholder="eyJ…"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <Note>
          Decoded only. This does not verify the signature or establish that a
          token is trustworthy.
        </Note>
        <ErrorBox error={error} />
      </Panel>
      {result && (
        <Panel title="Decoded token">
          <Code value={result} />
          <Copy value={result} />
        </Panel>
      )}
    </Page>
  );
}
export function EncodingPage() {
  const [input, setInput] = useState(""),
    [operation, setOperation] = useState("base64-encode"),
    [secret, setSecret] = useState(""),
    [result, setResult] = useState(""),
    [error, setError] = useState("");
  async function run() {
    try {
      const bytes = new TextEncoder().encode(input);
      let output = "";
      if (operation === "base64-encode") output = toBase64(bytes);
      if (operation === "base64-decode")
        output = decoder.decode(fromBase64(input.trim()));
      if (operation === "url-encode") output = encodeURIComponent(input);
      if (operation === "url-decode") output = decodeURIComponent(input);
      if (operation === "json-escape") output = JSON.stringify(input);
      if (operation === "json-unescape") {
        const parsed = JSON.parse(input);
        if (typeof parsed !== "string")
          throw Error("Paste a quoted JSON string.");
        output = parsed;
      }
      if (operation === "hmac") {
        if (!secret) throw Error("Enter a signing secret.");
        const key = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        output = Array.from(
          new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes)),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
      }
      if (operation === "sha256")
        output = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
      setResult(output);
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setResult("");
    }
  }
  return (
    <Page
      eyebrow="UTILITIES"
      title="Encoding & hashes"
      description="Convert strings and calculate SHA-256 hashes entirely in your browser."
    >
      <Panel title="Convert a value">
        <Field label="Operation">
          <select
            value={operation}
            onChange={(e) => {
              setOperation(e.target.value);
              setResult("");
            }}
          >
            {[
              ["base64-encode", "Text → Base64"],
              ["base64-decode", "Base64 → Text"],
              ["url-encode", "URL encode"],
              ["url-decode", "URL decode"],
              ["json-escape", "Escape as JSON string"],
              ["json-unescape", "Unescape JSON string"],
              ["sha256", "SHA-256 hash"],
              ["hmac", "HMAC-SHA256 (hex)"],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {operation === "hmac" && (
          <Field label="Signing secret">
            <input
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </Field>
        )}
        <textarea
          rows={8}
          aria-label="Input value"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste a value…"
        />
        <button className="button primary" onClick={() => void run()}>
          Convert
        </button>
        <ErrorBox error={error} />
      </Panel>
      {result && (
        <Panel title="Result" actions={<Copy value={result} />}>
          <Code value={result} />
        </Panel>
      )}
    </Page>
  );
}
export function TimePage() {
  const [input, setInput] = useState(""),
    [unit, setUnit] = useState("seconds"),
    [ids, setIds] = useState<string[]>([]);
  let result = "",
    error = "";
  try {
    if (input) {
      const date = /^-?\d+(\.\d+)?$/.test(input)
        ? new Date(Number(input) * (unit === "seconds" ? 1000 : 1))
        : new Date(input);
      if (Number.isNaN(date.getTime()))
        throw Error(
          "Enter a Unix timestamp or a date such as 2026-10-19T12:00:00Z.",
        );
      result = JSON.stringify(
        {
          utc: date.toISOString(),
          local: date.toLocaleString(),
          unixSeconds: Math.floor(date.getTime() / 1000),
          unixMilliseconds: date.getTime(),
        },
        null,
        2,
      );
    }
  } catch (e) {
    error = (e as Error).message;
  }
  return (
    <Page
      eyebrow="UTILITIES"
      title="Time & IDs"
      description="Make timestamps readable and generate UUIDs for test events."
    >
      <div className="lab-columns">
        <Panel title="Timestamp converter">
          <Field label="Timestamp or ISO date">
            <input
              className="technical"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="1792411200 or 2026-10-19T12:00:00Z"
            />
          </Field>
          <Field label="Numeric timestamp units">
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="seconds">Seconds</option>
              <option value="milliseconds">Milliseconds</option>
            </select>
          </Field>
          <button
            className="button"
            onClick={() => {
              setUnit("milliseconds");
              setInput(String(Date.now()));
            }}
          >
            Use current time
          </button>
          <ErrorBox error={error} />
          {result && (
            <>
              <Code value={result} />
              <Copy value={result} />
            </>
          )}
        </Panel>
        <Panel
          title="UUID generator"
          description="Random UUID v4 values, ready to use as event or correlation IDs."
        >
          <div className="lab-actions">
            <button
              className="button primary"
              onClick={() => setIds([crypto.randomUUID()])}
            >
              Generate one
            </button>
            <button
              className="button"
              onClick={() =>
                setIds(Array.from({ length: 10 }, () => crypto.randomUUID()))
              }
            >
              Generate ten
            </button>
          </div>
          {ids.length > 0 && (
            <>
              <Code value={ids.join("\n")} />
              <Copy value={ids.join("\n")} />
            </>
          )}
        </Panel>
      </div>
    </Page>
  );
}
function hex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function SignaturePage() {
  const [preset, setPreset] = useState("generic"),
    [body, setBody] = useState(""),
    [secret, setSecret] = useState(""),
    [signature, setSignature] = useState(""),
    [timestamp, setTimestamp] = useState(""),
    [id, setId] = useState(""),
    [result, setResult] = useState(""),
    [error, setError] = useState("");
  async function verify() {
    try {
      let message = body,
        keyBytes = new TextEncoder().encode(secret),
        candidates: string[] = [],
        format: "hex" | "base64" = "hex",
        time = "";
      if (!secret)
        throw Error(
          "Enter the signing secret. It is used only in this browser.",
        );
      if (preset === "stripe") {
        const parts = signature.split(",").map((p) => p.trim());
        time = parts.find((p) => p.startsWith("t="))?.slice(2) || timestamp;
        if (!/^\d+$/.test(time))
          throw Error("Stripe needs a numeric t= timestamp.");
        candidates = parts
          .filter((p) => p.startsWith("v1="))
          .map((p) => p.slice(3));
        message = `${time}.${body}`;
      } else if (preset === "svix") {
        time = timestamp;
        if (!id || !/^\d+$/.test(time))
          throw Error("Svix needs the webhook ID and numeric timestamp.");
        keyBytes = fromBase64(secret.replace(/^whsec_/, ""));
        message = `${id}.${time}.${body}`;
        format = "base64";
        candidates = signature
          .split(" ")
          .filter((p) => p.startsWith("v1,"))
          .map((p) => p.slice(3));
      } else if (preset === "shopify") {
        format = "base64";
        candidates = [signature.trim()];
      } else candidates = [signature.trim().replace(/^sha256=/, "")];
      if (!candidates.length || !candidates[0])
        throw Error("Paste a signature header value.");
      const key = await crypto.subtle.importKey(
        "raw",
        keyBytes.buffer as ArrayBuffer,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
      const bytes = new TextEncoder().encode(message);
      let matches = false;
      for (const candidate of candidates) {
        try {
          if (format === "hex" && !/^[\da-f]{64}$/i.test(candidate)) continue;
          const sig =
            format === "hex"
              ? Uint8Array.from(
                  candidate.match(/../g)!.map((s) => parseInt(s, 16)),
                )
              : fromBase64(candidate);
          if (
            await crypto.subtle.verify(
              "HMAC",
              key,
              sig.buffer as ArrayBuffer,
              bytes,
            )
          )
            matches = true;
        } catch {
          /* Invalid candidate does not match. */
        }
      }
      const digest = new Uint8Array(
        await crypto.subtle.sign("HMAC", key, bytes),
      );
      const stale = time && Math.abs(Date.now() / 1000 - Number(time)) > 300;
      setResult(
        `${matches ? "Signature matches." : "Signature does not match."}${time ? `\nTimestamp: ${new Date(Number(time) * 1000).toISOString()}\n${stale ? "Outside a 5-minute freshness window." : "Within a 5-minute freshness window."}` : ""}\n\nCalculated HMAC-SHA256 (${format}):\n${format === "hex" ? hex(digest) : toBase64(digest)}`,
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setResult("");
    }
  }
  return (
    <Page
      eyebrow="INSPECT"
      title="Signature checker"
      description="Compare a webhook’s signature with its original body. Signing secrets stay in this browser’s memory."
    >
      <Panel title="Provider and request">
        <Field label="Signature format">
          <select
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value);
              setResult("");
            }}
          >
            <option value="generic">Generic HMAC-SHA256 (hex)</option>
            <option value="github">GitHub · X-Hub-Signature-256</option>
            <option value="stripe">Stripe · Stripe-Signature</option>
            <option value="shopify">Shopify · X-Shopify-Hmac-Sha256</option>
            <option value="svix">Svix · webhook-signature</option>
          </select>
        </Field>
        <CaptureSelect
          onLoad={(r) => {
            if (r.binary) {
              setError(
                "Choose a text capture. Binary signatures need the original file bytes.",
              );
              return;
            }
            setBody(r.bodyText || "");
            const headers = Object.fromEntries(
              r.headers.map(([k, v]) => [k.toLowerCase(), v]),
            );
            const names: Record<string, string> = {
              generic: "x-signature",
              github: "x-hub-signature-256",
              stripe: "stripe-signature",
              shopify: "x-shopify-hmac-sha256",
              svix: "webhook-signature",
            };
            setSignature(
              headers[names[preset]] || headers["svix-signature"] || "",
            );
            setTimestamp(
              headers["webhook-timestamp"] || headers["svix-timestamp"] || "",
            );
            setId(headers["webhook-id"] || headers["svix-id"] || "");
            setResult("");
            setError("");
          }}
        />
        <Field
          label="Original request body"
          help="Do not format or edit a captured body before checking its signature."
        >
          <textarea
            rows={9}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        <div className="lab-form-grid">
          <Field label="Signing secret">
            <input
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </Field>
          <Field label="Signature header">
            <input
              className="technical"
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder={
                preset === "stripe"
                  ? "t=…,v1=…"
                  : preset === "svix"
                    ? "v1,…"
                    : "Paste the complete header value"
              }
            />
          </Field>
          {preset === "svix" && (
            <>
              <Field label="Webhook ID">
                <input value={id} onChange={(e) => setId(e.target.value)} />
              </Field>
              <Field label="Webhook timestamp (Unix seconds)">
                <input
                  value={timestamp}
                  onChange={(e) => setTimestamp(e.target.value)}
                />
              </Field>
            </>
          )}
        </div>
        <button className="button primary" onClick={() => void verify()}>
          Check signature
        </button>
        <ErrorBox error={error} />
      </Panel>
      {result && (
        <Panel title="Verification result">
          <Code value={result} />
          <Note>
            Timestamp freshness is reported separately. A matching signature
            from an old event can still be rejected by your application.
          </Note>
        </Panel>
      )}
    </Page>
  );
}
