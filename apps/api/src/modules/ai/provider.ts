import type { AiEngine, BookingSlots, ClarificationDto } from '@appt/shared';
import type { PromptContext } from './prompts.js';
import type { ASSISTANT_INTENTS } from './tools.js';

export type AssistantIntent = (typeof ASSISTANT_INTENTS)[number];

export interface ProviderInput extends PromptContext {
  /** Recent turns, oldest first, already trimmed to AI_HISTORY_TURNS. */
  history: { role: 'user' | 'assistant'; content: string }[];
  requestId: string;
}

export interface ProviderOutput {
  reply: string;
  /** Only the slots mentioned on this turn. Merged over the stored draft by the caller. */
  slots: Partial<BookingSlots>;
  intent: AssistantIntent;
  engine: AiEngine;
  model?: string | undefined;
  usage?: { promptTokens?: number; completionTokens?: number } | undefined;
  latencyMs: number;
  /**
   * Draft fields this message reopened without settling ("at 5": AM or PM?).
   * The caller clears them, so a confirmation on screen for the old value can
   * no longer be agreed to while the reply asks which one was meant.
   */
  clarify?: ('date' | 'time')[] | undefined;
  /** The readings the clarifying question offers, for the client to show as answers. */
  clarification?: ClarificationDto | undefined;
}

/**
 * The seam between the application and whichever model is behind it.
 *
 * Everything upstream of this interface — the chat service, the booking rules,
 * the persistence — is written against `AiProvider`, not against Mistral. That
 * is what makes the deterministic fallback a drop-in rather than a special
 * case, and what would make swapping providers a new file rather than a
 * refactor.
 */
export interface AiProvider {
  readonly engine: AiEngine;
  readonly available: boolean;
  respond(input: ProviderInput): Promise<ProviderOutput>;
}

/**
 * Raised by a provider when it cannot produce a usable answer at all.
 *
 * `auth_error` is kept apart from `provider_error` because it is the one
 * failure that is ours to fix: a revoked or mistyped key fails every call until
 * someone changes configuration, and must not hide among transient 5xx noise.
 */
export class ProviderError extends Error {
  readonly outcome: 'timeout' | 'rate_limited' | 'auth_error' | 'invalid_output' | 'provider_error';
  constructor(outcome: ProviderError['outcome'], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderError';
    this.outcome = outcome;
  }
}
