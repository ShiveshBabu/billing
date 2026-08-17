# Deployment Guide — Sri Velan Pasumai ERP

This backend serves both the API and the frontend from one process by
default (`SERVE_FRONTEND=true`), so a typical deployment is **one Railway
service**, one URL, no CORS configuration needed. Everything in this guide
assumes that setup unless stated otherwise.

## Architecture (why same-origin)

```
Browser
   |
   v
Railway service (this repo)
   |
   +-- GET /              → frontend (index.html, support.js, services/*.js, assets/*)
   +-- GET|POST /api/v1/*  → REST API
   +-- GET /api/health     → health check
   |
   v
PostgreSQL (Railway Postgres plugin, or any managed Postgres)
```

Frontend and API sharing one origin means the session cookie is a normal
same-site cookie — no `SameSite=None`, no `CORS_ORIGIN` to get wrong, no
"login spins forever because the cookie got dropped cross-site" class of bug.
If you have a specific reason to deploy the frontend separately, set
`SERVE_FRONTEND=false`; see the "Split deployment" section near the bottom.

---

## Local development

```bash
git clone <this repo>
cd backend
npm install
cp .env.example .env
# edit .env: set DATABASE_URL to a local Postgres, generate SESSION_SECRET with:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

npm run dev
```

Open `http://localhost:4000` — that's the frontend, served by the same
process, talking to the API on the same origin. To seed demo data:

```bash
npm run seed
```

Demo login afterward: username `ravi.velan`, password whatever
`DEV_SEED_PASSWORD` is set to in your `.env` (defaults to `ChangeMe123!`).
**This seed is development/demo data only — never run it against a database
that might hold real business data.**

---

## Production build (what actually runs in production)

```bash
npm run build   # tsc compiles src/ → dist/
npm start       # node dist/server.js
```

On startup the server:
1. Validates required environment variables — fails immediately with a
   specific error if `DATABASE_URL` or `SESSION_SECRET` are missing or left
   as placeholder values (see `src/lib/env.ts`). No obscure crash five
   requests later.
2. Applies the database schema automatically if this is a fresh database
   (tracked via a `_schema_migrations` table, so it's a safe no-op on every
   subsequent restart/redeploy — see `src/lib/migrate.ts`). This does **not**
   run the seed script — seeding is always a separate, manual, explicit step.
3. Starts listening on `0.0.0.0:$PORT` (Railway sets `PORT` automatically —
   never hardcode a port in production).

---

## Deploying to Railway

1. **Create a Postgres database** — add the Postgres plugin to your Railway
   project (or bring your own managed Postgres).
2. **Create the app service** from this repo. Railway auto-detects Node via
   Nixpacks; `railway.toml` in this repo pins the exact build/start commands
   and health check path so there's one unambiguous path (no guessing).
3. **Set environment variables** on the service (Variables tab):

   | Variable | Required | Purpose | Example |
   |---|---|---|---|
   | `DATABASE_URL` | Yes | Postgres connection string | Reference the Postgres plugin's own variable, e.g. `${{Postgres.DATABASE_URL}}` |
   | `SESSION_SECRET` | Yes | Signs session cookies | Generate with the node command above |
   | `NODE_ENV` | Recommended | Enables secure cookies, redacted logs | `production` |
   | `SERVE_FRONTEND` | No (defaults true) | Same-origin frontend serving | `true` |
   | `APP_URL` | Recommended | Used in password-reset links | `https://your-app.up.railway.app` |
   | `BACKUP_DIRECTORY` | No | Where local backups are written | `./backups` |
   | `SMTP_HOST`/`SMTP_USER`/`SMTP_PASSWORD`/`SMTP_FROM` | No | Real password-reset email delivery | see `.env.example` |
   | `CORS_ORIGIN` | Only if `SERVE_FRONTEND=false` | Exact frontend origin | `https://your-frontend.up.railway.app` |

   Never paste real secrets into files that get committed — set them in
   Railway's dashboard directly.

4. **Deploy.** Railway builds with `npm install && npm run build` and starts
   with `npm start`, then polls `GET /api/health` to confirm the deploy is
   healthy (`healthcheckPath` in `railway.toml`).
5. **Seed demo data (optional, one-time, manual):** open the service's shell
   in Railway (or run `railway run npm run seed` via the Railway CLI locally)
   — do this deliberately, never as part of the automated build/deploy.
6. **Verify:**
   ```bash
   SMOKE_TEST_URL=https://your-app.up.railway.app \
   SMOKE_TEST_USER=ravi.velan SMOKE_TEST_PASSWORD=<your password> \
     npm run smoke-test
   ```

---

## One-command local validation

```bash
npm run verify
```

Runs typecheck → tests → build, in that order, and fails on the first real
problem rather than silently continuing. Run this before every deploy.

```bash
npm run smoke-test
```

Hits a running instance (local by default, or `SMOKE_TEST_URL=...` for a
deployed one) and checks: frontend loads, health check responds, session
store is reachable, static assets serve, and — if `SMOKE_TEST_USER`/
`SMOKE_TEST_PASSWORD` are set — a full login + authenticated request.

---

## Backup & restore

```bash
npm run db:backup                                  # creates backups/svp-erp-<timestamp>.dump + .sha256 + .meta.json
bash scripts/db-verify-backup.sh backups/<file>     # actually test-restores it into a scratch DB, then drops the scratch DB
npm run db:restore -- backups/<file>                # restores into DATABASE_URL — requires typing "yes" to confirm
```

- **RPO** (Recovery Point Objective): however often you run `db:backup` — for
  a real production system, schedule this (cron, or a Railway scheduled job)
  rather than relying on someone remembering to run it manually.
- **RTO** (Recovery Time Objective): the time to run `db:restore` against a
  fresh database plus the time to redeploy the app — typically a few minutes
  for a database this size.
- **Retention**: `BACKUP_RETENTION_COUNT` (default 14) — older backups are
  deleted automatically each time `db:backup` runs.
- Verifying a backup with `db-verify-backup.sh` needs a Postgres connection
  that can `CREATE DATABASE` (a scratch DB for the test restore). Your app's
  own `DATABASE_URL` correctly *cannot* do this if it's a least-privilege
  role — that's good security, not a bug. Pass a superuser connection via
  `SUPERUSER_DATABASE_URL` when you want to run this check.
- The in-app "Export" button in Settings is a **browser data export for
  convenience**, not this backup system — it's explicitly labeled as such in
  the UI and does not substitute for the real PostgreSQL backup above.

---

## Troubleshooting

**Build fails** — run `npm run typecheck` locally to see the exact TypeScript
error; the production build (`tsc`) fails on the same errors.

**Server won't start / crashes immediately** — check the first lines of the
log. `src/lib/env.ts` prints exactly which environment variable is missing
or invalid and how to fix it; don't guess.

**Database connection failure** — confirm `DATABASE_URL` is reachable from
where the app runs (Railway's Postgres plugin URL only works from inside
Railway's network, not from your laptop, unless you use their proxy/CLI).

**Frontend loads but can't reach the API** — if `SERVE_FRONTEND=true` (the
default), this shouldn't happen since it's the same origin; check the
Network tab for the actual failing request. If you deliberately run split
deployment (`SERVE_FRONTEND=false`), verify `CORS_ORIGIN` on the backend
exactly matches the frontend's URL (no trailing slash) and that the frontend
sets `window.SVP_API_BASE_URL` to the backend's URL before `support.js` loads.

**Login hangs / spins forever** — almost always a session cookie that's
being silently dropped by the browser. In same-origin mode this shouldn't
occur; if you're on split deployment, you need `SameSite=None` + `Secure`
cookies (already applied automatically when `SERVE_FRONTEND=false`) and an
exact `CORS_ORIGIN` match.

**429 responses** — this is the tiered rate limiter working as designed
(strict on `/auth/login` and password-reset endpoints, generous on health/
CSRF/reads). The response includes a `Retry-After` header. If legitimate
usage is getting throttled, that's a signal to review the tiers in
`src/server.ts`, not to remove the limiter.

**Railway health check failing** — confirm `GET /api/health` returns 200
when you hit the deployed URL directly; if the app isn't starting at all,
the health check will correctly report the deploy as unhealthy — check the
deploy logs for the actual startup error first.

**500 Internal Server Error with no detail** — expected in production
(`NODE_ENV=production` redacts error detail from the client on purpose,
per the error contract). Check the server logs for the real error; it's
never swallowed, just not sent to the browser.

---

## Split deployment (frontend and backend as separate services)

Only do this if you have a specific reason (e.g. a CDN-hosted static
frontend). Set `SERVE_FRONTEND=false` on the backend, then:

1. Set `CORS_ORIGIN` on the backend to the frontend's exact URL.
2. The backend automatically switches session cookies to `SameSite=None` +
   `Secure` in this mode (required for cross-site cookies to work at all).
3. On the frontend, set `window.SVP_API_BASE_URL` to the backend's URL
   *before* `support.js` loads:
   ```html
   <script>window.SVP_API_BASE_URL = 'https://your-backend.up.railway.app';</script>
   <script src="./support.js"></script>
   ```
4. Deploy the contents of `public/` (or wherever your frontend build lives)
   to your static host of choice.

This is strictly more moving parts than the same-origin setup above — only
choose it if same-origin genuinely doesn't fit your infrastructure.
