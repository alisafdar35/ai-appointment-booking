import { ListChecks, Sparkles } from 'lucide-react';
import type { AiEngine } from '@appt/shared';
import { Badge } from '@/components/ui/Badge';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * The engines that read what the user wrote. The third, "system", answers the
 * booking form: no language understanding is involved, so there is nothing to
 * be transparent about and no badge is shown.
 */
type LanguageEngine = Exclude<AiEngine, 'system'>;

export const isLanguageEngine = (engine: AiEngine): engine is LanguageEngine => engine !== 'system';

const COPY: Record<LanguageEngine, { label: string; explanation: string }> = {
  mistral: {
    label: 'AI',
    explanation: 'Written by the AI assistant, which reads free-form requests. Bookings are still checked against real availability.',
  },
  fallback: {
    label: 'Guided mode',
    explanation: 'Answered by built-in rules instead of the AI. It understands dates, times and services, and can still book.',
  },
};

/**
 * Says which engine wrote a reply, so a downgrade is visible rather than hidden.
 * Focusable on purpose: the explanation is a tooltip, and a keyboard user needs
 * to reach it as much as a mouse user.
 */
export function EngineBadge({ engine }: { engine: LanguageEngine }) {
  const { label, explanation } = COPY[engine];
  const Icon = engine === 'mistral' ? Sparkles : ListChecks;
  return (
    // The badge sits near the left edge of the conversation, so the bubble starts at the badge
    // rather than centring on it, which would push it past the pane's border.
    <Tooltip align="start" className="w-56 whitespace-normal py-1.5 leading-snug" content={explanation}>
      <Badge
        tone={engine === 'mistral' ? 'accent' : 'neutral'}
        tabIndex={0}
        className="cursor-help px-2 py-0 text-[11px] leading-5"
      >
        <Icon className="size-3" aria-hidden="true" />
        {label}
        <span className="sr-only"> engine</span>
      </Badge>
    </Tooltip>
  );
}
