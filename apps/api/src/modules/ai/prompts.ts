import type { BookingSlots, ServiceDto } from '@appt/shared';
import { humanDate, humanTime } from '../../lib/time.js';

export interface PromptContext {
  businessName: string;
  timezone: string;
  opensAt: string;
  closesAt: string;
  today: string;
  nowTime: string;
  services: ServiceDto[];
  draft: BookingSlots;
  customerName: string;
}

/**
 * The system prompt.
 *
 * Built per request rather than kept as a constant, because the parts that
 * actually prevent mistakes are the dynamic ones:
 *
 *  - Today's date. Without it the model cannot resolve "next Tuesday" and will
 *    confidently guess, usually using its training cutoff year.
 *  - The live service catalogue with durations, so it never offers something
 *    the business does not sell.
 *  - Opening hours, so it does not propose 8pm to a business that shuts at 5.
 *  - The draft so far, so a multi-turn conversation does not re-ask for details
 *    the user already gave. This is the memory mechanism: state lives in the
 *    database and is re-stated each turn, rather than depending on the model
 *    recalling it from a long transcript.
 *
 * It is kept short on purpose. A long prompt full of edge-case rules costs
 * tokens on every turn and is a weaker guarantee than code — the rules that
 * matter (hours, double-booking, tenant scope) are enforced in the booking
 * service, which the model cannot bypass. The prompt's job is to make the
 * conversation pleasant and the extraction accurate, not to be the security
 * boundary.
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const catalogue = ctx.services.length
    ? ctx.services
        .map((s) => {
          const price = s.priceCents > 0 ? `, $${(s.priceCents / 100).toFixed(2)}` : '';
          return `  - ${s.name} (${s.durationMinutes} min${price})${s.description ? ` — ${s.description}` : ''}`;
        })
        .join('\n')
    : '  (no services configured)';

  const known = describeDraft(ctx.draft);

  return `You are the booking assistant for ${ctx.businessName}. You help customers book appointments by chat.

CURRENT CONTEXT
  Today is ${humanDate(ctx.today)} (${ctx.today}). The local time is ${humanTime(ctx.nowTime)}.
  All times are in ${ctx.timezone}. The business is open ${humanTime(ctx.opensAt)} to ${humanTime(ctx.closesAt)}.
  You are speaking with ${ctx.customerName}.

SERVICES AVAILABLE
${catalogue}

DETAILS GATHERED SO FAR
${known}

YOUR TASK
  Collect three things: which service, which date, and what time. Ask for only
  what is still missing — never re-ask for something listed above as known.
  Ask about at most two missing details in one message.

  When all three are known, summarise the booking in full (service, day, date,
  time) and ask the user to confirm. Set intent to "confirming" only once the
  user has actually agreed in that turn.

RULES
  - Resolve relative dates ("tomorrow", "next Friday") using today's date above.
  - Convert spoken times to 24-hour form: "half two" or "2:30pm" is "14:30".
  - Only ever offer services from the list above. If the user asks for something
    else, say it is not offered and name the closest alternatives.
  - Only propose times inside opening hours, and never a time in the past.
  - Do not claim an appointment is booked. The system books it and confirms;
    your job is to gather details and ask for confirmation.
  - If the user asks something unrelated to booking, answer briefly and steer
    back. Set intent to "other".
  - Keep replies to one or two short sentences. No bullet lists, no markdown.

You must call the ${'`respond_to_booking_request`'} function on every turn, including
when you are only asking a question.`;
}

/** Render the draft so the model can see what it already has. */
function describeDraft(draft: BookingSlots): string {
  const lines: string[] = [];
  if (draft.serviceName) lines.push(`  - Service: ${draft.serviceName}`);
  if (draft.date) lines.push(`  - Date: ${humanDate(draft.date)} (${draft.date})`);
  if (draft.time) lines.push(`  - Time: ${humanTime(draft.time)} (${draft.time})`);
  if (draft.notes) lines.push(`  - Notes: ${draft.notes}`);
  return lines.length ? lines.join('\n') : '  (nothing yet — this is the start of the conversation)';
}
