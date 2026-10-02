import { createHash } from 'node:crypto';
import type { CreateAppointmentInput } from '@appt/shared';
import type { Queryable } from '../../db/pool.js';

/**
 * Idempotency-Key storage for POST /api/appointments (table idempotency_keys).
 *
 * Every function runs on the booking transaction's client: the claim, the
 * booking and the stored response commit or roll back together, so a key is
 * never recorded without its booking, nor a booking left without its key.
 */

/** How long a key is honoured. After this it is free to describe a new booking. */
export const IDEMPOTENCY_TTL_HOURS = 24;

interface Owner {
  businessId: string;
  userId: string;
}

/**
 * Fingerprint of what the request asks for, after validation.
 *
 * Built from the parsed body, not the raw bytes, so a retry that serialises
 * the same booking differently (key order, whitespace, an omitted default)
 * still matches. A blank note is no note, as the repository stores it.
 */
export function fingerprint(input: CreateAppointmentInput): Buffer {
  const canonical = JSON.stringify([
    input.serviceId,
    input.date,
    input.time,
    input.notes || null,
    input.chatSessionId ?? null,
    input.source,
  ]);
  return createHash('sha256').update(canonical).digest();
}

/**
 * Claim a key for this request. True means this request owns it and should
 * book; false means another request already completed with it.
 *
 * The insert is the lock: a concurrent request with the same key blocks here
 * until the holder commits (then this returns false) or rolls back (then this
 * insert goes through). An expired row is taken over in the same statement.
 */
export async function claim(client: Queryable, owner: Owner, key: string, hash: Buffer): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO idempotency_keys (business_id, user_id, key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, user_id, key) DO UPDATE
       SET request_hash = EXCLUDED.request_hash, appointment_id = NULL, response = NULL, created_at = now()
       WHERE idempotency_keys.created_at < now() - make_interval(hours => $5)`,
    [owner.businessId, owner.userId, key, hash, IDEMPOTENCY_TTL_HOURS],
  );
  return (rowCount ?? 0) > 0;
}

/** The completed request a key belongs to. Only called after `claim` returned false. */
export async function find(
  client: Queryable,
  owner: Owner,
  key: string,
): Promise<{ requestHash: Buffer; response: unknown }> {
  const { rows } = await client.query<{ request_hash: Buffer; response: unknown }>(
    `SELECT request_hash, response FROM idempotency_keys
     WHERE business_id = $1 AND user_id = $2 AND key = $3`,
    [owner.businessId, owner.userId, key],
  );
  const row = rows[0];
  // claim() saw a committed, unexpired row, and rows are only ever committed
  // with their response; nothing deletes one inside the TTL.
  if (!row?.response) throw new Error(`Idempotency key row missing or incomplete for ${key}`);
  return { requestHash: row.request_hash, response: row.response };
}

export async function saveResponse(
  client: Queryable,
  owner: Owner,
  key: string,
  appointmentId: string,
  response: object,
): Promise<void> {
  await client.query(
    `UPDATE idempotency_keys SET appointment_id = $4, response = $5
     WHERE business_id = $1 AND user_id = $2 AND key = $3`,
    [owner.businessId, owner.userId, key, appointmentId, JSON.stringify(response)],
  );
}
