import * as pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS _drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL
  )
`;

/**
 * Apply SQL migration files from migrationsDir that have not yet been applied.
 * Migration filenames must end in .sql and are applied in lexicographic order.
 * Each migration is tracked by its filename (without .sql) as the hash.
 */
export async function runMigrations(pool: pg.Pool, migrationsDir: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(MIGRATIONS_TABLE);

    let files: string[];
    try {
      files = readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    } catch {
      // No migrations directory yet or empty — nothing to run
      return;
    }

    if (files.length === 0) return;

    const { rows: applied } = await client.query<{ hash: string }>(
      'SELECT hash FROM _drizzle_migrations ORDER BY id',
    );
    const appliedSet = new Set(applied.map((r) => r.hash));

    for (const file of files) {
      const hash = file.replace(/\.sql$/, '');
      if (appliedSet.has(hash)) continue;

      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _drizzle_migrations (hash, created_at) VALUES ($1, $2)', [
          hash,
          Date.now(),
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    client.release();
  }
}

/**
 * Returns the hash of the most recently applied migration, or null if none.
 */
export async function getMigrationVersion(pool: pg.Pool): Promise<string | null> {
  const client = await pool.connect();
  try {
    try {
      const { rows } = await client.query<{ hash: string }>(
        'SELECT hash FROM _drizzle_migrations ORDER BY id DESC LIMIT 1',
      );
      return rows[0]?.hash ?? null;
    } catch {
      return null;
    }
  } finally {
    client.release();
  }
}
