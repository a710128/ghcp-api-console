import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hasTestDatabase, applyTestEncryptionEnv, resetDatabase } from '@ghcp/database/test-support';
import { runMigrations, getMigrationVersion } from './migrate.js';

if (!hasTestDatabase()) {
  describe('migrate integration tests (skipped: no TEST_DATABASE_URL)', () => {
    it('skip', { skip: 'TEST_DATABASE_URL not set' }, () => {});
  });
} else {
  describe('migrate integration', () => {
    const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
    let pool: pg.Pool;

    before(() => {
      applyTestEncryptionEnv();
      pool = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
    });

    after(async () => {
      await pool.end();
    });

    it('getMigrationVersion returns null on an empty database (before any migration)', async () => {
      // Drop everything without re-migrating.
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

      const version = await getMigrationVersion(pool);
      assert.equal(version, null);
    });

    it('runMigrations applies migrations and is idempotent', async () => {
      await resetDatabase(pool);
      // Second run against an already-migrated DB must not throw.
      await runMigrations(pool, migrationsDir);
      await runMigrations(pool, migrationsDir);
    });

    it('_drizzle_migrations table has rows after migration', async () => {
      await resetDatabase(pool);
      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*)::int AS count FROM _drizzle_migrations',
      );
      assert.ok(Number(rows[0]!.count) > 0, 'expected at least one applied migration row');
    });

    it('getMigrationVersion returns a non-null migration hash after migration', async () => {
      await resetDatabase(pool);
      const version = await getMigrationVersion(pool);
      assert.equal(typeof version, 'string');
      assert.ok(version && version.length > 0, 'expected a non-empty migration hash');
    });
  });
}
