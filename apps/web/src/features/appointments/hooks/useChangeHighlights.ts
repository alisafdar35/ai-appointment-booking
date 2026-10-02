import type { AppointmentDto } from '@appt/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

const HIGHLIGHT_MS = 4000;

/** Everything a card displays, so a change to any of it counts as an update. */
const signature = (a: AppointmentDto) => [a.status, a.startsAt, a.endsAt, a.notes, a.cancellationReason].join('|');

/**
 * Tracks which cards just arrived or changed, so the list can flash them.
 *
 * Changes are found by diffing consecutive snapshots of the visible list,
 * which means the dashboard needs no knowledge of where an update came from:
 * a booking made in this tab, a chat booking, or a socket event from another
 * device all land in the same cache and look the same here. The first snapshot
 * for a scope (and a switch of scope, e.g. changing tab) is a baseline, not a
 * change, so opening the page never lights everything up.
 */
export function useChangeHighlights(items: readonly AppointmentDto[] | undefined, scope: string) {
  const [highlightedIds, setHighlightedIds] = useState<ReadonlySet<string>>(() => new Set());
  const baseline = useRef<{ scope: string; signatures: Map<string, string> } | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const highlight = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    setHighlightedIds((current) => new Set([...current, ...ids]));
    for (const id of ids) {
      clearTimeout(timers.current.get(id));
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          setHighlightedIds((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }, HIGHLIGHT_MS),
      );
    }
  }, []);

  useEffect(() => {
    if (!items) return;
    const signatures = new Map(items.map((item) => [item.id, signature(item)]));
    const previous = baseline.current;
    baseline.current = { scope, signatures };
    if (!previous || previous.scope !== scope) return;
    highlight(items.filter((item) => previous.signatures.get(item.id) !== signatures.get(item.id)).map((i) => i.id));
  }, [items, scope, highlight]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  return { highlightedIds, highlight };
}
