# Architecture decision records

The ten decisions that shape the system, each with the context, the decision, the alternatives considered and what it costs. Smaller choices are listed in one line each at the end.

| # | Decision |
|---|---|
| [ADR-1](#adr-1-the-llm-extracts-code-decides) | The LLM extracts, code decides |
| [ADR-2](#adr-2-a-deterministic-engine-as-a-first-class-provider) | A deterministic engine as a first-class provider |
| [ADR-3](#adr-3-guardrails-verify-model-output-where-code-is-reliable) | Guardrails verify model output where code is reliable |
| [ADR-4](#adr-4-conversation-memory-lives-in-the-database) | Conversation memory lives in the database |
| [ADR-5](#adr-5-double-booking-is-prevented-by-an-exclude-constraint) | Double-booking is prevented by an EXCLUDE constraint |
| [ADR-6](#adr-6-shared-schema-multi-tenancy-with-composite-foreign-keys) | Shared-schema multi-tenancy with composite foreign keys |
| [ADR-7](#adr-7-plain-sql-with-pg-and-a-small-migration-runner-no-orm) | Plain SQL with `pg` and a small migration runner, no ORM |
| [ADR-8](#adr-8-short-lived-jwt-plus-rotating-opaque-refresh-tokens-in-httponly-cookies) | Short-lived JWT plus rotating opaque refresh tokens, in httpOnly cookies |
| [ADR-9](#adr-9-rest-through-a-same-origin-proxy-socketio-as-a-direct-enhancement) | REST through a same-origin proxy; Socket.IO as a direct enhancement |
| [ADR-10](#adr-10-booking-retries-use-an-idempotency-key-claimed-inside-the-booking-transaction) | Booking retries use an Idempotency-Key claimed inside the booking transaction |

---

## ADR-1: The LLM extracts, code decides

**Context.** The brief wants practical AI with guardrails and clear boundaries between AI calls and business logic.
**Decision.** One forced tool call returns `{ slots, reply, intent }`. The chat service merges slots, resolves the service in SQL, applies the consent rule and chooses the `action` (`decideAction`). The booking service enforces every rule. Confirmation, refusal, clarifying and off-topic texts are written by code (`copy.ts`).
**Alternatives.** Agentic tool use where the model calls `check_availability` and `book` (more round trips, and correctness depends on the model following instructions); free-text parsing (fragile).
**Cost.** More orchestration code, and the model's personality only shows in "collecting" replies.

## ADR-2: A deterministic engine as a first-class provider

**Context.** Providers time out, rate-limit and reject keys. Reviewers may not have a key.
**Decision.** `FallbackProvider` (chrono-node plus rules, built on the pure readers in `parse.ts`) implements the same interface. Any Mistral failure falls through to it within the same request. The UI labels these replies "Guided mode". The same readers also cross-check the model (ADR-3).
**Alternatives.** Return 503 and let the user retry (a lost booking because a third party had a bad minute); queue and retry later (a chat user is waiting).
**Cost.** A second extractor to maintain, with plainer replies.

## ADR-3: Guardrails verify model output where code is reliable

**Context.** Against the live model, a well-formed answer was still wrong: "next Wednesday" came back as a Thursday, "At 5." was stored as 17:00 (closing time), "do you have parking?" was reported as consent, and replies claimed bookings that did not exist.
**Decision.** Post-checks in `guardrails.ts` (policy only; the readers live in `parse.ts`). A confidently parsed date or time from the same message overrides the model's. A detail with two readings is asked about, **one question per turn, date first**, and the turn carries `clarification { field, options }` so the chips offer exactly those readings; AM/PM is asked only when both readings can be booked. A service the user never named is dropped. Consent is an allow-list of plain agreements. An off-topic message gets a code-worded redirect. A reply claiming a booking, naming a different day or time, or built around a dropped service is replaced. Each correction is logged in `ai_interaction_logs.guardrails`. The full list is in [ai-integration.md](ai-integration.md#guardrails).
**Cost.** False positives replace natural wording with a template, the right trade when a false negative tells someone they have an appointment they do not. Grounding also rejects a correct inference from a description ("my teeth are yellow" → whitening); the user is asked to pick instead.

## ADR-4: Conversation memory lives in the database

**Decision.** `chat_sessions.booking_draft` is the memory. It is restated in each prompt, merged field by field (an absent field is not a cleared field), and returned in every turn. History sent to the model is capped at `AI_HISTORY_TURNS`. Each assistant message stores its `action`, `suggestions`, `clarification`, a required `draft` snapshot and, when it booked, the `appointmentId` (`chat_messages.meta`), so a reload rebuilds every card from its own message.
**Alternatives.** Transcript recall by the model (prompt grows each turn, and the draft would change with the provider).
**Cost.** A merge policy to get right, which is covered by shared unit tests.

## ADR-5: Double-booking is prevented by an EXCLUDE constraint

**Context.** "Check availability, then insert" races under concurrency.
**Decision.** `EXCLUDE USING gist (business_id WITH =, service_id WITH =, slot WITH &&) WHERE status IN ('pending','confirmed')` on a generated `tstzrange`, and a second one per customer (`user_id` instead of `service_id`). The application pre-check exists for good error messages and suggestions. The constraint is the guarantee, and its violation maps to `409`. Booking inserts in one business queue on a transaction-scoped advisory lock, so overlapping concurrent inserts meet as an ordinary exclusion violation instead of deadlocking in the index.
**Alternatives.** `SELECT … FOR UPDATE` or advisory locks alone (correct, but easy to bypass from a new code path); serializable transactions (retry plumbing everywhere).
**Cost.** Scope is per service, a modelling simplification. Real practices need `resource_id`.

## ADR-6: Shared-schema multi-tenancy with composite foreign keys

**Context.** A SaaS product needs tenant isolation that holds even when application code has a bug.
**Decision.** Every tenant-scoped row has `business_id`. Children reference parents by `(business_id, id)`, so the database refuses cross-tenant links. `business_id` comes only from the JWT.
**Alternatives.** Schema- or database-per-tenant (strong isolation, but operationally heavy for many small tenants); RLS alone (good, but it depends on the session variable being set correctly on every connection).
**Cost.** Wider keys and extra UNIQUE constraints. RLS is the planned second layer.

## ADR-7: Plain SQL with `pg` and a small migration runner, no ORM

**Context.** The brief asks for the DDL as a deliverable and evaluates modelling, constraints and indexes.
**Decision.** Hand-written SQL migrations, a forward-only runner with a checksum ledger and one transaction per file, and parameterized queries in repositories. The development-time migrations were squashed before release into `001_schema.sql` and `002_indexes.sql`, since there was no production data to carry; from now on every change is a new incremental migration.
**Alternatives.** Prisma or Drizzle. Both hide EXCLUDE constraints, generated range columns, partial indexes and composite-FK `ON DELETE SET NULL (col)` behind escape hatches, which is exactly the work being assessed.
**Cost.** Manual row-to-DTO mapping and no generated types for rows. Mitigated by narrow repository functions and the integration tests.

## ADR-8: Short-lived JWT plus rotating opaque refresh tokens, in httpOnly cookies

**Context.** The brief allows JWT or sessions. Tokens in `localStorage` are one XSS away from theft.
**Decision.** A 15-minute HS256 access JWT (`sub`, `bid`, `role`, `email`) in an httpOnly cookie, also accepted as a Bearer header for API clients. A 7-day opaque refresh token, stored as SHA-256 and rotated on every use, in an httpOnly cookie scoped to `/api/auth`. Replay of a rotated token revokes every session of that user. A 15-second grace window turns a sibling tab's lost race into `SESSION_SUPERSEDED` instead of a forced logout, and, when the successor was never used, recovers an abandoned rotation (a response lost to a timeout) by revoking the unused successor and issuing a fresh pair, as Auth0's reuse interval does. The client serializes refreshes with Web Locks.
**Alternatives.** Server sessions (simplest revocation, but a lookup on every request and the brief leans JWT); a JWT refresh token (cannot be revoked without a denylist, which is a database hit anyway).
**Cost.** Inside the window, whoever presents a just-rotated token whose successor is unused gets a session; that is the reuse interval's trade, bounded to 15 seconds. An access token stays valid up to 15 minutes after logout on REST calls (no denylist; checking one would put a lookup on every request, which the short TTL avoids). Sockets are cut sooner: on token expiry, logout everywhere and refresh-token replay. The socket needs a JS-readable token, kept in memory only.

## ADR-9: REST through a same-origin proxy; Socket.IO as a direct enhancement

**Context.** The web app (Vercel) and API (Render) are on different sites, and third-party cookies are increasingly blocked. A chat that depends on a WebSocket looks broken behind a restrictive proxy.
**Decision.** Next.js rewrites `/api/:path*` to `API_ORIGIN`, so cookies are first-party, `SameSite=Lax` and need no CORS preflight. Each chat turn is a REST request that returns the whole turn. WebSocket upgrades do not survive the rewrite, so the browser connects to the API's Socket.IO endpoint directly, authenticating with the in-memory token. Sockets only push to the user's other tabs (`assistant:turn`, `assistant:typing`, `appointment:*`); rooms are `user:<id>`, plus `business:<id>` for staff and owners, and nothing broadcasts. On reconnect the client refetches.
**Alternatives.** Socket-only chat (a blocked WebSocket would look like a broken product); polling only (meets the brief, but cross-tab updates arrive late); cross-site cookies (`CROSS_SITE_COOKIES=true` remains for a deployment without the proxy).
**Cost.** An extra network hop on REST calls, and the API sees the proxy as its TCP peer (see [deployment.md](deployment.md#rate-limiting-behind-the-proxy)). Two delivery paths, reconciled by message id. Rooms live in process memory, so more than one API instance needs the Redis adapter.

## ADR-10: Booking retries use an Idempotency-Key claimed inside the booking transaction

**Context.** A booking whose response is lost (a timeout, a dropped connection, a double-clicked Confirm) used to be retried as a new request. The per-customer EXCLUDE constraint already stopped a second row, but the retry got `409 CUSTOMER_BUSY` for the booking it had just made.
**Decision.** `POST /api/appointments` accepts an optional `Idempotency-Key` header (1–255 printable ASCII characters; the web app sends a UUID). Keys live in `idempotency_keys`, scoped to `(business_id, user_id, key)`. The booking transaction inserts the key row **first**, so a concurrent request with the same key blocks on the primary key until the first commits (then it replays) or rolls back (then it books). The stored response is the exact 201 body, replayed with `Idempotent-Replayed: true`; a different request under the same key is `422 IDEMPOTENCY_KEY_REUSED`. Only successes are stored, so a refusal or a database failure rolls the key back with the booking and the client can retry with the same key. Keys are honoured for 24 hours.
**Alternatives.** Deduplicating on the booking's own fields (cannot tell a retry from a deliberate second booking); a lookup before the insert (racy); an advisory lock (works, but a unique key is the guarantee reviewers expect and it doubles as the store).
**Cost.** One more table, with no sweep job yet (its `created_at` index is there for one). A replay returns the booking as it was when created, even if it was cancelled since; that is what the original caller would have seen.

---

## Minor decisions

- **Monorepo with a shared contract package.** `@appt/shared` holds the zod schemas, DTOs, `ERROR_CODES` and `SOCKET_EVENTS`, so form, API and LLM tool schema cannot drift; it must be built before the apps.
- **Express 4 with `asyncHandler`.** The long-established middleware pairing; the wrapper closes the one async gap Express 5 fixes, so upgrading later is mostly deleting it.
- **Client-side route guard.** The refresh cookie is scoped to `/api/auth`, so Next.js middleware cannot see it; `AuthGuard` restores the session, and every data call is authorized on the server regardless.
- **Timezone conversion in Postgres.** `AT TIME ZONE businesses.timezone` at insert and in availability, so Node and the database cannot disagree about DST.
- **TanStack Query plus a pure reducer, no global store.** Server state lives in the query cache; only unconfirmed chat state lives in a reducer.
- **Fire-and-forget AI logging to Postgres.** One row per provider call, never awaited, never throwing; partition by month at scale.
- **Hosting on Vercel, Render and Neon.** Socket.IO needs a long-lived process (Render); migrations run in `startCommand` because the free plan has no pre-deploy step.
- **Rate-limit keys follow `TRUST_PROXY_HOPS`.** The hop count is a fact about the deployment; login keys by IP and counts only failures (keying by IP + email would hand an attacker 10 tries per email). See [deployment.md](deployment.md#rate-limiting-behind-the-proxy).
- **Signup says when an email is already registered.** Hiding it needs email verification, which does not exist yet; bounded by the auth limiter and scoped to one business.
- **Closed weekdays are a column; DST gaps are refused.** `businesses.open_days` defaults to all seven days. A spring-forward wall time is `400` on `time` and left out of the grid; a repeated fall-back time books its second (standard-time) occurrence, Postgres's own resolution.
- **One workspace per owner email.** A resubmitted owner signup gets `409 EMAIL_TAKEN` instead of a second, unreachable business; an advisory lock serialises concurrent submissions.
