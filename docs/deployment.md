# Deployment

The target setup is Postgres on **Neon**, the Express + Socket.IO API on **Render** (from [`render.yaml`](../render.yaml)), and the Next.js app on **Vercel** (from [`apps/web/vercel.json`](../apps/web/vercel.json)).

```mermaid
flowchart LR
  U[Browser] -- "https://slotly.vercel.app/api/*" --> V[Vercel: Next.js]
  V -- "rewrite to API_ORIGIN/api/*" --> R[Render: slotly-api]
  U -- "wss://slotly-api.onrender.com/socket.io" --> R
  R -- "TLS, pooled" --> N[(Neon Postgres)]
  R -- HTTPS --> M[[Mistral]]
```

Deploy in this order: **database, then API, then web, then API CORS**. Each step needs a value from the previous one.

## 1. Neon (database)

1. Create a project with **Postgres 16**, in a region close to your Render region (Render's `oregon` is near AWS `us-west-2`).
2. Copy the **pooled** connection string (host contains `-pooler`). It looks like `postgresql://user:pass@ep-xxx-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require`.
3. No manual DDL is needed. The API applies `db/migrations` on boot. The extensions it creates (`btree_gist`, `citext`, and `pgcrypto` for the seed) are available on Neon.

## 2. Render (API)

1. In Render, choose **New, then Blueprint**, select the GitHub repo, and Render reads `render.yaml`.
2. Fill in the `sync: false` variables when prompted:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Neon pooled string from step 1 |
| `CORS_ORIGINS` | a placeholder for now (e.g. `https://example.com`). Set the real Vercel origin in step 4 |
| `MISTRAL_API_KEY` | optional. Leave it empty to run on the deterministic engine |

   These are set by the blueprint: `NODE_ENV=production`, `NODE_VERSION=22`, `DATABASE_SSL=true`, `PG_POOL_MAX=5`, `JWT_SECRET` (generated), `CROSS_SITE_COOKIES=false`, `TRUST_PROXY_HOPS=2`, `MISTRAL_MODEL=ministral-8b-latest`, `LOG_LEVEL=info`. Every other variable keeps the default from [`env.ts`](../apps/api/src/config/env.ts); see the [README configuration table](../README.md#configuration).

3. What the blueprint runs:
   - **Build:** `npm ci --include=dev && npm run build:api`. This builds `@appt/shared`, then `tsc` writes the API to `apps/api/dist`.
   - **Start:** `npm run db:migrate:prod -w @appt/api && npm start -w @appt/api`. This runs `node dist/db/migrate.js`, which resolves `db/migrations` relative to `apps/api/dist/db` (four levels up is the repo root), applies pending files, then starts `node dist/index.js`.
   - **Health check:** `/health`. It returns 503 if the database is unreachable. Boot also fails fast if `SELECT 1` fails or any env var is invalid (including the `.env.example` placeholder `JWT_SECRET`), and the error names the variable.
   - **Database TLS:** `DATABASE_SSL=true` verifies the server certificate. Neon's certificates are publicly trusted, so this should work as is, but it has not yet been exercised against Neon: if boot fails with a certificate error, that is the place to look.
4. Open `https://<service>.onrender.com/health`. Expect `"status":"ok","db":"up"` and `"aiProvider"` set to `"mistral"` or `"fallback-only"`.

> The free plan sleeps after inactivity, so the first request can take about 50 s. Open `/health` before a demo.

### Seed the demo data (once)

The seed creates the public demo accounts in the [README](../README.md#live-demo), so it is a deliberate, one-time step and is not part of `startCommand`. The free Render plan has no shell, so run it from your machine against Neon. Use **either** option:

```bash
# A: plain psql (seed.sql needs nothing but Postgres)
psql "<NEON_URL>" -f db/seed.sql

# B: the project's seed runner (uses DATABASE_URL from the environment, which takes precedence over .env)
DATABASE_URL="<NEON_URL>" DATABASE_SSL=true npm run db:seed
```

The seed is idempotent, so re-running it does not duplicate rows. Seeded appointment times are computed in each business's own timezone, so they land inside opening hours whatever the database session's timezone.

## 3. Vercel (web)

1. Import the repo. Set **Root Directory** to `apps/web` and keep "Include files outside the root directory" enabled (the build needs `packages/shared`).
2. `apps/web/vercel.json` sets the framework to Next.js, and runs install and build **from the repo root**: `npm ci`, then `npm run build:web`, which compiles `@appt/shared` and then runs `next build`.
3. Set **Node.js version 22** in Project Settings, then General.
4. Environment variables (Production, and Preview if you use it). **Both are read at build time**: `API_ORIGIN` is compiled into the rewrite rules and `NEXT_PUBLIC_SOCKET_URL` is inlined into the client bundle and the CSP. Changing either needs a redeploy.

| Variable | Value |
|---|---|
| `API_ORIGIN` | `https://<service>.onrender.com` (no trailing slash) |
| `NEXT_PUBLIC_SOCKET_URL` | `https://<service>.onrender.com` |

5. Deploy, and note the production origin, e.g. `https://slotly.vercel.app`.

## 4. Close the loop: CORS on Render

Set `CORS_ORIGINS` on Render to the exact Vercel origin (scheme and host, no path, no trailing slash) and redeploy. This one value controls three things:

- **CSRF check:** the Next proxy forwards the browser's `Origin`, and any state-changing request whose `Origin` is not listed gets `403 FORBIDDEN`. If login fails with 403 after deploying, this value is wrong.
- **Socket.IO CORS:** the browser connects to Render directly.
- **REST CORS:** relevant only to cross-site callers.

Vercel **preview** URLs are different origins. Add them as a comma-separated list if previews need to write.

## Cookies and the proxy

- REST goes browser → `vercel.app/api/*` → Render, so the API's `Set-Cookie` lands on the **Vercel** origin: first-party, `httpOnly`, `Secure` (production), `SameSite=Lax`. No third-party cookies, no `SameSite=None`, and `CROSS_SITE_COOKIES` stays `false`.
- The refresh cookie's path is `/api/auth`, which matches the proxied path.
- Only set `CROSS_SITE_COOKIES=true` if you drop the proxy and have the browser call Render directly. Cookies then become `SameSite=None; Secure`, which some browsers block as third-party.
- The socket does not use cookies. It sends the in-memory access token in its handshake.

## Rate limiting behind the proxy

Express's `trust proxy` is set from `TRUST_PROXY_HOPS` (default `0`, which trusts no forwarding header). `render.yaml` sets `2`: the browser's request passes the Vercel `/api` rewrite and then Render's edge, each appending to `X-Forwarded-For`, so the client is two hops back. With too few hops, every user looks like Vercel's egress address and shares the per-IP limiters (general 300/min, login 10 failures/15 min, refresh 60/5 min). With too many, a client can choose its own key by prepending addresses. Authenticated chat and write limiters key by user id and are unaffected. `production-mode.test.ts` covers both directions.

**After deploying, check** that `2` matches the real chain: from two different networks, sign in and compare the `RateLimit` header budgets (they should be independent), or temporarily log `req.ip`. The API should be reachable only through the proxy for this to hold; anyone calling `onrender.com` directly can still spoof `X-Forwarded-For`.

## Smoke checklist

| # | Check | Expected |
|---|---|---|
| 1 | `GET <render>/health` | 200, `db: "up"`, the provider you intended |
| 2 | `GET <vercel>/api/health` | the same body, which proves the rewrite |
| 3 | Open `<vercel>/`, then "Sign in", then the demo customer | lands on `/assistant`, and the header pill shows **Live** (the socket connected) |
| 4 | Type "Teeth whitening next Wednesday around 3" | confirmation card; draft rail filled |
| 5 | Click **Confirm booking** | "Booked" card with `.ics` download; the appointment appears under **Appointments → Upcoming** |
| 6 | Open a second tab on `/appointments`, then book from the first tab | the new booking appears without a reload |
| 7 | Book the same slot again from the Appointments dialog | 409 message; slot picker refreshes |
| 8 | Reload `/assistant` | transcript and booked card restored |
| 9 | DevTools → Application → Cookies | `appt_access` (path `/`) and `appt_refresh` (path `/api/auth`) on the Vercel domain, HttpOnly, Secure |
| 10 | Sign out, then open `/appointments` | redirected to `/login?next=%2Fappointments` |
| 11 | Sign in as `staff@bluewave.test` | Appointments shows customer names across the tenant |
| 12 | As `owner@bluewave.test`, `GET <vercel>/api/ai/summary` | `totalCalls` increased; customers and staff get 403 |

## Operations notes

- **Logs:** pino JSON in production, one access line per request, and `X-Request-Id` on every response and error body. Search Render logs by request id. AI calls are also in `ai_interaction_logs` with the same id.
- **Shutdown:** SIGTERM stops accepting connections, drains requests, closes Socket.IO and the pool, with a 10 s backstop.
- **Scaling beyond one instance** needs: a Redis store for rate limits, the Socket.IO Redis adapter, and migrations moved from `startCommand` to a release job.
- **Secrets:** `JWT_SECRET` is generated by Render. Rotating it signs everyone out of their access tokens. Refresh tokens are opaque database rows and are unaffected, so users re-acquire access silently.
