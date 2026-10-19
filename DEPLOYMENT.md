# Sevalla deployment

Live dashboard: https://webhook-inbox-pa23o.sevalla.app

- Application: `webhook-inbox-pa23o`
- App ID: `85f3515c-acd4-49e2-8926-49c233c1081b`
- Web process ID: `6c75c451-1961-4df1-81c3-57f2a6912e5f`
- Region: Ashburn, Virginia (`us-east4`)
- Runtime: one H1 instance, port 3000; no database or persistent storage
- Build: repository Dockerfile; production frontend and Node backend served together
- Health/readiness path: `/healthz`
- Source: https://github.com/jmh9171/webhook-service, branch `main`
- Verified deployment: `8126b39d-ad45-4662-ab00-779e15881c02`
- Deployed application commit: `e7797123900fc9b0d1422427524f77b9df6ff334`

The repository is public with the user's explicit approval. Sevalla's private-Git creation/connection returned HTTP 500, including after GitHub repository access was enabled; public Git succeeded. Public-Git pushes do not automatically deploy. Trigger deployments explicitly through Sevalla.

The dashboard now uses a dedicated login page, an explicit sign-out control, and 24-hour in-memory sessions. Sessions expire on sign-out or server restart. The dashboard username is `owner`. The generated password and capture token are saved in the local **gitignored** `.env.access.json` and in Sevalla's runtime variables. The Sevalla API token is in the local **gitignored** `.env`; it is not part of the deployed application's configuration. Do not commit either credentials file.

The app's environment variables are runtime-only: `NODE_ENV`, `PORT`, `ADMIN_USER`, `ADMIN_PASSWORD`, and `CAPTURE_TOKEN`. Keep the capture token stable when redeploying so existing webhook URLs continue working. The local replay destination is set and remembered separately by each browser.

Manual deployment: `POST /v3/applications/{app-id}/deployments` with `{"branch":"main"}`. To restart the existing build, use `{"is_restart":true}` instead. To roll back after a future deployment, use `POST /v3/applications/{app-id}/deployments/rollback`. All operations require the Sevalla API key in a bearer header; load it privately rather than inserting it in command arguments or source files.

Verified on October 19, 2026: HTTPS health, dashboard/history authentication, built frontend assets, unauthenticated public capture, byte-preserving body download, duplicate query parameters, and real local cURL replay of a request captured by the hosted app. Request history resets on restarts/deployments and is capped at 100 entries / 20 MiB of bodies.
