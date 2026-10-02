import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { titleFromMessage } from '../../src/modules/chat/title.js';

describe('titleFromMessage', () => {
  it('keeps a message that fits as it is, with its spacing tidied', () => {
    assert.equal(titleFromMessage('  Teeth whitening\n next   Monday '), 'Teeth whitening next Monday');
  });

  it('cuts a long message at a word boundary and marks the cut', () => {
    const title = titleFromMessage('Could I book a routine checkup for my son on Wednesday, October 7 at 11?');
    assert.equal(title, 'Could I book a routine checkup for my son on Wednesday…');
    assert.ok(title.length <= 60);
  });

  it('keeps the last whole word when the limit falls just after it', () => {
    const message = `${'a'.repeat(59)} tail`;
    assert.equal(titleFromMessage(message), `${'a'.repeat(59)}…`);
  });

  it('cuts a single overlong word where it must', () => {
    const title = titleFromMessage('x'.repeat(80));
    assert.equal(title, `${'x'.repeat(59)}…`);
  });
});

describe('titleFromMessage: greetings', () => {
  it('drops a leading greeting and capitalises what follows', () => {
    assert.equal(titleFromMessage('hi, i want to get my teeth whitened'), 'I want to get my teeth whitened');
    assert.equal(titleFromMessage('Hello there! Routine checkup on Friday'), 'Routine checkup on Friday');
    assert.equal(titleFromMessage('hey hey - whitening tomorrow?'), 'Whitening tomorrow?');
    assert.equal(titleFromMessage('Good morning, can I come in at 3?'), 'Can I come in at 3?');
  });

  it('keeps a message that is only a greeting, and words that merely start like one', () => {
    assert.equal(titleFromMessage('Hello!'), 'Hello!');
    assert.equal(titleFromMessage('Hilda needs a checkup'), 'Hilda needs a checkup');
    assert.equal(titleFromMessage('Heyward St. location?'), 'Heyward St. location?');
  });
});
