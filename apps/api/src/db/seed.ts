/** Applies db/seed.sql. Kept as SQL so it is a reviewable deliverable in its own right. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, pool } from './pool.js';
import { logger } from '../lib/logger.js';

const SEED_FILE = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../db/seed.sql');

async function seed() {
  const sql = await readFile(SEED_FILE, 'utf8');
  await pool.query(sql);
  const { rows } = await pool.query<{ users: number; appointments: number }>(
    'SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM appointments)::int AS appointments',
  );
  logger.info({ ...rows[0] }, 'Seed complete — log in as customer@bluewave.test / Password123!');
}

seed()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, 'Seed failed');
    process.exit(1);
  });
