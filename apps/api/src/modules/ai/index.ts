import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { FallbackProvider } from './fallback.js';
import { applyGuardrails } from './guardrails.js';
import { MistralProvider } from './mistral.js';
import { recordAiInteraction, type AiOutcome } from './logs.js';
import { ProviderError, type ProviderInput, type ProviderOutput } from './provider.js';

export { confirmationPrompt, heldPrompt } from './copy.js';
export { negates } from './fallback.js';
export type { ProviderInput, ProviderOutput } from './provider.js';

const mistral = new MistralProvider();
const fallback = new FallbackProvider();

/**
 * The AI orchestrator.
 *
 * One function, one responsibility: produce a usable turn, and record what
 * happened. The policy is deliberately simple —
 *
 *   1. If a key is configured, try Mistral.
 *   2. Check a usable answer against what code can verify (guardrails.ts),
 *      correcting it where they disagree.
 *   3. On any failure (timeout, 5xx, rate limit, unparseable output), fall
 *      through to the deterministic extractor rather than returning an error.
 *   4. Record the attempt either way, corrections included.
 *
 * Step 3 is the design decision worth defending. The alternative — surface a
 * 503 and let the user retry — is a worse product: the user is mid-conversation
 * trying to book an appointment, and the business loses the booking because a
 * third-party API had a bad minute. A degraded reply that still captures "2pm
 * Thursday" is strictly better than an apology. The response reports which
 * engine served it, so the UI can be honest about the downgrade rather than
 * hiding it.
 *
 * No circuit breaker: with one retry and a hard timeout the worst case is
 * bounded, and a breaker's shared state does not survive the multi-instance
 * deployment this would need anyway. Noted as a limitation, not an oversight.
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
