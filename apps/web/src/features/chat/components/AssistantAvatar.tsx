import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

/** The assistant's mark. Decorative: every message is already attributed in text and by layout. */
export function AssistantAvatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground',
        className,
      )}
    >
      <Sparkles className="size-4" />
    </span>
  );
}
