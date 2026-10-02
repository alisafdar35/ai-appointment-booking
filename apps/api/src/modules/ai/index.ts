import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { FallbackProvider } from './fallback.js';
import { applyGuardrails } from './guardrails.js';
import { MistralProvider } from './mistral.js';
import { recordAiInteraction, type AiOutcome } from './logs.js';
import { ProviderError, type ProviderInput, type ProviderOutput } from './provider.js';

export { confirmationPrompt, heldPrompt } from './copy.js';
export { negates, PART_OF_DAY_WINDOW, statedPartOfDay } from './parse.js';
export type { ProviderInput, ProviderOutput } from './provider.js';

const mistral = new MistralProvider();
const fallback = new FallbackProvider();

/**
 * Produce a usable turn and record what happened: try Mistral when a key is
 * configured, correct a usable answer with code-checkable facts (guardrails),
 * and on any failure serve the deterministic provider instead of an error —
 * a user mid-booking should not lose it because a third party had a bad
 * minute. The turn reports its engine so the UI can be honest about it.
 * No circuit breaker: one retry and a hard timeout already bound the worst case.
 */
export async function generateAssistantTurn(
  input: ProviderInput,
  meta: { businessId: string; sessionId: string | null },
): Promise<ProviderOutput> {
  if (mistral.available) {
    try {
      const { output, events } = applyGuardrails(await mistral.respond(input), input);
      if (events.length) {
        logger.warn({ reqId: input.requestId, guardrails: events }, 'Corrected a model answer before using it');
      }
      void recordAiInteraction({
        businessId: meta.businessId,
        sessionId: meta.sessionId,
        requestId: input.requestId,
        provider: 'mistral',
        model: output.model,
        latencyMs: output.latencyMs,
        promptTokens: output.usage?.promptTokens,
        completionTokens: output.usage?.completionTokens,
        outcome: 'ok',
        extractedSlots: output.slots,
        guardrails: events,
      });
      return output;
    } catch (err) {
      const outcome: AiOutcome = err instanceof ProviderError ? err.outcome : 'provider_error';
      const message = err instanceof Error ? err.message : String(err);

      // A rejected key fails every call until configuration changes, so it is
      // an error for an operator, not a warning about a flaky dependency.
      logger[outcome === 'auth_error' ? 'error' : 'warn'](
        { reqId: input.requestId, outcome, err: message },
        'Mistral call failed — serving the deterministic fallback',
      );
      void recordAiInteraction({
        businessId: meta.businessId,
        sessionId: meta.sessionId,
        requestId: input.requestId,
        provider: 'mistral',
        model: env.MISTRAL_MODEL,
        outcome,
        errorMessage: message,
      });
    }
  }

  const output = await fallback.respond(input);
  void recordAiInteraction({
    businessId: meta.businessId,
    sessionId: meta.sessionId,
    requestId: input.requestId,
    provider: 'fallback',
    latencyMs: output.latencyMs,
    outcome: 'ok',
    errorMessage: mistral.available
      ? 'Served by deterministic extractor after provider failure'
      : 'No MISTRAL_API_KEY configured; deterministic extractor is the primary path',
    extractedSlots: output.slots,
  });
  return output;
}
