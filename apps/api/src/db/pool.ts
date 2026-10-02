import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * node-postgres returns DATE/TIMESTAMP as JS Date by parsing in the server's
 * local timezone, which silently shifts values depending on where the process
 * runs. We take control of parsing so behaviour is identical on a laptop in PKT
 * and a container in UTC.
 *
 * timestamptz is normalised to a UTC ISO-8601 string. Postgres' text output
 * ("2026-10-07 10:00:00+05") is neither ISO-8601 nor offset-stable: it renders
 * in the DB session's timezone, and Safari's Date parser rejects it outright.
 * Every API timestamp therefore leaves the server as "...Z", and clients convert
 * to the business timezone for display. DATE columns stay as plain YYYY-MM-DD.
 */
const TIMESTAMPTZ_OID = 1184;
const TIMESTAMP_OID = 1114;
const DATE_OID = 1082;

function timestamptzToIso(v: string): string {
  // "2026-10-07 10:00:00.123456+05" -> "2026-10-07T10:00:00.123456+05:00"
  const normalised = v
    .replace(' ', 'T')
    .replace(/([+-]\d{2})$/, '$1:00')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(normalised);
  return Number.isNaN(ms) ? v : new Date(ms).toISOString();
}

pg.types.setTypeParser(TIMESTAMPTZ_OID, timestamptzToIso);
pg.types.setTypeParser(TIMESTAMP_OID, (v) => v);
pg.types.setTypeParser(DATE_OID, (v) => v);
// int8/bigint: returned as string by default to avoid precision loss. Our
// bigserial ids are far below 2^53, so parsing to number is safe and spares
// every caller a conversion.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Certificates are verified: Neon's chain to a public CA that Node already
  // trusts, and TLS without verification would accept any man in the middle.
  // A provider with a private CA would pass its bundle here as `ca`.
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : false,
});

// A pool-level error is an idle client dying, not a failed query. Without this
// listener Node treats it as an unhandled 'error' event and kills the process.
pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected idle client error in the Postgres pool');
});

export type Queryable = Pick<pg.PoolClient, 'query'>;

/**
 * Run a function inside a transaction, releasing the client on every path.
 *
 * Every multi-statement write in this codebase goes through here. Taking a
 * client from the pool manually and forgetting a `release()` in a catch branch
 * is the classic way to exhaust a connection pool under load.
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'ROLLBACK failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
