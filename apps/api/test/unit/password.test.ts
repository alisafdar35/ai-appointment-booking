import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { equalizeTiming, hashPassword, verifyPassword } from '../../src/lib/password.js';

describe('password hashing', () => {
  it('produces a bcrypt hash at cost 12 that verifies the original password only', async () => {
    const hash = await hashPassword('Correct-Horse-9');
    assert.match(hash, /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/);
    assert.equal(await verifyPassword('Correct-Horse-9', hash), true);
    assert.equal(await verifyPassword('Correct-Horse-8', hash), false);
    assert.equal(await verifyPassword('', hash), false);
  });

  it('salts every hash, so equal passwords do not produce equal hashes', async () => {
    const [a, b] = await Promise.all([hashPassword('Same-Password-1'), hashPassword('Same-Password-1')]);
    assert.notEqual(a, b);
  });
});

describe('equalizeTiming', () => {
  it('does a real bcrypt comparison, so an unknown email costs what a wrong password costs', async () => {
    const startedAt = performance.now();
    const result = await equalizeTiming();
    const elapsed = performance.now() - startedAt;

    assert.equal(result, false, 'it compares against a hash nobody can match; only the time spent matters');
    // Cost 12 takes hundreds of milliseconds; anything near zero means the work was skipped.
    assert.ok(elapsed >= 50, `took only ${elapsed.toFixed(1)}ms`);
  });
});
