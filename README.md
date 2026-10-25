# Webhook Lab

A personal webhook testing toolbox. TypeScript, React/Vite, Fastify, one application instance, and temporary memory storage. No database.

Live dashboard: https://webhook-inbox-pa23o.sevalla.app. Access credentials are saved locally in the ignored `.env.access.json`; see [deployment details](DEPLOYMENT.md).

## Feature workspaces

The overview groups tools by task. Each feature has its own page and controls; the green interface uses sans-serif typography with monospace reserved for request data.

| Section | Tools | Where they run |
| --- | --- | --- |
| Inspect | Webhook inbox, HTTP/JSON comparison, contract learning and drift checks, webhook signature verification | Hosted captures; browser analysis |
| Local replay | Time machine, duplicate/shuffle/omit simulator, JSON payload mutation, visual workflows | Downloaded Node.js scripts on your machine |
| Hosted simulators | Chaos endpoints and mock APIs | This application instance |
| Monitor | Correlated event timeline and heartbeat watchdogs | This application instance |
| Utilities | JSON formatting/extraction, JWT decoding, Base64/URL/JSON conversions, SHA-256/HMAC, timestamps, UUIDs | Browser only |

### Local replay and workflows

Choose captured requests, enter your local destination, download the generated `.mjs` script, and run it with Node.js 22+. It preserves body bytes and duplicate query parameters while stripping transport, proxy, and sensitive headers. Time machine controls order and timing; Event disorder changes event multiplicity and selection and sends the resulting sequence without recorded delays. Payload mutation creates separate JSON test cases. The workflow builder supports up to 20 steps, delays, JSON field changes, per-step destinations, import/export, and an optional local HTTP trigger. Triggered workflows apply accumulated field changes to the incoming event. Local scripts are executed by you; the hosted server never forwards traffic to your localhost.

### Hosted endpoints

- **Chaos:** up to 10 endpoints. Fail the first N requests, every Nth request, or a percentage; add delay/jitter (maximum total 10 seconds), choose an error status, inspect attempts, and reset counters.
- **Mock APIs:** up to 10 APIs with 10 routes each. Match methods, literal paths, and `:parameter` segments. Return JSON or text, custom headers, chosen statuses, and delays. Optionally require a test bearer token, paginate an array with `page`/`limit`, or impose a per-route minute limit. CORS is enabled only on simulator endpoints. Bodies are capped at 16 KiB per route. Definitions can be exported and imported; copy an existing API to the editor to create a variant.
- **Heartbeats:** up to 10 watches with interval/grace settings, ping URLs, missed/recovered events, and an optional HTTPS alert webhook. Monitoring continues while the application instance runs, even if the browser closes. Alert delivery uses public IPv4 destinations on HTTPS port 443, pins DNS resolution, follows no redirects, and times out. A failed delivery is shown in the watch. This is a temporary test monitor, not durable uptime monitoring.

### Correlating App Notifier events

The timeline retains up to 300 events. Capture events derive correlation IDs from `X-Correlation-Id`, `X-Request-Id`, `correlationId`, `event_id`, `data.id`, or `id`. External apps can POST `{ "event": "notification.delivered", "correlationId": "order_001", "status": "delivered", "detail": "Email accepted" }` to the event URL shown on the Timeline page. Use the same correlation ID across services. The UI includes an integration cURL example and a test form.

App Notifier has not been modified or merged into this repository. To show actual delivery events, configure its code or an adapter to emit these events. Heartbeat alert receivers must map the documented alert payload to their own notification API. Email, SMS, and Slack credentials remain in the notification service.

### Keeping your work

Captures, simulator definitions, attempt counters, watches, and the timeline reset on restart/deployment. Browser refreshes preserve server state while the same instance runs. The localhost destination remains browser-local. Working analysis and editor drafts last while their page is open; export workflows, contract baselines, and mock definitions before leaving if you need to retain them. Browser utility inputs and signing secrets are not uploaded or saved to localStorage.

## Run locally

Requires Node.js 22.12+ and npm.

```sh
npm install
npm run dev
```

Open http://localhost:3000. The development capture URL is http://localhost:3000/hooks/local. Development binds to loopback and is unauthenticated unless `ADMIN_PASSWORD` is supplied. The test-request button sends a real webhook into the inbox.

## Capture and replay

1. Give your webhook provider the capture URL displayed in the dashboard.
2. Click **Local replay URL** and enter the full local destination once, for example `http://localhost:4000/api/webhooks`.
3. Choose a captured request, select **cURL / Postman**, and click **Copy for Postman**.
4. Import the cURL into the Postman desktop app on your computer and send it.

The local destination and sensitive-header preference are saved automatically in this browser's localStorage. They are never server settings or environment variables. Another browser or a different site origin has its own settings; clearing site data removes them.

Text exports retain the original body, method, and incoming query string. Transport/proxy headers are removed; sensitive headers are excluded unless selected. Binary, compressed, and multipart payloads can be downloaded and attached as a binary body in Postman. Old signatures may fail freshness checks or validation against a different URL.

## Temporary history

The server retains at most 100 requests and 20 MiB of body data, with a 1 MiB per-request body limit. The oldest requests are evicted as limits are reached. **A restart, crash, or deployment clears the inbox.** Browser refreshes preserve history while that server process runs. There is a clear-history button.

Run exactly one application instance. Multiple replicas have separate inboxes. No disk, database, migrations, background workers, or object storage are needed.

## Production / Sevalla

```sh
npm ci
npm run build
npm start
```

Set these environment variables privately in hosting settings (or a gitignored `.env` when running production locally):

| Variable | Purpose |
| --- | --- |
| `NODE_ENV=production` | Serve built frontend and require dashboard protection. |
| `ADMIN_USER` | Login username; defaults to `owner`. |
| `ADMIN_PASSWORD` | Dashboard password, at least 16 characters. |
| `CAPTURE_TOKEN` | Unguessable URL token, at least 20 characters; keep stable across deployments. |
| `PORT` | Listening port; defaults to 3000. |
| `HOST` | Defaults to `0.0.0.0` in production and `127.0.0.1` in development. |
| `SIGNAL_API_KEY` | Optional Signal **server** project key; enables backend analytics. Supply privately at runtime. |

The app has a username/password login page and a sign-out control. Sessions use HttpOnly, SameSite=Strict cookies with Secure enabled in production. They expire after 24 hours, on sign-out, or when the server restarts. Use HTTPS at the hosting proxy for dashboard authentication. Public webhook routes do not require dashboard credentials. Inspection, downloads, and history deletion require authentication. Health checks use `/healthz`. Request bodies and credentials are not logged by the application; hosting access logs may still record URLs.

The included multi-stage Dockerfile builds the frontend/backend, runs as the Node user, and includes a health check. On Sevalla, deploy from this Dockerfile with **one web instance**, port 3000, no persistent volume, and no database. Provisioning requires a Git repository or container image reachable by Sevalla; the API key does not automatically authorize a private Git repository.

The Sevalla API key is only for infrastructure setup. Do not put it in frontend code or the running application's environment. Supply it through the private secret-entry flow when deployment starts.

To verify locally:

```sh
npm test
npm run build
```

See [PLAN.md](PLAN.md) for scope and deployment steps.

## Signal analytics

The backend sends internal usage events to `https://clonalytics-staging-kpjmx.sevalla.app` using Signal's copied server SDK. Set `SIGNAL_API_KEY` privately in the runtime environment (or the ignored local `.env`). Missing or blank keys disable tracking. The key stays on the backend; there is no browser analytics client.

Only successful backend actions are tracked: sign-in/out, accepted webhook and external timeline ingress, request inspection/body downloads, inbox clearing, chaos endpoint creation/reset/deletion, mock API creation/deletion, heartbeat watch creation/deletion/alert tests, and timeline clearing. Browser-only tools and replay script execution do not emit events. Health checks, polling, rejected requests, simulator traffic, and recurring heartbeat pings do not emit events.

Every event includes only `method` and `status_code`. Subjects are the fixed pseudonymous internal IDs `webhook-lab:admin` for dashboard actions and `webhook-lab:collector` for ingress; sender traffic is not attributed to the admin. No usernames, payloads, headers, URLs, query strings, endpoint IDs, correlation IDs, user-entered labels, or credentials are sent. Each accepted HTTP action gets an event ID unique across restarts and stable across SDK delivery retries. Repeated incoming webhook deliveries count as separate accepted captures.

Configure the Signal project's allowed property keys as `method`, `status_code` and allowed event names as:

```text
admin_signed_in
admin_signed_out
webhook_received
external_event_received
request_inspected
request_body_downloaded
inbox_cleared
chaos_endpoint_created
chaos_endpoint_reset
chaos_endpoint_deleted
mock_api_created
mock_api_deleted
heartbeat_watch_created
heartbeat_watch_deleted
heartbeat_alert_tested
timeline_cleared
```

Consent is enabled explicitly for this internal server integration. Captures queue in bounded memory and flush every 10 seconds and on graceful shutdown. Network timeouts, retries, queue limits, and a shutdown deadline keep Signal outages from failing user requests or preventing shutdown. Events can be lost on crashes, queue overflow, or prolonged outages; this is usage analytics rather than an audit log. Diagnostics contain only bounded codes, counts, and HTTP statuses.
