import { z } from 'zod';
import {
  bookingSlotsSchema,
  type AppointmentDto,
  type BookingSlots,
  type BookingSuggestion,
  type RequiredSlot,
} from './booking.js';

// These mirror the database enums. 'system', 'tool' and 'abandoned' are
// reserved there (for injected context, raw tool results and an idle-session
// sweep) and are not written by the API today.
export const CHAT_MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool'] as const;
export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];

export const CHAT_SESSION_STATUSES = ['active', 'completed', 'abandoned'] as const;
export type ChatSessionStatus = (typeof CHAT_SESSION_STATUSES)[number];

/**
 * Which engine produced an assistant turn. Surfaced in the UI for transparency.
 *
 *   mistral   — the language model
 *   fallback  — the deterministic extractor, standing in for the model
 *   system    — no language understanding involved at all (the booking form)
 */
export type AiEngine = 'mistral' | 'fallback' | 'system';

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1, 'Type a message').max(2000, 'Message is too long'),
  /** Omitted on the first message; the server creates the session. */
  sessionId: z.string().uuid().optional(),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/** Used when the user completes the structured fallback card instead of typing. */
export const submitDraftSchema = z.object({
  sessionId: z.string().uuid(),
  slots: bookingSlotsSchema.partial(),
});

export interface ChatMessageDto {
  id: string;
  role: ChatMessageRole;
  content: string;
  engine: AiEngine | null;
  /**
   * What the UI should offer alongside this assistant message, as decided when
   * it was sent — so a reloaded transcript can restore the confirmation card or
   * the suggested times. Null for user messages and for messages stored before
   * this was recorded.
   */
  action: AssistantAction | null;
  suggestions?: BookingSuggestion[];
  createdAt: string;
}

export interface ChatSessionDto {
  id: string;
  title: string;
  status: ChatSessionStatus;
  bookingDraft: BookingSlots;
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

/**
 * ---------------------------------------------------------------------------
 * What the assistant returns for one turn.
 *
 * `action` is the important field: it is the explicit handoff between the AI
 * layer and the UI. The model never decides what the UI does — it produces
 * slots, the booking service decides the action, and the client renders it.
 *
 *   collect_info   — keep talking, slots still incomplete
 *   confirm        — all slots present, show a confirmation card before writing
 *   booked         — an appointment row exists; `appointment` is populated
 *   needs_form     — conversation is not converging, fall back to the form
 *   error          — something failed; `message` is user-safe
 * ---------------------------------------------------------------------------
 */
export const ASSISTANT_ACTIONS = ['collect_info', 'confirm', 'booked', 'needs_form', 'error'] as const;
export type AssistantAction = (typeof ASSISTANT_ACTIONS)[number];

export interface AssistantTurnDto {
  sessionId: string;
  /** The user's message as stored, so a client can reconcile its optimistic copy by id. */
  userMessage: ChatMessageDto;
  message: ChatMessageDto;
  action: AssistantAction;
  /** Server-authoritative draft after this turn. The client mirrors, never owns, this. */
  bookingDraft: BookingSlots;
  missing: RequiredSlot[];
  /** Populated when action === 'booked'. */
  appointment?: AppointmentDto;
  /** Suggested times when the requested slot was taken. */
  suggestions?: BookingSuggestion[];
  engine: AiEngine;
}

/** Payload of SOCKET_EVENTS.ASSISTANT_TYPING. */
export interface AssistantTypingPayload {
  sessionId: string;
  typing: boolean;
}

/**
 * Socket.IO event names, shared so client and server cannot disagree on strings.
 *
 * All server -> client. There is nothing for a client to send: every socket
 * joins its user's room at the handshake, so there is no session to "join".
 */
export const SOCKET_EVENTS = {
  ASSISTANT_TYPING: 'assistant:typing',
  ASSISTANT_TURN: 'assistant:turn',
  APPOINTMENT_CREATED: 'appointment:created',
  APPOINTMENT_UPDATED: 'appointment:updated',
} as const;
