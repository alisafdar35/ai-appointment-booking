# Assessment checklist

Every requirement line in the brief, with its status and the evidence. **Done** means implemented and covered by tests or manual verification. **Partial** and **Not yet** are explained.

Test counts are from the latest local run: API 559 passing (22 files), web 425 passing (39 files). The e2e suite has 50 tests (25 scenarios × 2 viewports), run locally against a live stack: 50/50 on one run, but on a development database already holding hundreds of e2e bookings, parallel specs occasionally collide on the same free slot (see the README's known limitations).

## Submission

| Requirement | Status | Evidence / note |
|---|---|---|
| Push code to a GitHub repository | **Not yet** | Remote configured: https://github.com/alisafdar35/ai-appointment-booking. Nothing committed or pushed at the time of writing |
| Share the repository URL | **Not yet** | Same as above |
| Publicly viewable README / documentation | Done (in repo) | [README.md](../README.md), [docs/](.) (public once pushed) |
| Deploy the prototype and share a live demo link | **Not yet** | Deploy config ready: [render.yaml](../render.yaml), [apps/web/vercel.json](../apps/web/vercel.json), and the step-by-step guide [deployment.md](deployment.md). The README has placeholders for the URLs |
| Optional: recorded demo video | **Not yet** | Script and shot list: [demo-script.md](demo-script.md) |

## Documentation must explain

| Requirement | Status | Evidence |
|---|---|---|
| High-level architecture | Done | [README § Architecture](../README.md#architecture) (flowchart and sequence diagram), [architecture.md](architecture.md) |
| How to run locally | Done | [README § Quick start](../README.md#quick-start), [README § Testing](../README.md#testing) |
| Key design decisions and tradeoffs | Done | [README § Key design decisions](../README.md#key-design-decisions), [decisions.md](decisions.md) (19 ADRs) |
| Assumptions and known limitations | Done | [README § Assumptions](../README.md#assumptions), [§ Known limitations](../README.md#known-limitations) |

## Assessment objective

| Requirement | Status | Evidence |
|---|---|---|
| End-to-end web app with an AI-assisted chatbot for booking | Done | `/assistant` → `POST /api/chat/messages` → [chat/service.ts](../apps/api/src/modules/chat/service.ts) → [appointments/service.ts](../apps/api/src/modules/appointments/service.ts) |
| Clean frontend/backend separation | Done | Separate apps; the only shared code is the contract package [packages/shared](../packages/shared/src); the web app talks to the API only over HTTP and Socket.IO |
| Practical API and database design | Done | [api.md](api.md), [database.md](database.md) |
| Thoughtful UI and UX | Done | [frontend.md](frontend.md), [screenshots](screenshots) |
| Sensible AI integration (not research) | Done | [ai-integration.md](ai-integration.md) |

## 1. Frontend application

| Requirement | Status | Evidence |
|---|---|---|
| React or Next.js | Done | Next.js 15 App Router, React 19 ([apps/web](../apps/web)) |
| A web page with an embedded chatbot UI | Done | [ChatWorkspace.tsx](../apps/web/src/features/chat/components/ChatWorkspace.tsx), [ConversationPanel.tsx](../apps/web/src/features/chat/components/ConversationPanel.tsx) · [screenshot](screenshots/assistant-conversation.png) |
| Real-time or near-real-time chat (WebSockets or polling) | Done | Socket.IO: `assistant:typing`, `assistant:turn`, `appointment:*` ([realtime/index.ts](../apps/api/src/realtime/index.ts), [RealtimeProvider.tsx](../apps/web/src/providers/RealtimeProvider.tsx)), with long-polling transport fallback. Staff and owners also join a business room, so their dashboards update live. Turns themselves are request/response (not token-streamed) |
| Basic authentication (signup/login with JWT or session) | Done | [auth/routes.ts](../apps/api/src/modules/auth/routes.ts), [LoginForm.tsx](../apps/web/src/features/auth/LoginForm.tsx), [SignupForm.tsx](../apps/web/src/features/auth/SignupForm.tsx); tests in `auth.test.ts` |
| Appointment booking UI (form or conversational) | Done (both) | Conversational, the in-chat form ([FallbackFormCard.tsx](../apps/web/src/features/chat/components/FallbackFormCard.tsx)), and the dashboard dialog ([BookingDialog.tsx](../apps/web/src/features/appointments/BookingDialog.tsx)) |
| Clean, well-structured, visually usable UI | Done | Design-system primitives in [components/ui](../apps/web/src/components/ui); checked at 1440/1024/390 px and in dark mode |
| Attention to layout, spacing, typography, interactions | Done | Skeletons, focus management, keyboard support, toasts, reduced motion ([frontend.md](frontend.md#accessibility)) |
| *Eval:* component structure and state management | Done | Feature folders; Query cache + pure reducer ([frontend.md § State](frontend.md#state-management)) |
| *Eval:* API integration patterns | Done | Typed client with single-flight refresh ([client.ts](../apps/web/src/lib/api/client.ts)); query keys and hooks ([lib/queries](../apps/web/src/lib/queries)) |
| *Eval:* async flows and errors | Done | Optimistic sends, retry, rate-limit countdown, `SESSION_CLOSED` recovery, 409 handling; `useChat.test.tsx`, `client.test.ts`, e2e `resilience.spec.ts` |
| *Eval:* conversation-driven UX | Done | Draft rail, confirmation card, suggestion chips, quick replies, needs_form offer, transcript restore |
| *Eval:* UI clarity, usability, polish | Done | [screenshots](screenshots) |

## 2. Backend API

| Requirement | Status | Evidence |
|---|---|---|
| Node.js with Express | Done | Express 4 ([app.ts](../apps/api/src/app.ts)); choice explained in [ADR-002](decisions.md#adr-002-express-4-with-an-explicit-async-wrapper) |
| REST: authentication | Done | signup, login, refresh, logout, me ([api.md § Auth](api.md#auth)) |
| REST: chat messages | Done | sessions list/create/get, messages, draft ([api.md § Chat](api.md#chat-requires-auth)) |
| REST: appointment creation and retrieval | Done | list (filters), create, get, cancel; services and availability ([api.md § Appointments](api.md#appointments-requires-auth)) |
| JWT or session-based auth | Done | [lib/jwt.ts](../apps/api/src/lib/jwt.ts), [middleware/auth.ts](../apps/api/src/middleware/auth.ts) |
| Middleware: request validation | Done | [validate.ts](../apps/api/src/middleware/validate.ts) with shared zod schemas |
| Middleware: logging | Done | [requestContext.ts](../apps/api/src/middleware/requestContext.ts), [logger.ts](../apps/api/src/lib/logger.ts) (request ids, redaction) |
| Middleware: basic rate limiting | Done | [rateLimit.ts](../apps/api/src/middleware/rateLimit.ts), five tiers (general, auth, refresh, chat, write); `rate-limit.test.ts`. IP keys behind proxies follow `TRUST_PROXY_HOPS`. **Limitation:** in-memory, per instance |
| Proper error handling and HTTP status codes | Done | [errorHandler.ts](../apps/api/src/middleware/errorHandler.ts), [errors.ts](../apps/api/src/lib/errors.ts); `http.test.ts` asserts the envelope |
| *Eval:* API clarity and consistency | Done | One envelope and stable codes; named action for cancel |
| *Eval:* security awareness | Done | httpOnly cookies, refresh rotation with reuse detection, Origin check (CSRF), helmet, constant-time login miss, bcrypt 72-byte rule, pinned JWT algorithm, tenant-scoped queries, open-redirect-safe `next`. Limitations listed in the README |
| *Eval:* separation of concerns, service boundaries | Done | routes / services / repositories / ai ([architecture.md § Service boundaries](architecture.md#service-boundaries)) |
| *Eval:* code organization and maintainability | Done | Module-per-domain; 559 API tests |

## 3. AI integration service

| Requirement | Status | Evidence |
|---|---|---|
| Any AI provider API (Mistral recommended) | Done | [mistral.ts](../apps/api/src/modules/ai/mistral.ts) |
| Understand appointment requests | Done | System prompt with date, hours, catalogue and draft ([prompts.ts](../apps/api/src/modules/ai/prompts.ts)); `intent` in the tool |
| Extract booking details from messages | Done | Forced tool call with schema generated from `bookingSlotsSchema` ([tools.ts](../apps/api/src/modules/ai/tools.ts)) |
| Multi-turn conversation (simple memory) | Done | `chat_sessions.booking_draft` + `mergeSlots` + history cap ([ai-integration.md § Memory](ai-integration.md#multi-turn-memory)) |
| Fallback to structured forms if input is incomplete or ambiguous | Done | `needs_form` after 4 turns in a row with no progress (at most once per conversation); always-available "Prefer a form?"; ambiguous services asked back ([chat/service.ts](../apps/api/src/modules/chat/service.ts)) · [screenshot](screenshots/assistant-fallback-form.png) |
| Log AI interactions (console or DB) | Done (both) | `ai_interaction_logs` table + pino ([logs.ts](../apps/api/src/modules/ai/logs.ts)); per-tenant summary at the owner-only `GET /api/ai/summary` |
| *Eval:* practical AI usage | Done | One call per turn, small model, code-written confirmations |
| *Eval:* error handling and guardrails | Done (partial on one point) | 16 guardrails ([ai-integration.md § Guardrails](ai-integration.md#guardrails)); deterministic fallback. **Partial:** model *times* are not cross-checked by code the way dates are |
| *Eval:* clear boundaries between AI calls and business logic | Done | `AiProvider` seam; the AI module cannot write appointments ([ADR-008](decisions.md#adr-008-the-llm-extracts-code-decides)) |

## 4. Database design

| Requirement | Status | Evidence |
|---|---|---|
| PostgreSQL | Done | 16 (docker-compose and CI) |
| DDL: users (authentication and profile) | Done | [001_init.sql](../db/migrations/001_init.sql) |
| DDL: appointments (scheduling and status) | Done | 001 + 003 + 005 (per-customer no-overlap) |
| DDL: chat_sessions (conversation history and metadata) | Done | `chat_sessions` + `chat_messages` (001, 004) |
| Sample insert statements | Done | [db/seed.sql](../db/seed.sql). Seeded times are computed in each business's timezone; [verify.sql](../db/verify.sql) check 8 asserts every live booking sits inside opening hours |
| Indexing strategy | Done | [002_indexes.sql](../db/migrations/002_indexes.sql) and [006](../db/migrations/006_users_email_idx.sql) (login by email), mapped to queries in [database.md](database.md#indexing-strategy). Two indexes anticipate features not built (token sweep, tenant user list), and this is stated |
| Notes on performance considerations | Done | [database.md § Performance](database.md#performance-notes) |
| Optional: multi-tenancy (business_id) | Done | Composite tenant FKs; [verify.sql](../db/verify.sql) checks 3 and 5 |
| *Eval:* modelling, normalization, constraints | Done | Two EXCLUDE constraints (per service, per customer), CHECKs, enums, composite FKs; `schema.test.ts` |
| *Eval:* scalability awareness, SaaS-ready schema | Done | [database.md § What changes at scale](database.md#what-changes-at-scale) |

## Technical skills and evaluation criteria

| Criterion | Where to look |
|---|---|
| Clarity of thought and documentation | README, [docs/](.), and code comments that explain *why* |
| Code readability and structure | Module layout ([README § Repository layout](../README.md#repository-layout)) |
| Sensible architectural decisions | [decisions.md](decisions.md) |
| Quality of UI implementation and usability | [frontend.md](frontend.md), [screenshots](screenshots), Playwright specs |
| Realistic use of AI in a product workflow | [ai-integration.md](ai-integration.md) |
| Ability to explain and defend tradeoffs | ADRs, each with "Alternatives" and "Cost" |
| Testing (not asked; included) | 559 API + 425 web + 50 e2e tests; [CI workflow](../.github/workflows/ci.yml) (e2e not in CI) |
