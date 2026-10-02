/**
 * Consent, phrase by phrase. A summary is on screen; only these replies may
 * book. The same isAffirmative decides for the model's `confirming` intent
 * (guardrails.test.ts, ai-mistral.test.ts), so this table holds for both engines.
 */
export const CONSENT_TABLE: [text: string, agrees: boolean][] = [
  ['yes', true],
  ['Yes!', true],
  ['yes please', true],
  ['Yes please 👍', true],
  ['yep', true],
  ['sure', true],
  ['ok', true],
  ['Okay.', true],
  ['confirm', true],
  ['Confirm it', true],
  ['book it', true],
  ['go ahead', true],
  ['sounds good', true],
  ['that works', true],
  ['please do', true],
  ['correct', true],
  ['yes, book it', true],
  ['sure, confirm it', true],
  ['yes please book that', true],
  ["let's do it, thanks", true],
  ['Can you confirm the price first?', false],
  ['confirm the price?', false],
  ['confirm the price first', false],
  ['yes but what does it cost?', false],
  ['ok wait', false],
  ['is that 60 minutes?', false],
  ['not yet', false],
  ['no', false],
  ['yes, but make it 3pm', false],
  ['book it?', false],
  ["don't book it", false],
  ['could you book it before noon', false],
  ['how much is it', false],
  ['please', false],
  ['thanks', false],
  ['yes, how long does it take', false],
];

