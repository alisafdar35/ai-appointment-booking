import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * config/env.ts validates once at import and exits the process on bad input,
 * so each case boots it in a child process with a controlled environment.
 */
const API_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const PLACEHOLDER = 'replace-me-with-a-long-random-string-at-least-32-chars';

function loadEnv(overrides: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', 'tsx', '-e', "await import('./src/config/env.ts')"], {
    cwd: API_DIR,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: 'postgresql://user:pass@localhost:5433/unused_test',
      ...overrides,
    },
  });
}

describe('environment validation', () => {
  it('refuses to start in production with the JWT_SECRET published in .env.example', () => {
    const result = loadEnv({ NODE_ENV: 'production', JWT_SECRET: PLACEHOLDER });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /JWT_SECRET is still the \.env\.example placeholder/);
  });

  it('accepts the placeholder outside production, where nothing real is signed with it', () => {
    const result = loadEnv({ NODE_ENV: 'development', JWT_SECRET: PLACEHOLDER });
    assert.equal(result.status, 0, result.stderr);
  });

  it('accepts a real secret in production', () => {
    const result = loadEnv({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(48) });
    assert.equal(result.status, 0, result.stderr);
  });
});
