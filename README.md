# Slotly — AI-assisted appointment booking

Slotly is a multi-tenant SaaS prototype. A customer types *"teeth whitening next Wednesday around 3"* and gets a booked appointment. The assistant collects what is missing and shows a confirmation card. If the conversation stalls, it offers a pre-filled form. If the language model is slow, rate-limited, misconfigured or simply wrong, booking still works. The LLM only **extracts** information. Ordinary code and a Postgres constraint **decide** what gets booked. This split is the core design decision, and the rest of the system is built around it.

**Stack:** Next.js 15 (React 19, TanStack Query, react-hook-form, Tailwind) · Express 4 + Socket.IO · PostgreSQL 16 · Mistral (with a deterministic fallback engine) · zod schemas shared by both sides through `@appt/shared`.

---

## Live demo

| | |
|---|---|
| Web app | **https://ai-appointment-booking-psi.vercel.app** |
| API health | **https://slotly-api-r5g6.onrender.com/health** (DB status, active AI provider, uptime; per-tenant AI usage is at the owner-only `GET /api/ai/summary`) |
| Demo video | _coming soon_ |
| Repository | https://github.com/alisafdar35/ai-appointment-booking |

> The API runs on Render's free plan, which sleeps after 15 minutes idle: the first request after a pause can take ~30–60 s while it wakes. Everything is fast after that.

**Demo logins** (password for all: `Password123!`)

| Email | Role | Tenant |
|---|---|---|
| `customer@bluewave.test` | customer | Bluewave Dental (`bluewave`, America/New_York, 09:00–17:00) |
| `staff@bluewave.test` | staff (sees every customer's bookings) | Bluewave Dental |
| `owner@bluewave.test` | owner | Bluewave Dental |
| `owner@northside.test` | owner | Northside Clinic (`northside`, Europe/London), the second tenant used to show isolation |

The sign-in page can fill in the customer account for you. You can also sign up with a new business, or join Bluewave with the business code `bluewave`.

> The free Render instance sleeps when idle, so the first request after a pause can take about 50 seconds.

---

## Screenshots

| Conversational booking | Booked, with live dashboard |
|---|---|
| ![Assistant confirmation card](docs/screenshots/assistant-confirmation.png) | ![Booked card](docs/screenshots/assistant-booked.png) |
| **Form fallback (needs_form)** | **Appointments dashboard** |
| ![Fallback form](docs/screenshots/assistant-fallback-form.png) | ![Appointments dashboard](docs/screenshots/appointments-dashboard.png) |

More screenshots: [landing](docs/screenshots/landing.png), [login](docs/screenshots/login.png), [signup](docs/screenshots/signup.png), [empty assistant](docs/screenshots/assistant-empty.png), [mid-conversation](docs/screenshots/assistant-conversation.png), [booking dialog](docs/screenshots/appointments-booking-dialog.png), [cancel dialog](docs/screenshots/appointments-cancel-dialog.png), [staff view](docs/screenshots/staff-dashboard.png), [dark mode](docs/screenshots/dark-assistant.png), [mobile assistant](docs/screenshots/mobile-assistant.png), [mobile appointments](docs/screenshots/mobile-appointments.png).

---

## What the brief asked for, and where it is

The full line-by-line audit, including what is partial, is in [docs/assessment-checklist.md](docs/assessment-checklist.md).

| Brief | Implementation |
|---|---|
| Embedded chatbot UI | `/assistant`: conversation list, transcript, composer, booking-draft side rail, inline confirmation, booked and suggestion cards ([features/chat](apps/web/src/features/chat)) |
| Real-time chat | REST request/response for each turn, plus Socket.IO push for typing indicators, turns from your other tabs, and appointment changes. The app works fully if the socket is down; a status pill shows "Live", "Connecting…" or "Live updates unavailable" ([realtime](apps/api/src/realtime/index.ts)) |
| Signup/login with JWT | 15-minute HS256 access JWT and an opaque 7-day refresh token, both in httpOnly cookies. Refresh tokens rotate, and replaying an old one is detected. A Bearer header also works for API clients ([auth](apps/api/src/modules/auth)) |
| Booking UI (form or conversational) | Both. Chat, a "Prefer a form?" card inside the chat, and a booking dialog on `/appointments` with a live slot picker. All three go through **one** booking service |
| REST: auth, chat, appointments | 17 REST endpoints plus `/health`, documented in [docs/api.md](docs/api.md) |
| Validation, logging, rate limiting, errors | Shared zod schemas through the `validate()` middleware · pino with request ids and redaction · five rate-limit tiers · one error envelope with stable codes ([middleware](apps/api/src/middleware)) |
| LLM understands requests and extracts details | Mistral chat completions with **one forced tool call**. The tool's JSON Schema is generated from the shared zod booking schema ([ai](apps/api/src/modules/ai)) |
| Multi-turn memory | The partial booking draft is stored on `chat_sessions.booking_draft`, restated in every prompt, and merged one field at a time. History sent to the model is capped (`AI_HISTORY_TURNS`) |
| Fallback to a form | After 4 turns in a row with no progress (the same details still missing, no times offered), the assistant returns `needs_form` with a form pre-filled from the draft, at most once per conversation. A "Prefer a form?" link is always available |
| AI interaction logging | One row per provider call in `ai_interaction_logs`: latency, tokens, outcome, extracted slots and guardrail corrections. Per-tenant summary (calls, error rate, p50/p95 latency per provider) at the owner-only `GET /api/ai/summary` |
| SQL DDL, sample inserts, indexes, performance notes, multi-tenancy | [db/migrations](db/migrations), [db/seed.sql](db/seed.sql), [db/verify.sql](db/verify.sql), [docs/database.md](docs/database.md). `business_id` with composite tenant foreign keys |

---

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    UI[Next.js app<br/>React 19 + TanStack Query]
  end

  subgraph Vercel
    NX[Next.js server<br/>static pages + /api rewrite]
  end

  subgraph Render
    API[Express 4 API<br/>auth · chat · appointments]
    WS[Socket.IO gateway<br/>user + business rooms]
    AI[AI orchestrator<br/>guardrails]
    FB[Deterministic engine<br/>chrono-node + rules]
  end

  DB[(PostgreSQL 16<br/>Neon)]
  M[[Mistral API]]

  UI -- "same-origin /api/* (httpOnly cookies)" --> NX
  NX -- "rewrite /api/:path*" --> API
  UI -- "WebSocket, token in handshake" --> WS
  API --> AI
  AI -- "forced tool call, timeout + 1 retry" --> M
  AI -. "any failure / no key" .-> FB
  API --> DB
  WS --- API
```

- **The browser only talks to its own origin for REST.** Next.js proxies `/api/*` to the API, so the auth cookies are first-party: `SameSite=Lax` and no third-party-cookie dependency. Socket.IO connects **directly** to the API, because WebSocket upgrades do not survive the rewrite. It authenticates with the in-memory access token.
- **Clear service boundaries.** Routes only handle HTTP. Services hold the rules. Repositories hold the SQL. The AI module returns slots and a sentence, and it cannot write to the database. See [docs/architecture.md](docs/architecture.md).

### One chat turn

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant R as POST /api/chat/messages
  participant C as Chat service
  participant A as AI orchestrator
  participant M as Mistral
  participant K as Booking service
  participant D as Postgres
  participant S as Socket.IO

  B->>R: { content, sessionId? }
  R->>R: requireAuth · chatLimiter (20/min/user) · validate(sendMessageSchema)
  R->>C: handleUserMessage
  C->>D: load session + draft (409 SESSION_CLOSED if already booked)
  C->>D: store user message first (never lost)
  C->>S: assistant:typing { typing: true } to the user's other tabs
  C->>A: prompt context (today, tz, hours, catalogue, draft, last N turns)
  A->>M: one forced tool call (schema from @appt/shared)
  alt usable answer
    M-->>A: tool arguments
    A->>A: zod parse · date/time cross-check · service grounding · reply guardrail
  else timeout / 429 / 5xx / 401 / invalid output
    A->>A: deterministic engine reads the same message
  end
  A--)D: ai_interaction_logs (fire-and-forget)
  A-->>C: { slots, reply, intent, engine }
  C->>C: mergeSlots over draft · resolve service name in tenant catalogue
  C->>K: only if the draft was already confirmed and unchanged: attemptBooking
  K->>D: checkSlot, then INSERT (EXCLUDE constraint decides races)
  K-->>C: booked, or refusal + nearby free times
  C->>C: choose action: collect_info | confirm | booked | needs_form
  C->>D: assistant message + meta {action, suggestions, missing, draft, appointmentId}, new draft
  R->>S: assistant:typing false · assistant:turn · appointment:created
  R-->>B: 201 AssistantTurnDto
```

---

## Repository layout

```
apps/
  api/                Express + Socket.IO (TypeScript, ESM)
    src/config        env validation (zod, fails at boot)
    src/middleware    requestId/logging, auth, origin check, rate limits, validate, errors
    src/modules/      auth · appointments (+ availability) · chat · ai (provider, mistral, fallback, guardrails, tools, prompts, logs)
    src/realtime      Socket.IO gateway
    src/db            pool, migration runner, seed runner
    test/             node:test unit + integration (real HTTP, real Postgres)
  web/                Next.js 15 App Router
    src/app           routes: /, /login, /signup, /(app)/assistant, /(app)/appointments
    src/features      auth · chat · appointments · booking · marketing
    src/lib           api client, query hooks + keys, socket, datetime
    src/providers     Auth, Query, Realtime, Toast
    e2e/              Playwright specs (desktop + mobile projects)
packages/shared       zod schemas, DTO types, ERROR_CODES, SOCKET_EVENTS
db/                   migrations/001–006, seed.sql, verify.sql
scripts/              e2e.mjs (fresh database + own stack + Playwright), wait-for-db.mjs
docs/                 architecture, api, database, ai-integration, frontend, decisions, deployment, demo script, checklist
```

---

## Quick start

**Prerequisites:** Node 22 (`.nvmrc`), and either Docker or your own PostgreSQL 15+ with the `btree_gist`, `citext` and `pgcrypto` extensions available.

```bash
git clone https://github.com/alisafdar35/ai-appointment-booking.git
cd ai-appointment-booking
cp .env.example .env          # set JWT_SECRET (32+ chars); MISTRAL_API_KEY is optional
npm run setup                 # npm install, Postgres via docker compose on :5433, migrate, seed
npm run dev                   # builds @appt/shared, then API on :4000 and web on :3000
```

Open http://localhost:3000 and sign in as `customer@bluewave.test` / `Password123!`.

- **Without Docker:** create a database, point `DATABASE_URL` at it, then run `npm install && npm run db:migrate && npm run db:seed`.
- **Without a Mistral key:** everything works. Replies come from the deterministic engine and the UI labels them "Guided mode".
- **Reset local data:** `npm run db:reset` (drops the Docker volume, then migrates and seeds again).
- The web app reads its own env from `apps/web/.env.local` (see [apps/web/.env.example](apps/web/.env.example)). The defaults already point at `localhost:4000`.

---

## Configuration

API variables are validated once at boot by [apps/api/src/config/env.ts](apps/api/src/config/env.ts). The process exits with a readable list if any are missing or malformed. Blank values count as unset.

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
| `CORS_ORIGINS` | no | `http://localhost:3000` | Comma-separated exact origins. Also the CSRF allow-list for state-changing requests and the Socket.IO CORS list |
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
| `TEST_DATABASE_URL` | tests only | `postgresql://appt:appt_local_dev@localhost:5433/appt_test` | API test server. The database name must end in `_test` |

Web (`apps/web`, read by Next.js **at build time**):

| Variable | Default | Purpose |
|---|---|---|
| `API_ORIGIN` | `http://localhost:4000` | Where the Next.js server proxies `/api/*` |
| `NEXT_PUBLIC_SOCKET_URL` | `http://localhost:4000` | Socket.IO origin the browser connects to. Also added to the CSP `connect-src` |
| `E2E_BASE_URL` | `http://localhost:3000` | Playwright target for `npm run e2e:run`. `npm run e2e` sets it to its own web app |

---

## Testing

| Suite | Command | Count (latest local run) | Needs |
|---|---|---|---|
| API unit + integration | `npm test -w @appt/api` | **589 tests**, 22 files, all passing (~28 s) | Postgres on :5433 (creates throwaway `appt_test*` databases) |
| Web unit/component | `npm test -w @appt/web` | **439 tests**, 39 files, all passing (~7 s) | nothing |
| End-to-end (Playwright) | `npm run e2e` | **50 tests**: 25 scenarios × desktop and mobile Chrome, 6 spec files, all passing (~1 min incl. build) | Postgres on :5433, ports 3100 and 4100 free |
| Types + lint | `npm run typecheck && npm run lint` | clean | — |

- The **API integration tests** run the real `createApp()` over HTTP, against a database built by the production migration runner and `db/seed.sql`. Mistral is exercised through a local stub that speaks the chat-completions protocol. Details: [apps/api/test/README.md](apps/api/test/README.md).
- **E2E** brings up a stack of its own. `npm run e2e` ([scripts/e2e.mjs](scripts/e2e.mjs)) drops and recreates the `appt_e2e` database (it refuses any name not ending in `_e2e`, and any non-local host), migrates it with the real runner and seeds it, builds everything, starts the API on :4100 and the production web build on :3100, waits for both to be healthy, runs Playwright, and stops both servers even when a test fails or the run is interrupted. A development stack on :3000/:4000 is left alone, and the web build goes to `apps/web/.next-e2e`, not `.next`.
  ```bash
  npm run e2e                           # the whole suite, desktop + mobile
  npm run e2e -- --project=desktop      # extra arguments go to Playwright
  npm run e2e -- --skip-build           # reuse the last build; the database is still recreated
  ```
  The API runs with no Mistral key (a preflight refuses any stack with a model, so every reply comes from the deterministic engine) and with rate limits off. Each Playwright worker books only on its own business days (`laneDays` in [e2e/support/api.ts](apps/web/e2e/support/api.ts)), so parallel tests never compete for a slot. `npm run e2e:run` runs Playwright alone against `E2E_BASE_URL`, for debugging a stack started by hand.
- **CI** ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs build, typecheck, lint, API tests with a Postgres 16 service, web tests and the API and web production builds on every push and PR, and a second job runs `npm run e2e` against its own Postgres service.

---

## Key design decisions

Full ADRs with alternatives are in [docs/decisions.md](docs/decisions.md).

| Decision | Why | Cost |
|---|---|---|
| **The LLM extracts, code decides.** One forced tool call returns slots and a reply. The chat service picks the action, and the booking service plus a DB constraint enforce the rules | A model cannot book, skip business hours, or see another tenant. Its mistakes become a wrong question, not a wrong booking | More orchestration code than "let the agent call `book()`" |
| **Deterministic engine as a first-class provider** | A provider outage or bad key does not stop bookings, and reviewers without a key see the full flow | A second extractor (chrono-node + rules) to maintain; replies are plainer |
| **Guardrails check model output against code** (date cross-check, reply replacement, consent rule) | Mistakes seen against the live model, e.g. "next Wednesday" resolved to a Thursday | Some false positives replace warm wording with a template |
| **Draft lives in Postgres, not in the prompt** | Survives reloads, new tabs and provider failover. Prompt size stays flat | Needs a merge policy (`mergeSlots`: an absent field is "not mentioned", never "cleared") |
| **`EXCLUDE USING gist` against overlap** | Double-booking is solved in the schema, so concurrent requests cannot both commit. A second constraint stops one customer holding two overlapping bookings | Overlap is per *service* (one chair per service). A real clinic needs per-staff or per-room resources |
| **Shared-schema multi-tenancy with composite FKs** `(business_id, id)` | The database refuses rows that point into another tenant | Wider keys; Row Level Security would be the next layer |
| **httpOnly cookies + proxy, rotating opaque refresh tokens** | No token in `localStorage`, first-party cookies, theft detection with a 15 s multi-tab grace window | The socket still needs a JS-readable token, held only in memory |
| **Socket.IO as an enhancement** | Every feature works over REST. A blocked WebSocket shows "Live updates unavailable", not a broken app | Two delivery paths to reconcile (handled by message ids) |
| **Plain SQL + a ~90-line migration runner, no ORM** | The DDL *is* the deliverable; checksums stop edited migrations | Hand-written row mapping |
| **Express 4 + `asyncHandler`** | Mature middleware and types; the wrapper covers Express 5's main gain | One wrapper on each async route |
| **Shared zod package** | Form, API and LLM tool schema cannot drift apart | Shared package must be built before the apps |

---

## Assumptions

- One business is one tenant with **one opening window applied every day** (no closed days or holidays). Bookings sit on a 30-minute grid, and a service's duration sets the end time.
- A booking is created `confirmed`. There is no approval workflow, reschedule, or no-show handling, only **cancel with a reason**.
- Self-serve signup either creates a business (you become its owner, it starts with three free starter services and UTC 09:00–17:00) or joins one by its public code (you become a customer). Staff accounts exist only in the seed.
- Times are entered and shown in the **business's** timezone. The API stores and returns UTC instants.
- English-language conversation only.

## Known limitations

These are deliberate scope cuts, each checked against the code:

- **Route protection is client-side** (`AuthGuard`). The refresh cookie is scoped to `/api/auth`, so Next.js middleware cannot see it. Protected pages' JavaScript loads before the check, but no data is exposed, because every API call is authorized on the server.
- **Rate limiting is in-memory, per instance.** With more than one replica, each instance has its own budget (the fix is a Redis store). Unauthenticated limiters key by IP, which depends on `TRUST_PROXY_HOPS` matching the real proxy chain. `2` is the assumed Vercel → Render chain and must be checked on the deployed stack (see [docs/deployment.md](docs/deployment.md#rate-limiting-behind-the-proxy)). The API must also be reachable only through the proxy, or a spoofed `X-Forwarded-For` lets a client pick its own key.
- **Access JWTs stay valid until they expire (15 min) after logout.** Logout revokes the refresh token, clears cookies and disconnects the user's sockets, but there is no denylist for access tokens on REST calls.
- **No cursor pagination.** Appointment lists cap at 100 (`limit`), the session sidebar at 30, and transcripts load the newest 200 messages.
- **Overlap is per service** (one chair per service): two customers can book two different services at the same time. There is no staff or room model.
- **No status transitions beyond cancel.** `completed` and `no_show` are reserved for a staff endpoint that does not exist yet, so past bookings stay `confirmed`. Staff cannot book on a customer's behalf.
- **Login without a business code** picks the oldest account if an email exists in several tenants, and the login form has no business-code field.
- **No email verification, password reset or tenant settings UI** (hours and timezone are seed or DB values).
- **AI:** only *dates* from the model are cross-checked by code. Model *times* are validated for format and business hours, not re-derived. There is no circuit breaker.
- **Ops:** migrations run in Render's `startCommand` (fine for one instance). Expired refresh tokens are never swept, although the index for that job exists. Certificate-verified TLS (`DATABASE_SSL=true`) has not yet been exercised against Neon. The production CSP allows `'unsafe-inline'` scripts (a Next.js limitation without nonces).

## What I'd do next

1. Redis for rate limits and the Socket.IO adapter, so the API can scale horizontally.
2. Row Level Security keyed on `business_id`, on top of the composite FKs.
3. A resources model (staff/rooms), weekly hours and closures. The EXCLUDE constraint moves to `(resource_id, slot)`.
4. Keyset pagination for appointments and transcripts (the indexes already support it).
5. Cross-check model times the way dates are checked, and build an offline eval set from `ai_interaction_logs` + `chat_messages.tool_calls`.
6. A scheduled job to sweep expired refresh tokens and partition AI logs by month.
7. Reschedule flow, email confirmations with the `.ics` already generated client-side, and a tenant settings page.

## Documentation

| Doc | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Components, boundaries, request lifecycle, middleware order, realtime, multi-tenancy |
| [docs/api.md](docs/api.md) | Every endpoint, schemas, errors, curl examples, socket events |
| [docs/database.md](docs/database.md) | ER diagram, constraints, index-to-query map, performance, migrations |
| [docs/ai-integration.md](docs/ai-integration.md) | Provider seam, prompt, tool schema, memory, guardrails, fallback, logging, failure modes |
| [docs/frontend.md](docs/frontend.md) | Structure, state, API client and refresh, async/error UX, a11y, responsive |
| [docs/decisions.md](docs/decisions.md) | ADRs |
| [docs/deployment.md](docs/deployment.md) | Neon + Render + Vercel, step by step |
| [docs/demo-script.md](docs/demo-script.md) | 4–5 minute video script |
| [docs/assessment-checklist.md](docs/assessment-checklist.md) | Every requirement → status → evidence |

## License

[MIT](LICENSE) © Ali Safdar
