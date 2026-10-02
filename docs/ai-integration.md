# AI integration

**The model reads, code decides.** The LLM turns a customer's sentence into structured booking slots and a short reply. It does not book anything, choose the UI, or enforce any business rule. When the model is unavailable or wrong, a deterministic engine and a set of code-level guardrails keep the product working.

All code is in [`apps/api/src/modules/ai`](../apps/api/src/modules/ai). The conversation state machine that uses it is in [`modules/chat/service.ts`](../apps/api/src/modules/chat/service.ts).

## Provider abstraction

```ts
// provider.ts
interface AiProvider {
  readonly engine: 'mistral' | 'fallback' | 'system';
  readonly available: boolean;
  respond(input: ProviderInput): Promise<ProviderOutput>;  // { reply, slots, intent, engine, model?, usage?, latencyMs }
}
```

| File | Role |
|---|---|
| [`index.ts`](../apps/api/src/modules/ai/index.ts) | Orchestrator `generateAssistantTurn`: try Mistral, apply guardrails, fall back on any failure, log every call |
| [`mistral.ts`](../apps/api/src/modules/ai/mistral.ts) | `fetch` against `/v1/chat/completions`. No SDK, so timeout, retry and `Retry-After` handling are explicit |
| [`fallback.ts`](../apps/api/src/modules/ai/fallback.ts) | Deterministic provider: chrono-node dates and times, catalogue matching, confirmation patterns, templated replies |
| [`guardrails.ts`](../apps/api/src/modules/ai/guardrails.ts) | Post-checks a well-formed model answer against what code can verify |
| [`tools.ts`](../apps/api/src/modules/ai/tools.ts) | Tool definition generated from the shared zod schema, plus a lenient-but-strict parser |
| [`prompts.ts`](../apps/api/src/modules/ai/prompts.ts) | System prompt built per request |
| [`copy.ts`](../apps/api/src/modules/ai/copy.ts) | The confirmation question, worded once by code |
| [`logs.ts`](../apps/api/src/modules/ai/logs.ts) | `ai_interaction_logs` writer and the per-tenant summary behind `GET /api/ai/summary` |

`ProviderError.outcome` classifies failures as `timeout | rate_limited | auth_error | invalid_output | provider_error`.

## Prompt construction

`buildSystemPrompt` is rebuilt on every turn because the useful parts are dynamic:

- **Today's date and local time in the business timezone.** Without them, "next Tuesday" gets guessed from the training cutoff.
- **Timezone and opening hours**, so the model does not propose 8 pm.
- **The live service catalogue** with durations and prices.
- **"Details gathered so far"**, rendered from the stored draft, with the instruction never to re-ask for them.
- Rules: resolve relative dates, use 24-hour times, only offer listed services, **never claim a booking was made**, keep to 1–2 sentences with no markdown, and always call the function.

It stays short on purpose. The prompt is not the security boundary; the booking service is.

## One forced tool call, schema generated from the shared contract

```ts
// tools.ts
assistantToolSchema = bookingSlotsSchema.partial().extend({ reply, intent })   // bookingSlotsSchema comes from @appt/shared
zodToJsonSchema(assistantToolSchema)  // → parameters of `respond_to_booking_request`
```

- `tool_choice: 'any'` forces a tool call every turn, so every answer is structured. Slots **and** the reply come back in one round trip.
- The JSON Schema is **generated** from the same `bookingSlotsSchema` the form and API validate against, so the model contract cannot drift from the booking contract.
- `serviceName` gets an `enum` of the tenant's live services to steer the model. Parsing is lenient on the name (the service layer resolves "whitening" → "Teeth Whitening") and strict on everything else: `date` must be a real `YYYY-MM-DD`, `time` must be `HH:MM`.
- `intent`: `collecting | confirming | cancelling | other`. It is one *input* to the consent decision, never the decision itself.
- `temperature: 0.2`, `max_tokens: 600`.

## Multi-turn memory

Memory is **server-side state, not transcript recall**:

1. `chat_sessions.booking_draft` holds `{ serviceName, date, time, notes }`.
2. Each turn, the prompt restates the draft and the last `AI_HISTORY_TURNS` (default 12) messages, oldest first (`recentTurns`).
3. The provider returns only what this message said. `mergeSlots` (shared) overlays it: **an absent or null field means "not mentioned", never "cleared"**, so "actually make it 4pm" keeps the service and day.
4. The merged draft is stored with the assistant message, so a reload, a second tab or a switch to the fallback engine continues where the conversation left off.

## Guardrails

These are listed in the order a turn meets them.

| # | Guardrail | Where |
|---|---|---|
| 1 | **Input bounds.** Message 1–2000 chars; chat rate limit 20/min per user (each message may cost a paid call) | `sendMessageSchema`, `chatLimiter` |
| 2 | **Closed sessions.** A conversation that already booked refuses further turns (`409 SESSION_CLOSED`), so a stray "yes" in an old tab cannot re-book | `chat/service.ts` `assertOpen` |
| 3 | **User message stored before the AI call**, so it is never lost to a provider failure | `chat/service.ts` step 2 |
| 4 | **Tenant-scoped context.** The model only sees this tenant's catalogue and hours, and this user's conversation | `prompts.ts`, repositories |
| 5 | **Forced tool call.** A prose answer with no tool call becomes `invalid_output`, and the turn falls back | `mistral.ts` |
| 6 | **Schema validation.** Arguments are parsed through zod; `"null"`/`""` noise is normalised; a bad date or time becomes `invalid_output` | `tools.ts` `parseAssistantArgs` |
| 7 | **Date cross-check.** If chrono-node confidently reads a date from the same message and the model's differs, chrono wins (`date_corrected`). Context-dependent dates such as "the 12th" are not overruled. Seen live: "next Wednesday" resolved by the model to 2026-10-08 (a Thursday), corrected to 2026-10-07 | `guardrails.ts` |
| 8 | **Reply replacement.** A reply that claims a booking was made, or names a weekday or date other than the draft's, is replaced with the code-composed question (`reply_replaced`, reason `booking_claim` / `date_mismatch`) | `guardrails.ts` |
| 9 | **Service resolution in SQL.** Exact match, then ranked containment with `strpos` (not `LIKE`, so `%` is not a wildcard). Several best matches lead to "Did you mean A or B?"; none leads to "We don't offer that. We have: …" | `chat/service.ts` `resolveService`, `appointments/repository.matchServiceByName` |
| 10 | **Consent rule.** A booking is attempted only when (a) the stored draft was **already complete**, so a confirmation card was on screen, (b) this turn changed none of service, date or time, and (c) intent is `confirming`. In the deterministic engine a negation check runs before consent, so "don't book it", "wait" or "hold off" never book. "Book a checkup tomorrow at 2" therefore shows a summary first, and "yes, but make it 4pm" re-confirms | `chat/service.ts` |
| 11 | **Code-worded confirmation.** The last sentence before consent is built from the resolved slots, never from model prose | `copy.ts` |
| 12 | **Booking rules in one service, plus DB constraints.** Past, outside hours, off the 30-minute grid, taken, customer already busy at that time, inactive service; races resolved by two `EXCLUDE` constraints | `appointments/service.ts`, `availability.ts` |
| 13 | **Refusals are composed by code.** "That slot is already booked. I could do 2:30 PM, or 3:30 PM — which works?" Suggestions come from the availability query, and the rejected field is cleared from the draft | `chat/service.ts` `clearRejected` |
| 14 | **needs_form escalation.** After 4 turns in a row with no progress (the same details still missing, no times offered), the turn becomes `needs_form` and the UI offers the structured form pre-filled from the draft. It is offered at most once per conversation | `chat/service.ts` `STALLED_TURN_THRESHOLD` |
| 15 | **Bounded latency.** `AbortSignal.timeout(AI_TIMEOUT_MS)` per attempt; retry only 408/429/5xx/network, with jittered backoff; a 429 `Retry-After` is obeyed only if the wait plus one attempt fits the budget `AI_TIMEOUT_MS × (AI_MAX_RETRIES + 1)`; 401/403 are never retried and are logged at error level as `auth_error` | `mistral.ts` |
| 16 | **Transparency.** Every turn reports `engine`; the UI labels non-LLM replies "Guided mode" and shows a one-time notice | `EngineBadge`, `EngineNotice` |

**Gap, stated honestly:** the model's **time** is validated for format, and the booking service checks it against business hours, but code does not re-derive it the way it re-derives dates. The deterministic engine's AM/PM rules (below) are not yet applied as a cross-check on model output.

## The deterministic engine

[`fallback.ts`](../apps/api/src/modules/ai/fallback.ts) is a full provider, not a stub. It runs when there is no key, or after any Mistral failure.

- **Dates** via chrono-node, parsed against the **business's** wall clock. Only "certain" readings are taken, so a bare "2pm" does not imply today. Vague ranges ("sometime next week") stay unresolved so the next turn asks which day. "the 12th" resolves to the next 12th that exists.
- **Times:** explicit am/pm wins. Otherwise a stated part of day decides ("morning" means AM; "afternoon", "evening" or "after work" mean PM). Otherwise whichever reading falls inside opening hours. Otherwise 1–7 means PM. "around 3", "about 4:30" and "3ish" are read; "3 days" and "2 people" are not. A bare "afternoon" becomes 14:00, clamped to opening hours.
- **Services** by substring, then token overlap with joined neighbours ("check up" matches "Checkup"). Ties return nothing, so the user is asked.
- **Confirmation** ("yes", "book it", "go ahead") only when the merged draft is complete and no decline words are present.
- **Replies** are templated from the draft: they acknowledge what is known, ask for at most what is missing, and include opening hours when asking for a time.

## Interaction logging

`recordAiInteraction` writes one row per provider call, **fire-and-forget**, and never throws:

| Column | Example |
|---|---|
| `provider`, `model` | `mistral`, `ministral-8b-latest` |
| `latency_ms`, `prompt_tokens`, `completion_tokens` | 742, 486, 58 |
| `outcome` | `ok · timeout · rate_limited · auth_error · invalid_output · provider_error` |
| `error_message` | `Mistral responded 401: …` (truncated) |
| `extracted_slots` | `{"serviceName":"Teeth Whitening","date":"2026-10-07"}` |
| `guardrails` | `[{"kind":"date_corrected","model":"2026-10-08","deterministic":"2026-10-07"}]` |
| `request_id`, `session_id`, `business_id` | correlate with access logs and the transcript |

After a Mistral failure two rows are written: the failed call and the fallback that served the turn. The assistant message also stores the raw extraction in `chat_messages.tool_calls`, so a conversation can be replayed without calling the provider again. Pino also logs guardrail corrections and failures with the request id.

`GET /api/ai/summary` (owner only, scoped to the caller's business) summarises the last 24 h: totals by outcome, and per provider the call count, error rate and p50/p95 latency. Percentiles are per provider so the near-instant fallback engine cannot hide the model's latency.

Useful queries:

```sql
-- Fallback rate and failure mix, last 7 days
SELECT provider, outcome, count(*) FROM ai_interaction_logs
WHERE created_at > now() - interval '7 days' GROUP BY 1, 2 ORDER BY 3 DESC;

-- How often an accepted model answer still needed correcting
SELECT g->>'kind' AS kind, count(*) FROM ai_interaction_logs, jsonb_array_elements(guardrails) g
GROUP BY 1;

-- Token cost per conversation
SELECT session_id, sum(prompt_tokens + completion_tokens) FROM ai_interaction_logs
WHERE provider = 'mistral' GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

## Failure modes

| Failure | Detection | User sees | Logged as |
|---|---|---|---|
| No `MISTRAL_API_KEY` | `env.aiEnabled` false at boot | Guided-mode replies; `/health` reports `fallback-only` | `fallback / ok` |
| Bad or revoked key (401/403) | status | Guided-mode reply, no retry delay | `auth_error` (error level) + fallback row |
| Timeout | `AbortSignal.timeout` | One retry, then a guided reply | `timeout` + fallback |
| 429 | status + `Retry-After` | Waits only if it fits the budget, else an immediate guided reply | `rate_limited` + fallback |
| 5xx / network | status / fetch error | One retry, then a guided reply | `provider_error` + fallback |
| Prose instead of a tool call | no `tool_calls` | Guided reply (the deterministic engine reads the same message) | `invalid_output` |
| Malformed arguments (bad date, wrong type) | zod | Guided reply | `invalid_output` |
| Wrong weekday arithmetic | chrono cross-check | Correct date in draft and confirmation | `ok` + `guardrails` |
| Claims "you're booked" | regex | Code-composed question | `ok` + `guardrails` |
| Unknown or ambiguous service | SQL resolution | "We don't offer that…" / "Did you mean…" | — |
| Conversation not converging | 4 turns in a row with no progress | `needs_form` card pre-filled from the draft | — |
| Slot taken between confirm and insert | `EXCLUDE` (constraint name tells taken from customer busy) | "Someone just took that slot" + suggestions | warn log |
| Log insert fails | caught | Nothing | error log |

## Cost and latency controls

- **One call per turn.** Slots and reply share the same tool call. Titles come from the first message, not a summarisation call.
- **History capped** at `AI_HISTORY_TURNS` (12), so prompt size stays flat as conversations grow.
- **Confirmations, refusals, ambiguity questions and booked messages are written by code**, adding no extra model call.
- `max_tokens: 600`, `temperature: 0.2`.
- Worst-case wait is bounded by `AI_TIMEOUT_MS × (AI_MAX_RETRIES + 1)` plus backoff (about 24 s by default). The web client's request timeout (30 s) sits above it.
- A per-user chat limit of 20/min caps spend per account. `render.yaml` defaults to the smaller `ministral-8b-latest` model.
- **Not done:** a circuit breaker (a breaker's state does not survive multiple instances without shared storage), and caching.

## Swapping providers

1. Add `modules/ai/<provider>.ts` implementing `AiProvider`. Map the provider's tool or function-calling format onto `buildAssistantTool()` and parse with `parseAssistantArgs()`. Throw `ProviderError` with an outcome.
2. Instantiate it in `index.ts` in place of, or ahead of, `MistralProvider`.
3. Add its env vars to `config/env.ts`.

Nothing in chat, booking, persistence or the web app changes. They depend on `ProviderOutput` and `engine`. The `engine` union (shared) and the `chat_messages.engine` CHECK would gain the new name.

## How to evaluate it

- **Unit tests:** `test/unit/guardrails.test.ts`, `fallback.test.ts`, `tools.test.ts`, covering date correction, booking-claim and date-mismatch detection, AM/PM rules, ordinal days, vague ranges and argument parsing.
- **Provider behaviour over real HTTP:** `test/integration/ai-mistral.test.ts` drives the real `MistralProvider` against a scripted chat-completions stub ([`helpers/mistralStub.ts`](../apps/api/test/helpers/mistralStub.ts)). It covers success, retries, `Retry-After` inside and outside the budget, 401 without retry, prose without a tool call, malformed arguments, fallback and log rows.
- **Conversation flows:** `test/integration/chat.test.ts` on the deterministic engine, covering consent, closed sessions, escalation, suggestions and the draft form.
- **Online:** watch the fallback rate, `invalid_output` rate and `guardrails` frequency in `ai_interaction_logs`. Each correction is a labelled failure case. Exporting `chat_messages` (user text) with the corrected slots gives a regression set to replay against a new model or prompt before switching.
