import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type pg from 'pg';
import { SEED } from '../helpers/fixtures.js';
import { startTestApp, type TestApp } from '../helpers/testApp.js';

/**
 * The database's own guarantees, checked directly with SQL — below the
 * application, so nothing in the service layer can be what makes them pass.
 *
 * Application code checks most of these first, to give a good error message.
 * They are repeated here because the checks in code are an optimisation and
 * these constraints are the guarantee: if someone deletes a validation in a
 * service, or writes a script that bypasses the API, the schema must still hold.
 *
 * Each case runs in a transaction that is rolled back, so every case sees the
 * seeded data and nothing else. The first cases mirror db/verify.sql.
 */
describe('schema constraints', () => {
  let app: TestApp;
  let client: pg.PoolClient;

  const { bluewave, northside, users, services } = SEED;
  /** Whitening for the customer, three days out, 14:00-15:00 New York time. */
  const SEEDED_WHITENING = 'ffffffff-0000-0000-0000-000000000001';
  /** Emergency Consult for staff, cancelled. */
  const SEEDED_CANCELLED = 'ffffffff-0000-0000-0000-000000000004';
  const SEEDED_SESSION = 'eeeeeeee-0000-0000-0000-000000000001';

  before(async () => {
    app = await startTestApp();
    client = await app.db.connect();
  });
  after(async () => {
    client.release();
    await app.stop();
  });

  type DbError = { code?: string; constraint?: string };

  /** Run `work` in a transaction and always roll it back. */
  async function inRollback<T>(work: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    try {
      return await work();
    } finally {
      await client.query('ROLLBACK');
    }
  }

  /** Run a statement that must be refused, and return the database's error. */
  const refused = (sql: string, params: unknown[] = []): Promise<DbError> =>
    inRollback(async () => {
      try {
        await client.query(sql, params);
      } catch (err) {
        return err as DbError;
      }
      return assert.fail(`the database accepted: ${sql}`);
    });

  /** Insert an appointment positioned relative to the seeded Whitening one. */
  const insertRelativeToSeeded = (
    startOffset: string,
    length: string,
    options: { userId?: string; serviceId?: string; status?: string } = {},
  ) =>
    client.query(
      `INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status)
       SELECT business_id, $1, $2, starts_at + $3::interval, starts_at + $3::interval + $4::interval, $5
       FROM appointments WHERE id = $6`,
      [
        options.userId ?? users.staff.id,
        options.serviceId ?? services.teethWhitening.id,
        startOffset,
        length,
        options.status ?? 'pending',
        SEEDED_WHITENING,
      ],
    );

  describe('double booking', () => {
    it('rejects an overlapping booking for the same service', async () => {
      // 14:30-15:30 against the seeded 14:00-15:00.
      const error = await inRollback(async () => {
        try {
          await insertRelativeToSeeded('30 minutes', '60 minutes');
        } catch (err) {
          return err as DbError;
        }
        return assert.fail('overlap was accepted');
      });
      assert.equal(error.code, '23P01');
      assert.equal(error.constraint, 'appointments_no_overlap');
    });

    it('rejects an exact duplicate, a booking that contains another, and one that sits inside another', async () => {
      for (const [offset, length] of [
        ['0 minutes', '60 minutes'],
        ['-30 minutes', '120 minutes'],
        ['15 minutes', '15 minutes'],
      ] as const) {
        await inRollback(() => assert.rejects(insertRelativeToSeeded(offset, length), { code: '23P01' }, `${offset} + ${length}`));
      }
    });

    it('allows a booking that starts exactly when another ends, and one that ends exactly when another starts', async () => {
      await inRollback(async () => {
        await insertRelativeToSeeded('60 minutes', '60 minutes'); // 15:00-16:00
        await insertRelativeToSeeded('-60 minutes', '60 minutes'); // 13:00-14:00
      });
    });

    it('allows the same time for a different service, and for a different tenant', async () => {
      await inRollback(async () => {
        await insertRelativeToSeeded('0 minutes', '60 minutes', { serviceId: services.routineCheckup.id });
        await client.query(
          `INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at)
           SELECT $1, $2, $3, starts_at, ends_at FROM appointments WHERE id = $4`,
          [northside.id, users.northsideOwner.id, services.generalPractice.id, SEEDED_WHITENING],
        );
      });
    });

    it('rejects the same customer holding two overlapping appointments, even for different services', async () => {
      const error = await inRollback(async () => {
        try {
          await insertRelativeToSeeded('15 minutes', '30 minutes', {
            userId: users.customer.id,
            serviceId: services.routineCheckup.id,
          });
        } catch (err) {
          return err as DbError;
        }
        return assert.fail('the customer was booked into two places at once');
      });
      assert.equal(error.code, '23P01');
      assert.equal(error.constraint, 'appointments_customer_no_overlap');
    });

    it('lets the same customer book back to back, and overlap a booking of theirs that is no longer live', async () => {
      await inRollback(async () => {
        await insertRelativeToSeeded('60 minutes', '30 minutes', { userId: users.customer.id, serviceId: services.routineCheckup.id });
        await client.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [SEEDED_WHITENING]);
        await insertRelativeToSeeded('0 minutes', '30 minutes', { userId: users.customer.id, serviceId: services.routineCheckup.id });
      });
    });

    it('does not let a cancelled, completed or no-show appointment block its slot', async () => {
      await inRollback(async () => {
        await client.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [SEEDED_WHITENING]);
        await insertRelativeToSeeded('0 minutes', '60 minutes', { status: 'confirmed' });
        // Records that never occupy a slot can overlap anything.
        await insertRelativeToSeeded('0 minutes', '60 minutes', { status: 'completed' });
        await insertRelativeToSeeded('0 minutes', '60 minutes', { status: 'no_show' });
      });
    });

    it('frees the slot of the seeded cancelled appointment', async () => {
      await inRollback(async () => {
        await client.query(
          `INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status)
           SELECT business_id, $1, service_id, starts_at, ends_at, 'confirmed' FROM appointments WHERE id = $2`,
          [users.customer.id, SEEDED_CANCELLED],
        );
      });
    });

    it('refuses to revive a cancelled appointment whose slot has since been re-booked', async () => {
      await inRollback(async () => {
        await client.query(
          `INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status)
           SELECT business_id, $1, service_id, starts_at, ends_at, 'confirmed' FROM appointments WHERE id = $2`,
          [users.customer.id, SEEDED_CANCELLED],
        );
        await assert.rejects(
          client.query(`UPDATE appointments SET status = 'confirmed' WHERE id = $1`, [SEEDED_CANCELLED]),
          { code: '23P01' },
        );
      });
    });

    it('derives the stored range from the start and end times, half-open, and refuses a direct write to it', async () => {
      const { rows } = await client.query<{ matches: boolean; includes_end: boolean }>(
        `SELECT slot = tstzrange(starts_at, ends_at, '[)') AS matches, slot @> ends_at AS includes_end
         FROM appointments WHERE id = $1`,
        [SEEDED_WHITENING],
      );
      assert.equal(rows[0]!.matches, true);
      assert.equal(rows[0]!.includes_end, false, 'the end instant belongs to the next slot');

      const error = await refused(`UPDATE appointments SET slot = tstzrange(now(), now() + interval '1 hour') WHERE id = $1`, [
        SEEDED_WHITENING,
      ]);
      assert.equal(error.code, '428C9', 'a generated column cannot be written');
    });
  });

  describe('tenant isolation', () => {
    it('rejects an appointment for a user from another tenant', async () => {
      const error = await refused(
        `INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status)
         VALUES ($1, $2, $3, now() + interval '40 days', now() + interval '40 days 30 minutes', 'pending')`,
        [bluewave.id, users.northsideOwner.id, services.routineCheckup.id],
      );
      assert.equal(error.code, '23503');
      assert.equal(error.constraint, 'appointments_user_fk');
    });

    it('rejects an appointment for a service from another tenant', async () => {
      const error = await refused(
        `INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status)
         VALUES ($1, $2, $3, now() + interval '40 days', now() + interval '40 days 30 minutes', 'pending')`,
        [bluewave.id, users.customer.id, services.generalPractice.id],
      );
      assert.equal(error.code, '23503');
      assert.equal(error.constraint, 'appointments_service_fk');
    });

    it('rejects an appointment linked to another tenant’s conversation', async () => {
      const error = await inRollback(async () => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO chat_sessions (business_id, user_id) VALUES ($1, $2) RETURNING id`,
          [northside.id, users.northsideOwner.id],
        );
        try {
          await client.query(
            `INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status, chat_session_id)
             VALUES ($1, $2, $3, now() + interval '41 days', now() + interval '41 days 30 minutes', 'pending', $4)`,
            [bluewave.id, users.customer.id, services.routineCheckup.id, rows[0]!.id],
          );
        } catch (err) {
          return err as DbError;
        }
        return assert.fail('a cross-tenant conversation link was accepted');
      });
      assert.equal(error.code, '23503');
      assert.equal(error.constraint, 'appointments_chat_session_fk');
    });

    it('accepts a link to the user’s own tenant’s conversation, and no link at all', async () => {
      await inRollback(async () => {
        // A conversation of its own: the seeded one already holds its one live booking.
        const { rows } = await client.query<{ id: string }>(
          'INSERT INTO chat_sessions (business_id, user_id) VALUES ($1, $2) RETURNING id',
          [bluewave.id, users.customer.id],
        );
        await client.query(
          `INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status, chat_session_id)
           VALUES ($1, $2, $3, now() + interval '41 days', now() + interval '41 days 30 minutes', 'pending', $4),
                  ($1, $2, $3, now() + interval '42 days', now() + interval '42 days 30 minutes', 'pending', NULL)`,
          [bluewave.id, users.customer.id, services.routineCheckup.id, rows[0]!.id],
        );
      });
    });

    it('rejects a conversation owned by a user of another tenant', async () => {
      const error = await refused(`INSERT INTO chat_sessions (business_id, user_id) VALUES ($1, $2)`, [
        bluewave.id,
        users.northsideOwner.id,
      ]);
      assert.equal(error.constraint, 'chat_sessions_user_fk');
    });

    it('keeps an appointment when its conversation is deleted, forgetting only the link', async () => {
      await inRollback(async () => {
        await client.query('DELETE FROM chat_sessions WHERE id = $1', [SEEDED_SESSION]);
        const { rows } = await client.query(
          'SELECT business_id, chat_session_id FROM appointments WHERE id = $1',
          [SEEDED_WHITENING],
        );
        assert.deepEqual(rows, [{ business_id: bluewave.id, chat_session_id: null }]);
      });
    });

    it('removes a user’s appointments, conversations and refresh tokens along with the user', async () => {
      await app.client().login(users.customer.email, SEED.password);
      await inRollback(async () => {
        await client.query('DELETE FROM users WHERE id = $1', [users.customer.id]);
        for (const table of ['appointments', 'chat_sessions', 'refresh_tokens']) {
          const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [users.customer.id]);
          assert.equal(rows[0].n, 0, table);
        }
      });
    });

    it('does not let a service that has bookings be deleted out from under them', async () => {
      const error = await refused('DELETE FROM services WHERE id = $1', [services.teethWhitening.id]);
      assert.equal(error.constraint, 'appointments_service_fk');
    });
  });

  describe('one booking per conversation', () => {
    const linkToSeededSession = (status: string) =>
      client.query(
        `INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status, chat_session_id)
         VALUES ($1, $2, $3, now() + interval '43 days', now() + interval '43 days 30 minutes', $4, $5)`,
        [bluewave.id, users.customer.id, services.routineCheckup.id, status, SEEDED_SESSION],
      );

    it('rejects a second live appointment for a conversation that already holds one', async () => {
      for (const status of ['pending', 'confirmed']) {
        const error = await refused(
          `INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status, chat_session_id)
           VALUES ($1, $2, $3, now() + interval '43 days', now() + interval '43 days 30 minutes', $4, $5)`,
          [bluewave.id, users.customer.id, services.routineCheckup.id, status, SEEDED_SESSION],
        );
        assert.equal(error.code, '23505', status);
        assert.equal(error.constraint, 'appointments_one_live_per_chat_session', status);
      }
    });

    it('allows a cancelled or finished one alongside it, and a new one once the first is cancelled', async () => {
      await inRollback(async () => {
        await linkToSeededSession('cancelled');
        await linkToSeededSession('completed');
        await client.query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [SEEDED_WHITENING]);
        await linkToSeededSession('confirmed');
      });
    });
  });

  describe('data integrity', () => {
    const insertAppointment = (starts: string, ends: string) =>
      refused(
        `INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [bluewave.id, users.customer.id, services.routineCheckup.id, starts, ends],
      );

    it('rejects an appointment that ends before, or exactly when, it starts', async () => {
      // Reversed: the generated range column cannot even be built (SQLSTATE 22000).
      assert.equal((await insertAppointment('2031-04-22T10:00:00Z', '2031-04-22T09:00:00Z')).code, '22000');
      // Zero-length builds an empty range, so the CHECK is what refuses it.
      assert.equal((await insertAppointment('2031-04-22T10:00:00Z', '2031-04-22T10:00:00Z')).constraint, 'appointments_time_ordered');
    });

    it('rejects over-long notes and cancellation reasons', async () => {
      const insert = (column: string) =>
        refused(
          `INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, ${column})
           VALUES ($1, $2, $3, '2031-04-22T10:00:00Z', '2031-04-22T10:30:00Z', $4)`,
          [bluewave.id, users.customer.id, services.routineCheckup.id, 'x'.repeat(2001)],
        );
      assert.equal((await insert('notes')).constraint, 'appointments_notes_check');
      assert.equal((await insert('cancellation_reason')).code, '23514');
    });

    it('rejects a status outside the enumerated values', async () => {
      const error = await refused(
        `INSERT INTO appointments (business_id, user_id, service_id, starts_at, ends_at, status)
         VALUES ($1, $2, $3, '2031-04-22T10:00:00Z', '2031-04-22T10:30:00Z', 'maybe')`,
        [bluewave.id, users.customer.id, services.routineCheckup.id],
      );
      assert.equal(error.code, '22P02');
    });

    it('allows one email per tenant, compared case-insensitively, but the same email in two tenants', async () => {
      const duplicate = await refused(
        `INSERT INTO users (business_id, email, password_hash, full_name) VALUES ($1, 'CUSTOMER@Bluewave.TEST', 'x', 'Someone')`,
        [bluewave.id],
      );
      assert.equal(duplicate.constraint, 'users_business_email_key');

      await inRollback(() =>
        client.query(`INSERT INTO users (business_id, email, password_hash, full_name) VALUES ($1, $2, 'x', 'Someone')`, [
          northside.id,
          users.customer.email,
        ]),
      );
    });

    it('rejects a malformed email, phone, slug or business-hours range', async () => {
      const badEmail = await refused(`INSERT INTO users (business_id, email, password_hash, full_name) VALUES ($1, 'nope', 'x', 'A')`, [
        bluewave.id,
      ]);
      assert.equal(badEmail.code, '23514');
      const badPhone = await refused(
        `INSERT INTO users (business_id, email, password_hash, full_name, phone) VALUES ($1, 'a@b.test', 'x', 'A', 'call me')`,
        [bluewave.id],
      );
      assert.equal(badPhone.code, '23514');
      const badSlug = await refused(`INSERT INTO businesses (name, slug) VALUES ('X', 'Not A Slug')`);
      assert.equal(badSlug.code, '23514');
      const reversedHours = await refused(
        `INSERT INTO businesses (name, slug, opens_at, closes_at) VALUES ('X', 'x-hours', '17:00', '09:00')`,
      );
      assert.equal(reversedHours.constraint, 'businesses_hours_ordered');
    });

    it('keeps tenant slugs globally unique, whatever their case', async () => {
      const error = await refused(`INSERT INTO businesses (name, slug) VALUES ('Imposter', 'BLUEWAVE')`);
      assert.equal(error.constraint, 'businesses_slug_key');
    });

    it('rejects a service with a nonsensical duration or price, and a duplicate name within a tenant', async () => {
      const insert = (name: string, minutes: number, price = 0) =>
        refused(`INSERT INTO services (business_id, name, duration_minutes, price_cents) VALUES ($1, $2, $3, $4)`, [
          bluewave.id,
          name,
          minutes,
          price,
        ]);
      assert.equal((await insert('Too Short', 4)).code, '23514');
      assert.equal((await insert('Too Long', 481)).code, '23514');
      assert.equal((await insert('Negative', 30, -1)).code, '23514');
      assert.equal((await insert('Routine Checkup', 30)).constraint, 'services_business_name_key');
    });

    it('rejects an unknown AI engine on a message, and a booking draft that is not an object', async () => {
      const badEngine = await refused(
        `INSERT INTO chat_messages (session_id, role, content, engine) VALUES ($1, 'assistant', 'hi', 'gpt')`,
        [SEEDED_SESSION],
      );
      assert.equal(badEngine.code, '23514');
      const badDraft = await refused(`UPDATE chat_sessions SET booking_draft = '[1,2]'::jsonb WHERE id = $1`, [SEEDED_SESSION]);
      assert.equal(badDraft.code, '23514');
    });

    it('refuses a refresh token that expires before it was created', async () => {
      const error = await refused(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at)
         VALUES ($1, '\\x00', now() - interval '1 day', now())`,
        [users.customer.id],
      );
      assert.equal(error.constraint, 'refresh_tokens_expiry_future');
    });
  });

  describe('indexes', () => {
    const explain = (sql: string, params: unknown[], settings: string[]) =>
      inRollback(async () => {
        for (const setting of settings) await client.query(`SET LOCAL ${setting} = off`);
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params);
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      });

    it('serves the "my appointments" dashboard query in index order, with no sort step', async () => {
      // The seed is too small for the planner to prefer an index unprompted, so
      // sequential and bitmap scans are disabled to ask the narrower question
      // that matters: can the index serve this query's filter and ordering?
      const plan = await explain(
        `SELECT id, starts_at FROM appointments
         WHERE business_id = $1 AND user_id = $2
         ORDER BY starts_at DESC LIMIT 20`,
        [bluewave.id, users.customer.id],
        ['enable_seqscan', 'enable_bitmapscan'],
      );
      assert.match(plan, /appointments_user_starts_idx/);
      assert.doesNotMatch(plan, /Sort/);
    });

    it('serves both overlap probes with the GiST indexes that enforce the constraints', async () => {
      // Both EXCLUDE indexes cover (business_id, ..., slot), so on a table this
      // small the planner may answer either probe from either one; what matters
      // is that each probe is an index scan over a constraint's GiST index,
      // never a scan of the table.
      const probe = (column: 'service_id' | 'user_id', value: string) =>
        explain(
          `SELECT 1 FROM appointments
           WHERE business_id = $1 AND ${column} = $2 AND status IN ('pending', 'confirmed')
             AND slot && tstzrange(now(), now() + interval '1 hour', '[)')`,
          [bluewave.id, value],
          ['enable_seqscan'],
        );
      for (const plan of [await probe('service_id', services.teethWhitening.id), await probe('user_id', users.customer.id)]) {
        assert.match(plan, /Index (Only )?Scan using appointments_(customer_)?no_overlap/);
      }
    });
  });
});
