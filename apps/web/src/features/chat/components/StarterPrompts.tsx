import { MessageSquareText } from 'lucide-react';
import { useMemo } from 'react';
import { useServices } from '@/lib/queries';
import { buildStarterPrompts } from '../lib/chips';

interface StarterPromptsProps {
  onPick: (prompt: string) => void;
  disabled: boolean;
}

/** The empty conversation: what this is, what it will and will not do, and four ways to begin. */
export function StarterPrompts({ onPick, disabled }: StarterPromptsProps) {
  const services = useServices();
  const prompts = useMemo(() => buildStarterPrompts(services.data ?? []), [services.data]);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-xl flex-col animate-fade-in">
      {/* my-auto, not justify-center: centring clips the top of content taller than the pane, where it cannot be scrolled to. */}
      <div className="my-auto space-y-5 py-6 text-center">
        <div className="space-y-2">
          <span className="mx-auto hidden size-12 items-center justify-center rounded-2xl bg-accent-subtle text-accent-text min-[480px]:inline-flex">
            <MessageSquareText className="size-6" aria-hidden="true" />
          </span>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">How can I help you book?</h2>
          <p className="mx-auto max-w-md text-sm text-muted-foreground">
            Tell me what you need in your own words. I&rsquo;ll find a time, and nothing is booked until you confirm.
          </p>
        </div>

        <ul aria-label="Conversation starters" className="grid w-full gap-2 sm:grid-cols-2">
          {prompts.map((prompt, index) => (
            <li key={prompt} className={index === 3 ? 'max-sm:hidden' : undefined}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(prompt)}
                className="min-h-12 w-full rounded-xl border border-border bg-surface px-4 py-2.5 text-left text-sm font-medium text-foreground shadow-card transition-colors hover:border-accent-border hover:bg-accent-subtle disabled:pointer-events-none disabled:opacity-50"
              >
                {prompt}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
