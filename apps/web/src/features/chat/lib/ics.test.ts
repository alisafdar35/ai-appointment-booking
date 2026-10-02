import { describe, expect, it } from 'vitest';
import { appointment } from '../test/factories';
import { buildIcs, escapeIcsText, foldIcsLine, icsFileName, toIcsUtc } from './ics';

const NOW = new Date('2026-10-02T13:30:00.000Z');
const build = (overrides = {}, businessName = 'Bluewave Dental') =>
  buildIcs(appointment(overrides), { businessName, now: NOW });
const lines = (ics: string) => ics.split('\r\n');

describe('toIcsUtc', () => {
  it('writes an ISO instant as a basic-format UTC timestamp', () => {
    expect(toIcsUtc('2026-10-05T18:00:00.000Z')).toBe('20261005T180000Z');
  });

  it('normalises an offset to UTC', () => {
    expect(toIcsUtc('2026-10-05T14:00:00-04:00')).toBe('20261005T180000Z');
  });
});

describe('buildIcs', () => {
  it('is a CRLF-delimited calendar with one event', () => {
    const ics = build();
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(ics.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    expect(lines(ics).filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(1);
  });

  it('uses UTC start and end, a stable UID, and the supplied DTSTAMP', () => {
    const ics = lines(build());
    expect(ics).toContain('DTSTART:20261005T180000Z');
    expect(ics).toContain('DTEND:20261005T183000Z');
    expect(ics).toContain('UID:a1b2c3d4-0000-0000-0000-000000000001@slotly');
    expect(ics).toContain('DTSTAMP:20261002T133000Z');
  });

  it('names the service and the business, and sets the business as the location', () => {
    const ics = lines(build());
    expect(ics).toContain('SUMMARY:Routine Checkup at Bluewave Dental');
    expect(ics).toContain('LOCATION:Bluewave Dental');
  });

  it('escapes structural characters in free text', () => {
    const ics = lines(build({ notes: 'Bring X-rays; ask about\nbraces, please \\ thanks' }));
    expect(ics).toContain('DESCRIPTION:Bring X-rays\\; ask about\\nbraces\\, please \\\\ thanks');
  });

  it('adds an event DESCRIPTION only when there are notes (the reminder has its own)', () => {
    expect(lines(build()).filter((line) => line.startsWith('DESCRIPTION:'))).toHaveLength(1);
    expect(lines(build({ notes: 'Bring X-rays' })).filter((line) => line.startsWith('DESCRIPTION:'))).toHaveLength(2);
  });

  it('marks a pending appointment tentative', () => {
    expect(lines(build({ status: 'pending' }))).toContain('STATUS:TENTATIVE');
    expect(lines(build({ status: 'confirmed' }))).toContain('STATUS:CONFIRMED');
  });

  it('folds no line past 75 octets', () => {
    const ics = build({ notes: 'é'.repeat(200) });
    for (const line of lines(ics)) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});

describe('escapeIcsText', () => {
  it('escapes backslash first so it does not double-escape the others', () => {
    expect(escapeIcsText('a\\b;c,d')).toBe('a\\\\b\\;c\\,d');
  });

  it('escapes a semicolon so it is not read as a value separator', () => {
    expect(escapeIcsText('x;y')).toBe('x\\;y');
  });

  it('turns every newline style into the \\n escape', () => {
    expect(escapeIcsText('one\r\ntwo\rthree\nfour')).toBe('one\\ntwo\\nthree\\nfour');
  });
});

describe('foldIcsLine', () => {
  it('leaves a short line alone', () => {
    expect(foldIcsLine('SUMMARY:Short')).toBe('SUMMARY:Short');
  });

  it('continues folded lines with a single space and loses nothing', () => {
    const long = `DESCRIPTION:${'word '.repeat(40)}`;
    const folded = foldIcsLine(long);
    expect(folded).toContain('\r\n ');
    expect(folded.split('\r\n ').join('')).toBe(long);
  });

  it('never splits a multi-byte character', () => {
    const folded = foldIcsLine(`SUMMARY:${'日本語'.repeat(30)}`);
    expect(folded.split('\r\n ').join('')).toBe(`SUMMARY:${'日本語'.repeat(30)}`);
  });
});

describe('icsFileName', () => {
  it('slugs the service and dates the file in the business timezone', () => {
    // 11pm in New York on Oct 5 is already Oct 6 in UTC.
    const late = appointment({ startsAt: '2026-10-06T03:00:00.000Z', endsAt: '2026-10-06T03:30:00.000Z' });
    expect(icsFileName(late, 'America/New_York')).toBe('slotly-routine-checkup-2026-10-05.ics');
  });
});
