/**
 * PostgreSQL advisory lock helper for cross-replica coordination.
 *
 * Uses session-level advisory locks via pg_try_advisory_lock(ns, key) where:
 * - ns: fixed integer namespace (e.g. hashtext('proxy:init'))
 * - key: hashtext(identity) — deterministic 32-bit hash
 *
 * The coordination pool is used exclusively for advisory locks.
 * Lock clients are NEVER returned to the pool if unlock fails.
 *
 * Design:
 * - Lock is acquired with pg_try_advisory_lock (non-blocking)
 * - If lock not available: return immediately with lockAcquired=false
 * - If lock acquired: execute work function, then release in finally
 * - If release fails: destroy the client (don't return to pool)
 */
import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';

/**
 * Fixed namespaces for different coordination domains.
 * Values are deterministic int32 hashes of the namespace string.
 */
export const ADVISORY_NAMESPACES = {
  PROXY_INIT: hashNamespace('proxy:init'),
  PROXY_REFRESH: hashNamespace('proxy:refresh'),
  SSO_SCIM: hashNamespace('sso:scim'),
  LOGIN_WORKER: hashNamespace('login:worker'),
} as const;

function hashNamespace(name: string): number {
  const hash = createHash('sha256').update(name).digest();
  // Read first 4 bytes as signed int32 (big-endian)
  return hash.readInt32BE(0);
}

/**
 * Hash a string key to a PostgreSQL int4 for use as the second advisory lock key.
 * Uses the same algorithm as PostgreSQL's hashtext() for compatibility.
 * We use SHA-256 truncated to int32 as a portable approximation.
 */
function hashKey(key: string): number {
  const hash = createHash('sha256').update(key).digest();
  return hash.readInt32BE(4); // Use bytes 4-7 for the key hash
}

export interface AdvisoryLockResult<T> {
  lockAcquired: boolean;
  result?: T;
}

/**
 * Try to acquire a PostgreSQL session-level advisory lock and execute work.
 * Returns {lockAcquired: false} immediately if lock is not available.
 * The coordination pool client is never used for regular queries.
 *
 * @param pool - The coordination pool (NOT the general pool)
 * @param namespace - Fixed namespace int (from ADVISORY_NAMESPACES)
 * @param key - Variable string key (identity, etc.)
 * @param work - Async function to execute while holding the lock
 */
export async function withPostgresAdvisoryLock<T>(
  pool: Pool,
  namespace: number,
  key: string,
  work: () => Promise<T>,
): Promise<AdvisoryLockResult<T>> {
  const keyHash = hashKey(key);
  let client: PoolClient | null = null;
  let lockAcquired = false;

  try {
    client = await pool.connect();

    // Try to acquire session-level advisory lock (non-blocking)
    const lockResult = await client.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2)',
      [namespace, keyHash],
    );

    lockAcquired = lockResult.rows[0]?.pg_try_advisory_lock === true;
    if (!lockAcquired) {
      client.release();
      client = null;
      return { lockAcquired: false };
    }

    // Execute work while holding lock
    const result = await work();
    return { lockAcquired: true, result };
  } finally {
    if (client && lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [namespace, keyHash]);
        client.release();
      } catch {
        // Unlock failed — destroy the client so it's not reused
        client.release(true);
      }
    } else if (client) {
      client.release();
    }
  }
}
