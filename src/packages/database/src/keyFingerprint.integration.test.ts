import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  hasTestDatabase,
  applyTestEncryptionEnv,
  resetDatabase,
  TEST_DATA_ENCRYPTION_KEY,
  TEST_LOGIN_JOB_ENCRYPTION_KEY,
} from '@ghcp/database/test-support';
import { validateClusterKeys } from './keyFingerprint.js';

if (!hasTestDatabase()) {
  describe('keyFingerprint integration tests (skipped: no TEST_DATABASE_URL)', () => {
    it('skip', { skip: 'TEST_DATABASE_URL not set' }, () => {});
  });
} else {
  describe('validateClusterKeys integration', () => {
    const dataKey = Buffer.from(TEST_DATA_ENCRYPTION_KEY, 'base64');
    const loginKey = Buffer.from(TEST_LOGIN_JOB_ENCRYPTION_KEY, 'base64');
    // Distinct 32-byte keys used for mismatch scenarios.
    const otherDataKey = Buffer.alloc(32, 0xaa);
    const otherLoginKey = Buffer.alloc(32, 0xbb);

    let pool: pg.Pool;

    before(() => {
      applyTestEncryptionEnv();
      pool = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
      // Sanity: mismatch keys must be exactly 32 bytes.
      assert.equal(otherDataKey.length, 32);
      assert.equal(otherLoginKey.length, 32);
    });

    beforeEach(async () => {
      await resetDatabase(pool);
    });

    after(async () => {
      await pool.end();
    });

    it('first run inserts the fingerprint row and succeeds', async () => {
      await validateClusterKeys(pool, dataKey, loginKey);
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::int AS count FROM cluster_metadata WHERE id = 'singleton'`,
      );
      assert.equal(Number(rows[0]!.count), 1);
    });

    it('second run with the same keys succeeds (matching fingerprints)', async () => {
      await validateClusterKeys(pool, dataKey, loginKey);
      await validateClusterKeys(pool, dataKey, loginKey);
    });

    it('different DATA_ENCRYPTION_KEY after first insert throws a mismatch error', async () => {
      await validateClusterKeys(pool, dataKey, loginKey);
      await assert.rejects(
        () => validateClusterKeys(pool, otherDataKey, loginKey),
        /DATA_ENCRYPTION_KEY fingerprint mismatch/,
      );
    });

    it('different LOGIN_JOB_ENCRYPTION_KEY after first insert throws a mismatch error', async () => {
      await validateClusterKeys(pool, dataKey, loginKey);
      await assert.rejects(
        () => validateClusterKeys(pool, dataKey, otherLoginKey),
        /LOGIN_JOB_ENCRYPTION_KEY fingerprint mismatch/,
      );
    });
  });
}
