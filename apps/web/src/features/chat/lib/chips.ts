import type { BookingSlots, RequiredSlot, ServiceDto } from '@appt/shared';
import { addDays, formatDate, to12Hour } from '@/lib/datetime';
import type { TurnMeta } from './reducer';

export interface QuickReply {
  id: string;
  /** What the chip says. */
  label: string;
  /** What is sent when it is clicked: plain language the assistant engines already understand. */
  message: string;
}

const MAX_CHIPS = 4;

interface QuickReplyContext {
  meta: Pick<TurnMeta, 'action' | 'missing' | 'suggestions' | 'clarification'>;
  draft: BookingSlots;
  services: readonly ServiceDto[];
  /** "YYYY-MM-DD" today in the business timezone; every relative day is computed from it. */
  today: string;
  timeZone: string;
}

/**
 * Chips that answer the assistant's last question, derived from the structured
 * turn rather than from its wording: the engine says what is missing, so the
 * client knows what to offer without reading prose.
 *
 * Each chip's `message` is ordinary language, not a command. Whichever engine
 * answers (the model or the deterministic fallback) already parses it, so chips
 * add no second protocol to keep in sync with the backend.
 */
export function deriveQuickReplies({ meta, draft, services, today, timeZone }: QuickReplyContext): QuickReply[] {
  if (meta.action !== 'collect_info') return [];

  // A clarifying question is answered with its own readings, nothing else.
  if (meta.clarification) {
    const { field, options } = meta.clarification;
    return options.map((value) =>
      field === 'date'
        ? { id: `date-${value}`, label: formatDate(value, timeZone, 'short'), message: formatDate(value, timeZone, 'medium') }
        : { id: `time-${value}`, label: to12Hour(value), message: to12Hour(value) },
    );
  }

  // Real free times from the server: alternatives to a refused slot, or the
  // first open times on the chosen day. Times are never invented here.
  if (meta.suggestions?.length) {
    return meta.suggestions.slice(0, MAX_CHIPS).map(({ date, time }) => ({
      id: `slot-${date}-${time}`,
      label: date === draft.date ? to12Hour(time) : `${formatDate(date, timeZone, 'short')} · ${to12Hour(time)}`,
      message: `${formatDate(date, timeZone, 'medium')} at ${to12Hour(time)}`,
    }));
  }

  const missing: readonly RequiredSlot[] = meta.missing;

  if (missing.includes('serviceName')) {
    return services.slice(0, MAX_CHIPS).map((service) => ({
      id: `service-${service.id}`,
      label: service.name,
      message: service.name,
    }));
  }

  if (missing.includes('date') && missing.includes('time')) {
    return [
      { id: 'tomorrow-morning', label: 'Tomorrow morning', message: 'tomorrow morning' },
      { id: 'tomorrow-afternoon', label: 'Tomorrow afternoon', message: 'tomorrow afternoon' },
    ];
  }

  if (missing.includes('date')) {
    return [1, 2, 3].map((offset) => {
      const date = addDays(today, offset);
      return {
        id: `date-${date}`,
        label: offset === 1 ? 'Tomorrow' : formatDate(date, timeZone, 'short'),
        message: offset === 1 ? 'tomorrow' : formatDate(date, timeZone, 'medium'),
      };
    });
  }

  return [];
}

const GENERIC_STARTERS = [
  'Book a routine checkup tomorrow at 2pm',
  'I need an appointment next Wednesday afternoon',
  'What services do you offer?',
  "What's the earliest opening on Friday?",
];

/**
 * Conversation starters for an empty chat. Built from the business's own
 * catalogue so every suggestion names something it actually sells; the generic
 * set covers the moments before (or without) the catalogue.
 */
export function buildStarterPrompts(services: readonly ServiceDto[]): string[] {
  const [first, second, third] = services.map((service) => service.name);
  if (!first) return GENERIC_STARTERS;

  return [
    `Book ${first} tomorrow at 2pm`,
    second ? `${second} next Wednesday afternoon, please` : GENERIC_STARTERS[1]!,
    'What services do you offer?',
    third ? `What's the earliest opening for ${third} on Friday?` : GENERIC_STARTERS[3]!,
  ];
}
