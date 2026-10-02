import Link from 'next/link';
import { buttonStyles } from '@/components/ui/Button';
import { AuthAwareAction } from './AuthAwareAction';
import { ChatPreview } from './ChatPreview';

export function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden">
      {/* Wash of the accent colour fading into the page; tokens make it dark-mode safe. */}
      <div aria-hidden="true" className="absolute inset-x-0 top-0 -z-10 h-[32rem] bg-gradient-to-b from-accent-subtle to-transparent" />

      <div className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pb-20 pt-14 sm:px-6 sm:pt-20 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:gap-16 lg:pb-28">
        <div className="animate-fade-in">
          <p className="inline-flex items-center rounded-full border border-accent-border bg-surface px-3 py-1 text-xs font-medium text-accent-text">
            AI-assisted scheduling for service businesses
          </p>
          <h1 id="hero-title" className="mt-5 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
            Book appointments by conversation.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Tell Slotly what you need in your own words. It checks real availability, confirms the details with you
            and books the slot. Prefer a form? That works too, always.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <AuthAwareAction size="lg" />
            <Link href="#how-it-works" className={buttonStyles({ size: 'lg', variant: 'secondary' })}>
              See how it works
            </Link>
          </div>
        </div>

        <ChatPreview className="animate-rise-in" />
      </div>
    </section>
  );
}
