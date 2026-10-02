import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { buildSystemPrompt } from './prompts.js';
import {
  ASSISTANT_TOOL_NAME,
  buildAssistantTool,
  parseAssistantArgs,
} from './tools.js';
import { ProviderError, type AiProvider, type ProviderInput, type ProviderOutput } from './provider.js';

/**
 * Mistral provider.
 *
 * Written against the HTTP API with `fetch` rather than the vendor SDK. For one
 * endpoint it is less code than the SDK's configuration surface, it makes the
 * timeout and retry policy explicit and inspectable instead of inherited, and
 * it keeps a dependency that moves fast out of the build.
 */

interface MistralToolCall {
  id?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

interface MistralResponse {
  model?: string;
  choices?: {
    message?: { content?: string | null; tool_calls?: MistralToolCall[] };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Errors worth a second attempt: transient. A 400 means our request is wrong. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
/** The key is missing, wrong or revoked. No retry can fix that; configuration can. */
const AUTH_STATUS = new Set([401, 403]);

/** Retry-After as milliseconds: delay-seconds or an HTTP date. Null if absent or unreadable. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

export class MistralProvider implements AiProvider {
  readonly engine = 'mistral' as const;
  readonly available = env.aiEnabled;

  async respond(input: ProviderInput): Promise<ProviderOutput> {
    const startedAt = Date.now();
    const tool = buildAssistantTool(input.services.map((s) => s.name));

    const messages: { role: string; content: string }[] = [
      { role: 'system', content: buildSystemPrompt(input) },
      ...input.history.map((m) => ({ role: m.role, content: m.content })),
    ];

    const body = {
      model: env.MISTRAL_MODEL,
      messages,
      tools: [tool],
      // 'any' forces a tool call, which is what makes the response reliably
      // structured. Without it the model will sometimes reply in prose and the
      // turn yields no slots.
      tool_choice: 'any',
      // Low but non-zero: extraction wants determinism, the reply text wants to
      // not read like a form letter.
      temperature: 0.2,
      max_tokens: 600,
    };

    const response = await this.callWithRetry(body, input.requestId);
    const latencyMs = Date.now() - startedAt;

    const choice = response.choices?.[0];
    const toolCall = choice?.message?.tool_calls?.find((c) => c.function?.name === ASSISTANT_TOOL_NAME);

    if (!toolCall?.function?.arguments) {
      // The model ignored tool_choice. Its prose cannot be used: without the
      // tool call the turn carries no slots, so whatever the user just said
      // ("tomorrow at 2pm") would be dropped and the conversation would stall.
      // Failing here hands the turn to the deterministic extractor, which reads it.
      throw new ProviderError(
        'invalid_output',
        choice?.message?.content?.trim()
          ? 'Model replied in prose without calling the tool'
          : 'Model returned neither a tool call nor any content',
      );
    }

    const parsed = parseAssistantArgs(toolCall.function.arguments);
    if (!parsed.ok) {
      // Schema violation. Treated as a provider failure so the orchestrator
      // falls back deterministically instead of guessing at malformed slots.
      throw new ProviderError('invalid_output', `Tool arguments failed validation — ${parsed.issue}`);
    }

    const { reply, intent, ...slots } = parsed.args;
    return {
      reply: reply.trim(),
      slots,
      intent,
      engine: this.engine,
      model: response.model ?? env.MISTRAL_MODEL,
      usage: {
        promptTokens: response.usage?.prompt_tokens,
        completionTokens: response.usage?.completion_tokens,
      },
      latencyMs,
    };
  }

  /**
   * One retry by default, on transient failures only, with jittered backoff.
   *
   * Retries are capped deliberately: a user is waiting on this request, so the
   * useful ceiling is "one more go", not exponential persistence. Jitter avoids
   * a thundering herd if the provider briefly rate-limits everyone at once.
   *
   * A 429 that says how long to wait (Retry-After) is obeyed instead of the
   * backoff — retrying sooner only earns another 429 — but only while the wait
   * plus one full attempt still fits the call's time budget: the most the
   * attempts alone could take. A longer wait means falling back now, because
   * the user is better served by the deterministic engine than by a spinner.
   */
  private async callWithRetry(body: unknown, requestId: string): Promise<MistralResponse> {
    let lastError: ProviderError | undefined;
    const deadline = Date.now() + env.AI_TIMEOUT_MS * (env.AI_MAX_RETRIES + 1);

    for (let attempt = 0; attempt <= env.AI_MAX_RETRIES; attempt += 1) {
      // AbortSignal.timeout gives a hard ceiling on the request. Without it a
      // hung upstream connection holds the user's request open indefinitely.
      const signal = AbortSignal.timeout(env.AI_TIMEOUT_MS);
      try {
        const res = await fetch(`${env.MISTRAL_BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
          },
          body: JSON.stringify(body),
          signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const outcome = AUTH_STATUS.has(res.status)
            ? 'auth_error'
            : res.status === 429
              ? 'rate_limited'
              : 'provider_error';
          lastError = new ProviderError(outcome, `Mistral responded ${res.status}: ${text.slice(0, 300)}`);
          if (!RETRYABLE_STATUS.has(res.status) || attempt >= env.AI_MAX_RETRIES) throw lastError;

          const asked = res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : null;
          if (asked === null) {
            await this.backoff(attempt, requestId, res.status);
          } else if (Date.now() + asked + env.AI_TIMEOUT_MS <= deadline) {
            await this.pause(asked, attempt, requestId, 'retry-after');
          } else {
            throw new ProviderError(
              'rate_limited',
              `Mistral responded 429 and asked for ${Math.ceil(asked / 1000)}s, beyond the time budget: ${text.slice(0, 200)}`,
            );
          }
          continue;
        }

        return (await res.json()) as MistralResponse;
      } catch (err) {
        if (err instanceof ProviderError) throw err;

        const isTimeout =
          err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        lastError = new ProviderError(
          isTimeout ? 'timeout' : 'provider_error',
          isTimeout
            ? `Provider did not respond within ${env.AI_TIMEOUT_MS}ms`
            : `Network error calling Mistral: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
        if (attempt < env.AI_MAX_RETRIES) {
          await this.backoff(attempt, requestId, isTimeout ? 'timeout' : 'network');
          continue;
        }
        throw lastError;
      }
    }

    throw lastError ?? new ProviderError('provider_error', 'Mistral call failed');
  }

  private backoff(attempt: number, requestId: string, reason: unknown): Promise<void> {
    return this.pause(300 * 2 ** attempt + Math.random() * 200, attempt, requestId, reason);
  }

  private async pause(delay: number, attempt: number, requestId: string, reason: unknown): Promise<void> {
    logger.warn({ reqId: requestId, attempt, reason, delay }, 'Retrying Mistral call');
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
