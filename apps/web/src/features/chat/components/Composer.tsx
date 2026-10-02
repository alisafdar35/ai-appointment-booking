'use client';

import { ArrowUp, ListChecks } from 'lucide-react';
import { useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { COUNTER_VISIBLE_FROM, MESSAGE_MAX_LENGTH } from '../lib/constants';

const MAX_HEIGHT_PX = 160;

export interface ComposerHandle {
  focus: () => void;
}

interface ComposerProps {
  /** Returns false when the message was not accepted (e.g. a reply is still pending); the text is then kept. */
  onSend: (text: string) => boolean;
  /** A reply is on its way: typing stays possible, sending waits. */
  sending: boolean;
  /**
   * False until the conversation to send into is known (on first load, the
   * page is still deciding whether to resume the latest one). Typing ahead is
   * fine; Send stays visibly off, rather than looking ready and doing nothing.
   */
  ready?: boolean;
  formOpen: boolean;
  onToggleForm: () => void;
  ref?: Ref<ComposerHandle>;
}

/**
 * The message box.
 *
 *  - Enter sends, Shift+Enter adds a line. Enter is ignored while an IME
 *    composition is active: for Japanese, Chinese or Korean input it confirms a
 *    candidate rather than meaning "send".
 *  - The textarea grows with its content up to a cap, then scrolls.
 *  - The 2,000-character limit is not enforced by truncating paste; the counter
 *    appears near the limit and Send is disabled past it, so nothing is lost.
 *  - It is never disabled while a reply is pending, so the next message can be
 *    typed ahead of the answer.
 */
export function Composer({ onSend, sending, ready = true, formOpen, onToggleForm, ref }: ComposerProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const counterId = useId();

  useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus() }), []);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const length = text.length;
  const tooLong = length > MESSAGE_MAX_LENGTH;
  const canSend = ready && text.trim().length > 0 && !tooLong && !sending;

  const submit = () => {
    if (!canSend) return;
    if (onSend(text)) setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // keyCode 229 covers browsers that report an IME keystroke without `isComposing`.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="space-y-2"
    >
      <div
        className={cn(
          'flex items-end gap-2 rounded-2xl border bg-surface p-2 shadow-card transition-colors focus-within:border-accent',
          tooLong ? 'border-danger' : 'border-input',
        )}
      >
        <label htmlFor="chat-message" className="sr-only">
          Message
        </label>
        <textarea
          id="chat-message"
          ref={textareaRef}
          value={text}
          rows={1}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Tell me what you'd like to book…"
          aria-invalid={tooLong || undefined}
          aria-describedby={length >= COUNTER_VISIBLE_FROM ? counterId : undefined}
          className="max-h-40 min-h-11 flex-1 resize-none bg-transparent px-2 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none sm:text-[15px]"
        />
        <Button
          type="submit"
          aria-label="Send"
          disabled={!canSend}
          loading={sending}
          leftIcon={<ArrowUp className="size-4" aria-hidden="true" />}
          className="shrink-0 rounded-xl px-3 sm:px-4"
        >
          <span aria-hidden="true" className="hidden sm:inline">
            Send
          </span>
        </Button>
      </div>

      <div className="flex min-h-9 items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
        <p className="hidden sm:block">
          <kbd className="font-sans font-medium">Enter</kbd> to send · <kbd className="font-sans font-medium">Shift + Enter</kbd> for a new line
        </p>
        <div className="ml-auto flex items-center gap-3">
          {length >= COUNTER_VISIBLE_FROM ? (
            <span id={counterId} role={tooLong ? 'alert' : undefined} className={cn('tabular-nums', tooLong && 'font-medium text-danger-text')}>
              {tooLong
                ? `${(length - MESSAGE_MAX_LENGTH).toLocaleString()} over the ${MESSAGE_MAX_LENGTH.toLocaleString()}-character limit`
                : `${length.toLocaleString()} / ${MESSAGE_MAX_LENGTH.toLocaleString()}`}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={formOpen}
            aria-controls="booking-form"
            onClick={onToggleForm}
            leftIcon={<ListChecks className="size-4" aria-hidden="true" />}
            className="text-muted-foreground hover:text-foreground"
          >
            Prefer a form?
          </Button>
        </div>
      </div>
    </form>
  );
}
