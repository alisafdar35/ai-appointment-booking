'use client';

import { useEffect, useState } from 'react';

/**
 * Whole seconds left until `startedAt + seconds`, ticking once a second and
 * stopping at zero. Returns 0 when there is nothing to wait for.
 */
export function useCountdown(seconds: number | undefined, startedAt: number): number {
  const endsAt = seconds ? startedAt + seconds * 1000 : 0;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!endsAt) return;
    const tick = () => {
      setNow(Date.now());
      if (Date.now() >= endsAt) clearInterval(timer);
    };
    const timer = setInterval(tick, 1000);
    tick();
    return () => clearInterval(timer);
  }, [endsAt]);

  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}
