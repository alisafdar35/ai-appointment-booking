import type { AppointmentDto } from '@appt/shared';
import { dateInZone } from '@/lib/datetime';

/**
 * A single-event iCalendar (RFC 5545) file for a booked appointment, built on
 * the client so there is no endpoint to maintain and nothing to authenticate.
 *
 * Times are written as UTC ("...Z"). The API already stores instants in UTC, and
 * a UTC time is unambiguous in every calendar app, so no VTIMEZONE block is
 * needed and a daylight-saving change cannot move the event.
 */

const CRLF = '\r\n';
/** RFC 5545 §3.1: content lines are folded at 75 octets. */
const MAX_LINE_OCTETS = 75;
const encoder = new TextEncoder();

/** 2026-10-05T18:00:00.000Z -> 20261005T180000Z */
export function toIcsUtc(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Escape a TEXT value: backslash, semicolon, comma and newlines are structural in iCalendar. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold on code point boundaries so a multi-byte character is never split across lines. */
export function foldIcsLine(line: string): string {
  if (encoder.encode(line).length <= MAX_LINE_OCTETS) return line;

  const lines: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    // Continuation lines start with a space, which counts toward their 75 octets.
    const limit = lines.length === 0 ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1;
    if (octets + size > limit) {
      lines.push(current);
      current = '';
      octets = 0;
    }
    current += char;
    octets += size;
  }
  lines.push(current);
  return lines.join(`${CRLF} `);
}

export interface IcsOptions {
  businessName: string;
  /** Injected so the DTSTAMP is deterministic in tests. */
  now?: Date;
}

export function buildIcs(appointment: AppointmentDto, { businessName, now = new Date() }: IcsOptions): string {
  const { service } = appointment;
  const summary = `${service.name} at ${businessName}`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Slotly//Appointments//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    // The appointment id is stable, so re-importing the file updates the event instead of duplicating it.
    `UID:${appointment.id}@slotly`,
    `DTSTAMP:${toIcsUtc(now.toISOString())}`,
    `DTSTART:${toIcsUtc(appointment.startsAt)}`,
    `DTEND:${toIcsUtc(appointment.endsAt)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `LOCATION:${escapeIcsText(businessName)}`,
    ...(appointment.notes ? [`DESCRIPTION:${escapeIcsText(appointment.notes)}`] : []),
    `STATUS:${appointment.status === 'pending' ? 'TENTATIVE' : 'CONFIRMED'}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeIcsText(summary)}`,
    'TRIGGER:-PT1H',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];

  return `${lines.map(foldIcsLine).join(CRLF)}${CRLF}`;
}

/** "slotly-routine-checkup-2026-10-05.ics", dated in the business timezone. */
export function icsFileName(appointment: AppointmentDto, timeZone: string): string {
  const slug = appointment.service.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `slotly-${slug || 'appointment'}-${dateInZone(appointment.startsAt, timeZone)}.ics`;
}
