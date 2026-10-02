import { CalendarCheck, MessagesSquare, ShieldCheck, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, CardBody } from '@/components/ui/Card';
import { Logo } from '@/components/ui/Logo';
import { ROUTES } from '@/lib/routes';

const HIGHLIGHTS: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: MessagesSquare,
    title: 'Ask in plain language',
    text: 'Describe what you need and the assistant finds a time that is genuinely free.',
  },
  {
    icon: CalendarCheck,
    title: 'Never blocked',
    text: 'If the assistant is unavailable, a guided form books the same appointment.',
  },
  {
    icon: ShieldCheck,
    title: 'Your business, your data',
    text: 'Each business is isolated: you only ever see your own services and bookings.',
  },
];

interface AuthCardProps {
  title: string;
  description: string;
  children: ReactNode;
  /** Secondary navigation under the card, e.g. "New here? Create an account". */
  footer: ReactNode;
}

/**
 * Frame shared by /login and /signup: the form in a centred card, plus a
 * supporting panel on large screens. The panel is decoration for context, so
 * it is hidden below `lg` where the form needs the whole width.
 */
export function AuthCard({ title, description, children, footer }: AuthCardProps) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <main id="main" className="flex flex-col px-4 py-6 sm:px-8">
        <Link href={ROUTES.home} aria-label="Slotly home" className="inline-flex w-fit rounded-lg">
          <Logo />
        </Link>
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-10">
          <Card>
            <CardBody className="space-y-6 sm:px-8 sm:py-8">
              <header className="space-y-1.5">
                <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
                <p className="text-pretty text-sm text-muted-foreground">{description}</p>
              </header>
              {children}
            </CardBody>
          </Card>
          <p className="mt-6 text-center text-sm text-muted-foreground">{footer}</p>
        </div>
      </main>

      <aside
        aria-label="About Slotly"
        className="hidden border-l border-accent-border bg-accent-subtle lg:flex lg:flex-col lg:justify-center lg:px-16"
      >
        <div className="max-w-md space-y-8">
          <p className="text-balance text-3xl font-semibold leading-tight tracking-tight">
            {/* Kept whole: the browser would otherwise break it at a hyphen, leaving "forth." alone. */}
            Booking, without the <span className="whitespace-nowrap">back-and-forth.</span>
          </p>
          <ul className="space-y-6">
            {HIGHLIGHTS.map(({ icon: Icon, title: itemTitle, text }) => (
              <li key={itemTitle} className="flex gap-4">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface text-accent-text shadow-card">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <div>
                  <h2 className="text-sm font-semibold">{itemTitle}</h2>
                  <p className="mt-0.5 text-sm text-muted-foreground">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
