# API reference

Base URL is the API origin (`http://localhost:4000` locally). Through the web app, the same paths are served same-origin under `/api/*` by the Next.js rewrite.

- **Format:** JSON in and out. Bodies are capped at 100 kb.
- **Auth:** the `appt_access` httpOnly cookie (browser) **or** `Authorization: Bearer <accessToken>` (any client). Refresh uses the `appt_refresh` cookie, scoped to `/api/auth`.
- **Schemas** are the zod objects in [`packages/shared/src`](../packages/shared/src). The validator replaces `req.body`/`req.query`/`req.params` with the parsed result, so trimming, lower-casing and defaults below are applied by the server.
- **CSRF:** POST/PUT/PATCH/DELETE carrying an `Origin` header that is not in `CORS_ORIGINS` returns `403 FORBIDDEN`.
- **Request ids:** every response has `X-Request-Id`. Send your own (8–128 chars of `[A-Za-z0-9._-]`) to correlate.

## Rate-limit tiers

[`middleware/rateLimit.ts`](../apps/api/src/middleware/rateLimit.ts). Responses carry draft-7 `RateLimit` / `RateLimit-Policy` headers. A 429 also carries `Retry-After`.

| Tier | Limit | Key | Applies to |
|---|---|---|---|
| general | 300 / 1 min | IP | every `/api/*` request |
| auth | 10 **failed** / 15 min | IP | `POST /auth/signup`, `POST /auth/login` |
| refresh | 60 / 5 min (all requests) | IP | `POST /auth/refresh` |
| chat | 20 / 1 min | user | `POST /chat/messages` |
| write | 40 / 1 min | user | `POST /appointments`, `POST /appointments/:id/cancel`, `POST /chat/sessions`, `POST /chat/draft` |

The store is in-memory, per process. `RATE_LIMIT_DISABLED=true` turns all limiters off.

## Errors

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Some fields need attention",
    "details": { "password": ["Must contain a number"] },
    "requestId": "6f1c..."
  }
}
```

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Schema failure (`details` keyed by field path), malformed JSON, impossible date, a start time off the 30-minute grid (`details.time`) |
| `UNAUTHENTICATED` | 401 | No, invalid or expired access token; dead refresh token |
| `SESSION_SUPERSEDED` | 401 | The refresh token was rotated by another tab less than 15 s ago. Retry; do not sign out |
| `INVALID_CREDENTIALS` | 401 | Wrong email or password. Deliberately the same for both |
| `FORBIDDEN` | 403 | Foreign `Origin` on a write; a role that may not call the endpoint (`GET /api/ai/summary` is owner-only) |
| `NOT_FOUND` | 404 | Unknown route or resource, or one belonging to another user or tenant |
| `EMAIL_TAKEN` | 409 | Email already registered in that business |
| `SLOT_UNAVAILABLE` | 409 | Overlaps a live appointment for the same service (pre-check or EXCLUDE constraint) |
| `CUSTOMER_BUSY` | 409 | The caller already holds another live appointment overlapping that time (pre-check or `appointments_customer_no_overlap`) |
| `APPOINTMENT_NOT_CANCELLABLE` | 409 | Already cancelled or completed |
| `SESSION_CLOSED` | 409 | The conversation already booked; start a new one |
| `CONFLICT` | 409 | Any other unique-constraint violation (well-formed input that collides with an existing value) |
| `PAYLOAD_TOO_LARGE` | 413 | Body over 100 kb |
| `OUTSIDE_BUSINESS_HOURS` | 422 | The whole appointment must fit inside opening hours |
| `APPOINTMENT_IN_PAST` | 422 | Start time already passed (business clock) |
| `RATE_LIMITED` | 429 | See tiers above |
| `INTERNAL` | 500 | Unexpected. Outside production the body adds `debug` with the message |

There is no AI error code on purpose: AI failures fall back to the deterministic engine instead of erroring.

---

## Health

### `GET /health` (also `GET /api/health`)

No auth, no rate limit. Returns 200, or 503 (`status: "degraded"`) when the database is unreachable.

```json
{ "status": "ok", "db": "up", "aiProvider": "mistral", "uptimeSeconds": 22 }
```

`aiProvider` is `"mistral"` when a key is configured, otherwise `"fallback-only"`. AI usage is tenant data, so it is not on this unauthenticated probe (see `GET /api/ai/summary`).

### `GET /api/ai/summary` · requires auth, owner only

The caller's business's AI usage over the last 24 hours, from `ai_interaction_logs`. 403 for customers and staff.

```json
{
  "summary": {
    "windowHours": 24,
    "totalCalls": 536,
    "byOutcome": { "ok": 535, "timeout": 1 },
    "byProvider": {
      "fallback": { "calls": 525, "errorRate": 0,     "p50LatencyMs": 1,    "p95LatencyMs": 3 },
      "mistral":  { "calls": 11,  "errorRate": 0.091, "p50LatencyMs": 1367, "p95LatencyMs": 8000 }
    }
  }
}
```

Percentiles are per provider, because a pooled figure would let the near-instant fallback engine hide the model's latency.

---

## Auth

### `POST /api/auth/signup` · auth tier

Creates a business and makes you its **owner** (if `businessSlug` is omitted), or joins an existing business as a **customer**.

| Field | Rule |
|---|---|
| `email` | trimmed, lower-cased, valid email, ≤254 |
| `password` | ≥10 chars, lower + upper + digit, ≤72 UTF-8 bytes |
| `fullName` | 1–160 |
| `phone` | optional; `^\+?[0-9 ()-]{6,24}$`; blank = absent |
| `businessSlug` | optional; `^[a-z0-9][a-z0-9-]{1,62}$`; blank = absent |
| `businessName` | optional, ≤160; used when creating (defaults to "<first name>'s Workspace") |

**201** `{ user: UserDto, accessToken, expiresInSeconds }` and both auth cookies.
Errors: 400 (including `details.businessSlug` for an unknown code), 409 `EMAIL_TAKEN`, 429.

```bash
curl -i -c jar.txt -X POST http://localhost:4000/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"ana@example.com","password":"Sunshine2026","fullName":"Ana Lima","businessSlug":"bluewave"}'
```

### `POST /api/auth/login` · auth tier

`{ email, password, businessSlug? }`. The password is only checked for presence (1–200 chars), so a tightened policy never locks existing users out. `businessSlug` picks the account when an email exists in several tenants. Without it, the oldest account is used.

**200** `{ user, accessToken, expiresInSeconds }` and cookies. Errors: 400, 401 `INVALID_CREDENTIALS`, 429.

```bash
TOKEN=$(curl -s -c jar.txt -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"customer@bluewave.test","password":"Password123!"}' | jq -r .accessToken)
```

### `POST /api/auth/refresh` · refresh tier

Authenticated by the `appt_refresh` cookie alone. It rotates the token: the old one is single-use.
**200** `{ user, accessToken, expiresInSeconds }` and new cookies.
Errors: 401 `UNAUTHENTICATED` (cookies cleared; also returned after a replayed token, in which case all the user's sessions are revoked), 401 `SESSION_SUPERSEDED` (cookies left in place).

```bash
curl -s -b jar.txt -c jar.txt -X POST http://localhost:4000/api/auth/refresh
```

### `POST /api/auth/logout`

Revokes the presented refresh token (`?everywhere=true` revokes every one of the user's tokens) and clears cookies. It is idempotent. **204**.

### `GET /api/auth/me` · requires auth

**200** `{ user: UserDto }`. 401 without a session, 404 if the account no longer exists.

```bash
curl -s http://localhost:4000/api/auth/me -H "Authorization: Bearer $TOKEN"
```

`UserDto`: `{ id, email, fullName, phone, role: "owner"|"staff"|"customer", businessId, businessName, businessSlug, businessTimezone, createdAt }`.

---

## Services and availability (requires auth)

### `GET /api/services`

**200** `{ services: ServiceDto[] }`. Active services of the caller's tenant, sorted by name.
`ServiceDto`: `{ id, name, description, durationMinutes, priceCents }`.

### `GET /api/services/:serviceId/availability?date=YYYY-MM-DD`

A 30-minute grid of start times inside opening hours, for one day in the business timezone. A slot is `available: false` if it is in the past, overlaps a live appointment for that service, or overlaps one of the caller's own live appointments (on any service). The form's slot picker and the chat's suggestions use the same query.

**200** `{ availability: { date, serviceId, durationMinutes, slots: [{ time: "09:00", available: true }, ...] } }`.
Errors: 400 (bad uuid, or an impossible date such as `2026-02-31`), 404 service not in the tenant.

```bash
curl -s "http://localhost:4000/api/services/cccccccc-0000-0000-0000-000000000001/availability?date=2026-10-07" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Appointments (requires auth)

Customers see and cancel only their own appointments. Staff and owners see and cancel the whole tenant's.

### `GET /api/appointments`

| Query | Rule |
|---|---|
| `status` | optional; one status or a comma list: `pending,confirmed` |
| `window` | `upcoming` (starts ≥ now, **soonest first**) · `past` (newest first) · `all` (default, newest first) |
| `limit` | 1–100, default 50 |

**200** `{ appointments: AppointmentDto[] }`.

```bash
curl -s "http://localhost:4000/api/appointments?window=upcoming&status=pending,confirmed&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

`AppointmentDto`: `{ id, status, source: "chat"|"form"|"admin", startsAt, endsAt (UTC ISO), notes, cancellationReason, chatSessionId, createdAt, service: ServiceDto, customer: { id, fullName, email } }`.

### `POST /api/appointments` · write tier

| Field | Rule |
|---|---|
| `serviceId` | uuid of an active service in your tenant |
| `date` | `YYYY-MM-DD`, a real calendar date (business timezone) |
| `time` | `HH:MM` 24-hour (business timezone) |
| `notes` | optional, trimmed, ≤2000 |
| `chatSessionId` | optional; must be your own conversation (else 404) |
| `source` | `form` (default) · `chat`. `admin` exists in the database enum for display only and is rejected (400) from clients |

**201** `{ appointment }`, created `confirmed`, with `ends_at` derived from the service duration. Emits `appointment:created`.
Errors: 400 (including an off-grid time), 404 (service/conversation), 409 `SLOT_UNAVAILABLE` / `CUSTOMER_BUSY`, 422 `OUTSIDE_BUSINESS_HOURS` / `APPOINTMENT_IN_PAST`, 429.

```bash
curl -s -X POST http://localhost:4000/api/appointments -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"serviceId":"cccccccc-0000-0000-0000-000000000001","date":"2026-10-07","time":"10:30","notes":"First visit"}'
```

### `GET /api/appointments/:id`

**200** `{ appointment }`. 404 if not visible to the caller.

### `POST /api/appointments/:id/cancel` · write tier

`{ reason?: string (≤500) }`. This is a named state transition, not a PATCH of `status`. **200** `{ appointment }`. Emits `appointment:updated` to the customer and to the business's staff and owners.
Errors: 404, 409 `APPOINTMENT_NOT_CANCELLABLE`.

```bash
curl -s -X POST http://localhost:4000/api/appointments/<id>/cancel -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"reason":"Travelling"}'
```

---

## Chat (requires auth)

Conversations are private to their user. Any session id that is not yours returns 404.

### `GET /api/chat/sessions`

**200** `{ sessions: ChatSessionDto[] }`. The 30 most recent conversations by last activity.
`ChatSessionDto`: `{ id, title, status: "active"|"completed"|"abandoned", bookingDraft: { serviceName, date, time, notes }, messageCount, lastMessageAt, createdAt }`.

### `POST /api/chat/sessions` · write tier

Starts an empty conversation titled "New conversation"; the first message sent into it retitles it. **201** `{ session }`.

### `GET /api/chat/sessions/:id`

**200** `{ session, messages: ChatMessageDto[], appointments: AppointmentDto[] }`. The newest 200 messages, oldest first.
`ChatMessageDto`: `{ id, role, content, engine: "mistral"|"fallback"|"system"|null, action, suggestions?, draft?, appointmentId?, createdAt }`. `action`, `suggestions`, `draft` (the booking draft as it stood after that turn) and, on a `booked` turn, `appointmentId` are stored with each assistant turn, so a reload rebuilds every confirmation card, receipt and suggested-time chip from its own message. Messages stored before `draft`/`appointmentId` were recorded omit them.
`appointments` are the conversation's bookings that are not cancelled (joined by `appointments.chat_session_id`, scoped to the caller's tenant and to the conversation's owner), oldest first, so a receipt shows the row as it is now however far off or long past it is.

### `POST /api/chat/messages` · chat tier

| Field | Rule |
|---|---|
| `content` | trimmed, 1–2000 chars |
| `sessionId` | optional uuid. Omit it to create a session titled from the message |

**201** `AssistantTurnDto`:

```json
{
  "sessionId": "…",
  "userMessage": { "id": "…", "role": "user", "content": "whitening next wednesday around 3", "engine": null, "action": null, "createdAt": "…" },
  "message": { "id": "…", "role": "assistant", "content": "Just to confirm: Teeth Whitening on Wednesday, October 7, 2026 at 3:00 PM. Shall I book it?", "engine": "fallback", "action": "confirm", "createdAt": "…" },
  "action": "confirm",
  "bookingDraft": { "serviceName": "Teeth Whitening", "date": "2026-10-07", "time": "15:00", "notes": null },
  "missing": [],
  "engine": "fallback"
}
```

`action` is one of `collect_info` · `confirm` · `booked` (with `appointment`) · `needs_form`. `suggestions: [{ date, time, label }]` is present when the requested slot was refused. (`error` exists in the shared type but the server never sends it.)
Errors: 400, 404 (session), 409 `SESSION_CLOSED` (the message is **not** stored), 429. Provider failures are never errors.
Side effects: `assistant:typing` (true, then false), `assistant:turn`, and `appointment:created` when it books.

```bash
curl -s -X POST http://localhost:4000/api/chat/messages -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content":"Teeth whitening next Wednesday around 3"}'
```

### `POST /api/chat/draft` · write tier

This completes the booking from the structured fallback form inside a conversation.
`{ sessionId: uuid, slots: { serviceName?, date?, time?, notes? } }`. The slots are merged over the stored draft.

**201** `AssistantTurnDto` with `engine: "system"`. It stores a user message ("Book X on D at T.") and the outcome. On success the session is completed and titled "Service — Mon, Oct 5".
Errors: 400 with `details` for every missing or unknown field at once, 404, 409 `SESSION_CLOSED`. A refused slot is **not** an HTTP error: it returns `action: "collect_info"` with `suggestions`.

---

## Socket.IO

Connect to the API origin, path `/socket.io`, with `auth: { token: <accessToken> }` (or an `Authorization: Bearer` header). An invalid or missing token gets a `connect_error` with message `UNAUTHENTICATED`. Each socket joins `user:<id>`; staff and owner sockets also join `business:<id>`, so their dashboards hear about customers' bookings. Appointment events go to both rooms and reach each socket once. There are no client-to-server events.

The server disconnects a socket when the access token that opened it expires (the client reconnects with a fresh one), and closes all of a user's sockets on logout everywhere and on refresh-token replay.

```js
import { io } from 'socket.io-client';
const socket = io('http://localhost:4000', { auth: { token } });
socket.on('assistant:turn', (turn) => console.log(turn.action));
```

| Event | Payload |
|---|---|
| `assistant:typing` | `{ sessionId, typing: boolean }` |
| `assistant:turn` | `AssistantTurnDto` |
| `appointment:created` | `{ appointment: AppointmentDto }` |
| `appointment:updated` | `{ appointment: AppointmentDto }` |
