import { addDays, dateInZone, formatDate, formatTime } from '@/lib/datetime';

/**
 * The sidebar's "last active" label, in the business timezone: a clock time for
 * today, "Yesterday", then a short date. Relative phrases like "3 days ago" are
 * avoided on purpose: they shift under the user's eyes and are harder to scan.
 */
export function formatSessionTime(value: string | null, timeZone: string, now: Date = new Date()): string {
  if (!value) return '';
  const today = dateInZone(now, timeZone);
  const day = dateInZone(value, timeZone);
  if (day === today) return formatTime(value, timeZone);
  if (day === addDays(today, -1)) return 'Yesterday';
  return formatDate(value, timeZone, 'short');
}
