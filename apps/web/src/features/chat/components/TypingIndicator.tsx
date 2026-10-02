import { AssistantAvatar } from './AssistantAvatar';

/**
 * Shown while a request is in flight and when the server reports the assistant
 * is typing. The dots only move when motion is allowed (the global
 * reduced-motion rule flattens the animation); the status text carries the
 * meaning for everyone else.
 */
export function TypingIndicator() {
  return (
    <div role="status" className="flex items-center gap-2 animate-fade-in">
      <AssistantAvatar />
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-muted px-4 py-3.5" aria-hidden="true">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="size-1.5 rounded-full bg-muted-foreground/70 motion-safe:animate-bounce"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
      <span className="sr-only">The assistant is typing</span>
    </div>
  );
}
