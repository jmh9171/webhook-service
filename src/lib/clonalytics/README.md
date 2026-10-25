# Browser analytics

`sdk/capture.ts`, `sdk/browser.ts`, and `shared/contracts.ts` are exact copies of
`/Users/jacobheylek/Repositories/posthog-clone/src/` at commit
`3736e0630a2a9e64b85298a9bc59fbffcc7d75c8`, with relative imports preserved.
Update them together; keep app policy in `../analytics.ts`.

App code imports only `src/lib/analytics.ts`: `track(name, properties)`,
`identify(userId)`, and `resetIdentity()`. The authenticated session supplies the
internal stable subject `webhook-lab:admin`; never use an email or credential.
Identify when a session is established and reset on logout or session loss.
Properties are flat `Record<string, string | number | boolean | null>` values;
nested objects, arrays, and nonfinite numbers are rejected. Use predefined
event names and bounded, nonpersonal properties; never pass
webhook contents, headers, URLs, tokens, or form input.

Vite reads `VITE_ANALYTICS_URL` (collector origin, HTTPS or loopback HTTP) and
`SIGNAL_API_KEY_FRONTEND` (public browser `pk_` key), mapping that exact public
alias to `VITE_ANALYTICS_KEY`. An explicit `VITE_ANALYTICS_KEY` takes precedence.
The private `SIGNAL_API_KEY` is never exposed. Either setting missing makes the wrapper
a silent no-op, with no SDK, listener, timer, or network activity. Invalid
configuration, including server/admin keys, disables it. Consent is enabled
under the internal analytics policy.

Configured clients flush every 10 seconds and when document visibility becomes
hidden. The collector request uses `credentials: 'omit'`, `redirect: 'error'`,
and only `content-type` and `x-project-key` headers. Events stay in SDK memory.
Queued events snapshot their identity at capture. Identity changes preserve
queued and in-flight payloads with that original attribution; reset affects
future events and rotates their anonymous ID. Repeating the same identify
preserves that user's identity and queue.

The shared `analytics` object exposes `flush()` and idempotent `dispose()` for
lifecycle use. The module self-accepts Vite HMR and invalidates its importers;
disposal removes the old instance's interval/listener and clears and aborts SDK
work without a final send. Public calls and background
work contain synchronous failures and unexpected promise rejections.
Development diagnostics contain only fixed codes, counts, and HTTP statuses;
production is silent. SDK messages, IDs, payloads, keys, and errors are never logged.

`createBrowserAnalytics(config, dependencies)` supports isolated tests with
injected SDK, fetch, document, interval functions, HMR registration, and a
development diagnostic sink. Tests use local fakes and never call a collector.
