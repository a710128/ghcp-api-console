/**
 * Integration tests for the login PostgreSQL-backed queue against a real Postgres.
 *
 * Skipped entirely when TEST_DATABASE_URL is unset (exits 0 with a skip marker).
 *
 * The queue does NOT use pg-boss here. enqueueLoginTask writes to login.tasks
 * AND login.job_outbox via createOrCoalesceLoginTaskTx. We do not run any worker;
 * we only assert the durable rows that enqueue/cancel/retry produce.
 *
 * Real signatures (see ./queue.ts):
 *   - enqueueLoginTask(request: CreateLoginTaskRequest) -> LoginTaskRecord
 *   - cancelLoginTask(id) -> LoginTaskRecord | undefined
 *   - retryLoginTask(taskId, request) -> LoginTaskRecord   (delegates to enqueueLoginTask)
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { CreateLoginTaskRequest } from '@ghcp/shared';
import pg from 'pg';
import { hasTestDatabase, applyTestEncryptionEnv, resetDatabase } from '@ghcp/database/test-support';
import { initPool, getGeneralPool, closePool } from './pool.js';
import { enqueueLoginTask, cancelLoginTask, retryLoginTask } from './queue.js';
import { markSuccess } from './tasksRepo.js';

function req(overrides: Partial<CreateLoginTaskRequest> = {}): CreateLoginTaskRequest {
  return {
    identity: 'queue-user',
    ssoUser: 'queue-sso',
    ssoPassword: 'secret-password',
    ghLogin: 'queue-gh',
    ssoType: 'custom',
    ...overrides,
  };
}

if (!hasTestDatabase()) {
  describe('login queue integration (skipped: no TEST_DATABASE_URL)', () => {
    it('skip', { skip: 'TEST_DATABASE_URL not set' }, () => {});
  });
} else {
  describe('login queue integration', () => {
    before(async () => {
      applyTestEncryptionEnv();
      const barePool = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
      await resetDatabase(barePool);
      await barePool.end();
      await initPool();
    });

    beforeEach(async () => {
      await getGeneralPool().query(`
        TRUNCATE login.tasks, login.task_secrets, login.job_outbox, login.result_outbox
        RESTART IDENTITY CASCADE
      `);
    });

    after(async () => {
      await closePool();
    });

    it('enqueueLoginTask creates a pending task plus job_outbox and task_secrets rows', async () => {
      const task = await enqueueLoginTask(req({ identity: 'enq-1' }));
      assert.ok(task.id);
      assert.equal(task.identity, 'enq-1');
      assert.equal(task.status, 'pending');

      const outbox = await getGeneralPool().query(
        'SELECT * FROM login.job_outbox WHERE task_id = $1',
        [task.id],
      );
      assert.equal(outbox.rowCount, 1, 'expected exactly one job_outbox row');
      assert.equal(outbox.rows[0]!.state, 'pending');

      const secrets = await getGeneralPool().query(
        'SELECT * FROM login.task_secrets WHERE task_id = $1',
        [task.id],
      );
      assert.equal(secrets.rowCount, 1, 'expected exactly one task_secrets row');
    });

    it('second enqueueLoginTask for the same identity coalesces (no duplicate task)', async () => {
      const first = await enqueueLoginTask(req({ identity: 'coalesce-1' }));
      const second = await enqueueLoginTask(req({ identity: 'coalesce-1' }));

      // Coalesced: same task id returned, no new row created.
      assert.equal(second.id, first.id);

      const count = await getGeneralPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM login.tasks WHERE identity = $1`,
        ['coalesce-1'],
      );
      assert.equal(parseInt(count.rows[0]!.count, 10), 1, 'expected only one task for the identity');

      const outboxCount = await getGeneralPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM login.job_outbox WHERE task_id = $1`,
        [first.id],
      );
      assert.equal(parseInt(outboxCount.rows[0]!.count, 10), 1, 'expected only one job_outbox row');
    });

    it('cancelLoginTask cancels a pending task', async () => {
      const task = await enqueueLoginTask(req({ identity: 'cancel-q-1' }));
      const cancelled = await cancelLoginTask(task.id);
      assert.ok(cancelled);
      assert.equal(cancelled.status, 'cancelled');
      assert.ok(cancelled.finishedAt);
    });

    it('cancelLoginTask on unknown id returns undefined', async () => {
      const result = await cancelLoginTask('00000000-0000-0000-0000-000000000000');
      assert.equal(result, undefined);
    });

    it('retryLoginTask provisions a new attempt from a finished task', async () => {
      // First lifecycle: enqueue then drive to a terminal state so retry is not coalesced.
      const first = await enqueueLoginTask(req({ identity: 'retry-1' }));
      await markSuccess(first.id);

      const retried = await retryLoginTask(first.id, req({ identity: 'retry-1' }));

      // A brand new pending task must be created (new generation), not the finished one.
      assert.notEqual(retried.id, first.id);
      assert.equal(retried.status, 'pending');
      assert.equal(BigInt(retried.taskGeneration!), BigInt(2));

      const count = await getGeneralPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM login.tasks WHERE identity = $1`,
        ['retry-1'],
      );
      assert.equal(parseInt(count.rows[0]!.count, 10), 2, 'expected two task rows after retry');

      // New generation has its own job_outbox row.
      const outbox = await getGeneralPool().query(
        `SELECT * FROM login.job_outbox WHERE task_id = $1`,
        [retried.id],
      );
      assert.equal(outbox.rowCount, 1);
    });

    it('retryLoginTask coalesces onto an active (pending) task instead of duplicating', async () => {
      const first = await enqueueLoginTask(req({ identity: 'retry-coalesce-1' }));
      // Task is still pending (active) -> retry must coalesce to the same task.
      const retried = await retryLoginTask(first.id, req({ identity: 'retry-coalesce-1' }));
      assert.equal(retried.id, first.id);

      const count = await getGeneralPool().query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM login.tasks WHERE identity = $1`,
        ['retry-coalesce-1'],
      );
      assert.equal(parseInt(count.rows[0]!.count, 10), 1);
    });
  });
}
