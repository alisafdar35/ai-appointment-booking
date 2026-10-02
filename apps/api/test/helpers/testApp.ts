import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ApiClient } from './apiClient.js';
import { SEED, type SeededUser } from './fixtures.js';

/**
 * Boots the real application against a throwaway database.
 *
 * What makes these integration tests rather than mocked unit tests: the app is
 * the production `createApp()`, the schema is built by the production migration
 * runner from db/migrations, and the data is db/seed.sql. Every test file
 * therefore also proves that "migrate from scratch, then seed" works.
 *
 * Application modules are imported dynamically AFTER the environment is set,
 * because config/env.ts validates process.env once at import time. A static
 * import at the top of a test file would run before any per-file override.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://appt:appt_local_dev@localhost:5433/appt_test';

/**
 * Every setting the app reads, pinned. A developer's repo-root .env is loaded by
 * config/env.ts for any key still unset, so leaving one out would let a local
 * MISTRAL_API_KEY or PG_POOL_MAX change what the suite does. A blank value
 * counts as "unset" to the app but still stops dotenv from filling it in.
 */
const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  // Unused: the harness listens on an ephemeral port itself.
  PORT: '4000',
  DATABASE_SSL: 'false',
  PG_POOL_MAX: '10',
  JWT_SECRET: 'test-only-secret-that-is-comfortably-over-32-characters',
  ACCESS_TOKEN_TTL_SECONDS: '900',
  REFRESH_TOKEN_TTL_DAYS: '7',
  CORS_ORIGINS: 'http://localhost:3000',
  CROSS_SITE_COOKIES: 'false',
  MISTRAL_API_KEY: '',
  MISTRAL_MODEL: 'ministral-8b-latest',
  MISTRAL_BASE_URL: 'https://api.mistral.ai',
  AI_TIMEOUT_MS: '12000',
  AI_MAX_RETRIES: '1',
  AI_HISTORY_TURNS: '12',
  LOG_LEVEL: 'silent',
  RATE_LIMIT_DISABLED: 'true',
  TRUST_PROXY_HOPS: '0',
};

/** Advisory-lock keys: one per database slot, plus one that serialises CREATE DATABASE. */
const SLOT_LOCK_BASE = 74_201_000;
const CREATE_LOCK = 74_201_999;
/** How many test files may run at once, each against a database of its own. */
const SLOTS = 8;

export interface TestAppOptions {
  /** Per-file environment overrides, applied on top of the pinned defaults. */
  env?: Record<string, string>;
  /** Attach the Socket.IO gateway to the HTTP server. Off unless a test needs it. */
  realtime?: boolean;
}

export interface TestApp {
  baseUrl: string;
  /** The application's own pool, for arranging and inspecting state directly. */
  db: pg.Pool;
  /** An anonymous client with an empty cookie jar. */
  client(): ApiClient;
  /** A client signed in as one of the seeded accounts. */
  loginAs(user: SeededUser): Promise<ApiClient>;
  stop(): Promise<void>;
}

function baseDatabaseName(url: string): string {
  const name = new URL(url).pathname.slice(1);
  // The suite drops and recreates the public schema. Refuse anything that is
  // not unmistakably a test database, so a mistyped URL can never wipe dev data.
  if (!/^[a-z0-9_]+_test$/.test(name)) {
    throw new Error(`Refusing to reset "${name}": the test database name must end in "_test".`);
  }
  return name;
}

interface DatabaseLease {
  /** Holds the session lock for this slot; closing it releases the database. */
  admin: pg.Client;
  url: string;
}

/**
 * Claim a test database for this process, creating it if needed.
 *
 * node:test runs every file in its own process and every file rebuilds its
 * database from scratch, so two files must never share one. Databases are
 * handed out in slots: slot 0 is the dedicated `appt_test`, further slots are
 * `appt_test_1`, `appt_test_2`, ... A slot is claimed with a session-level
 * advisory lock, held on a connection to the maintenance database for the life
 * of the process and released when it closes. Run serially, every file gets
 * `appt_test`; run in parallel, files spread over the slots, and an
 * overflowing runner simply waits for one to free up.
 */
async function acquireDatabase(): Promise<DatabaseLease> {
  const base = baseDatabaseName(TEST_DATABASE_URL);
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();

  for (;;) {
    for (let slot = 0; slot < SLOTS; slot += 1) {
      const { rows } = await admin.query<{ claimed: boolean }>('SELECT pg_try_advisory_lock($1) AS claimed', [
        SLOT_LOCK_BASE + slot,
      ]);
      if (!rows[0]!.claimed) continue;

      const name = slot === 0 ? base : `${base}_${slot}`;
      // CREATE DATABASE copies template1, which Postgres refuses to do while
      // another session is doing the same, so creation is serialised.
      await admin.query('SELECT pg_advisory_lock($1)', [CREATE_LOCK]);
      try {
        const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
        if (!rowCount) await admin.query(`CREATE DATABASE "${name}"`);
      } finally {
        await admin.query('SELECT pg_advisory_unlock($1)', [CREATE_LOCK]);
      }

      const url = new URL(TEST_DATABASE_URL);
      url.pathname = `/${name}`;
      return { admin, url: url.toString() };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function wipeSchema(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Dropping the schema also drops the extensions installed into it, so the
    // migrations' own CREATE EXTENSION statements are exercised on every run.
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
}

export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const lease = await acquireDatabase();
  const teardown: (() => Promise<unknown>)[] = [() => lease.admin.end()];
  // Run teardown newest-first, and keep going if one step fails, so that a
  // half-started app never leaves a connection open to hang the test process.
  const release = async () => {
    for (const step of teardown.reverse()) await step().catch(() => undefined);
  };

  try {
    Object.assign(process.env, BASE_ENV, { DATABASE_URL: lease.url }, options.env);
    await wipeSchema(lease.url);

    const [{ createApp }, { pool, closePool }, { migrate }, realtime] = await Promise.all([
      import('../../src/app.js'),
      import('../../src/db/pool.js'),
      import('../../src/db/migrate.js'),
      import('../../src/realtime/index.js'),
    ]);
    teardown.push(closePool);

    await migrate();
    await pool.query(await readFile(path.join(REPO_ROOT, 'db/seed.sql'), 'utf8'));

    const server: Server = createServer(createApp());
    if (options.realtime) realtime.initRealtime(server);
    teardown.push(async () => {
      await realtime.closeRealtime();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    return {
      baseUrl,
      db: pool,
      client: () => new ApiClient(baseUrl),
      async loginAs(user) {
        const client = new ApiClient(baseUrl);
        const { email } = SEED.users[user];
        const res = await client.login(email, SEED.password);
        if (res.status !== 200) throw new Error(`Seed login failed for ${email}: ${res.status}`);
        return client;
      },
      stop: release,
    };
  } catch (err) {
    await release();
    throw err;
  }
}
