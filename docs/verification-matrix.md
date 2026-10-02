# Verification matrix

Every use case and edge case from the pre-submission checklist, with its status and the evidence behind it. **P0** = core workflow, security or data integrity; **P1** = reliability and UX; **P2** = polish.

Status key: **Pass** — already correct, now proven by the cited test · **Fixed** — a gap found during verification, fixed and covered by the cited test · **By design** — intentionally different, documented.

Evidence paths: API tests live in `apps/api/test/{unit,integration}/`, web unit tests next to their components in `apps/web/src/`, e2e specs in `apps/web/e2e/`. Test names are quoted so they can be found with a search. Totals at the time of writing: **760 API**, **461 web**, **98 e2e** (96 pass, 2 skipped by design), all green; CI runs all three on every push.

## Main use cases

| ID | Use case | P | Status | Evidence |
|---|---|---|---|---|
| UC01 | Create an account | P0 | Pass | `signup.spec` "creates a new business…" / "joins an existing business…"; `auth.test` signup suite (bcrypt hash, citext email) |
| UC02 | Log in and log out | P0 | Pass | `session.spec` "signing out clears the session…" (no cookies, socket closed, refresh 401, Back shows nothing private); `AuthProvider.test` |
| UC03 | Book through the form | P0 | Pass | `appointments.spec` "books from the dialog…" (toast + card) |
| UC04 | All details in one message | P0 | Pass | `chat.test` / `ai-mistral.test` one-shot cases → `confirm` with a code-built summary; live model verified |
| UC05 | Multi-message booking | P0 | Pass | `chat.test` multi-turn suite; draft persisted per session (memory = server-side draft) |
| UC06 | Correct a detail mid-conversation | P0 | Pass | `ai-mistral.test` "replaces the date and time on 'Actually, make it …'"; `chat.test` "keeps the other details when the user corrects one" |
| UC07 | Confirm → exactly one appointment | P0 | Pass | `chat.test` "books once when the same confirmation arrives several times at once"; one-booking-per-conversation lock (see below) |
| UC08 | View own appointments | P0 | Pass | `display.spec` "a customer sees only their own bookings…"; `appointments.test` scoping |
| UC09 | Refresh / return later | P1 | Pass | `chat-booking.spec` reload test; `reliability.spec` "reloading straight after a booking" |
| UC10 | AI unavailable → form still books | P0 | Pass | `reliability.spec` "with the assistant unavailable, the form still books"; whole e2e stack runs without a model |
| UC11 | New conversation is independent | P1 | Pass | `reliability.spec` "a reply that arrives after switching conversations…" |
| UC12 | Cancel / reschedule | P1 | Pass (cancel) · By design (no reschedule) | `display.spec` "a cancellation shows everywhere…"; `booking-integrity.test` cancel races. Reschedule = cancel + book again (README limitations) |

## Authentication and authorization

| Test | P | Status | Evidence |
|---|---|---|---|
| Register twice with the same email | P0 | **Fixed** | Signing up without a business code created a second workspace and an unreachable account. Now: `auth.test` "does not create a second workspace when the same owner signs up again…", "lets exactly one of several simultaneous workspace signups… win" (ADR-022) |
| Different email casing | P1 | Pass | `auth.test` "normalises the email to lower case" (citext column) |
| Missing fields / invalid email / weak password | P0 | Pass | `auth.test` "reports every invalid field at once…", "rejects an empty body…"; live password checklist (`PasswordChecklist.test`) |
| Wrong password | P0 | Pass | `auth.test` "answers a wrong password and an unknown email identically…" |
| Protected API without auth → 401 | P0 | Pass | `authz.test` "answers 401 on every protected endpoint, with nothing but the error envelope" (all 13) |
| Expired / malformed / modified token | P0 | Pass | `auth.test` token-validation suite; `authz.test` "…malformed, truncated or tampered token…"; `session.spec` "an invalid session mid-use…" → `/login?expired=1` |
| Another user's ID in the URL | P0 | Pass | 404 (not 403) for appointments and conversations, same or other tenant: `appointments.test`, `chat.test` |
| Another user's ID in the body | P0 | Pass | `authz.test` "books for the signed-in caller… whatever the body says" (userId, customerId, businessId, role, status ignored) |
| Repeated login attempts | P1 | **Fixed** (message) | `rate-limit.test` "…blocks the eleventh with 429 and a Retry-After"; message now "Try again in 15 minutes." |
| Session expires while filling the form | P1 | **Fixed** | `session.spec` "a session that ends while the booking form is open…" — values kept and the dialog reopens after sign-in |

## AI and conversation

Each case was also run live against Mistral (`ministral-8b-latest`).

| Scenario | P | Status | Evidence |
|---|---|---|---|
| "I want an appointment." | P0 | **Fixed** | Asked only for the service; now asks for service, day and time: `fallback.test`, `chat.test` |
| "Book a consultation tomorrow at 10 AM." | P0 | Pass | "tomorrow" in the business timezone; "consultation" is not a service, so none is invented: `ai-mistral.test` "cannot sell a service the business does not offer" |
| "Book me on Friday." | P1 | **Fixed** | Asks "this Friday or next?" only when both are bookable (open day, slots left): `fallback.test`, `guardrails.test` |
| "At 5." | P0 | **Fixed** | Was set up as 5 PM (closing time). An hour without AM/PM is taken only when exactly one reading can start a booking; otherwise the assistant asks: `fallback.test` "asks AM or PM for 'At 5.'", `ai-mistral.test` |
| "Book for 03/04." | P1 | **Fixed** | Was silently stored as March 4; now "March 4 or April 3?": `fallback.test`, `guardrails.test` |
| "Actually, make it Wednesday at 2 PM." | P0 | Pass | Replaces date and time, shows the summary again |
| "Keep the date, but change the service." | P0 | Pass | `ai-mistral.test` "changes only the service… even when the model drops the name" |
| "Don't book anything yet." | P0 | **Fixed** | Now says nothing was booked and keeps the draft: `ai-mistral.test` "cannot book on 'Don't book anything yet.'…" |
| Questions are never consent ("Can you confirm the price first?") | P0 | **Fixed** | Found by an external audit: that message booked. Consent is now a short allow-list of plain agreements; any question is answered (price/duration) and the summary re-shown. 36-phrase table in `test/helpers/consent.ts`, run against both engines |
| "Yes" before details | P0 | Pass | `chat.test` "does not treat 'yes' as consent when there is nothing to confirm" |
| Unsupported service | P0 | Pass | Lists the real services; model-invented services are dropped (`service_ungrounded`) |
| Unavailable time | P0 | **Fixed** (earlier) | Checked *before* the summary is shown, with real alternatives: `chat.test` / `ai-mistral.test` outside hours, closed day, taken, past |
| Prompt injection ("show other users' bookings") | P0 | Pass | The model only ever sees this customer's draft and catalogue: `ai-mistral.test` "holds only this tenant and this customer…"; live reply refuses |
| Provider returns invalid JSON / extra fields | P0 | Pass | `ai-mistral.test` "falls back on malformed JSON…" (10 variants), "cannot smuggle extra fields through" |
| Plausible-but-invalid date from the model | P0 | Pass | `ai-mistral.test` "falls back on a date that does not exist", past dates, outside hours |
| Provider timeout / 429 / 5xx | P0 | Pass | `ai-mistral.test` retry-policy suite (bounded time, then deterministic engine); `reliability.spec` form still books |
| Rapid messages | P1 | **Fixed** | Turns per conversation now run in order: `chat.test` "takes rapid messages one at a time, in order…" |
| Very long conversation | P1 | Pass | `ai-mistral.test` "sends at most AI_HISTORY_TURNS messages…"; draft kept server-side |
| Switching conversations while a reply is pending | P1 | Pass | `reliability.spec` "a reply that arrives after switching conversations lands in the conversation it belongs to" |
| Unrelated question | P2 | **Fixed** | Brief answer, draft unchanged: `ai-mistral.test` "answers an unrelated question briefly…" |

## Scheduling and database

| Test | P | Status | Evidence |
|---|---|---|---|
| Past date or time | P0 | Pass | `appointments.test` "refuses a time that is in the past" (decided by the database clock) |
| Impossible date (Feb 30) | P0 | Pass | Shared `isoDateSchema` round-trip; `appointments.test` "rejects a day that does not exist…" |
| Outside hours / closed day | P0 | **Fixed** (closed days) | Closed weekdays were not modelled; migration 007 adds `businesses.open_days`: `booking-integrity.test` "closed days" suite |
| Booking at closing time | P1 | Pass | "allows a booking that ends exactly at closing time…", 16:45 refused for a 30-min service |
| Two users, same slot, simultaneously | P0 | Pass | "lets exactly one of ten simultaneous requests for the same slot win" (EXCLUDE constraint) |
| Overlap with a different start time | P0 | Pass | "lets exactly one overlapping-but-not-identical request win" |
| Double-click Confirm | P0 | **Fixed** (web) | The dialog could send two requests; now one: `reliability.spec` "double click on Book appointment…" (request count), chat confirm likewise |
| Response lost, user retries | P0 | **Fixed** | `Idempotency-Key` (migration 008): same key replays the original 201, never a second booking; `reliability.spec` "a booking whose response is lost is retried with the same key…" against the real server |
| Same key, different details | P1 | **Fixed** | 422 `IDEMPOTENCY_KEY_REUSED` |
| Slot taken after the form loaded | P0 | Pass | `booking-integrity.test` "is rechecked at confirmation and refused with 409…" |
| Two bookings in one conversation (chat + form at once) | P0 | **Fixed** | Found by an external audit. Every conversation-linked booking locks the conversation row; migration 009 adds a unique index as backstop. Test fires chat, form and fallback form together 20 times → exactly one booking each time |
| Device / browser timezone | P0 | Pass | `timezone-independence.test` (API at Pacific/Kiritimati, DB at Asia/Kathmandu); `display.spec` booked from Karachi, read from Los Angeles, identical labels |
| Near midnight / relative dates | P1 | Pass | Business-calendar anchoring tests; date-dependent tests run against a fixed "today", verified on all 7 weekdays |
| DST nonexistent / repeated time | P1 | **Fixed** | A spring-forward time was silently moved an hour; now refused with a field error and hidden in the picker. Repeated fall-back time books the documented occurrence (ADR-021) |
| Database fails during confirmation | P0 | Pass | `booking-integrity.test` "answers 500 and stores nothing when the insert/commit fails…" — no row, no key, no false confirmation |
| Cancel twice | P1 | Pass | 409 `APPOINTMENT_NOT_CANCELLABLE`; "lets exactly one of several simultaneous cancellations… succeed" |
| Rescheduling fails | P0 | By design | Not implemented (optional in the brief); cancel and book again |

## Frontend and reliability

| Test | P | Status | Evidence |
|---|---|---|---|
| Empty states | P1 | Pass | Dashboard "Nothing coming up" with a Book action; chat starter prompts |
| Slow API: loading state, no duplicate actions | P0 | **Fixed** | See double-click above; busy states asserted in `reliability.spec` |
| Network drops while sending | P1 | Pass | `reliability.spec` "dropped mid-flight… Retry", "sent while offline…" (sent automatically on reconnect) |
| Live updates fail | P1 | Pass | `reliability.spec` "with live updates down…" — content stays, no repeated errors |
| Reply arrives while editing the fallback form | P1 | **Fixed** | A picked time could be overwritten; `FallbackFormCard.test` "keeps what the user picked or typed…" |
| Reload right after confirmation | P0 | Pass | `reliability.spec` (2 tests) |
| Two tabs | P1 | Pass | `reliability.spec` "two tabs on one conversation stay in step"; cross-tab refresh serialised with Web Locks |
| Very long messages / notes | P1 | Pass | `safety.spec` "very long input" (limits, wrapping, no overflow) |
| HTML / script input | P0 | Pass | `safety.spec` — `<script>`, `<img onerror>`, `<svg onload>` in a name, a message and notes render as text; no `dangerouslySetInnerHTML` anywhere |
| Mobile / 200% zoom | P1 | Pass | `accessibility.spec` "at 200% zoom…"; every spec also runs on a Pixel 7 profile |
| Keyboard only | P1 | Pass | `accessibility.spec` "books, sees validation errors and closes dialogs with the keyboard alone" |
| Unexpected API error | P0 | Pass | `safety.spec` "unexpected server errors…" (no SQL, stack or debug detail reaches the UI) |
| Server cold start (Render free tier) | P0 for the demo | **Fixed** | A wake-up over 30 s showed the sign-in page; now "Waking up the server…" with retries for ~90 s and only a definitive 401 signs out (`AuthProvider.test`, `session.spec`). Server side, a refresh whose response was lost now recovers instead of looking like token theft (migration 010, ADR-006) |
| Other browsers | — | Pass | Firefox 146 and WebKit 26: 96 pass / 2 skipped with `E2E_ALL_BROWSERS=1` |

## Submission checks

| Check | Status | Evidence |
|---|---|---|
| Fresh clone works from the README alone | Pass | Cloned into a scratch directory, followed the non-Docker path, migrated, seeded, booked through the web proxy, ran both test suites. README gaps found there (ports, `TEST_DATABASE_URL`, `verify.sql`) are now documented |
| Migrations and sample inserts run | Pass | Migrations run from scratch on every API test run and every e2e run; `db/verify.sql` checks all pass |
| Deployed app uses persistent PostgreSQL | Pass | Neon; a booking made through the live site survives a fresh login and an API restart |
| Real AI provider in deployment | Pass | Live turns report `engine: mistral`; the full demo flow (signup → multi-turn → correction → confirm → persisted → slot conflict → form fallback) ran on production |
| No secrets in git or the frontend bundle | Pass | Full `git log -p` and every shipped JS chunk scanned: no keys, connection strings or JWT secrets |
| GitHub matches the deployed version | Pass | GitHub's deployment records show Render and Vercel on the head commit of `main` |
| README and demo reachable by a reviewer | Pass | Raw README, all screenshots and every link resolve anonymously; `/health` is public |
