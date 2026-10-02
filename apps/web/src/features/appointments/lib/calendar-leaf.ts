/**
 * Month and day-of-month of an instant in the business zone, for the date tile
 * on a card ("OCT" over "5"). `formatDate` only produces whole strings, and
 * splitting "Mon, Oct 5" apart would depend on the locale's punctuation, so
 * the parts are asked for directly, with the zone explicit as everywhere else.
 */
export function calendarLeaf(value: string, timeZone: string): { month: string; day: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).formatToParts(
    new Date(value),
  );
  const part = (type: 'month' | 'day') => parts.find((p) => p.type === type)?.value ?? '';
  return { month: part('month'), day: part('day') };
}
