'use client';

import { useSyncExternalStore } from 'react';

/**
 * Subscribe to a CSS media query. Used where the layout changes what is
 * *rendered* (one sidebar instance, either inline or in a dialog) rather than
 * just how it looks, so there is never a hidden duplicate in the accessibility
 * tree. The server snapshot is `false`: this page only renders after the
 * client-side session check, so there is no server markup to mismatch.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
