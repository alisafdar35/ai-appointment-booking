import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge our custom shadow tokens, otherwise `shadow-card` and
// `shadow-sm` are not recognised as the same property and both survive a merge.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { shadow: [{ shadow: ['card', 'popover'] }] } },
});

/** Compose class names; later Tailwind utilities win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** "Ada Lovelace" -> "AL", "Ada" -> "AD". Always upper-case, at most two letters. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return '?';
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const letters = last ? `${first[0]}${last[0]}` : first.slice(0, 2);
  return letters.toUpperCase();
}

/** 4500 -> "$45", 4550 -> "$45.50", 0 -> "Free". Whole-dollar prices drop the cents for a calmer UI. */
export function formatPrice(cents: number, currency = 'USD'): string {
  // A new business's starter services have no price set yet; "$0" read like missing data.
  if (cents === 0) return 'Free';
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/** pluralize(1, 'service') -> "1 service"; pluralize(3, 'service') -> "3 services". */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
