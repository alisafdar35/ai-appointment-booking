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
