import type { BookingSlots } from '@appt/shared';
import { pool } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import type { GuardrailEvent } from './guardrails.js';
import type { ProviderError } from './provider.js';

export type AiOutcome = 'ok' | ProviderError['outcome'];

export interface AiLogEntry {
  businessId: string;
  sessionId: string | null;
  requestId: string;
  provider: string;
  model?: string | undefined;
  latencyMs?: number | undefined;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  outcome: AiOutcome;
  errorMessage?: string | undefined;
  extractedSlots?: Partial<BookingSlots> | undefined;
  /** Corrections made to an answer that was otherwise accepted. */
  guardrails?: GuardrailEvent[] | undefined;
}

/**
 * Persist one AI interaction.
 *
 * Every provider call is recorded — successes, timeouts, schema violations and
 * fallbacks alike — which is what turns "the assistant feels slow sometimes"
 * into a query. With this table you can answer, without adding instrumentation
 * after the fact: what does a turn cost, what is each provider's p95 latency,
 * how often does the model return something unparseable, and how often do
 * users end up on the deterministic path. getAiUsageSummary below answers the
 * latency and failure questions per tenant (GET /api/ai/summary).
 *
 * Deliberately fire-and-forget at the call sites: logging is diagnostics, and a
 * failure to write a diagnostic row must never fail — or slow — the user's
 * booking. This function never throws; a test that needs the row polls for it.
 */
export async function recordAiInteraction(entry: AiLogEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO ai_interaction_logs
         (business_id, session_id, request_id, provider, model, latency_ms,
          prompt_tokens, completion_tokens, outcome, error_message, extracted_slots, guardrails)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        entry.businessId,
        entry.sessionId,
        entry.requestId,
        entry.provider,
        entry.model ?? null,
        entry.latencyMs ?? null,
        entry.promptTokens ?? null,
        entry.completionTokens ?? null,
        entry.outcome,
        entry.errorMessage?.slice(0, 1000) ?? null,
        entry.extractedSlots ? JSON.stringify(entry.extractedSlots) : null,
        entry.guardrails?.length ? JSON.stringify(entry.guardrails) : null,
      ],
    );
  } catch (err) {
    logger.error({ err, requestId: entry.requestId }, 'Failed to persist AI interaction log');
  }
}

export interface ProviderSummary {
  calls: number;
  /** Share of calls whose outcome was not 'ok', 0..1. */
  errorRate: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

export interface AiUsageSummary {
  windowHours: number;
  totalCalls: number;
  byOutcome: Record<string, number>;
  byProvider: Record<string, ProviderSummary>;
}

/**
 * One tenant's AI usage over a rolling window, for its owner.
 *
 * Latency percentiles are computed per provider. The deterministic engine
 * answers in about a millisecond and, while the model is unavailable, serves
 * nearly every turn; percentiles over all rows together would report its
 * latency and hide the model's entirely.
 */
export async function getAiUsageSummary(businessId: string, windowHours = 24): Promise<AiUsageSummary> {
  const window = `business_id = $1 AND created_at >= now() - make_interval(hours => $2::int)`;
  const [outcomes, providers] = await Promise.all([
    pool.query<{ outcome: string; count: number }>(
      `SELECT outcome, count(*)::int AS count
       FROM ai_interaction_logs WHERE ${window}
       GROUP BY outcome`,
      [businessId, windowHours],
    ),
    pool.query<{ provider: string; calls: number; failures: number; p50: number | null; p95: number | null }>(
      `SELECT provider,
              count(*)::int AS calls,
              count(*) FILTER (WHERE outcome <> 'ok')::int AS failures,
              percentile_disc(0.5)  WITHIN GROUP (ORDER BY latency_ms)::int AS p50,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)::int AS p95
       FROM ai_interaction_logs WHERE ${window}
       GROUP BY provider`,
      [businessId, windowHours],
    ),
  ]);

  const byOutcome = Object.fromEntries(outcomes.rows.map((r) => [r.outcome, r.count]));
  const byProvider = Object.fromEntries(
    providers.rows.map((r) => [
      r.provider,
      {
        calls: r.calls,
        errorRate: Math.round((r.failures / r.calls) * 1000) / 1000,
        p50LatencyMs: r.p50,
        p95LatencyMs: r.p95,
      } satisfies ProviderSummary,
    ]),
  );
  return {
    windowHours,
    totalCalls: providers.rows.reduce((sum, r) => sum + r.calls, 0),
    byOutcome,
    byProvider,
  };
}
