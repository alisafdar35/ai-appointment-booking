'use client';

import { ChevronDown, LogOut } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { useAuth, useCurrentUser } from '@/providers/AuthProvider';

const ROLE_BADGES = {
  owner: { label: 'Owner', tone: 'accent' },
  staff: { label: 'Staff', tone: 'accent' },
  customer: { label: 'Customer', tone: 'neutral' },
} as const satisfies Record<string, { label: string; tone: BadgeTone }>;

/**
 * Account menu as a disclosure (button + panel), not an ARIA "menu": it holds
 * plain content and one action, so it needs no arrow-key menu semantics — Tab
 * order is the whole interaction model.
 */
export function UserMenu() {
  const user = useCurrentUser();
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const role = ROLE_BADGES[user.role];

  const signOut = async () => {
    setSigningOut(true);
    await logout();
  };

  return (
    <div
      ref={rootRef}
      className="relative"
      // Tabbing out of the panel closes it, so it never lingers over the page.
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-11 items-center gap-2 rounded-xl px-1.5 transition-colors hover:bg-muted sm:pr-2.5"
      >
        <Avatar name={user.fullName} size="md" />
        <span className="hidden max-w-[10rem] truncate text-sm font-medium text-foreground sm:block">
          {user.fullName}
        </span>
        <span className="sr-only sm:hidden">Account menu for {user.fullName}</span>
        <ChevronDown
          className={cn('hidden size-4 text-muted-foreground transition-transform sm:block', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div
          id={panelId}
          className="absolute right-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] animate-rise-in rounded-xl border border-border bg-surface p-4 shadow-popover"
        >
          <div className="flex items-start gap-3">
            <Avatar name={user.fullName} size="lg" />
            <div className="min-w-0 space-y-1">
              <p className="truncate text-sm font-semibold text-foreground">{user.fullName}</p>
              <p className="truncate text-sm text-muted-foreground">{user.email}</p>
              <Badge tone={role.tone}>{role.label}</Badge>
            </div>
          </div>
          <p className="mt-3 truncate text-sm text-muted-foreground">{user.businessName}</p>
          <div className="mt-4 border-t border-border pt-4">
            <Button
              variant="secondary"
              fullWidth
              loading={signingOut}
              leftIcon={<LogOut className="size-4" aria-hidden="true" />}
              onClick={signOut}
            >
              Sign out
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
