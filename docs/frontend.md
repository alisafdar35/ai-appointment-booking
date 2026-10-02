# Frontend

Next.js 15 App Router, React 19, TypeScript. The server-state cache is TanStack Query; forms use react-hook-form with zod; styling is Tailwind 3.4; realtime uses socket.io-client. There is no global client store: each kind of state has one owner (below).

## Structure

```
apps/web/src
  app/                         routes only; thin
    page.tsx                   landing (marketing)
    login/, signup/            wrapped in GuestGuard
    (app)/layout.tsx           AuthGuard + AppShell for signed-in routes
    (app)/assistant/           chat workspace
    (app)/appointments/        dashboard
    error.tsx, not-found.tsx, (app)/loading.tsx
  features/                    product areas, each owning its components, hooks and pure lib
    chat/        components/ (ChatWorkspace, ConversationPanel, MessageList, TurnCard, ConfirmationCard,
                 BookedCard, FallbackFormCard, SideRail, SessionList, Composer, ...)
                 hooks/useChat.ts   lib/reducer.ts, turn-meta.ts, cache.ts, failure.ts, ics.ts, ...
    appointments/  AppointmentsDashboard, AppointmentList/Card, BookingDialog, CancelDialog, SummaryTiles,
                   hooks/useAppointmentViews, useChangeHighlights
    booking/     SlotPicker, DateField (shared by the dialog and the in-chat form)
    auth/        LoginForm, SignupForm, signup-schema, error-map, redirect
    marketing/   landing sections
  components/ui/               design-system primitives (Button, Dialog, Tabs, FormField, Alert, ...)
  components/layout/           AppShell, AuthGuard, GuestGuard, UserMenu, RealtimeStatusPill
  lib/api/                     typed fetch client, errors, per-resource endpoint functions
  lib/queries/                 query keys, hooks, cache helpers, retry policy
  lib/socket.ts, datetime.ts, routes.ts
  providers/                   Query → Auth → Realtime → Toast
```

**Rule of thumb:** `components/ui` knows nothing about the domain; `features/*` know nothing about each other except through `lib/queries` and the shared DTOs; pure logic (`lib/*.ts` in a feature) is separated from components so it can be unit-tested without rendering.

## State management

| State | Owner | Why |
|---|---|---|
| Server data (sessions, transcripts, appointments, services, availability) | **TanStack Query**, keys in [`lib/queries/keys.ts`](../apps/web/src/lib/queries/keys.ts) | Caching, dedupe, background refetch, hierarchical invalidation (`appointments.all` vs `appointments.lists()`) |
| Auth session | `AuthProvider` (context: `loading | authenticated | unauthenticated`) | One subscription to "session ended" from the API client |
| Unconfirmed chat state (optimistic, failed, retried messages; per-turn payload) | Pure **reducer** in [`features/chat/lib/reducer.ts`](../apps/web/src/features/chat/lib/reducer.ts), driven by `useChat` | Optimistic reconciliation is the trickiest part of the UI, so it is pure and has no clock, ids or network |
| Booking draft | **Server** (mirrored from each `AssistantTurnDto`, never edited locally) | The draft is the conversation's memory; the client cannot disagree with it |
| Form state | react-hook-form | Local, validated with shared schemas |
| Socket connection | `RealtimeProvider` (`connecting | connected | degraded`) | One connection per signed-in user |

**Chat reconciliation details** ([`useChat.ts`](../apps/web/src/features/chat/hooks/useChat.ts)):
- A sent message appears immediately with a local key. The server returns `userMessage.id`, and the bubble is matched **by id**, keeping its React key, so two identical "yes" messages never cross-match.
- The reducer is keyed by session, so a reply arriving after you switch conversations lands in the right one.
- On reload, every assistant message is rebuilt from what was stored with it (`turnMetaFor` in `turn-meta.ts`): its `action`, `suggestions` and `draft` snapshot restore each confirmation card (earlier ones disabled, only the latest live), the suggestion chips and the form offer; a `booked` message's `appointmentId` picks its row from the transcript's `appointments`, so the receipt does not depend on the rail's capped upcoming list. Without the row (cancelled since) the receipt falls back to the message's draft and claims no status. Older rows without a `draft` get a card only when they are the latest message (from the session's draft); rows without an `action` fall back to inference from the draft.
- A server-confirmed appointment update (cancellation from the dashboard, a socket event) is folded into the cached transcript of the conversation that booked it. Once that transcript is refetched, a cancelled booking is no longer among its `appointments` (the API lists only bookings still going ahead), so the receipt falls back to "Booked in this conversation" with no status and points to the dashboard: it never shows a stale "Confirmed". Rescheduling is not implemented; cancel and book again.
- `assistant:turn` from another tab is merged into the transcript cache. `assistant:typing` shows dots in the open conversation, with a 15 s timeout if the turn never arrives.
- On first load the latest *unfinished* conversation is resumed; otherwise a new one starts. This decision is made once, so a refetch never moves the user.

## API client and token refresh

[`lib/api/client.ts`](../apps/web/src/lib/api/client.ts):

- **Same-origin only.** All requests go to `/api/*`, which Next.js rewrites to `API_ORIGIN`, so cookies are first-party.
- Every failure becomes an `ApiError { status, code, message, details, requestId, retryAfterSeconds }`. Non-JSON bodies (a proxy's HTML 502), timeouts (30 s) and network drops are mapped to friendly messages with code `NETWORK`, `INTERNAL`, or the status default. 413 always reads the same, whoever sent it.
- **Silent refresh.** On `401 UNAUTHENTICATED` the client refreshes once and replays the request. Refresh is **single-flight per tab** (a shared promise, which also covers React StrictMode double mounts) and **serialized across tabs** with `navigator.locks`. `SESSION_SUPERSEDED` is retried up to 4 times with jittered exponential backoff. Only a definitive 401 clears the session and redirects to `/login?next=…`.
- **Restoring the session on load survives a sleeping API host.** Only a definitive 401 from `/auth/refresh` (not `SESSION_SUPERSEDED`) signs the user out. A timeout, network failure or 5xx is retried (3 attempts, backoff, ~90 s budget, first attempt with a 60 s timeout), the loading screen says "Waking up the server…" after 5 s, and after the budget it offers **Try again** instead of the sign-in form. Refreshes get a 75 s timeout by default, because abandoning one the server still completes leaves the browser holding a rotated-out cookie that the next refresh presents as a replay. Data requests never end the session on timeouts or 5xx either: only a definitive 401 after a refresh does.
- **When the session ends** (a definitive 401 mid-use, or a refused refresh on load for a browser that had signed in), the user is sent to `/login?next=…&expired=1`, which says the session has ended. Signing out on purpose goes to plain `/login`. An open booking dialog saves its values when the session ends (`lib/interrupted-drafts.ts`: sessionStorage, owned by the user id, 30-minute life, cleared on sign-out); after signing in again the dashboard reopens the dialog with them and says so.
- **Idempotent booking.** The booking dialog sends `Idempotency-Key` (from `@appt/shared`) on `POST /api/appointments`: one UUID per booking attempt, reused when the same values are submitted again (Retry after a dropped response) and replayed by the API instead of booking twice; changed values make a new key. `RequestOptions.headers` carries it, including on the replay after a token refresh.
- **Access token in memory only** (`token-store.ts`), for the Socket.IO handshake. A one-bit `localStorage` hint (`session-hint.ts`) skips the refresh call for visitors who never signed in. It carries no credential.
- **Query retries** happen only for `NETWORK` and 5xx, at most 2, with backoff. Mutations never auto-retry: a booking is the user's intent, not a read.

## Async and error UX patterns

- **Loading:** skeletons shaped like the content (app shell, summary tiles, lists), not spinners over blank pages. The Send button visibly holds until the conversation is ready.
- **Chat failures stay in the transcript** next to the message, with a cause-specific action: rate limited shows a countdown from `Retry-After`; network offers **Retry**; `SESSION_CLOSED` marks the conversation completed, switches the composer to "Start a new conversation", and offers **Send in a new conversation**, which carries the text over.
- **No duplicate actions:** the dialog's Book button goes busy the moment it is pressed (react-hook-form's `isSubmitting`, before validation finishes) and a ref blocks a second submit, so a double click sends one request; a chat confirmation card stops being actionable as soon as the user's "Yes, book it" is on screen. Both are proven by request-counting e2e tests with a slowed API.
- **Offline:** TanStack Query pauses a chat send while the browser reports it is offline; the message stays in the transcript, a notice explains the wait, and it goes out on reconnect. A request that drops mid-flight fails with a **Retry**.
- **Fallback form vs. a reply that changes the draft:** fields the user has touched (including a picked time) are dirty and are never replaced; untouched fields follow the server.
- **Booking conflicts:** a 409 in the dialog keeps the form, says the slot was taken, and refreshes the slot picker. In chat, the assistant offers suggestion chips (one tap resends as a message).
- **Cancelling something already cancelled or completed** (`APPOINTMENT_NOT_CANCELLABLE`) closes the dialog with "Already taken care of" and refetches.
- **Field errors from the server** (`details`) are mapped onto form fields (`lib/form-errors.ts`), so client and server messages appear in the same place.
- **Failed list loads** show an "Unavailable" state on tiles and a retryable error in lists, rather than shimmering forever.
- **Toasts** only confirm actions that happened elsewhere on screen, such as "Appointment cancelled".
- **Route-level** `error.tsx` and `not-found.tsx` handle the rest.

## Realtime as an enhancement

`RealtimeProvider` opens one socket after authentication and closes it on sign-out. Appointment events are upserted into **every matching cached list** using the API's own filter schema (`appointment-cache.ts`), so a booking made in another tab appears in "Upcoming" in the right order, and a cancellation moves to "Cancelled", without a refetch. On reconnect, appointments and sessions are invalidated, because missed events are gone. When the socket is degraded, `refetchOnWindowFocus` plus a 30 s `staleTime` keep data current. Nothing waits on the socket.

## Forms share the API's schemas

| Form | Schema |
|---|---|
| Sign up | `signupSchema.pick(...)` plus a form-only `mode` (create vs join) that decides which business field is required ([`signup-schema.ts`](../apps/web/src/features/auth/signup-schema.ts)). The password checklist shows the same rules as `passwordSchema`; the 72-byte rule is listed only once exceeded |
| Sign in | `loginSchema` |
| Booking dialog | `createAppointmentSchema.extend(...)` with a "today or later" rule in the business timezone |
| In-chat fallback form | `bookingSlotsSchema` fields, pre-filled from the draft |
| Cancel | `cancelAppointmentSchema` (reason ≤ 500, with a character count) |

Because rules come from `@appt/shared`, the form cannot accept what the API rejects, or the reverse.

## Accessibility

- The transcript is `role="log"` with `aria-live="polite"`. The typing indicator and engine notice are status regions.
- `Dialog` is hand-rolled for explicit behaviour: it moves focus in on open, returns focus on close, traps Tab, closes on Escape and backdrop click, is labelled and described, and locks background scroll. Destructive confirmations autofocus the safe option.
- `Tabs` follow the WAI-ARIA tabs pattern with arrow-key navigation, and focus moves to the active panel.
- After choosing or starting a conversation, focus moves to the composer. Enter sends, Shift+Enter adds a newline.
- Every action is reachable by keyboard: an e2e spec books, triggers validation errors and closes dialogs with the keyboard alone (Chromium; Firefox on macOS only tabs between text fields by default). Visible focus rings are inset where a scroller would clip them.
- `prefers-reduced-motion` disables animations. Colour is never the only signal: status badges carry text.
- The realtime pill keeps its full label for screen readers on narrow screens.

## Responsive behaviour

The layout was checked at 1440×900, 1024×768 and 390×844, in light and dark mode.

- **Assistant:** three columns on desktop (conversations, transcript, draft rail). On phones the conversation list and draft rail collapse, and a sticky summary bar shows the draft ("Booked · …" after booking).
- **Appointments:** the summary tiles go to two rows and the tabs go full-width on phones. Cards wrap without dangling separators.
- **200% zoom:** an e2e spec runs the dashboard, the booking dialog and the assistant at 640×360 CSS px (a 1280×720 window at 200%) and checks nothing overflows horizontally.
- **Times** always show in the business timezone, with the zone abbreviation on confirmation (e.g. "2:00 PM EDT"). An e2e spec books from a browser in Asia/Karachi and reads it from one in America/Los_Angeles: identical labels, matching the saved instant. A day the business does not open (`AvailabilityDto.closed`) is shown as "Closed on this day".

## Security headers

Set in [`next.config.mjs`](../apps/web/next.config.mjs): `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy, a permissions policy, and in production HSTS plus a CSP that limits `connect-src` to self and the Socket.IO origin, `frame-ancestors 'none'` and `form-action 'self'`. `script-src` allows `'unsafe-inline'`, because Next.js inline bootstrap scripts would otherwise need per-request nonces and fully dynamic rendering.

## Tests

- **Vitest + Testing Library** (461 tests): reducer, turn-meta rebuild, cache upserts, failure mapping, ICS generation, retry policy, API client refresh and superseded handling, `useChat` (optimistic flow, socket echo, typing, `SESSION_CLOSED`), ConversationPanel, dialogs, forms and tabs.
- **Playwright** ([`e2e/`](../apps/web/e2e)): conversational booking with a mid-flow correction, taken slot leading to a suggestion and a booking, form fallback, appointments dialog and cancel, realtime across two tabs, resilience (injected 500, network failure, 429 with Retry-After), signup create/join, and route guard redirect; plus `session.spec.ts` (sign-out leaves no cookie, socket or readable page; invalid and expired sessions; the booking kept across re-login), `reliability.spec.ts` (double clicks with a slow API, a lost response retried with the same idempotency key, reload right after booking, offline and dropped sends, socket down, assistant down, two tabs, a reply landing after a conversation switch), `safety.spec.ts` (markup in names, messages and notes stays text; length limits; no internals in error messages), `display.spec.ts` (browser timezones, only your own bookings, cancellation consistency) and `accessibility.spec.ts` (keyboard only, 200% zoom). Each runs on desktop and Pixel 7 projects; `E2E_ALL_BROWSERS=1` adds Firefox and WebKit. `npm run e2e` ([scripts/e2e.mjs](../scripts/e2e.mjs)) runs them against a stack of their own: a freshly recreated and seeded `appt_e2e` database, the API on :4100 without a Mistral key, and the production web build on :3100. Each worker books only on its own days (`laneDays` in [e2e/support/api.ts](../apps/web/e2e/support/api.ts)), so parallel tests never compete for a slot, and CI runs the same command.
