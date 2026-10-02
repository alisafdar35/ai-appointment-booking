/**
 * Minimal forward-only migration runner.
 *
 * Deliberately not a migration framework: the requirement is plain SQL DDL that
 * a reviewer can read, and a dependency that rewrites the schema from a DSL
 * would hide exactly the work being assessed. What a runner must get right is:
 *   - apply each file at most once (schema_migrations ledger)
 *   - apply in deterministic order (filenames are zero-padded and sorted)
 *   - run each file in a transaction, so a failure leaves no partial schema
 *   - detect a migration edited after it was applied (checksum mismatch)
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, pool, withTransaction } from './pool.js';
import { logger } from '../lib/logger.js';

const MIGRATIONS_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../db/migrations');

const LEDGER_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  );
`;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function migrate(): Promise<{ applied: string[]; skipped: string[] }> {
  await pool.query(LEDGER_DDL);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);

  const { rows } = await pool.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM schema_migrations',
  );
  const already = new Map(rows.map((r) => [r.filename, r.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const filename of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
    const checksum = sha256(sql);
    const previous = already.get(filename);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${filename} was modified after being applied.\n` +
            `Applied migrations are immutable — add a new migration instead.\n` +
            `(To rebuild a local database from scratch: npm run db:reset)`,
        );
      }
      skipped.push(filename);
      continue;
    }

    // One transaction per file: Postgres supports transactional DDL, so a
    // migration either lands completely or not at all.
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
        filename,
        checksum,
      ]);
    });
    applied.push(filename);
    logger.info({ filename }, 'Migration applied');
  }

  return { applied, skipped };
}

// Run directly (npm run db:migrate) rather than imported.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  migrate()
    .then(({ applied, skipped }) => {
      logger.info(
        { applied: applied.length, alreadyApplied: skipped.length },
        applied.length ? 'Migrations complete' : 'Database already up to date',
      );
      return closePool();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err: err instanceof Error ? err.message : err }, 'Migration failed');
      process.exit(1);
    });
}
