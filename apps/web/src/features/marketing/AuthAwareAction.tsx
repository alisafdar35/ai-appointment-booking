'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { buttonStyles, type ButtonSize } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { ROUTES } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { useAuth } from '@/providers/AuthProvider';

interface AuthAwareActionProps {
  size?: ButtonSize;
  /** Wording for a signed-out visitor; a signed-in one always sees "Open Slotly". */
  guestLabel?: string;
  className?: string;
}

/**
 * The page's primary call to action. It adapts to the session so a returning
 * user is never invited to "get started" again. While the session is being
 * restored it reserves the button's footprint, so the layout does not shift
 * when the real label arrives.
 */
export function AuthAwareAction({ size = 'md', guestLabel = 'Get started', className }: AuthAwareActionProps) {
  const { status } = useAuth();

  if (status === 'loading') {
    return <Skeleton aria-hidden="true" className={cn(size === 'lg' ? 'h-12 w-44' : 'h-11 w-32', 'rounded-lg', className)} />;
  }

  const signedIn = status === 'authenticated';
  return (
    <Link
      href={signedIn ? ROUTES.assistant : ROUTES.signup}
      className={buttonStyles({ size, className })}
    >
      {signedIn ? 'Open Slotly' : guestLabel}
      <ArrowRight className="size-4" aria-hidden="true" />
    </Link>
  );
}
