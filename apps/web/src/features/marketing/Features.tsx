import { Building2, MessagesSquare, Radio, type LucideIcon } from 'lucide-react';

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: MessagesSquare,
    title: 'Conversational booking that never blocks you',
    text: 'Ask for what you need and the assistant offers real open times. If the AI is slow or unavailable, the same conversation continues as a guided form, so nobody is stuck.',
  },
  {
    icon: Radio,
    title: 'Live updates, graceful without them',
    text: 'New and changed bookings appear on every open screen as they happen. If the live connection drops, everything keeps working and the page tells you it is offline.',
  },
  {
    icon: Building2,
    title: 'Multi-tenant by design',
    text: 'Every business has its own services, opening hours and timezone, and its data stays separate. Times are always shown in the business’s timezone, wherever you are.',
  },
];

export function Features() {
  return (
    <section id="features" aria-labelledby="features-title" className="border-t border-border bg-surface">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <div className="max-w-2xl">
          <h2 id="features-title" className="text-3xl font-semibold tracking-tight">
            Fewer steps between &ldquo;I need an appointment&rdquo; and a confirmed slot.
          </h2>
        </div>
        <ul className="mt-12 grid gap-6 md:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <li key={title} className="rounded-xl border border-border bg-background p-6">
              <span className="grid size-11 place-items-center rounded-lg bg-accent-subtle text-accent-text">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <h3 className="mt-5 text-lg font-semibold leading-snug tracking-tight">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
