import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { SEED } from '../helpers/fixtures.js';
import { humanDate, shortDate } from '../../src/lib/time.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';

const DB_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../db');

/**
 * Every test file starts by dropping the schema, running the migration runner
 * and loading the seed, so a broken migration fails the whole suite. This file
 * pins down what the runner and the seed promise beyond "it did not throw".
 */
describe('migrations and seed', () => {
  let app: TestApp;
  let migrate: typeof import('../../src/db/migrate.js').migrate;

  const files = async () => (await readdir(path.join(DB_DIR, 'migrations'))).filter((f) => f.endsWith('.sql')).sort();
  const tableCounts = async () =>
    (
      await app.db.query<{ name: string; n: number }>(
        `SELECT 'businesses' AS name, count(*)::int AS n FROM businesses
         UNION ALL SELECT 'users', count(*)::int FROM users
         UNION ALL SELECT 'services', count(*)::int FROM services
         UNION ALL SELECT 'appointments', count(*)::int FROM appointments
         UNION ALL SELECT 'chat_sessions', count(*)::int FROM chat_sessions
         UNION ALL SELECT 'chat_messages', count(*)::int FROM chat_messages
         UNION ALL SELECT 'ai_interaction_logs', count(*)::int FROM ai_interaction_logs`,
      )
    ).rows;

  before(async () => {
    app = await startTestApp();
    ({ migrate } = await import('../../src/db/migrate.js'));
  });
  after(async () => {
    await app.stop();
  });

  describe('the migration runner', () => {
    it('applied every file once, in order, recording a checksum of each', async () => {
      const { rows } = await app.db.query<{ filename: string; checksum: string }>(
        'SELECT filename, checksum FROM schema_migrations ORDER BY filename',
      );
      const expected = await Promise.all(
        (await files()).map(async (filename) => ({
          filename,
          checksum: createHash('sha256').update(await readFile(path.join(DB_DIR, 'migrations', filename), 'utf8')).digest('hex'),
        })),
      );
      assert.deepEqual(rows, expected);
      assert.deepEqual(rows.map((r) => r.filename), ['001_schema.sql', '002_indexes.sql']);
    });

    it('is a no-op when run again', async () => {
      const result = await migrate();
      assert.deepEqual(result.applied, []);
      assert.deepEqual(result.skipped, await files());
    });

    it('refuses to continue when an applied migration has been edited since', async () => {
      await app.db.query(`UPDATE schema_migrations SET checksum = 'edited-after-the-fact' WHERE filename = '001_schema.sql'`);
      try {
        await assert.rejects(migrate(), /001_schema\.sql was modified after being applied/);
      } finally {
        const original = createHash('sha256').update(await readFile(path.join(DB_DIR, 'migrations/001_schema.sql'), 'utf8')).digest('hex');
        await app.db.query(`UPDATE schema_migrations SET checksum = $1 WHERE filename = '001_schema.sql'`, [original]);
      }
      assert.deepEqual((await migrate()).applied, [], 'and recovers once the ledger matches again');
    });

    it('installs the extensions the schema relies on', async () => {
      const { rows } = await app.db.query<{ extname: string }>(
        `SELECT extname FROM pg_extension WHERE extname IN ('citext', 'btree_gist', 'pgcrypto') ORDER BY extname`,
      );
      assert.deepEqual(rows.map((r) => r.extname), ['btree_gist', 'citext', 'pgcrypto']);
    });

    it('creates every table and the indexes named in the indexing strategy', async () => {
      const tables = await app.db.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      );
      assert.deepEqual(tables.rows.map((r) => r.tablename), [
        'ai_interaction_logs',
        'appointments',
        'businesses',
        'chat_messages',
        'chat_sessions',
        'idempotency_keys',
        'refresh_tokens',
        'schema_migrations',
        'services',
        'users',
      ]);

      // Exactly the indexes the two files declare: every one not backing a
      // constraint (PK/UNIQUE/EXCLUDE) is listed here, so an index cannot be
      // added or lost without this list, and the comment naming its query, changing.
      const standalone = await app.db.query<{ indexname: string }>(
        `SELECT i.indexname FROM pg_indexes i
         WHERE i.schemaname = 'public' AND i.tablename <> 'schema_migrations'
           AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = (quote_ident(i.indexname))::regclass)
         ORDER BY i.indexname`,
      );
      assert.deepEqual(standalone.rows.map((r) => r.indexname), [
        'ai_logs_created_idx',
        'ai_logs_failures_idx',
        'ai_logs_session_idx',
        'appointments_business_starts_idx',
        'appointments_chat_session_idx',
        'appointments_one_live_per_chat_session',
        'appointments_service_idx',
        'appointments_upcoming_idx',
        'appointments_user_starts_idx',
        'chat_messages_session_id_idx',
        'chat_sessions_user_recent_idx',
        'idempotency_keys_appointment_idx',
        'idempotency_keys_created_idx',
        'refresh_tokens_expires_idx',
        'refresh_tokens_user_idx',
        'services_business_active_idx',
        'users_business_created_idx',
        'users_email_idx',
      ]);

      const constraints = await app.db.query<{ conname: string; contype: string }>(
        `SELECT conname, contype::text FROM pg_constraint
         WHERE connamespace = 'public'::regnamespace AND contype IN ('u', 'x') ORDER BY conname`,
      );
      assert.deepEqual(constraints.rows, [
        { conname: 'appointments_customer_no_overlap', contype: 'x' },
        { conname: 'appointments_no_overlap', contype: 'x' },
        { conname: 'businesses_slug_key', contype: 'u' },
        { conname: 'chat_sessions_business_id_id_key', contype: 'u' },
        { conname: 'refresh_tokens_token_hash_key', contype: 'u' },
        { conname: 'services_business_id_id_key', contype: 'u' },
        { conname: 'services_business_name_key', contype: 'u' },
        { conname: 'users_business_email_key', contype: 'u' },
        { conname: 'users_business_id_id_key', contype: 'u' },
      ]);
    });
  });

  describe('the seed', () => {
    it('creates the documented demo tenants, accounts and catalogue', async () => {
      const counts = Object.fromEntries((await tableCounts()).map((r) => [r.name, r.n]));
      assert.deepEqual(counts, {
        businesses: 2,
        users: 4,
        services: 5,
        appointments: 4,
        chat_sessions: 1,
        chat_messages: 6,
        ai_interaction_logs: 4,
      });

      const { rows } = await app.db.query<{ email: string; role: string; slug: string }>(
        `SELECT u.email::text, u.role::text, b.slug::text FROM users u JOIN businesses b ON b.id = u.business_id ORDER BY u.email`,
      );
      assert.deepEqual(rows, [
        { email: 'customer@bluewave.test', role: 'customer', slug: 'bluewave' },
        { email: 'owner@bluewave.test', role: 'owner', slug: 'bluewave' },
        { email: 'owner@northside.test', role: 'owner', slug: 'northside' },
        { email: 'staff@bluewave.test', role: 'staff', slug: 'bluewave' },
      ]);
    });

    it('stores passwords as bcrypt hashes that the API accepts', async () => {
      const { rows } = await app.db.query<{ password_hash: string }>('SELECT password_hash FROM users');
      for (const row of rows) assert.match(row.password_hash, /^\$2[aby]\$12\$/);
      for (const user of Object.values(SEED.users)) {
        assert.equal((await app.client().login(user.email, SEED.password)).status, 200, user.email);
      }
    });

    it('keeps every seeded appointment in the future or the past it was meant for, so the demo is never empty', async () => {
      const { rows } = await app.db.query<{ status: string; upcoming: boolean }>(
        `SELECT status::text, starts_at > now() AS upcoming FROM appointments ORDER BY starts_at`,
      );
      assert.deepEqual(rows, [
        { status: 'completed', upcoming: false },
        { status: 'cancelled', upcoming: true },
        { status: 'confirmed', upcoming: true },
        { status: 'pending', upcoming: true },
      ]);
    });

    it('places every live appointment inside opening hours in the business’s timezone, whatever the session timezone', async () => {
      // Re-seed the appointments from a connection set to a zone far from New
      // York: wall-clock times must be anchored to the business, not the session.
      const connection = await app.db.connect();
      try {
        await connection.query(`SET TimeZone = 'Asia/Karachi'`);
        await connection.query(`DELETE FROM appointments WHERE id::text LIKE 'ffffffff-%'`);
        await connection.query(await readFile(path.join(DB_DIR, 'seed.sql'), 'utf8'));
      } finally {
        await connection.query('RESET TimeZone');
        connection.release();
      }

      const { rows } = await app.db.query<{ id: string; local_start: string; local_end: string }>(
        `SELECT a.id::text, to_char(a.starts_at AT TIME ZONE b.timezone, 'HH24:MI') AS local_start,
                to_char(a.ends_at AT TIME ZONE b.timezone, 'HH24:MI') AS local_end
         FROM appointments a JOIN businesses b ON b.id = a.business_id
         WHERE a.id::text LIKE 'ffffffff-%' ORDER BY a.id`,
      );
      assert.deepEqual(rows.map((r) => [r.local_start, r.local_end]), [
        ['14:00', '15:00'],
        ['10:00', '10:30'],
        ['11:00', '11:30'],
        ['09:00', '09:20'],
      ]);
    });

    it('tells one story: the seeded conversation names the day and time of the appointment it booked', async () => {
      const { rows } = await app.db.query<{ local_date: string; long_date: string; draft_date: string; title: string }>(
        `SELECT to_char(a.starts_at AT TIME ZONE b.timezone, 'YYYY-MM-DD') AS local_date,
                to_char(a.starts_at AT TIME ZONE b.timezone, 'FMDay, FMMonth FMDD, YYYY') AS long_date,
                s.booking_draft->>'date' AS draft_date, s.title
         FROM appointments a
         JOIN businesses b ON b.id = a.business_id
         JOIN chat_sessions s ON s.id = a.chat_session_id
         WHERE a.id = 'ffffffff-0000-0000-0000-000000000001'`,
      );
      const [booked] = rows;
      assert.ok(booked);
      assert.equal(booked.draft_date, booked.local_date);
      assert.equal(booked.title, `Teeth Whitening — ${shortDate(booked.local_date)}`);

      const replies = await app.db.query<{ content: string; engine: string; tool_name: string }>(
        `SELECT content, engine, tool_calls->0->>'name' AS tool_name FROM chat_messages
         WHERE session_id = 'eeeeeeee-0000-0000-0000-000000000001' AND role = 'assistant' ORDER BY id`,
      );
      const last = replies.rows.at(-1)!;
      assert.equal(last.content, `Booked — Teeth Whitening on ${humanDate(booked.local_date)} at 2:00 PM. It's on your dashboard now.`);
      assert.equal(humanDate(booked.local_date), booked.long_date, 'Postgres and the API spell the date the same way');
      for (const reply of replies.rows) assert.equal(reply.tool_name, 'respond_to_booking_request');
    });

    it('is idempotent: running it again changes nothing, and adds no duplicate transcript or log rows', async () => {
      const before = await tableCounts();
      const sql = await readFile(path.join(DB_DIR, 'seed.sql'), 'utf8');
      await app.db.query(sql);
      await app.db.query(sql);
      assert.deepEqual(await tableCounts(), before);

      const { rows } = await app.db.query<{ message_count: number; actual: number }>(
        `SELECT s.message_count, (SELECT count(*)::int FROM chat_messages m WHERE m.session_id = s.id) AS actual
         FROM chat_sessions s WHERE s.id = 'eeeeeeee-0000-0000-0000-000000000001'`,
      );
      assert.deepEqual(rows, [{ message_count: 6, actual: 6 }], 'the session counter still matches its transcript');
    });
  });
});
