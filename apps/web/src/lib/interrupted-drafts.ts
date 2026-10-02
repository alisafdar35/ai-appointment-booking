/**
 * Work a user was in the middle of when their session ended, kept so that
 * signing in again picks up where they were instead of starting over.
 *
 * - sessionStorage, not localStorage: it lives only as long as this tab, which
 *   is exactly the journey "session expired -> sign in -> back to the page".
 * - Owned by one user id: a different person signing in on this tab never sees
 *   it.
 * - Short-lived (see MAX_AGE_MS) and discarded once restored, so a stale draft
 *   cannot pop up an hour later.
 * - Holds form values only (never a credential), and every draft is removed
 *   on an explicit sign-out (clearInterruptedDrafts).
 */
const PREFIX = 'slotly.interrupted.';
const MAX_AGE_MS = 30 * 60 * 1000;

interface Stored<T> {
  userId: string;
  savedAt: number;
  values: T;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Blocked storage (strict privacy settings): the feature quietly does nothing.
    return null;
  }
}

export function saveInterruptedDraft<T>(name: string, userId: string, values: T): void {
  try {
    storage()?.setItem(PREFIX + name, JSON.stringify({ userId, savedAt: Date.now(), values } satisfies Stored<T>));
  } catch {
    // Quota or serialisation failure: losing the convenience is acceptable.
  }
}

/**
 * The draft, if it belongs to this user and is recent. Reading does not remove
 * it (render-time initialisers may run twice); call discardInterruptedDraft
 * once it has been put back on screen.
 */
export function readInterruptedDraft<T>(name: string, userId: string, now = Date.now()): T | null {
  try {
    const raw = storage()?.getItem(PREFIX + name);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<Stored<T>>;
    if (stored.userId !== userId || typeof stored.savedAt !== 'number' || now - stored.savedAt > MAX_AGE_MS) return null;
    return stored.values ?? null;
  } catch {
    return null;
  }
}

export function discardInterruptedDraft(name: string): void {
  try {
    storage()?.removeItem(PREFIX + name);
  } catch {
    // Nothing to remove if storage is unavailable.
  }
}

/** Forget every interrupted draft on this tab: the user chose to sign out. */
export function clearInterruptedDrafts(): void {
  const store = storage();
  if (!store) return;
  try {
    for (let index = store.length - 1; index >= 0; index--) {
      const key = store.key(index);
      if (key?.startsWith(PREFIX)) store.removeItem(key);
    }
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}
