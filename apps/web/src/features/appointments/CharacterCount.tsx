import { cn } from '@/lib/utils';

/** "15/500", turning red past the limit. Not a live region: announcing every keystroke would be noise; the field's error covers overflow. */
export function CharacterCount({ length, max }: { length: number; max: number }) {
  return (
    <p className={cn('mt-1.5 text-right text-xs tabular-nums', length > max ? 'text-danger-text' : 'text-muted-foreground')}>
      {length}/{max}
    </p>
  );
}
