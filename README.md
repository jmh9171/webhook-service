# Webhook Inbox

A personal webhook capture and local replay tool. One application, an in-memory inbox, no database.

Live dashboard: https://webhook-inbox-pa23o.sevalla.app. Access credentials are saved locally in the ignored `.env.access.json`; see [deployment details](DEPLOYMENT.md).

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

The app has a username/password login page and a sign-out control. Sessions use HttpOnly, SameSite=Strict cookies with Secure enabled in production. They expire after 24 hours, on sign-out, or when the server restarts. Use HTTPS at the hosting proxy for dashboard authentication. Public webhook routes do not require dashboard credentials. Inspection, downloads, and history deletion require authentication. Health checks use `/healthz`. Request bodies and credentials are not logged by the application; hosting access logs may still record URLs.

The included multi-stage Dockerfile builds the frontend/backend, runs as the Node user, and includes a health check. On Sevalla, deploy from this Dockerfile with **one web instance**, port 3000, no persistent volume, and no database. Provisioning requires a Git repository or container image reachable by Sevalla; the API key does not automatically authorize a private Git repository.

The Sevalla API key is only for infrastructure setup. Do not put it in frontend code or the running application's environment. Supply it through the private secret-entry flow when deployment starts.

To verify locally:

```sh
npm test
npm run build
```

See [PLAN.md](PLAN.md) for scope and deployment steps.
