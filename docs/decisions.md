# Architecture decision records

Short ADRs: the context, the decision, the alternatives considered, and what it costs. Each one is a choice I would defend in review and would revisit under the stated conditions.

---

## ADR-001: npm-workspaces monorepo with a shared contract package

**Context.** Forms, the API validator and the LLM tool definition all describe the same booking. Three hand-maintained copies would drift.
**Decision.** One repo with `apps/api`, `apps/web`, `packages/shared`. `@appt/shared` holds the zod schemas, DTO types, `ERROR_CODES` and `SOCKET_EVENTS`, and is consumed as compiled output.
**Alternatives.** Separate repos with an OpenAPI-generated client (more ceremony than two apps need); Turborepo/Nx (a build cache is not a problem at this size).
**Cost.** The shared package must be built before the apps (`npm run build:shared`, which the `dev`, `build:*`, `typecheck` and CI steps already do).

## ADR-002: Express 4, with an explicit async wrapper

**Context.** The brief asks for Express or similar. Express 5 forwards rejected promises to error middleware natively. Express 4 hangs the request instead.
**Decision.** Express 4.21, with `asyncHandler` ([`middleware/errorHandler.ts`](../apps/api/src/middleware/errorHandler.ts)) on every async route. The middleware this project depends on (`express-rate-limit`, `pino-http`, `helmet`, `cors`, `cookie-parser`) and `@types/express@4` are the long-established pairing, and the one async gap that Express 5 fixes is closed by about five lines. `validate()` writes parsed values with `Object.defineProperty`, so it already works with Express 5's getter-only `req.query`.
**Alternatives.** Express 5 (the natural upgrade; nothing here blocks it); Fastify (built-in schema validation and speed, but the brief names Express and the gain is irrelevant at this scale).
**Cost.** Every async route must be wrapped. A missing wrapper would hang the request instead of failing loudly.
**Revisit** when doing a dependency refresh. Upgrading to 5 is mostly deleting `asyncHandler`.

## ADR-003: Plain SQL with `pg` and a ~90-line migration runner, no ORM

**Context.** The brief asks for the DDL as a deliverable and evaluates modelling, constraints and indexes.
**Decision.** Hand-written SQL migrations, a forward-only runner with a checksum ledger and one transaction per file, and parameterized queries in repositories.
**Alternatives.** Prisma or Drizzle. Both hide EXCLUDE constraints, generated range columns, partial indexes and composite-FK `ON DELETE SET NULL (col)` behind escape hatches, which is exactly the work being assessed.
**Cost.** Manual row-to-DTO mapping and no generated types for rows. Mitigated by narrow repository functions and the integration tests.

## ADR-004: Shared-schema multi-tenancy with composite foreign keys

**Context.** A SaaS product needs tenant isolation that holds even when application code has a bug.
**Decision.** Every tenant-scoped row has `business_id`. Children reference parents by `(business_id, id)`, so the database refuses cross-tenant links. `business_id` comes only from the JWT.
**Alternatives.** Schema- or database-per-tenant (strong isolation, but operationally heavy for many small tenants); RLS alone (good, but it depends on the session variable being set correctly on every connection).
**Cost.** Wider keys and extra UNIQUE constraints. RLS is the planned second layer.

## ADR-005: Double-booking is prevented by an EXCLUDE constraint

**Context.** "Check availability, then insert" races under concurrency.
**Decision.** `EXCLUDE USING gist (business_id WITH =, service_id WITH =, slot WITH &&) WHERE status IN ('pending','confirmed')` on a generated `tstzrange`. The application pre-check exists for good error messages and suggestions. The constraint is the guarantee, and its violation maps to `409`.
**Alternatives.** `SELECT … FOR UPDATE` or advisory locks (correct, but easy to bypass from a new code path); serializable transactions (retry plumbing everywhere).
**Cost.** Scope is per service, a modelling simplification. Real practices need `resource_id`.

## ADR-006: Short-lived JWT plus rotating opaque refresh tokens, in httpOnly cookies

**Context.** The brief allows JWT or sessions. Tokens in `localStorage` are one XSS away from theft.
**Decision.** A 15-minute HS256 access JWT (`sub`, `bid`, `role`, `email`) in an httpOnly cookie, also accepted as a Bearer header for API clients. A 7-day opaque refresh token, stored as SHA-256 and rotated on every use, in an httpOnly cookie scoped to `/api/auth`. Replay of a rotated token revokes every session of that user. A 15-second grace window turns a sibling tab's lost race into `SESSION_SUPERSEDED` instead of a forced logout, and, when the successor was never used, recovers an abandoned rotation (a response lost to a timeout) by revoking the unused successor and issuing a fresh pair, as Auth0's reuse interval does. The client serializes refreshes with Web Locks.
**Alternatives.** Server sessions (simplest revocation, but a lookup on every request and the brief leans JWT); a JWT refresh token (cannot be revoked without a denylist, which is a database hit anyway).
**Cost.** Inside the window, whoever presents a just-rotated token whose successor is unused gets a session; that is the reuse interval's trade, bounded to 15 seconds. Two tabs refreshing the same token at once without Web Locks both get pairs and only the later survives. An access token stays valid up to 15 minutes after logout on REST calls (there is no denylist; checking one would put a database or Redis lookup on every request, which is what the short TTL avoids). Sockets are cut sooner: they are disconnected when their token expires and on logout everywhere or refresh-token replay. The socket needs a JS-readable token, kept in memory only.

## ADR-007: The web app proxies `/api`; Socket.IO connects directly

**Context.** The web app (Vercel) and API (Render) are on different sites, and third-party cookies are increasingly blocked.
**Decision.** Next.js rewrites `/api/:path*` to `API_ORIGIN`, so cookies are first-party, `SameSite=Lax` and need no CORS preflight. WebSocket upgrades do not survive that rewrite, so the browser connects to the API's Socket.IO endpoint directly and authenticates with the token in the handshake. `CROSS_SITE_COOKIES=true` remains for a deployment without the proxy.
**Cost.** An extra network hop on REST calls. The API sees the proxy, not the browser, as its TCP peer (see the rate-limiting note in [deployment.md](deployment.md#rate-limiting-behind-the-proxy)).

## ADR-008: The LLM extracts, code decides

**Context.** The brief wants practical AI with guardrails and clear boundaries between AI calls and business logic.
**Decision.** One forced tool call returns `{ slots, reply, intent }`. The chat service merges slots, resolves the service in SQL, applies the consent rule and chooses the `action`. The booking service enforces every rule. Confirmation, refusal and success texts are written by code.
**Alternatives.** Agentic tool use where the model calls `check_availability` and `book` (more round trips, and correctness depends on the model following instructions); free-text parsing (fragile).
**Cost.** More orchestration code, and the model's personality only shows in "collecting" replies.

## ADR-009: A deterministic engine as a first-class provider

**Context.** Providers time out, rate-limit and reject keys. Reviewers may not have a key.
**Decision.** `FallbackProvider` (chrono-node plus rules) implements the same interface. Any Mistral failure falls through to it within the same request. The UI labels these replies "Guided mode". Its date reader also cross-checks the model (ADR-010).
**Alternatives.** Return 503 and let the user retry (a lost booking because a third party had a bad minute); queue and retry later (a chat user is waiting).
**Cost.** A second extractor to maintain, with plainer replies.

## ADR-010: Guardrails verify model output where code is reliable

**Context.** Against the live model, a well-formed answer was still wrong: "next Wednesday" came back as a Thursday, and replies claimed bookings that did not exist.
**Decision.** Post-checks in `guardrails.ts`. A confidently parsed date or time from the same message overrides the model's. A service the user never named (and the draft does not hold) is dropped. A reply claiming a booking, naming a different day, naming the time just corrected, or built around a dropped service is replaced with the code-composed question. Each correction is logged in `ai_interaction_logs.guardrails`.
**Cost.** False positives replace natural wording with a template, the right trade when a false negative tells someone they have an appointment they do not. Grounding also rejects a correct inference from a description ("my teeth are yellow" → whitening); the user is asked to pick instead.

## ADR-011: Conversation memory lives in the database

**Decision.** `chat_sessions.booking_draft` is the memory. It is restated in each prompt, merged field by field (an absent field is not a cleared field), and returned in every turn. History sent to the model is capped at `AI_HISTORY_TURNS`. Each assistant message stores its `action`, `suggestions`, a `draft` snapshot and, when it booked, the `appointmentId` (`meta`), so a reload rebuilds every card from its own message.
**Cost.** A merge policy to get right, which is covered by shared unit tests.

## ADR-012: Socket.IO is an enhancement over REST, with user and business rooms

**Decision.** Each chat turn is a REST request that returns the whole turn. Sockets push to the user's other tabs (`assistant:turn`, `assistant:typing`, `appointment:*`). Rooms are `user:<id>`, and staff and owners also join `business:<id>` so their dashboards are live. There is no broadcast path. On reconnect the client refetches.
**Alternatives.** Socket-only chat (a blocked WebSocket would look like a broken product); polling only (meets the brief, but cross-tab updates arrive late).
**Cost.** Two delivery paths, reconciled by message id. Rooms live in process memory, so more than one API instance needs the Redis adapter.

## ADR-013: Client-side route guard

**Context.** The refresh cookie is path-scoped to `/api/auth`, so Next.js middleware on page routes cannot see it.
**Decision.** `AuthGuard` restores the session via `/api/auth/refresh` and renders a skeleton until it is confirmed. Every data call is authorized on the server regardless.
**Cost.** Protected pages' JavaScript is public. That is acceptable because it contains no data.

## ADR-014: Timezone conversion belongs to Postgres

**Decision.** Users speak in the business's wall-clock time. Inserts and availability convert with `AT TIME ZONE businesses.timezone`. All instants are `timestamptz` and leave the API as UTC ISO strings. The prompt and chrono-node use "now" in the business zone.
**Cost.** SQL is slightly more involved. In return there is no Node timezone library that could disagree with the database about DST.

## ADR-015: TanStack Query plus a pure reducer; no global store

**Decision.** Server state lives in the query cache, with hierarchical keys and realtime upserts that reuse the API's filter schema. Only unconfirmed chat state lives in a pure reducer. Auth and realtime use small contexts.
**Alternatives.** Redux or Zustand (another copy of server state to keep in sync).

## ADR-016: Fire-and-forget AI logging to Postgres

**Decision.** One row per provider call, written without awaiting, and never throwing. Pino logs carry the same request id.
**Alternatives.** An LLM observability vendor (better dashboards, but another dependency and data-sharing decision for a prototype).
**Cost.** The table grows fastest of all. Partition by month at scale.

## ADR-017: Hosting on Vercel, Render and Neon

**Decision.** Next.js on Vercel (native support). The API on Render as a long-lived Node process, which Socket.IO needs (serverless functions cannot hold WebSockets), defined in `render.yaml`. Postgres on Neon (managed Postgres 16 with `btree_gist`, `citext` and `pgcrypto`, plus a free tier). Migrations run in `startCommand` because the free Render plan has no pre-deploy step.
**Cost.** Three dashboards. Free-tier cold starts. Migrations should move to a release job before running more than one instance.

## ADR-018: Rate-limit keys, and how far to trust the proxy chain

**Context.** Signup, login and refresh run before the caller is known, so their limiters key by IP. The API sits behind two proxies in production (the Vercel `/api` rewrite, then Render's edge), each appending to `X-Forwarded-For`.
**Decision.** Express `trust proxy` is set from `TRUST_PROXY_HOPS` (default `0`, `2` in `render.yaml`), because the hop count is a fact about the deployment, not the code. The login limiter keys by IP alone and counts only failures (10 per 15 minutes); chat and write limiters key by user id.
**Alternatives.** Keying the login limiter on IP plus email: it would stop one shared address exhausting everyone's budget, but it gives one attacker a fresh 10 attempts for every email, which defeats protection against credential stuffing (one password tried across many accounts). The real shared-bucket problem is a wrong hop count, which configuration fixes. A fixed `trust proxy = 1`: behind Vercel every user would share the egress address.
**Cost.** The value must match the real chain: too few hops and users share a budget; too many and a client can choose its own key. It also holds only if the API is reachable just through the proxy; a direct call to Render can spoof `X-Forwarded-For`. The store is in-memory, per instance.

## ADR-019: Signup says when an email is already registered

**Context.** `409 EMAIL_TAKEN` on signup tells a caller that an address has an account in that business. Login deliberately does not: wrong email and wrong password both return `INVALID_CREDENTIALS`.
**Decision.** Keep the explicit signup answer. Hiding it properly means answering "check your inbox" either way, which needs email verification this prototype does not have; without it, someone who already has an account would be left stuck on a form that silently does nothing.
**Alternatives.** A generic signup success plus a verification email (the right answer once email delivery exists).
**Cost.** Signup is an enumeration oracle, bounded by the auth limiter (10 failed attempts per 15 minutes per IP) and scoped to one business.

## ADR-020: Booking retries use an Idempotency-Key claimed inside the booking transaction

**Context.** A booking whose response is lost (a timeout, a dropped connection, a double-clicked Confirm) used to be retried as a new request. The per-customer EXCLUDE constraint already stopped a second row, but the retry got `409 CUSTOMER_BUSY` for the booking it had just made.
**Decision.** `POST /api/appointments` accepts an optional `Idempotency-Key` header (1–255 printable ASCII characters, a UUID is ideal). Keys live in `idempotency_keys` (migration 008), scoped to `(business_id, user_id, key)`. The booking transaction inserts the key row **first**, so a concurrent request with the same key blocks on the primary key until the first commits (then it replays) or rolls back (then it books). The stored response is the exact 201 body, replayed with `Idempotent-Replayed: true`; a different request under the same key is `422 IDEMPOTENCY_KEY_REUSED`. The fingerprint is a SHA-256 of the validated body, so a retry serialised differently still matches. Only successes are stored: a refusal or a database failure rolls the key back with the booking, so the client can retry with the same key. Keys are honoured for 24 hours; an expired row is taken over in the same `ON CONFLICT` statement.
**Alternatives.** Deduplicating on the booking's own fields (it cannot tell a retry from a deliberate second booking); a lookup before the insert (racy); an advisory lock (works, but a unique key is the guarantee reviewers expect and it doubles as the store).
**Cost.** One more table, with no sweep job yet (its `created_at` index is there for one). A replay returns the booking as it was when created, even if it was cancelled since; that is what the original caller would have seen.

## ADR-021: Closed weekdays are a column with an "every day" default; DST gaps are refused

**Context.** Opening hours had times but no days, so nothing could say "closed on Sundays". Separately, Postgres resolves a wall time that DST skips (02:30 on a US spring-forward day) by moving it an hour, which would have booked 03:30 without saying so.
**Decision.** `businesses.open_days` (migration 007) lists ISO weekdays, judged on the business's own calendar date. The default is all seven days, which is what every tenant, the seeded demo included, already offered, so the migration changes no existing behaviour. A closed day is `422 OUTSIDE_BUSINESS_HOURS` with the open days in the message ("We're closed on Saturdays. We take bookings Monday to Friday."), and the availability endpoint returns `closed: true` with no slots. Chat suggestions come from the same availability query, so they skip closed days too. A time inside a spring-forward gap is `400 VALIDATION_FAILED` on `time` and is left out of the availability grid; a repeated fall-back time (01:30) is booked as its second, standard-time occurrence, Postgres's own resolution, used by both the check and the grid.
**Alternatives.** Defaulting to Monday–Friday (would retroactively close the demo tenants' weekends and invalidate seeded data). Per-day hours or holiday exceptions (a schedule table; more than this scope needs). Asking the user which 01:30 they meant (no business in the seed opens at that hour).
**Cost.** No settings screen: a business changes `open_days` in SQL. On a fall-back day the first 01:00–01:59 hour cannot be named by wall time.

## ADR-022: One workspace per owner email

**Context.** Email is unique per tenant (ADR-004), and a signup without a business code creates a tenant. So resubmitting the owner signup form (a double click, or a retry after a lost response) created a second business and a second account that the sign-in form could never reach, because login without a business code picks the oldest account.
**Decision.** Creating a workspace is refused with `409 EMAIL_TAKEN` ("This email already owns a workspace. Sign in instead.") when the email already owns one. A transaction-scoped advisory lock on the email serialises concurrent attempts, so exactly one of several simultaneous submissions wins. Joining a business as a customer is unchanged, and an email may still be a customer in many businesses and own one of its own.
**Alternatives.** A partial unique index on owner emails (would fail to apply on a database that already holds such duplicates, as the production demo may).
**Cost.** Someone who genuinely runs two businesses needs a second email for now.
