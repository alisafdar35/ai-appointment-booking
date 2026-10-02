'use client';

import Link from 'next/link';
import { buttonStyles } from '@/components/ui/Button';
import { Logo } from '@/components/ui/Logo';
import { ROUTES } from '@/lib/routes';
import { useAuth } from '@/providers/AuthProvider';
import { AuthAwareAction } from './AuthAwareAction';

const NAV_LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#demo', label: 'Demo' },
];

/** Sticky top bar. "Sign in" is shown only to signed-out visitors; the action beside it adapts to the session. */
export function LandingHeader() {
  const { status } = useAuth();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href={ROUTES.home} aria-label="Slotly home" className="rounded-lg">
          <Logo />
        </Link>

        <nav aria-label="Page sections" className="ml-6 hidden items-center gap-1 md:flex">
          {NAV_LINKS.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {status === 'unauthenticated' ? (
            <Link href={ROUTES.login} className={buttonStyles({ variant: 'ghost' })}>
              Sign in
            </Link>
          ) : null}
          <AuthAwareAction />
        </div>
      </div>
    </header>
  );
}
