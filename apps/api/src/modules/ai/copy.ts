import { humanDate, humanTime } from '../../lib/time.js';

/**
 * The confirmation question, worded once.
 *
 * It is the last thing a user reads before agreeing to a booking, so it is
 * written from the resolved slots by code — never taken from model prose, where
 * "Tuesday at 3pm" could drift from the 14:00 actually stored in the draft.
 */
export const confirmationPrompt = (serviceName: string, date: string, time: string): string =>
  `Just to confirm: ${serviceName} on ${humanDate(date)} at ${humanTime(time)}. Shall I book it?`;

/**
 * The reply to "don't book anything yet" while a summary is on screen. Nothing
 * is written; the details stay, so a later "yes" needs nothing re-typed.
 */
export const heldPrompt = (serviceName: string, date: string, time: string): string =>
  `Okay, I haven't booked anything. I've kept ${serviceName} on ${humanDate(date)} at ${humanTime(time)} — say yes when you're ready, or tell me what to change.`;

/** Catalogue prices are whole cents; "$45.00", as the system prompt lists them. */
export const formatPrice = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
