# Configuration

## API (`.env` at the repo root)

Validated once at boot by [apps/api/src/config/env.ts](../apps/api/src/config/env.ts). The process exits with a readable list if any variable is missing or malformed. Blank values count as unset. Start from [.env.example](../.env.example).

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | **yes** | — | Postgres connection string |
| `JWT_SECRET` | **yes** | — | HS256 signing key, at least 32 characters |
| `NODE_ENV` | no | `development` | `production` turns on secure cookies and JSON logs, hides error debug text, and refuses the `.env.example` placeholder `JWT_SECRET` |
| `PORT` | no | `4000` | HTTP + Socket.IO port |
| `DATABASE_SSL` | no | `false` | `true` for managed Postgres (Neon). TLS with certificate verification |
| `PG_POOL_MAX` | no | `10` | Connection pool size (1–100) |
| `ACCESS_TOKEN_TTL_SECONDS` | no | `900` | Access JWT lifetime |
| `REFRESH_TOKEN_TTL_DAYS` | no | `7` | Refresh token lifetime |
| `CORS_ORIGINS` | no | `http://localhost:3000` | Comma-separated exact origins. Also the CSRF allow-list for state-changing requests and the Socket.IO CORS list, so the web app's own origin must be listed |
| `TRUST_PROXY_HOPS` | no | `0` | Reverse proxies in front of the API, used for `req.ip` (rate-limit keys). `render.yaml` sets `2` (Vercel rewrite, then Render's edge) |
| `CROSS_SITE_COOKIES` | no | `false` | `true` only if the browser calls the API cross-site (cookies become `SameSite=None; Secure`). Not needed with the default proxy setup |
| `MISTRAL_API_KEY` | no | unset | Turns on the LLM path. Unset means the deterministic engine is the main path |
| `MISTRAL_MODEL` | no | `ministral-8b-latest` | Model id. Small and fast is enough for slot extraction, and it has free-tier quota |
| `MISTRAL_BASE_URL` | no | `https://api.mistral.ai` | Override for a proxy or the test stub |
| `AI_TIMEOUT_MS` | no | `12000` | Hard timeout for each provider attempt (1000–60000) |
| `AI_MAX_RETRIES` | no | `1` | Retries on transient failures (0–5) |
| `AI_HISTORY_TURNS` | no | `12` | Messages of history sent to the model (2–40) |
| `LOG_LEVEL` | no | `info` | pino level (`silent` in tests) |
| `RATE_LIMIT_DISABLED` | no | `false` | Turns off every limiter (tests and e2e only) |
| `TEST_DATABASE_URL` | tests only | `postgresql://appt:appt_local_dev@localhost:5433/appt_test` | API test server. The database name must end in `_test` (see [testing.md](testing.md)) |

## Web (`apps/web/.env.local`)

Next.js does **not** read the root `.env`. These are read **at build time**: `API_ORIGIN` is compiled into the rewrite rules and `NEXT_PUBLIC_SOCKET_URL` into the client bundle and the CSP, so a deployed change needs a rebuild. See [apps/web/.env.example](../apps/web/.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `API_ORIGIN` | `http://localhost:4000` | Where the Next.js server proxies `/api/*` |
| `NEXT_PUBLIC_SOCKET_URL` | `http://localhost:4000` | Socket.IO origin the browser connects to. Also added to the CSP `connect-src` |
| `NEXT_DIST_DIR` | `.next` | Build output folder; `npm run e2e` uses `.next-e2e` so a development build is left alone |
| `E2E_BASE_URL` | `http://localhost:3000` | Playwright target for `npm run e2e:run`. `npm run e2e` sets it to its own web app |
| `E2E_ALL_BROWSERS` | unset | `1` adds Firefox and WebKit projects to Playwright |

## Production values

What `render.yaml` and Vercel set is listed step by step in [deployment.md](deployment.md).
