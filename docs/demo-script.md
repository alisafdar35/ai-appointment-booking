# Demo video script (4–5 minutes)

**Goal:** show every requirement in the brief once, in a story, with the engineering visible but not lectured.

**Setup before recording**
- Deployed stack warmed up (open `<API_URL>/health` a minute before, since the free Render instance sleeps).
- Browser at 1440×900, 100% zoom, a clean profile. Two windows ready: the app, and a second tab on `/appointments`.
- A terminal with `curl` and `psql` against the database, font size 16+.
- Decide the AI mode. With `MISTRAL_API_KEY` set, replies carry the Mistral badge. Show the fallback in segment 6 by restarting locally with the key unset, or use a pre-recorded clip.
- Pick a weekday at least two days out whose 3 PM slot is free for Teeth Whitening.

| # | Time | Shot | Say (roughly) | Brief items covered |
|---|---|---|---|---|
| 1 | 0:00–0:20 | Landing page, then a scroll | "Slotly is a multi-tenant booking SaaS. A customer chats, the AI extracts the details, and code decides what gets booked." | Overview |
| 2 | 0:20–0:45 | **Sign up** as a new user, joining with code `bluewave`. Show the password checklist reacting. Then sign out and sign in as `customer@bluewave.test` via "Use demo account" | "JWT auth: a 15-minute access token and a rotating refresh token, both httpOnly cookies, proxied same-origin. Form rules come from the same zod schema the API validates with." | Signup/login, JWT, validation, shared schemas |
| 3 | 0:45–1:40 | `/assistant`. Type: *"Hi, I'd like teeth whitening next Wednesday"* → assistant asks for a time. Then *"around 3 in the afternoon"* → **confirmation card**; point at the draft rail filling in. Then *"actually make it 4pm"* → re-confirms at 4 PM. Click **Confirm booking** → Booked card, then click the `.ics` download | "Multi-turn memory lives in the database as a draft, so the correction kept the service and day. Nothing books until you confirm a summary you've actually seen, and the confirmation text is written by code, not the model." | Chatbot UI, understanding requests, extraction, multi-turn, conversational booking |
| 4 | 1:40–2:05 | Switch to the second tab on `/appointments`: the booking is already there, highlighted. Point at the **Live** pill | "Each turn is a REST call; Socket.IO pushes to your other tabs. If the socket is blocked, the app keeps working and the pill says so." | Real-time chat experience |
| 5 | 2:05–2:40 | New conversation: ask for the **same** day and 4 PM → "That slot is already booked. I could do …" with **suggestion chips**. Tap one → confirm → booked | "Availability and double-booking are enforced by the booking service and a Postgres EXCLUDE constraint. The model can't book, and two concurrent requests can't both win." | Business rules, guardrails, DB constraints |
| 6 | 2:40–3:15 | New conversation, on a stack without a Mistral key (guided badge visible; a live model may read vague messages as progress, e.g. guess a service, and then no form is offered). Type four vague messages ("hmm", "not sure", "whenever", "maybe later") → **"fill in the booking form instead"** card, pre-filled. Submit it → booked | "If the model times out, rate-limits, or returns bad output, the same request falls back to a deterministic engine. When the conversation isn't converging, it offers a structured form. Both go through the same booking service." | Fallback to structured forms, error handling |
| 7 | 3:15–3:45 | `/appointments`: tabs Upcoming / Past / Cancelled, then the **New appointment** booking dialog with the live slot picker, then **Cancel** with a reason. Briefly resize to a phone width | "The form surface: server-side status filters, a 409 kept in the dialog, keyboard-accessible dialogs, responsive down to phones." | Booking UI, layout, interactions, async/error states |
| 8 | 3:45–4:05 | Sign in as `staff@bluewave.test` → customer names across the tenant. Mention `owner@northside.test` sees none of it | "Tenant scope comes from the token, and composite foreign keys make cross-tenant rows impossible in the database itself." | Multi-tenancy, roles |
| 9 | 4:05–4:35 | Signed in as `owner@bluewave.test`, open `<WEB_URL>/api/ai/summary` (per-tenant AI summary: calls, error rate, p50/p95 per provider), then `psql`: `SELECT provider, outcome, latency_ms, guardrails FROM ai_interaction_logs ORDER BY id DESC LIMIT 5;`. Then `\d appointments` showing `appointments_no_overlap` and `appointments_customer_no_overlap` | "Every AI call is logged with latency, tokens, outcome and any guardrail correction. Here the model resolved 'next Wednesday' to a Thursday and code corrected it." | AI logging, DB schema, indexes |
| 10 | 4:35–4:55 | README on GitHub: the architecture diagram, then the limitations section | "The docs cover architecture, every endpoint, the schema and index strategy, the AI guardrails, and what I'd do next, including the honest limitations." | Documentation, tradeoffs |

**Closing line:** "The AI makes booking pleasant; the code makes it correct. Thanks for watching."

### Recording tips
- Hide bookmarks and extensions, and use the default light theme. Show dark mode for one second in segment 7 if there is time.
- If a live Mistral reply is slow, keep talking. The typing dots are part of the demo.
- Keep the cursor still while speaking. Zoom in on the confirmation card and the log query output in editing.
