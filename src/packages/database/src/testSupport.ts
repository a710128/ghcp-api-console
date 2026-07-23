import * as pg from 'pg';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './migrate.js';

// Deterministic 32-byte base64 keys for testing.
// Both decode to exactly 32 bytes: Buffer.from(KEY, 'base64').length === 32
export const TEST_DATA_ENCRYPTION_KEY = 'oZF04IP6wOOEd0hGhTWE9C/wNAogY/NZorDNyDiqwLc=';
export const TEST_LOGIN_JOB_ENCRYPTION_KEY = 'eZVg99hIYJ9tjiSAN2kO4JV6m5TzMvBDZYMZe368+8o=';

/**
 * Populate process.env with the test database URL and encryption keys so that
 * getDatabaseConfig() succeeds. Only sets env vars; never opens a connection.
 */
export function applyTestEncryptionEnv(): void {
  process.env['DATABASE_URL'] = process.env['TEST_DATABASE_URL'];
  process.env['DB_APPLICATION_NAME'] = 'ghcp-test';
  process.env['DATA_ENCRYPTION_KEY'] = TEST_DATA_ENCRYPTION_KEY;
  process.env['LOGIN_JOB_ENCRYPTION_KEY'] = TEST_LOGIN_JOB_ENCRYPTION_KEY;
}

/**
 * Returns true when TEST_DATABASE_URL is set. Performs no connection attempt.
 */
export function hasTestDatabase(): boolean {
  return !!process.env['TEST_DATABASE_URL'];
}

/**
 * Reset the database to a clean, freshly-migrated state.
 *
 * Drops the proxy/sso/login schemas plus the public migration-tracking and
 * cluster-metadata tables in a single statement sequence, then re-applies all
 * migrations. The caller owns the pool; this function never creates one.
 */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      DROP SCHEMA IF EXISTS proxy CASCADE;
      DROP SCHEMA IF EXISTS sso CASCADE;
      DROP SCHEMA IF EXISTS login CASCADE;
      DROP TABLE IF EXISTS public._drizzle_migrations;
      DROP TABLE IF EXISTS public.cluster_metadata;
    `);
  } finally {
    client.release();
  }

  // Migrations dir is at src/packages/database/migrations relative to this file
  // (src/packages/database/src/testSupport.ts).
  const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
  await runMigrations(pool, migrationsDir);
}

export interface MockFetchResponse {
  status: number;
  jsonBody?: unknown;
  textBody?: string;
  headers?: Record<string, string>;
}

export interface MockFetchCall {
  url: string;
  options?: RequestInit;
}

/**
 * Build a stub fetch that returns queued responses in order and records every
 * call. Throws once the queue is exhausted.
 */
export function mockFetch(responses: MockFetchResponse[]): {
  fetch: typeof globalThis.fetch;
  calls: MockFetchCall[];
} {
  const calls: MockFetchCall[] = [];
  const queue = [...responses];

  const fetch = async (
    url: string | URL | Request,
    options?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: url.toString(), options });
    const response = queue.shift();
    if (!response) throw new Error('mockFetch: no more queued responses');

    const body =
      response.jsonBody !== undefined
        ? JSON.stringify(response.jsonBody)
        : (response.textBody ?? '');

    const headers = new Headers(response.headers ?? {});
    if (response.jsonBody !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    return new Response(body, { status: response.status, headers });
  };

  return { fetch: fetch as typeof globalThis.fetch, calls };
}
