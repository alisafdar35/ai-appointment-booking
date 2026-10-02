import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { bookingSlotsSchema } from '@appt/shared';

/**
 * The LLM contract: one forced tool call per turn carrying both the slots and
 * the reply, so every answer is structured and validated in one round trip.
 * The JSON Schema is generated from the shared bookingSlotsSchema, so the
 * model's contract cannot drift from what the form and API validate.
 */
export const ASSISTANT_INTENTS = ['collecting', 'confirming', 'cancelling', 'other', 'off_topic'] as const;

export const assistantToolSchema = bookingSlotsSchema.partial().extend({
  reply: z
    .string()
    .min(1)
    .max(600)
    .describe(
      'The message to show the user. Warm, brief, one or two sentences. Never mention tools, JSON or internal fields.',
    ),
  intent: z
    .enum(ASSISTANT_INTENTS)
    .describe(
      "'collecting' while details are still missing; 'confirming' when the user is agreeing to a proposed booking; 'cancelling' if they want to cancel; 'other' for a question about this business; 'off_topic' for anything unrelated to it (not answered).",
    ),
});
export type AssistantToolArgs = z.infer<typeof assistantToolSchema>;

export const ASSISTANT_TOOL_NAME = 'respond_to_booking_request';

/**
 * Build the tool definition, injecting the tenant's live service catalogue as
 * an enum on `serviceName`.
 *
 * The enum is a guardrail: it steers the model to pick a real service rather
 * than invent "Deep Clean Plus" because it sounded plausible. Note that we
 * steer with the enum but PARSE leniently (see parseAssistantArgs) — a model
 * that answers "whitening" for "Teeth Whitening" is being helpful, not wrong,
 * and the service layer resolves near-misses by name. Rejecting the turn
 * outright would be strictness that costs the user a round trip.
 */
export function buildAssistantTool(serviceNames: string[]) {
  const json = zodToJsonSchema(assistantToolSchema, {
    target: 'openApi3',
    $refStrategy: 'none',
  }) as Record<string, unknown>;

  const properties = json.properties as Record<string, Record<string, unknown>> | undefined;
  if (properties?.serviceName && serviceNames.length > 0) {
    properties.serviceName = {
      ...properties.serviceName,
      enum: serviceNames,
      description: `The service the user wants. Must be one of the business's services: ${serviceNames.join(', ')}.`,
    };
  }
  if (properties?.date) {
    properties.date.description =
      'The appointment date as YYYY-MM-DD. Resolve relative dates ("tomorrow", "next Thursday") against the current date given in the system message. Omit if the user has not said.';
  }
  if (properties?.time) {
    properties.time.description =
      'The appointment start time as HH:MM in 24-hour form. "2pm" is "14:00". Omit if the user has not given a specific time.';
  }
  if (properties?.notes) {
    properties.notes.description =
      'Any short preference or detail worth recording (e.g. "first visit", "prefers afternoons"). Omit if there is none.';
  }

  return {
    type: 'function' as const,
    function: {
      name: ASSISTANT_TOOL_NAME,
      description:
        'Reply to the user and record any booking details they have provided so far. Call this on every turn.',
      parameters: json,
    },
  };
}

/**
 * Parse the model's tool arguments.
 *
 * Deliberately lenient about `serviceName` (free string, resolved downstream)
 * and strict about everything else: a malformed date or time is rejected here
 * rather than being passed into the booking path, where it would become either
 * a confusing validation error or, worse, a wrong booking.
 *
 * Returns a result instead of throwing so the caller can fall back to the
 * deterministic extractor on a bad turn rather than failing the request.
 */
const lenientArgsSchema = assistantToolSchema.extend({
  serviceName: z.string().trim().min(1).max(160).nullable().optional(),
});

export type ParseResult =
  | { ok: true; args: AssistantToolArgs }
  | { ok: false; issue: string };

export function parseAssistantArgs(raw: unknown): ParseResult {
  let value = raw;

  // Mistral returns `arguments` as a JSON string, but has been observed to
  // return an object. Accept both rather than depending on one.
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, issue: 'Tool arguments were not valid JSON' };
    }
  }
  if (typeof value !== 'object' || value === null) {
    return { ok: false, issue: 'Tool arguments were not an object' };
  }

  // Models sometimes emit the literal string "null" or "" for an unknown slot.
  // Normalising here keeps that noise out of the schema and out of the draft.
  const cleaned: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    cleaned[key] = v === 'null' || v === 'undefined' || v === '' ? null : v;
  }

  const parsed = lenientArgsSchema.safeParse(cleaned);
  if (!parsed.success) {
    return {
      ok: false,
      issue: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, args: parsed.data as AssistantToolArgs };
}
