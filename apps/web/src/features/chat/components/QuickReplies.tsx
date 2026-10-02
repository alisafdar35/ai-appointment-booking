import type { QuickReply } from '../lib/chips';

interface QuickRepliesProps {
  replies: QuickReply[];
  disabled: boolean;
  onPick: (message: string) => void;
}

/** One-tap answers to the assistant's last question. Sending one is the same as typing it. */
export function QuickReplies({ replies, disabled, onPick }: QuickRepliesProps) {
  if (replies.length === 0) return null;
  return (
    <div role="group" aria-label="Suggested replies" className="flex flex-wrap gap-2 pl-10 animate-fade-in">
      {replies.map((reply) => (
        <button
          key={reply.id}
          type="button"
          disabled={disabled}
          onClick={() => onPick(reply.message)}
          className="inline-flex min-h-9 items-center rounded-full border border-accent-border bg-surface px-3.5 text-sm font-medium text-accent-text transition-colors hover:bg-accent-subtle disabled:pointer-events-none disabled:opacity-50 coarse:min-h-11"
        >
          {reply.label}
        </button>
      ))}
    </div>
  );
}
