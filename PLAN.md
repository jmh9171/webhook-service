# Personal webhook capture tool

Status: deployed and verified on Sevalla, October 19, 2026. Live dashboard: https://webhook-inbox-pa23o.sevalla.app. See DEPLOYMENT.md for resource details.

## Confirmed goal

Receive webhook requests at a public URL, inspect them in a browser, then copy a request into Postman to replay against localhost. This is a personal testing tool with disposable request history.

## Simplest design: no database

- One TypeScript Node.js application with a small Fastify backend and React/Vite frontend, served together in production.
- Keep recent requests in a bounded in-memory buffer. No PostgreSQL, Prisma, SQLite, migrations, persistent disk, or separate worker.
- Run exactly one application instance. Each instance has its own memory, so horizontal scaling is outside this design.
- A restart, crash, or deployment clears request history. Refreshing or closing the browser does not clear server memory while the same process remains running.
- Use a stable capture token supplied through an environment variable so the webhook URL survives restarts even though history does not.
- Use a dedicated username/password login page with in-memory sessions and an explicit sign-out action. Session cookies are HttpOnly, SameSite=Strict, and Secure in production, expiring after 24 hours or server restart. Credentials remain private environment variables. No registration or session database. The capture URL stays accessible to webhook senders.

## First version

1. One capture URL: `/hooks/:token`, with optional descendant paths.
2. Receive common HTTP methods, retain raw body bytes, method, path/query, headers, and arrival time, and send a static HTTP 200 acknowledgment after adding the request to memory.
3. A two-panel dashboard: recent requests on the left; selected request body, headers, and query parameters on the right.
4. Poll for new requests every two seconds while the dashboard is open. No event streaming infrastructure.
5. Set a complete local replay URL once in the browser's replay settings, such as `http://localhost:3000/api/webhooks`. Save changes automatically in localStorage and reuse the saved URL for every cURL export, including after a page refresh.
6. Copy the body or select **Copy for Postman** to generate an importable cURL command using that local destination.
7. Clear history with one button.

The replay destination is a browser-only setting, never an environment variable or a hardcoded destination. Each browser remembers its own URL; offer an editable setting and explain when browser storage is unavailable. Keep captured payloads on the server only. Multiple inboxes, advanced search, Postman collections, custom responses, and forwarding can wait until there is a concrete need.

## Small but necessary limits

- Keep up to 100 requests, with a 1 MiB limit per incoming body and a 20 MiB total retained-body budget. Evict the oldest requests when the count or retained-body budget is reached.
- Bound headers and URL sizes too, so metadata cannot grow without limit. Reject oversized incoming bodies rather than keeping incomplete captures.
- Treat captured content as escaped text in the UI. Protect all inspection, export, and clear-history endpoints; the capture token must not authorize reading history.
- Keep credentials and captured payloads out of application logs. Use the private secret-entry flow for deployment credentials when needed.
- Show that history is temporary and that old entries are evicted automatically.

## Replay behavior

- Preserve the captured method, raw body, duplicate query parameters, and selected application headers. Show the final local URL before copying.
- Remove transport/proxy headers such as Host, Content-Length, Connection, and forwarded headers. Let Postman generate its own transport headers.
- Exclude Authorization and Cookie initially, with an explicit option to include them for local testing. Show which headers are omitted.
- Escape generated cURL arguments correctly, including quotes, multiline text, Unicode, and shell syntax inside payloads.
- For binary or other non-copyable bodies, provide a raw body download to attach in Postman. JSON formatting is for display only and must not alter exported bytes.
- Old webhook signatures can fail freshness checks; signatures covering the destination URL can fail after switching to localhost. Provider-specific re-signing is outside the initial scope.
- Postman on the user's computer sends the replay to localhost. The hosted app only captures and exports, so no local tunnel is required.

## SQLite alternative

SQLite is possible if on-disk querying becomes useful. Put its file in a disposable runtime directory and explicitly recreate it when the application starts for a predictable reset policy. A reset during the build alone is not the same as resetting a running process or an attached persistent volume.

SQLite adds a file lifecycle and database schema without helping the current workflow. Start with memory; adopt SQLite only if a later requirement benefits from it.

## Implementation and deployment

1. Scaffold TypeScript, React/Vite, and Fastify; add the memory buffer, capture endpoint, and the login page and session authentication.
2. Build the inspector and cURL export. Verify public capture, private inspection, raw body fidelity, local replay, limits/eviction, and clearing history.
3. Package as one Docker application. Deploy one instance to Sevalla with capture/auth settings supplied privately, no database service, and no persistent disk.
4. Verify public HTTPS capture, dashboard access, Postman replay against a local echo endpoint, and history reset after restarting the app. Confirm the capture URL remains stable.

Source: https://github.com/jmh9171/webhook-service. The user explicitly approved making this repository public after Sevalla's private-Git connection returned HTTP 500. The app uses the public-Git source and a Dockerfile build. API keys and generated runtime credentials remain in ignored local files and private hosting settings.

## References checked during initial planning

- [Postman cURL import](https://learning.postman.com/latest-v-12/docs/getting-started/importing-and-exporting/importing-data)
- [Postman raw and binary bodies](https://learning.postman.com/docs/sending-requests/create-requests/parameters/)
- [Sevalla API](https://api-docs.sevalla.com/)

## Completed verification

- All 15 automated tests pass, including actual cURL replays of captured text and binary payloads to a local HTTP receiver.
- TypeScript checks and the production build pass.
- Production smoke checks pass for password-protected HTML/assets, public capture, and authenticated request history.
- Browser checks confirm test capture, cURL copying, saved local replay URL after a page refresh, and a mobile layout without horizontal overflow.
- Sevalla built the Docker image and completed the production deployment successfully.
- Live HTTPS verification passed for health, protected dashboard/history, frontend assets, public capture, body download fidelity, duplicate query parameters, and a real cURL replay from the hosted capture to a local HTTP receiver. An actual Postman UI import was not performed.

## Completed expansion: Webhook Lab

The user subsequently authorized all suggested advanced testing tools and the earlier common utilities. The expanded interface has separate feature pages grouped by Inspect, Local replay, Hosted simulators, Monitor, and Utilities. See README.md for the full feature map, limits, and execution model.

The implementation keeps the original no-database, one-instance design. Local scripts perform localhost replay, timed recordings, ordering/duplicate simulations, payload mutation, and multi-step workflows. Server memory holds bounded chaos endpoints, mock APIs, watches, and correlated events. Browser-only tools handle JSON, contracts, signatures, JWTs, encoding, hashes, timestamps, and UUIDs. Download/import support preserves workflows, contract baselines, and mock definitions when needed. App Notifier integration is exposed through external event ingestion and optional alert webhooks; its repository and deployment are unchanged.

The expansion passed 27 automated tests, focused generated-script HTTP checks, the production build, desktop/mobile browser checks, and live Sevalla verification. Deployment details are recorded in DEPLOYMENT.md.
