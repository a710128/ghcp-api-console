/**
 * PostgreSQL-backed SCIM rate limiting.
 * Replaces the process-local nextScimRequestAt variable.
 * Uses sso.scim_rate_limits singleton row with SELECT FOR UPDATE.
 */
import { getGeneralPool } from '../db/pool.js';

interface ScimRateLimitRow {
  id: string;
  next_allowed_at: Date;
}

/**
 * Reserve a SCIM request slot.
 * Atomically advances next_allowed_at by scimRequestDelayMs.
 * Returns the number of milliseconds to wait before making the SCIM request.
 * Call this BEFORE each SCIM request, then sleep for the returned duration.
 */
export async function reserveScimSlot(scimRequestDelayMs: number): Promise<number> {
  const pool = getGeneralPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<ScimRateLimitRow>(
      'SELECT * FROM sso.scim_rate_limits WHERE id = $1 FOR UPDATE',
      ['singleton'],
    );
    const row = res.rows[0];
    const now = new Date();
    const nextAllowedAt = row?.next_allowed_at ?? now;
    const waitMs = Math.max(0, nextAllowedAt.getTime() - now.getTime());

    // Advance next_allowed_at to max(now, nextAllowedAt) + delay
    const newNextAllowedAt = new Date(Math.max(now.getTime(), nextAllowedAt.getTime()) + scimRequestDelayMs);
    await client.query(
      'UPDATE sso.scim_rate_limits SET next_allowed_at = $1 WHERE id = $2',
      [newNextAllowedAt, 'singleton'],
    );
    await client.query('COMMIT');
    return waitMs;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
