import Link from 'next/link';
import { buttonStyles } from '@/components/ui/Button';
import { DEMO_ACCOUNT } from '@/features/auth/demo-account';
import { ROUTES } from '@/lib/routes';

/**
 * Points visitors at the seeded demo account. The button goes to /login, where
 * "Use demo account" fills the form: credentials are shown here only so they
 * can be read, never auto-submitted.
 */
export function DemoCallout() {
  return (
    <section id="demo" aria-labelledby="demo-title" className="border-t border-border">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <div className="grid items-center gap-8 rounded-2xl border border-accent-border bg-accent-subtle p-6 sm:p-10 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="max-w-xl">
            <h2 id="demo-title" className="text-2xl font-semibold tracking-tight">
              Try it with a demo account
            </h2>
            <p className="mt-2 text-muted-foreground">
              Sign in as a customer of {DEMO_ACCOUNT.businessName} and book a real slot against seeded availability.
              On the sign-in page, &ldquo;Use demo account&rdquo; fills these in for you.
            </p>
            <dl className="mt-5 grid max-w-md grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Email</dt>
              <dd>
                <code className="rounded-md border border-border bg-surface px-2 py-1 font-mono text-[0.8125rem]">
                  {DEMO_ACCOUNT.email}
                </code>
              </dd>
              <dt className="text-muted-foreground">Password</dt>
              <dd>
                <code className="rounded-md border border-border bg-surface px-2 py-1 font-mono text-[0.8125rem]">
                  {DEMO_ACCOUNT.password}
                </code>
              </dd>
            </dl>
          </div>
          <Link href={ROUTES.login} className={buttonStyles({ size: 'lg' })}>
            Go to sign in
          </Link>
        </div>
      </div>
    </section>
  );
}
