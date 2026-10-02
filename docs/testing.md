# Testing

Testing was not in the brief; it is how every claim in these docs is backed. The requirement-by-requirement and edge-case-by-edge-case evidence is in [verification-matrix.md](verification-matrix.md).

## Suites and counts

This is the one place test counts are recorded (latest local run, all green).

| Suite | Command | Count | Needs |
|---|---|---|---|
| API unit + integration | `npm test -w @appt/api` | **791 tests** in 27 files (11 unit, 16 integration), ~25 s | Postgres on :5433, or `TEST_DATABASE_URL` pointing at a server where the role can CREATE DATABASE |
| Web unit/component | `npm test -w @appt/web` | **456 tests** in 41 files, ~7 s | nothing |
| End-to-end (Playwright) | `npm run e2e` | **100 tests** (50 scenarios × desktop and mobile Chrome, 11 spec files): **98 pass, 2 skipped by design** (the two `accessibility.spec` scenarios, keyboard-only and 200% zoom, run on desktop only) | Postgres on :5433, ports 3100 and 4100 free |
| Types + lint | `npm run typecheck && npm run lint` | clean | — |

`npm test` at the root runs the API and web suites. `E2E_ALL_BROWSERS=1 npm run e2e` adds Firefox and WebKit.

## API tests

The integration tests run the real `createApp()` over HTTP (and Socket.IO), against a database built by the production migration runner and `db/seed.sql`. Each test file claims its own database (`appt_test`, `appt_test_1`, …, created on demand; the harness refuses any name not ending in `_test`). Mistral is exercised through a local stub that speaks the chat-completions protocol. Date-relative tests run against a pinned "today" and must pass on all seven weekdays:

```bash
for d in monday tuesday wednesday thursday friday saturday sunday; do TEST_DATABASE_URL=… TEST_TODAY=$d npm test -w @appt/api; done
```

Layout, helpers and conventions: [apps/api/test/README.md](../apps/api/test/README.md).

## Web tests

Vitest + Testing Library, next to the code they test: the chat reducer and turn rebuild, cache upserts, failure mapping, ICS generation, the API client's refresh and superseded handling, `useChat` (optimistic flow, socket echo, typing, `SESSION_CLOSED`), dialogs, forms and tabs.

## End-to-end

`npm run e2e` ([scripts/e2e.mjs](../scripts/e2e.mjs)) brings up a stack of its own:

1. drops and recreates the `appt_e2e` database (it refuses any name not ending in `_e2e`, and any non-local host), then migrates and seeds it;
2. builds everything, with the web build in `apps/web/.next-e2e`, not `.next`;
3. starts the API on :4100 with **no Mistral key** (a preflight refuses a stack with a model, so every reply is deterministic) and rate limits off, and the production web build on :3100;
4. runs Playwright, then stops both servers even when a test fails or the run is interrupted.

A development stack on :3000/:4000 is left alone. Each Playwright worker books only on its own business days (`laneDays` in [e2e/support/api.ts](../apps/web/e2e/support/api.ts)), so parallel tests never compete for a slot.

```bash
npm run e2e                           # the whole suite, desktop + mobile
npm run e2e -- --project=desktop      # extra arguments go to Playwright
npm run e2e -- --skip-build           # reuse the last build; the database is still recreated
npm run e2e:run                       # Playwright alone, against E2E_BASE_URL (a stack started by hand)
```

The specs cover conversational booking (correction mid-flow, one-question clarification with chips, real free-time chips, taken slot → suggestion), the form fallback, the appointments dialog and cancel, realtime across two tabs, resilience (injected 500, network failure, 429 with `Retry-After`), signup create/join, session end and restore (`session.spec`), double clicks, lost responses, offline sends, socket down and assistant down (`reliability.spec`), markup and length limits (`safety.spec`), browser timezones and per-user scoping (`display.spec`), and keyboard-only use and 200% zoom (`accessibility.spec`).

## CI

[.github/workflows/ci.yml](../.github/workflows/ci.yml) runs build, typecheck, lint, the API tests against a Postgres 16 service, the web tests and both production builds on every push and PR; a second job runs `npm run e2e` against its own Postgres service.
