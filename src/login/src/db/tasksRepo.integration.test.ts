/**
 * Integration tests for the login PostgreSQL tasksRepo against a real Postgres.
 *
 * Skipped entirely when TEST_DATABASE_URL is unset (exits 0 with a skip marker).
 *
 * Canonical setup sequence (same as database package integration tests):
 *   applyTestEncryptionEnv -> bare pg.Pool -> resetDatabase -> bare pool end -> login initPool
 * beforeEach: TRUNCATE login data tables only (never resetDatabase).
 *
 * IMPORTANT: the real tasksRepo functions do NOT take a `pool` argument; they
 * resolve the general pool internally via getGeneralPool(). Signatures used here
 * match the actual source in ./tasksRepo.ts:
 *   - createTask({ identity, ssoUser, ghLogin, ssoType })
 *   - getTask(id) / listTasks(limit?) / listTasksPage(query)
 *   - claimTask(taskId, workerId) -> attemptToken string | null   (single-winner)
 *   - markRunning(id, logPath) / markSuccess(id, token?) / markFailed(id, reason, token?)
 *   - markCancelled(id) / getActiveTaskForIdentity(identity)
 *   - recoverResultPendingTasks()
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hasTestDatabase, applyTestEncryptionEnv, resetDatabase } from '@ghcp/database/test-support';
import { initPool, getGeneralPool, closePool } from './pool.js';
import {
  createTask,
  getTask,
  listTasks,
  listTasksPage,
  claimTask,
  markRunning,
  markSuccess,
  markFailed,
  markCancelled,
  getActiveTaskForIdentity,
  recoverResultPendingTasks,
} from './tasksRepo.js';

if (!hasTestDatabase()) {
  describe('login tasksRepo integration (skipped: no TEST_DATABASE_URL)', () => {
    it('skip', { skip: 'TEST_DATABASE_URL not set' }, () => {});
  });
} else {
  describe('login tasksRepo integration', () => {
    before(async () => {
      applyTestEncryptionEnv();
      const barePool = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
      await resetDatabase(barePool);
      await barePool.end();
      // login's own pool singleton - runs validateClusterKeys against migrated cluster_metadata
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

    it('createTask creates a pending task with generation 1', async () => {
      const task = await createTask({ identity: 'user1', ssoUser: 'u1', ghLogin: 'g1', ssoType: 'custom' });
      assert.ok(task.id, 'expected a task id');
      assert.equal(task.identity, 'user1');
      assert.equal(task.ssoUser, 'u1');
      assert.equal(task.ghLogin, 'g1');
      assert.equal(task.ssoType, 'custom');
      assert.equal(task.status, 'pending');
      assert.equal(task.attempts, 0);
      // pg returns BIGINT as a string; coerce before comparing.
      assert.equal(BigInt(task.taskGeneration!), BigInt(1));
      assert.equal(task.resultPending, false);
    });

    it('createTask increments task_generation per identity', async () => {
      const first = await createTask({ identity: 'gen-user', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      const second = await createTask({ identity: 'gen-user', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      assert.equal(BigInt(first.taskGeneration!), BigInt(1));
      assert.equal(BigInt(second.taskGeneration!), BigInt(2));
    });

    it('getTask returns the created task and undefined for unknown id', async () => {
      const created = await createTask({ identity: 'user2', ssoUser: 'u2', ghLogin: 'g2', ssoType: 'azure' });
      const fetched = await getTask(created.id);
      assert.ok(fetched);
      assert.equal(fetched.id, created.id);
      assert.equal(fetched.ssoType, 'azure');

      const missing = await getTask('00000000-0000-0000-0000-000000000000');
      assert.equal(missing, undefined);
    });

    it('listTasks returns an array of tasks ordered newest first', async () => {
      const a = await createTask({ identity: 'l1', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      const b = await createTask({ identity: 'l2', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      const tasks = await listTasks();
      assert.ok(Array.isArray(tasks));
      assert.equal(tasks.length, 2);
      // created_at DESC: b (created later) should come before a
      const ids = tasks.map((t) => t.id);
      assert.ok(ids.includes(a.id));
      assert.ok(ids.includes(b.id));
      assert.equal(tasks[0]!.id, b.id);
    });

    it('listTasksPage returns { items, total, page, pageSize }', async () => {
      for (let i = 0; i < 3; i++) {
        await createTask({ identity: `page-${i}`, ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      }
      const page = await listTasksPage({ page: 1, pageSize: 2 });
      assert.equal(page.total, 3);
      assert.equal(page.page, 1);
      assert.equal(page.pageSize, 2);
      assert.equal(page.items.length, 2);
    });

    it('listTasksPage filters by status', async () => {
      const t = await createTask({ identity: 'filter-1', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      await createTask({ identity: 'filter-2', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      await markFailed(t.id, 'boom');

      const failed = await listTasksPage({ status: 'failed' });
      assert.equal(failed.total, 1);
      assert.equal(failed.items[0]!.id, t.id);

      const pending = await listTasksPage({ status: 'pending' });
      assert.equal(pending.total, 1);
    });

    it('claimTask marks a pending task as running and returns an attempt token', async () => {
      const task = await createTask({ identity: 'claim-1', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      const token = await claimTask(task.id, 'worker-1');
      assert.ok(token, 'expected a non-null attempt token');
      assert.equal(typeof token, 'string');

      const after = await getTask(task.id);
      assert.equal(after!.status, 'running');
      assert.equal(after!.attempts, 1);
      assert.equal(after!.currentAttemptToken, token);
    });

    it('second claimTask on the same task returns null (already claimed)', async () => {
      const task = await createTask({ identity: 'claim-2', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      const first = await claimTask(task.id, 'worker-1');
      assert.ok(first);
      const second = await claimTask(task.id, 'worker-2');
      assert.equal(second, null);
    });

    it('claimTask is single-winner for concurrent claims', async () => {
      const task = await createTask({ identity: 'race-1', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });

      // Both try to claim at once - one must win (non-null token), the other loses (null).
      const [result1, result2] = await Promise.all([
        claimTask(task.id, 'worker-a'),
        claimTask(task.id, 'worker-b'),
      ]);

      const winners = [result1, result2].filter((r) => r !== null);
      assert.strictEqual(winners.length, 1, 'exactly one claim must win');
    });

    it('markRunning transitions a task to running', async () => {
      const task = await createTask({ identity: 'run-1', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      const updated = await markRunning(task.id, '/logs/run-1.log');
      assert.equal(updated.status, 'running');
      assert.equal(updated.attempts, 1);
      assert.ok(updated.startedAt, 'expected startedAt to be set');
    });

    it('markSuccess transitions a task to success', async () => {
      const task = await createTask({ identity: 'ok-1', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      const token = await claimTask(task.id, 'worker-1');
      const updated = await markSuccess(task.id, token!);
      assert.equal(updated.status, 'success');
      assert.equal(updated.failureReason, undefined);
      assert.equal(updated.resultPending, false);
      assert.ok(updated.finishedAt, 'expected finishedAt to be set');
    });

    it('markSuccess with wrong attempt token does not transition (fencing)', async () => {
      const task = await createTask({ identity: 'ok-2', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      await claimTask(task.id, 'worker-1');
      const updated = await markSuccess(task.id, 'wrong-token');
      // Fencing token mismatch: state must remain running.
      assert.equal(updated.status, 'running');
    });

    it('markFailed transitions a task to failed with a reason', async () => {
      const task = await createTask({ identity: 'fail-1', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      const updated = await markFailed(task.id, 'device flow timeout');
      assert.equal(updated.status, 'failed');
      assert.equal(updated.failureReason, 'device flow timeout');
      assert.ok(updated.finishedAt);
    });

    it('markCancelled transitions a pending task to cancelled', async () => {
      const task = await createTask({ identity: 'cancel-1', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      const updated = await markCancelled(task.id);
      assert.ok(updated);
      assert.equal(updated.status, 'cancelled');
      assert.ok(updated.finishedAt);
    });

    it('markCancelled does not overwrite an already-success task (guarded)', async () => {
      const task = await createTask({ identity: 'cancel-2', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      await markSuccess(task.id);
      const updated = await markCancelled(task.id);
      // markCancelled returns the task unchanged when already terminal (success/failed).
      assert.ok(updated);
      assert.equal(updated.status, 'success');
    });

    it('markCancelled does not overwrite an already-failed task (guarded)', async () => {
      const task = await createTask({ identity: 'cancel-3', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });
      await markFailed(task.id, 'nope');
      const updated = await markCancelled(task.id);
      assert.ok(updated);
      assert.equal(updated.status, 'failed');
    });

    it('getActiveTaskForIdentity returns pending/running tasks and undefined otherwise', async () => {
      const task = await createTask({ identity: 'active-1', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });

      const pendingActive = await getActiveTaskForIdentity('active-1');
      assert.ok(pendingActive);
      assert.equal(pendingActive.id, task.id);

      await claimTask(task.id, 'worker-1');
      const runningActive = await getActiveTaskForIdentity('active-1');
      assert.ok(runningActive);
      assert.equal(runningActive.status, 'running');

      // Once terminal, no active task remains.
      await markSuccess(task.id);
      const noneActive = await getActiveTaskForIdentity('active-1');
      assert.equal(noneActive, undefined);

      const unknown = await getActiveTaskForIdentity('never-existed');
      assert.equal(unknown, undefined);
    });

    it('recoverResultPendingTasks marks stuck result-pending success tasks as failed (does NOT re-queue)', async () => {
      const task = await createTask({ identity: 'recover-1', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });

      // Put the task into the exact state recoverResultPendingTasks targets:
      //   status = 'success', result_pending = true, finished_at > 1 hour ago.
      // No repo function reaches this state, so drive it directly via SQL.
      await getGeneralPool().query(
        `UPDATE login.tasks
         SET status = 'success',
             result_pending = true,
             finished_at = now() - interval '2 hours'
         WHERE id = $1`,
        [task.id],
      );

      await recoverResultPendingTasks();

      const after = await getTask(task.id);
      assert.ok(after);
      // Per plan: recovery marks the task FAILED, not re-queued/pending.
      assert.equal(after.status, 'failed');
      assert.notEqual(after.status, 'pending');
      assert.ok(after.failureReason, 'expected a failure reason from recovery');
    });

    it('recoverResultPendingTasks leaves recent result-pending success tasks untouched', async () => {
      const task = await createTask({ identity: 'recover-2', ssoUser: 'u', ghLogin: 'g', ssoType: 'custom' });

      // Recent success (finished_at within the last hour) must NOT be recovered.
      await getGeneralPool().query(
        `UPDATE login.tasks
         SET status = 'success',
             result_pending = true,
             finished_at = now()
         WHERE id = $1`,
        [task.id],
      );

      await recoverResultPendingTasks();

      const after = await getTask(task.id);
      assert.equal(after!.status, 'success');
    });
  });
}
