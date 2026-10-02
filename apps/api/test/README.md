# API tests

```bash
npm test -w @appt/api              # whole suite, ~25s
npm run test:watch -w @appt/api    # re-run on change
npm run typecheck:test -w @appt/api
```

Needs Postgres on `localhost:5433` (`npm run db:up`) and Node 22 (the runner
expands the `test/**/*.test.ts` glob itself). No other setup: the harness
creates the test databases on first use.

## What is under test

| Folder | What | Needs a database |
| --- | --- | --- |
| `unit/` | Date/time helpers, the deterministic fallback extractor, tool-call validation, model-answer guardrails, prompt content, the shared schemas and `mergeSlots` | no |
| `integration/` | The real Express app over real HTTP (and Socket.IO), against a freshly migrated and seeded Postgres | yes |

Integration files are split by concern, not by endpoint: `auth`, `appointments`,
`availability` (including DST), `chat` (deterministic engine), `ai-mistral`
(the provider against a local stub), `http` (envelope, request ids, body limits,
CORS, health), `rate-limit`, `production-mode`, `realtime`, `schema` (the
constraints in `db/verify.sql`, checked directly), `migrations` (runner and seed),
`authz` (every protected endpoint without a session, with a bad token, and with
an identity claimed in the body), `booking-integrity` (Idempotency-Key, double
submits, a slot taken while the form is open, database failure at insert and at
COMMIT, closed weekdays, DST gaps and repeats, near-midnight zones) and
`timezone-independence` (the API process and the database sessions in other zones).

## How a test file works

`startTestApp()` (`helpers/testApp.ts`) does, per file:

1. claims a database, drops and recreates its `public` schema,
2. runs the **production migration runner** over `db/migrations`,
3. applies `db/seed.sql`,
4. serves `createApp()` on an ephemeral port.

So every file also proves that "migrate from scratch, then seed" works, and no
file depends on what another left behind. Environment is pinned in
`BASE_ENV`; a file overrides what it needs, e.g.
`startTestApp({ env: { RATE_LIMIT_DISABLED: 'false' } })`. Application modules
are imported *after* that, because `config/env.ts` reads `process.env` once.

Rate limiting is off by default and only `rate-limit.test.ts` and
`production-mode.test.ts` turn it on.

## Databases

`node:test` runs files in parallel processes, so files cannot share a database.
Each claims one with a Postgres advisory lock: `appt_test`, then `appt_test_1`,
`appt_test_2`, and so on, created on demand. Run with `--test-concurrency=1` and
everything uses `appt_test`. The harness refuses any database whose name does not
end in `_test`; the dev database is never touched. Override the server with
`TEST_DATABASE_URL`.

## Conventions

- **A pinned "today" for relative dates.** `helpers/clock.ts` places the reference day on the
  `TEST_TODAY` weekday (default Wednesday) at least a week after the real date, at 10:00 business
  time; unit tests pass it as the provider's `today`, and `chat`/`ai-mistral` pin the app's clock
  to it. "In the past" stays the database's real `now()`, so past dates come from `pastDate()`.
  Every weekday must pass:
  `for d in monday tuesday wednesday thursday friday saturday sunday; do TEST_TODAY=$d npm test -w @appt/api; done`
- **No hard-coded dates.** The seed anchors its bookings to `now()`, so tests ask
  `fixtures.ts` for dates (`freshDate()`, `futureDate(n)`, `nextDstTransition()`).
- **Assert the envelope, not just the status.** `assertApiError(res, status, code)`
  checks the error shape, the request id and that the body is JSON.
- **Expected instants come from `helpers/zonedTime.ts`**, an independent
  wall-clock-to-UTC conversion, so Postgres is never asked to check itself.
- **Work done after the response** (AI log rows) is awaited with `eventually()`.
- **The Mistral provider is exercised over HTTP** against `helpers/mistralStub.ts`,
  which speaks the chat-completions protocol and is scripted per test.
- **Anything that revokes every session of a user** (token-theft detection,
  logout-everywhere) signs up a user of its own, so it cannot log out the seeded
  account another test is using.
