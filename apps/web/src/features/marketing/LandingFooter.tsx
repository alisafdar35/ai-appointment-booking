import Link from 'next/link';
import { Logo } from '@/components/ui/Logo';
import { ROUTES } from '@/lib/routes';

export function LandingFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="space-y-2">
          <Logo />
          <p className="text-sm text-muted-foreground">
            A demonstration of conversational appointment booking. Not a production service.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-2 gap-y-1">
          {[
            { href: ROUTES.login, label: 'Sign in' },
            { href: ROUTES.signup, label: 'Create an account' },
          ].map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
