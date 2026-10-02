import { cn, initials } from '@/lib/utils';

const SIZES = {
  sm: 'size-7 text-xs',
  md: 'size-9 text-sm',
  lg: 'size-12 text-base',
} as const;

interface AvatarProps {
  name: string;
  size?: keyof typeof SIZES;
  className?: string;
}

/** Initials in a tinted circle. Decorative: the name is always rendered as text nearby. */
export function Avatar({ name, size = 'md', className }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded-full bg-accent-subtle font-semibold text-accent-text',
        SIZES[size],
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
