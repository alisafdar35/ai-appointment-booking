'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { authPageHref, NEXT_PARAM, type AuthRoute } from './redirect';

interface AuthSwitchLinkProps {
  to: AuthRoute;
  prompt: string;
  label: string;
}

/** "New here? Create an account": hops between the auth pages without losing `?next=`. */
export function AuthSwitchLink({ to, prompt, label }: AuthSwitchLinkProps) {
  const next = useSearchParams().get(NEXT_PARAM);
  return (
    <>
      {prompt}{' '}
      <Link
        href={authPageHref(to, next)}
        className="inline-flex min-h-11 items-center rounded font-medium text-accent-text underline-offset-4 hover:underline"
      >
        {label}
      </Link>
    </>
  );
}
