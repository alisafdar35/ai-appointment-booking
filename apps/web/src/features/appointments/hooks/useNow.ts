import { useEffect, useState } from 'react';

/**
 * The current time, refreshed on an interval, so "in 5 minutes" and the
 * cancel button's eligibility stay true while a tab sits open all day.
 * Minute resolution is enough: nothing on the page is shown in seconds.
 */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
