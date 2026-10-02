'use client';

import { CalendarDays, MessageSquare, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Logo } from '@/components/ui/Logo';
import { ROUTES } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { useCurrentUser } from '@/providers/AuthProvider';
import { RealtimeStatusPill } from './RealtimeStatusPill';
import { UserMenu } from './UserMenu';

const NAV_ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: ROUTES.assistant, label: 'Assistant', icon: MessageSquare },
  { href: ROUTES.appointments, label: 'Appointments', icon: CalendarDays },
];

function MainNav({ className, linkClassName }: { className?: string; linkClassName?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className={className}>
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors',
              active
                ? 'bg-accent-subtle text-accent-text'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              linkClassName,
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The authenticated frame: sticky header (brand, business, primary nav, live
 * status, account menu) around the page content.
 *
 * The header's height is published as --app-header-height so a full-height page
 * (the assistant workspace) can size itself with
 * `h-[calc(100dvh-var(--app-header-height))]` instead of guessing a number.
 * On narrow screens the nav drops to its own row beneath the brand row.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { businessName } = useCurrentUser();

  return (
    <div className="flex min-h-dvh flex-col [--app-header-height:7.125rem] md:[--app-header-height:4.0625rem]">
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link href={ROUTES.assistant} aria-label="Slotly home" className="shrink-0 rounded-lg">
            <Logo />
          </Link>
          <span className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
          <p className="hidden min-w-0 truncate text-sm text-muted-foreground sm:block">{businessName}</p>
          <MainNav className="ml-4 hidden items-center gap-1 md:flex" />
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <RealtimeStatusPill />
            <UserMenu />
          </div>
        </div>
        <MainNav
          className="grid grid-cols-2 gap-1 border-t border-border px-4 py-1 md:hidden"
          linkClassName="justify-center"
        />
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
    </div>
  );
}
