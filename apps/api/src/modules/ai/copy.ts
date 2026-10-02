import type { BookingSlots, ServiceDto } from '@appt/shared';
import { humanDate, humanTime } from '../../lib/time.js';
import { asksAboutService, type Clarification } from './parse.js';
import type { ProviderInput } from './provider.js';

/**
 * Replies worded by code. Every fact in them comes from the draft or the
 * catalogue, so they cannot contradict what is stored — which is why they
 * replace model prose whenever that prose cannot be trusted (guardrails.ts).
 */

/**
 * The confirmation question: the last thing a user reads before agreeing, so
 * it is never model prose, where "3pm" could drift from the 14:00 stored.
 */
export const confirmationPrompt = (serviceName: string, date: string, time: string): string =>
  `Just to confirm: ${serviceName} on ${humanDate(date)} at ${humanTime(time)}. Shall I book it?`;

/** The reply to "don't book anything yet" while a summary is on screen. The details are kept. */
export const heldPrompt = (serviceName: string, date: string, time: string): string =>
  `Okay, I haven't booked anything. I've kept ${serviceName} on ${humanDate(date)} at ${humanTime(time)} — say yes when you're ready, or tell me what to change.`;

/** The redirect for a question unrelated to booking. It never answers the question itself. */
export const offTopicPrompt = (businessName: string): string =>
  `Sorry, I can only help with appointments at ${businessName}.`;

/** Catalogue prices are whole cents; "$45.00", as the system prompt lists them. */
export const formatPrice = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

const ISO_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** [1..7] -> "every day"; [1..5] -> "on Monday, Tuesday, Wednesday, Thursday, Friday". */
export function openDaysPhrase(openDays: number[]): string {
  const days = [...new Set(openDays)].sort((a, b) => a - b);
  return days.length === 7 ? 'every day' : `on ${days.map((d) => ISO_WEEKDAYS[d - 1]).join(', ')}`;
}

/**
 * The catalogue's answer to a price or length question ("Can you confirm the
 * price first?"), or null when the message asks neither or no service is
 * known. Facts come from the catalogue, never from a model.
 */
export function answerAboutService(
  text: string,
  serviceName: string | null,
  services: Pick<ServiceDto, 'name' | 'durationMinutes' | 'priceCents'>[],
): string | null {
  if (!asksAboutService(text)) return null;
  const service = services.find((s) => s.name.toLowerCase() === serviceName?.toLowerCase());
  if (!service) return null;
  const cost = service.priceCents > 0 ? `costs ${formatPrice(service.priceCents)}` : 'has no charge';
  return `${service.name} takes ${service.durationMinutes} minutes and ${cost}.`;
}

/** The next question for a draft: the summary when complete, otherwise exactly what is missing. */
export function composeReply(
  merged: BookingSlots,
  input: Pick<ProviderInput, 'services' | 'opensAt' | 'closesAt' | 'openDays'>,
  clarification: Clarification | null = null,
): string {
  // Also the reply to a "yes" that changed something: the booking is not made
  // until the user agrees to the summary they have actually seen.
  if (merged.serviceName && merged.date && merged.time && !clarification) {
    return confirmationPrompt(merged.serviceName, merged.date, merged.time);
  }

  const acknowledged = [
    merged.serviceName ? merged.serviceName : null,
    merged.date ? humanDate(merged.date) : null,
    merged.time ? humanTime(merged.time) : null,
  ].filter(Boolean);

  const prefix = acknowledged.length ? `Got it — ${acknowledged.join(', ')}. ` : '';
  if (clarification) return `${prefix}${clarification.question}`;

  // Days are named only when some are closed: "every day" adds nothing to a question.
  const days = input.openDays.length < 7 ? `${openDaysPhrase(input.openDays)}, ` : '';
  const openingHours = `We're open ${days}${humanTime(input.opensAt)} to ${humanTime(input.closesAt)}.`;

  if (!merged.serviceName) {
    const names = input.services.slice(0, 4).map((s) => s.name).join(', ');
    // Nothing known yet: ask for all of it at once rather than over three turns.
    if (!merged.date && !merged.time) {
      return `Which service would you like, and what day and time suit you? We offer: ${names}. ${openingHours}`;
    }
    return `${prefix}Which service would you like? We offer: ${names}.`;
  }
  if (!merged.date && !merged.time) return `${prefix}What day and time would suit you? ${openingHours}`;
  if (!merged.date) return `${prefix}Which day would you like to come in?`;
  return `${prefix}What time works for you? ${openingHours}`;
}
