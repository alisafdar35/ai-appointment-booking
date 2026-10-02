import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SEED } from '../helpers/fixtures.js';
import { buildSystemPrompt } from '../../src/modules/ai/prompts.js';
import { ASSISTANT_TOOL_NAME, buildAssistantTool, parseAssistantArgs } from '../../src/modules/ai/tools.js';

/**
 * The model's output is untrusted input. parseAssistantArgs is the gate every
 * tool call passes through, so these cases are the guardrail's specification:
 * what is accepted, what is normalised, and what is refused outright.
 */
describe('parseAssistantArgs', () => {
  const valid = { reply: 'What time suits you?', intent: 'collecting', serviceName: 'Routine Checkup' };

  it('accepts the JSON string Mistral sends', () => {
    const result = parseAssistantArgs(JSON.stringify({ ...valid, date: '2031-04-22', time: '14:00' }));
    assert.ok(result.ok);
    assert.deepEqual(result.args, { ...valid, date: '2031-04-22', time: '14:00' });
  });

  it('accepts an already-parsed object', () => {
    assert.ok(parseAssistantArgs(valid).ok);
  });

  it('normalises the placeholders models emit for "unknown" into null', () => {
    const result = parseAssistantArgs({ ...valid, date: 'null', time: '', notes: 'undefined' });
    assert.ok(result.ok);
    assert.equal(result.args.date, null);
    assert.equal(result.args.time, null);
    assert.equal(result.args.notes, null);
  });

  it('strips fields the contract does not define', () => {
    const result = parseAssistantArgs({ ...valid, role: 'admin', businessId: 'someone-else' });
    assert.ok(result.ok);
    assert.equal('role' in result.args, false);
    assert.equal('businessId' in result.args, false);
  });

  it('leaves the service name lenient, for the service layer to resolve', () => {
    const result = parseAssistantArgs({ ...valid, serviceName: 'whitening' });
    assert.ok(result.ok);
    assert.equal(result.args.serviceName, 'whitening');
  });

  const rejected: [string, unknown][] = [
    ['invalid JSON', '{"reply": "hi", intent'],
    ['a JSON array', '[1, 2]'],
    ['a bare string', '"hello"'],
    ['null', null],
    ['a number', 42],
    ['a missing reply', { intent: 'collecting' }],
    ['a missing intent', { reply: 'hi' }],
    ['an unknown intent', { reply: 'hi', intent: 'book_everything' }],
    ['a reply longer than 600 characters', { ...valid, reply: 'x'.repeat(601) }],
    ['a time in 12-hour form', { ...valid, time: '2pm' }],
    ['an out-of-range time', { ...valid, time: '25:00' }],
    ['a time with invalid minutes', { ...valid, time: '14:60' }],
    ['a natural-language date', { ...valid, date: 'next friday' }],
    ['a non-ISO date', { ...valid, date: '22/04/2031' }],
    ['a date that does not exist', { ...valid, date: '2026-02-31' }],
    ['a month that does not exist', { ...valid, date: '2026-13-01' }],
    ['a notes field over 500 characters', { ...valid, notes: 'x'.repeat(501) }],
  ];

  for (const [label, input] of rejected) {
    it(`rejects ${label}`, () => {
      const result = parseAssistantArgs(input);
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.issue.length > 0, 'the rejection must say why, for the log');
    });
  }
});

describe('buildAssistantTool', () => {
  const names = ['Routine Checkup', 'Teeth Whitening'];
  const tool = buildAssistantTool(names);
  const parameters = tool.function.parameters as {
    properties: Record<string, { enum?: string[]; description?: string }>;
    required?: string[];
  };

  it('declares the single function the provider forces the model to call', () => {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.name, ASSISTANT_TOOL_NAME);
  });

  it('constrains serviceName to the live catalogue', () => {
    assert.deepEqual(parameters.properties.serviceName?.enum, names);
    assert.match(parameters.properties.serviceName?.description ?? '', /Routine Checkup, Teeth Whitening/);
  });

  it('leaves serviceName unconstrained when the catalogue is empty', () => {
    const empty = buildAssistantTool([]).function.parameters as typeof parameters;
    assert.equal(empty.properties.serviceName?.enum, undefined);
  });

  it('requires a reply and an intent on every call, and nothing else', () => {
    assert.deepEqual([...(parameters.required ?? [])].sort(), ['intent', 'reply']);
  });

  it('describes the date and time formats the parser will accept', () => {
    assert.match(parameters.properties.date?.description ?? '', /YYYY-MM-DD/);
    assert.match(parameters.properties.time?.description ?? '', /HH:MM/);
  });
});

describe('buildSystemPrompt', () => {
  const prompt = buildSystemPrompt({
    businessName: 'Bluewave Dental',
    timezone: SEED.bluewave.timezone,
    opensAt: '09:00',
    closesAt: '17:00',
    today: '2031-04-22',
    nowTime: '14:05',
    services: [
      { id: '1', name: 'Routine Checkup', description: 'Standard examination.', durationMinutes: 30, priceCents: 8000 },
      { id: '2', name: 'Free Chat', description: null, durationMinutes: 15, priceCents: 0 },
    ],
    draft: { serviceName: 'Routine Checkup', date: null, time: '10:00', notes: null },
    customerName: 'Marcus',
  });

  it('grounds the model in today, the clock and the opening hours', () => {
    assert.match(prompt, /Tuesday, April 22, 2031 \(2031-04-22\)/);
    assert.match(prompt, /2:05 PM/);
    assert.match(prompt, /America\/New_York/);
    assert.match(prompt, /9:00 AM to 5:00 PM/);
  });

  it('lists the catalogue with durations and prices, omitting a zero price', () => {
    assert.match(prompt, /Routine Checkup \(30 min, \$80\.00\) — Standard examination\./);
    assert.match(prompt, /Free Chat \(15 min\)(?! —)/);
    assert.doesNotMatch(prompt, /\$0\.00/);
  });

  it('restates the draft so the model does not re-ask for known details', () => {
    assert.match(prompt, /Service: Routine Checkup/);
    assert.match(prompt, /Time: 10:00 AM \(10:00\)/);
    assert.doesNotMatch(prompt, /Date:/);
  });

  it('forbids the model from claiming a booking exists', () => {
    assert.match(prompt, /Do not claim an appointment is booked/);
  });

  it('says so when nothing has been gathered yet', () => {
    const fresh = buildSystemPrompt({
      businessName: 'B',
      timezone: 'UTC',
      opensAt: '09:00',
      closesAt: '17:00',
      today: '2031-04-22',
      nowTime: '09:00',
      services: [],
      draft: { serviceName: null, date: null, time: null, notes: null },
      customerName: 'x',
    });
    assert.match(fresh, /nothing yet/);
    assert.match(fresh, /no services configured/);
  });
});
