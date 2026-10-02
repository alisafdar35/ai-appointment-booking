const STEPS = [
  {
    title: 'Say what you need',
    text: 'Describe the service and a rough time in plain language, or choose them from the form.',
  },
  {
    title: 'Pick an open slot',
    text: 'You only see times that are actually free, shown in the business’s timezone.',
  },
  {
    title: 'Confirm and you are done',
    text: 'Review the details, confirm, and the booking shows up on your dashboard straight away.',
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="border-t border-border">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <h2 id="how-title" className="text-3xl font-semibold tracking-tight">
          How it works
        </h2>
        <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
          {STEPS.map(({ title, text }, index) => (
            <li key={title} className="relative flex gap-4 md:block">
              <span
                aria-hidden="true"
                className="grid size-10 shrink-0 place-items-center rounded-full border border-accent-border bg-accent-subtle text-sm font-semibold tabular-nums text-accent-text"
              >
                {index + 1}
              </span>
              <div className="md:mt-5">
                <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{text}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
