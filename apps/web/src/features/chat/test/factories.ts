import { EMPTY_SLOTS, type AppointmentDto, type AssistantTurnDto, type BookingSlots, type ChatMessageDto, type ChatSessionDto, type ServiceDto } from '@appt/shared';

export const SESSION_ID = '6bfa8cb0-c62b-4001-a670-ce8ae8cb26e0';

export const CHECKUP: ServiceDto = {
  id: 'cccccccc-0000-0000-0000-000000000001',
  name: 'Routine Checkup',
  description: 'Standard examination and cleaning.',
  durationMinutes: 30,
  priceCents: 8000,
};

export const WHITENING: ServiceDto = {
  id: 'cccccccc-0000-0000-0000-000000000002',
  name: 'Teeth Whitening',
  description: null,
  durationMinutes: 60,
  priceCents: 24000,
};

export const COMPLETE_DRAFT: BookingSlots = {
  serviceName: 'Routine Checkup',
  date: '2026-10-05',
  time: '14:00',
  notes: null,
};

/** A stored message. `action` defaults to null: what user messages and legacy assistant rows carry. */
export function message(overrides: Partial<ChatMessageDto> & Pick<ChatMessageDto, 'id' | 'role'>): ChatMessageDto {
  return {
    content: `${overrides.role} ${overrides.id}`,
    engine: overrides.role === 'assistant' ? 'fallback' : null,
    action: null,
    createdAt: '2026-10-02T13:00:00.000Z',
    ...overrides,
  };
}

interface TurnOverrides extends Partial<AssistantTurnDto> {
  messageId?: string;
  content?: string;
  /** Id of the stored user message the turn answers. */
  userMessageId?: string;
  userContent?: string;
}

/** A turn whose assistant message carries the same action and suggestions as the turn, as the server sends it. */
export function turn(overrides: TurnOverrides = {}): AssistantTurnDto {
  const {
    messageId = '2',
    content = 'Which day would you like to come in?',
    userMessageId = '1',
    userContent = 'Book a routine checkup',
    ...rest
  } = overrides;
  const action = rest.action ?? 'collect_info';
  return {
    sessionId: SESSION_ID,
    userMessage: message({ id: userMessageId, role: 'user', content: userContent }),
    message: message({ id: messageId, role: 'assistant', content, action, suggestions: rest.suggestions }),
    action,
    bookingDraft: { ...EMPTY_SLOTS, serviceName: 'Routine Checkup' },
    missing: ['date', 'time'],
    engine: 'fallback',
    ...rest,
  };
}

export function session(overrides: Partial<ChatSessionDto> = {}): ChatSessionDto {
  return {
    id: SESSION_ID,
    title: 'Book a routine checkup',
    status: 'active',
    bookingDraft: EMPTY_SLOTS,
    messageCount: 0,
    lastMessageAt: null,
    createdAt: '2026-10-02T13:00:00.000Z',
    ...overrides,
  };
}

export function appointment(overrides: Partial<AppointmentDto> = {}): AppointmentDto {
  return {
    id: 'a1b2c3d4-0000-0000-0000-000000000001',
    status: 'confirmed',
    source: 'chat',
    startsAt: '2026-10-05T18:00:00.000Z',
    endsAt: '2026-10-05T18:30:00.000Z',
    notes: null,
    cancellationReason: null,
    chatSessionId: SESSION_ID,
    createdAt: '2026-10-02T13:00:00.000Z',
    service: CHECKUP,
    customer: { id: 'u1', fullName: 'Marcus Reed', email: 'customer@bluewave.test' },
    ...overrides,
  };
}
