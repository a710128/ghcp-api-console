import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {
  hasTestDatabase,
  applyTestEncryptionEnv,
  resetDatabase,
  TEST_LOGIN_JOB_ENCRYPTION_KEY,
} from '@ghcp/database/test-support';
import { createOrCoalesceLoginTaskTx } from './loginTask.js';
import type { CreateOrCoalesceTaskInput } from './loginTask.js';

if (!hasTestDatabase()) {
  describe('loginTask integration tests (skipped: no TEST_DATABASE_URL)', () => {
    it('skip', { skip: 'TEST_DATABASE_URL not set' }, () => {});
  });
} else {
  describe('createOrCoalesceLoginTaskTx integration', () => {
    const loginKey = Buffer.from(TEST_LOGIN_JOB_ENCRYPTION_KEY, 'base64');
    let pool: pg.Pool;

    const baseInput: CreateOrCoalesceTaskInput = {
      identity: 'alice',
      ssoUser: 'alice-sso',
      ghLogin: 'alice-gh',
      ssoType: 'custom',
      ssoPassword: 'super-secret-password',
    };

    before(() => {
      applyTestEncryptionEnv();
      pool = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
    });

    beforeEach(async () => {
      await resetDatabase(pool);
    });

    after(async () => {
      await pool.end();
    });

    it('creates a new task on first call (created === true)', async () => {
      const result = await createOrCoalesceLoginTaskTx(pool, loginKey, baseInput);
      assert.equal(result.created, true);
      assert.ok(result.task.id, 'expected a task id');

      // A task_secrets row and a job_outbox row must have been created.
      const secrets = await pool.query<{ count: string }>(
        'SELECT count(*)::int AS count FROM login.task_secrets WHERE task_id = $1',
        [result.task.id],
      );
      assert.equal(Number(secrets.rows[0]!.count), 1);

      const outbox = await pool.query<{ count: string }>(
        'SELECT count(*)::int AS count FROM login.job_outbox WHERE task_id = $1',
        [result.task.id],
      );
      assert.equal(Number(outbox.rows[0]!.count), 1);
    });

    it('coalesces to the existing task on a second call with the same identity (created === false)', async () => {
      const first = await createOrCoalesceLoginTaskTx(pool, loginKey, baseInput);
      assert.equal(first.created, true);

      const second = await createOrCoalesceLoginTaskTx(pool, loginKey, baseInput);
      assert.equal(second.created, false);
      assert.equal(second.task.id, first.task.id);

      // Only a single task row should exist for the identity.
      const tasks = await pool.query<{ count: string }>(
        'SELECT count(*)::int AS count FROM login.tasks WHERE identity = $1',
        [baseInput.identity],
      );
      assert.equal(Number(tasks.rows[0]!.count), 1);
    });

    it('returned task carries the correct identity/ssoUser/ghLogin/ssoType', async () => {
      const result = await createOrCoalesceLoginTaskTx(pool, loginKey, baseInput);
      assert.equal(result.task.identity, baseInput.identity);
      assert.equal(result.task.sso_user, baseInput.ssoUser);
      assert.equal(result.task.gh_login, baseInput.ghLogin);
      assert.equal(result.task.sso_type, baseInput.ssoType);
      assert.equal(result.task.status, 'pending');
    });
  });
}
