# Verification matrix

Every use case and edge case from the pre-submission checklist, with its status and the evidence behind it. **P0** = core workflow, security or data integrity; **P1** = reliability and UX; **P2** = polish.

Status key: **Pass** — already correct, now proven by the cited test · **Fixed** — a gap found during verification, fixed and covered by the cited test · **By design** — intentionally different, documented.

Evidence paths: API tests live in `apps/api/test/{unit,integration}/`, web unit tests next to their components in `apps/web/src/`, e2e specs in `apps/web/e2e/`. Test names are quoted so they can be found with a search. Totals at the time of writing: **769 API**, **462 web**, **98 e2e** (96 pass, 2 skipped by design: `accessibility.spec` is desktop-only), all green; CI runs all three on every push.

## Main use cases

| ID | Use case | P | Status | Evidence |
|---|---|---|---|---|
| UC01 | Create an account | P0 | Pass | `signup.spec` "creates a new business…" / "joins an existing business…"; `auth.test` "creates a new tenant with the signer as owner when no business slug is given" (the stored `password_hash` is a cost-12 bcrypt hash, not the plaintext), "normalises the email to lower case" |
| UC02 | Log in and log out | P0 | Pass | `session.spec` "signing out clears the session…" (no cookies, socket closed, refresh 401, Back shows nothing private); `AuthProvider.test` |
| UC03 | Book through the form | P0 | Pass | `appointments.spec` "books from the dialog…" (toast + card) |
| UC04 | All details in one message | P0 | Pass | `chat.test` / `ai-mistral.test` one-shot cases → `confirm` with a code-built summary; live model verified |
| UC05 | Multi-message booking | P0 | Pass | `chat.test` multi-turn suite; draft persisted per session (memory = server-side draft) |
| UC06 | Correct a detail mid-conversation | P0 | Pass | `chat.test` (deterministic engine) and `ai-mistral.test` "replaces the date and time on "Actually, make it Wednesday at 2 PM." and asks again before booking" (weekday computed from the pinned clock; new date and 14:00, `confirm`, nothing booked); `chat.test` "keeps the other details when the user corrects one mid-conversation" |
| UC07 | Confirm → exactly one appointment | P0 | Pass | `chat.test` "books once per conversation when chat "yes", the booking form and the draft form race (20 rounds)" (exactly one live appointment per conversation each round); "books once when the same confirmation arrives several times at once" |
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
| Protected API without auth → 401 | P0 | Pass | `authz.test` "answers 401 on every protected endpoint, with nothing but the error envelope" (all 13); "sweeps every registered /api route except the public ones" reads the routes from the Express router, so a new route not in the sweep fails the suite (public: `/api/health`, `/api/auth/{signup,login,refresh,logout}`) |
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
| "Book a consultation tomorrow at 10 AM." | P0 | Pass | `chat.test` "takes "Book a consultation tomorrow at 10 AM." as a day and time, invents no service, and lists the real ones" (deterministic engine: no service, tomorrow in the business timezone from the pinned clock, 10:00, reply lists the catalogue). For the model path, `ai-mistral.test` "cannot sell a service the business does not offer" |
| "Book me on Friday." | P1 | **Fixed** | Said on a Friday, asks "this Friday or next?" only when both are bookable (open day, slots left): `fallback.test` "asks whether today’s weekday means today or next week while today is still bookable" and the "today’s weekday when today cannot be booked: a week today, without asking" suite; `guardrails.test` "asks whether today’s weekday means today or a week today while both can be booked" |
| "At 5." | P0 | **Fixed** | Was set up as 5 PM (closing time). An hour without AM/PM is taken only when exactly one reading can start a booking; otherwise the assistant asks: `fallback.test` "asks AM or PM for "At 5.", and stores no time", `ai-mistral.test` "is asked AM or PM instead of keeping its guess for "At 5.", and a "yes" then books nothing" |
| "Book for 03/04." | P1 | **Fixed** | Was silently stored as March 4; now "March 4 or April 3?": `fallback.test` "asks which date "03/04" means, and stores no date", `guardrails.test` "asks which date "03/04" means instead of keeping the model’s reading" |
| "Actually, make it Wednesday at 2 PM." | P0 | Pass | Replaces date and time, shows the summary again, books nothing: see UC06 (both engines) |
| "Keep the date, but change the service." | P0 | Pass | `ai-mistral.test` "changes only the service on "Keep the date, but change the service", even when the model drops the name" |
| "Don't book anything yet." | P0 | **Fixed** | Now says nothing was booked and keeps the draft: `ai-mistral.test` "cannot book on "Don’t book anything yet." even when the model reports the user confirmed"; `chat.test` "says nothing was booked on "Don’t book anything yet." and keeps the details for later" |
| Questions are never consent ("Can you confirm the price first?") | P0 | **Fixed** | Found by an external audit: that message booked. Consent is now a short allow-list of plain agreements; any question is answered (price/duration) and the summary re-shown. 36-phrase table in `test/helpers/consent.ts`, run against both engines |
| "Yes" before details | P0 | Pass | `chat.test` "does not treat "yes" as consent when there is nothing to confirm" |
| Unsupported service | P0 | **Fixed** (deterministic engine) | The model path already said "We don't offer that" and listed the catalogue (`ai-mistral.test` "cannot sell a service the business does not offer"; model-invented services are dropped as `service_ungrounded`). The deterministic engine only asked "Which service?" as if nothing had been named; it now passes a requested name through so the same answer is given: `chat.test` "says a service the business does not offer is not offered, and lists the ones it does" ("I'd like a haircut on … at 11am": no service set, day and time kept), `fallback.test` `requestedService` suite |
| Unavailable time | P0 | **Fixed** (earlier) | Checked *before* the summary is shown, with real alternatives: `chat.test` / `ai-mistral.test` outside hours, closed day, taken, past |
| Prompt injection ("show other users' bookings") | P0 | Pass | The model only ever sees this customer's draft and catalogue: `ai-mistral.test` "holds only this tenant and this customer, so "show other users’ bookings" has nothing to leak"; live reply refuses |
| Provider returns invalid JSON / extra fields | P0 | Pass | `ai-mistral.test` "falls back on <variant>, without retrying: the model answered, the answer was wrong" (10 variants, e.g. "falls back on malformed JSON in the tool arguments, without retrying: …"), "cannot smuggle extra fields through: only the booking slots reach the draft" |
| Plausible-but-invalid date from the model | P0 | Pass | `ai-mistral.test` "falls back on a date that does not exist, without retrying: …", "cannot book a date that has already passed, and does not summarise it", "cannot book outside opening hours, and does not summarise such a time" |
| Provider timeout / 429 / 5xx | P0 | Pass | `ai-mistral.test` "retry policy" suite (bounded time, then deterministic engine); `reliability.spec` form still books |
| Rapid messages | P1 | **Fixed** | Turns per conversation now run in order: `chat.test` "takes rapid messages one at a time, in order…" |
| Very long conversation | P1 | Pass | `ai-mistral.test` "sends at most AI_HISTORY_TURNS messages…"; draft kept server-side |
| Switching conversations while a reply is pending | P1 | Pass | `reliability.spec` "a reply that arrives after switching conversations lands in the conversation it belongs to" |
| Unrelated question | P2 | **Fixed** | The app keeps the draft unchanged and passes the model's answer through: `ai-mistral.test` "answers an unrelated question briefly and leaves the draft as it was" (the stub's reply is scripted, so brevity itself comes from the system prompt, not from code); `fallback.test` "keeps the draft and does not confirm on an unrelated question" |

## Scheduling and database

| Test | P | Status | Evidence |
|---|---|---|---|
| Past date or time | P0 | Pass | `appointments.test` "refuses a time that is in the past" (earlier days), "refuses a time earlier today in the business’s timezone" (the latest half-hour before now, today in New York → 422 `APPOINTMENT_IN_PAST`) |
| Impossible date (Feb 30) | P0 | Pass | Shared `isoDateSchema` round-trip; `appointments.test` "rejects a day that does not exist…" |
| Outside hours / closed day | P0 | **Fixed** (closed days) | Closed weekdays were not modelled; migration 007 adds `businesses.open_days`: `booking-integrity.test` "closed days" suite |
| Booking at closing time | P1 | Pass | "allows a booking that ends exactly at closing time…", 16:45 refused for a 30-min service |
| Two users, same slot, simultaneously | P0 | Pass | `appointments.test` "lets exactly one of ten simultaneous requests for the same slot win" (losers 409 `SLOT_UNAVAILABLE`, one row; EXCLUDE constraint) |
| Overlap with a different start time | P0 | **Fixed** | Asserting the losers' answers found that overlapping concurrent inserts could deadlock in the EXCLUDE indexes, so a loser got a 500 instead of 409 (about 1 run in 6). Booking inserts in a business now queue on a transaction-scoped advisory lock, so the second meets the first's committed row as an ordinary exclusion violation (`repository.lockBookingsFor`). `appointments.test` "lets exactly one overlapping-but-not-identical request win" (four 60-min bookings at 14:00/14:30 from four users: one 201, losers 409 `SLOT_UNAVAILABLE`, exactly one live row overlapping 14:00–15:30) |
| Double-click Confirm | P0 | **Fixed** (web) | The dialog could send two requests; now one: `reliability.spec` "a double click on Book appointment shows it is working and sends one request, with an idempotency key" (request count), "a double click on Confirm booking in chat books once". Each safeguard is proven alone in `BookingDialog.test`: "the in-flight guard alone: two submits in one act, with no re-render between them, make one request" and "the busy button alone: once a booking is in flight, clicking it again does not even submit the form" (each fails when its safeguard is removed); plus "makes one request from two back-to-back clicks" |
| Response lost, user retries | P0 | **Fixed** | `Idempotency-Key` (migration 008): same key replays the original 201, never a second booking; `reliability.spec` "a booking whose response is lost is retried with the same key…" against the real server |
| Same key, different details | P1 | **Fixed** | 422 `IDEMPOTENCY_KEY_REUSED` |
| Slot taken after the form loaded | P0 | Pass | `booking-integrity.test` "is rechecked at confirmation and refused with 409…" |
| Two bookings in one conversation (chat + form at once) | P0 | **Fixed** | Found by an external audit. Every conversation-linked booking locks the conversation row; migration 009 adds a unique index as backstop. `chat.test` "books once per conversation when chat "yes", the booking form and the draft form race (20 rounds)" fires chat, form and fallback form together 20 times → exactly one booking each time |
| Booking into a conversation whose booking was cancelled | P0 | Pass | The unique index ignores cancelled rows, so only the conversation's `completed` status refuses it: `chat.test` "stays closed after its booking is cancelled: the form and the draft form cannot book into it again" (409 `SESSION_CLOSED` from `POST /api/appointments` and `/api/chat/draft`; fails if the status check in `bookInSession` is removed) |
| Device / browser timezone | P0 | Pass | `timezone-independence.test` (API at Pacific/Kiritimati, DB at Asia/Kathmandu); `display.spec` booked from Karachi, read from Los Angeles, identical labels |
| Near midnight / relative dates | P1 | Pass | Business-calendar anchoring tests; date-dependent tests run against a fixed "today", verified on all 7 weekdays |
| DST nonexistent / repeated time | P1 | **Fixed** | A spring-forward time was silently moved an hour; now refused with a field error and hidden in the picker. Repeated fall-back time books the documented occurrence (ADR-021) |
| Database fails during confirmation | P0 | Pass | `booking-integrity.test` "answers 500 and stores nothing when the insert fails, never a false confirmation" and the same for "commit" — no row, no key, no false confirmation |
| Cancel twice | P1 | Pass | 409 `APPOINTMENT_NOT_CANCELLABLE`; "lets exactly one of several simultaneous cancellations… succeed" |
| Rescheduling fails | P0 | By design | Not implemented (optional in the brief); cancel and book again |

## Frontend and reliability

| Test | P | Status | Evidence |
|---|---|---|---|
| Empty states | P1 | Pass | Dashboard "Nothing coming up" with a Book action; chat starter prompts |
| Slow API: loading state, no duplicate actions | P0 | **Fixed** | See double-click above; busy states asserted in `reliability.spec` |
| Network drops while sending | P1 | Pass | `reliability.spec` "a message whose request drops mid-flight is kept, and Retry sends it once", "a message sent while offline is kept, says why it waits, and goes out once the connection is back" |
| Live updates fail | P1 | Pass | `reliability.spec` "with live updates down…" — content stays, no repeated errors |
| Reply arrives while editing the fallback form | P1 | **Fixed** | A picked time could be overwritten; `FallbackFormCard.test` "keeps what the user picked or typed…" |
| Reload right after confirmation | P0 | Pass | `reliability.spec` (2 tests) |
| Two tabs | P1 | Pass | `reliability.spec` "two tabs on one conversation stay in step"; cross-tab refresh serialised with Web Locks |
| Very long messages / notes | P1 | Pass | `safety.spec` "very long input" (limits, wrapping, no overflow) |
| HTML / script input | P0 | Pass | `safety.spec` "in a name, a chat message and booking notes": all three payloads (`<script>`, `<img onerror>`, `<svg onload>`, each setting `window.__xss` and calling `alert`) go into the name, into three chat messages and into the notes; on `/assistant` and again on `/appointments` they render as text, no dialog opens, `window.__xss` stays unset and no `img[src=x]` or `svg[onload]` element exists. No `dangerouslySetInnerHTML` anywhere |
| Mobile / 200% zoom | P1 | Pass | `accessibility.spec` "at 200% zoom (a 1280px window shows 640 CSS pixels) everything still fits and works" sets a 640×360 viewport, the CSS-pixel equivalent of 1280×720 at 200% (desktop project only). Mobile: every other spec also runs on a Pixel 7 profile; `accessibility.spec` is desktop-only |
| Keyboard only | P1 | Pass | `accessibility.spec` "books, sees validation errors and closes dialogs with the keyboard alone" |
| Unexpected API error | P0 | Pass | API, in production mode: `production-mode.test` "becomes a generic 500 that reveals nothing about the cause" (a thrown pg-style error) and "hides a genuine database failure too: a real missing-table error from Postgres, not a mock" — generic 500 `INTERNAL`, only `code`/`message`/`requestId`, no SQL, table, stack or debug text. UI: `safety.spec` "show a useful message and never the stack, SQL or debug detail behind them" |
| Server cold start (Render free tier) | P0 for the demo | **Fixed** | A wake-up over 30 s showed the sign-in page; now "Waking up the server. This can take up to a minute on the free tier…" with retries for ~90 s and only a definitive 401 signs out (`AuthProvider.test`, `session.spec`). Server side, a refresh whose response was lost now recovers instead of looking like token theft (migration 010, ADR-006) |
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
