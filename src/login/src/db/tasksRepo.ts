/**
 * PostgreSQL implementation of the login tasks repository.
 * Replaces the SQLite tasksRepo.ts.
 *
 * Key design differences from SQLite version:
 * - All functions are async
 * - login_tasks uses monotonic task_generation and current_attempt_token fencing
 * - Task secrets are stored encrypted in login.task_secrets
 * - Job outbox is managed via login.job_outbox for at-least-once pg-boss publishing
 */
import type { LoginTaskDto, LoginTaskStatus, PageResponse, SsoType } from '@ghcp/shared';
import { pageResponse } from '@ghcp/shared';
import { randomUUID } from 'node:crypto';
import { getGeneralPool } from './pool.js';

export interface LoginTaskRecord extends LoginTaskDto {
  ssoType: SsoType;
  taskGeneration?: bigint;
  currentAttemptToken?: string;
  resultPending?: boolean;
}

interface TaskRow {
  id: string;
  identity: string;
  sso_user: string;
  gh_login: string | null;
  sso_type: SsoType;
  status: LoginTaskStatus;
  attempts: number;
  failure_reason: string | null;
  task_generation: bigint;
  current_attempt_token: string | null;
  result_pending: boolean;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function mapRow(row: TaskRow): LoginTaskRecord {
  return {
    id: row.id,
    identity: row.identity,
    ssoUser: row.sso_user,
    ghLogin: row.gh_login ?? undefined,
    ssoType: row.sso_type,
    status: row.status,
    attempts: row.attempts,
    failureReason: row.failure_reason ?? undefined,
    taskGeneration: row.task_generation,
    currentAttemptToken: row.current_attempt_token ?? undefined,
    resultPending: row.result_pending,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString(),
    finishedAt: row.finished_at?.toISOString(),
    // logPath not in PostgreSQL schema (removed per plan spec)
  };
}

export async function createTask(input: {
  identity: string;
  ssoUser: string;
  ghLogin: string;
  ssoType: SsoType;
}): Promise<LoginTaskRecord> {
  const pool = getGeneralPool();
  const id = randomUUID();
  // Get max task_generation for this identity
  const genResult = await pool.query<{ max_gen: bigint | null }>(
    'SELECT MAX(task_generation) AS max_gen FROM login.tasks WHERE identity = $1',
    [input.identity],
  );
  const nextGen = BigInt(genResult.rows[0]?.max_gen ?? 0) + BigInt(1);

  await pool.query(
    `INSERT INTO login.tasks (id, identity, sso_user, gh_login, sso_type, status, attempts, task_generation, result_pending, created_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, false, now())`,
    [id, input.identity, input.ssoUser, input.ghLogin, input.ssoType, nextGen],
  );
  return (await getTask(id))!;
}

export async function getTask(id: string): Promise<LoginTaskRecord | undefined> {
  const pool = getGeneralPool();
  const res = await pool.query<TaskRow>('SELECT * FROM login.tasks WHERE id = $1', [id]);
  return res.rows[0] ? mapRow(res.rows[0]) : undefined;
}

export async function listTasks(limit = 100): Promise<LoginTaskRecord[]> {
  const pool = getGeneralPool();
  const res = await pool.query<TaskRow>('SELECT * FROM login.tasks ORDER BY created_at DESC LIMIT $1', [limit]);
  return res.rows.map(mapRow);
}

export async function listTasksPage(query: {
  q?: string;
  status?: LoginTaskStatus;
  page?: number;
  pageSize?: number;
} = {}): Promise<PageResponse<LoginTaskRecord>> {
  const pool = getGeneralPool();
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
  const requestedPage = Math.max(1, Math.trunc(query.page ?? 1));
  const conditions: string[] = [];
  const args: unknown[] = [];

  if (query.q?.trim()) {
    const q = `%${query.q.trim()}%`;
    conditions.push(`(id ILIKE $${args.length + 1} OR identity ILIKE $${args.length + 1} OR sso_user ILIKE $${args.length + 1} OR gh_login ILIKE $${args.length + 1} OR failure_reason ILIKE $${args.length + 1})`);
    args.push(q);
  }
  if (query.status) {
    conditions.push(`status = $${args.length + 1}`);
    args.push(query.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const countRes = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM login.tasks ${where}`, args);
  const total = parseInt(countRes.rows[0]!.count, 10);
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
  const listRes = await pool.query<TaskRow>(
    `SELECT * FROM login.tasks ${where} ORDER BY created_at DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
    [...args, pageSize, (page - 1) * pageSize],
  );
  return pageResponse(listRes.rows.map(mapRow), total, page, pageSize);
}

/**
 * Atomically claim a task for a worker (sets current_attempt_token and marks running).
 * Returns the claim token if successful, null if the task was already claimed/cancelled.
 */
export async function claimTask(taskId: string, workerId: string): Promise<string | null> {
  const pool = getGeneralPool();
  const attemptToken = randomUUID();
  const res = await pool.query(
    `UPDATE login.tasks
     SET status = 'running',
         attempts = attempts + 1,
         current_attempt_token = $1,
         started_at = now(),
         finished_at = NULL,
         failure_reason = NULL
     WHERE id = $2
       AND status = 'pending'
       AND current_attempt_token IS NULL
     RETURNING id`,
    [attemptToken, taskId],
  );
  return res.rowCount === 1 ? attemptToken : null;
}

export async function markRunning(id: string, _logPath: string): Promise<LoginTaskRecord> {
  // logPath removed from PostgreSQL schema; kept for API compatibility
  const pool = getGeneralPool();
  await pool.query(
    `UPDATE login.tasks SET status = 'running', attempts = attempts + 1, started_at = now(), finished_at = NULL, failure_reason = NULL WHERE id = $1`,
    [id],
  );
  return (await getTask(id))!;
}

export async function markSuccess(id: string, attemptToken?: string): Promise<LoginTaskRecord> {
  const pool = getGeneralPool();
  if (attemptToken) {
    await pool.query(
      `UPDATE login.tasks SET status = 'success', finished_at = now(), failure_reason = NULL, result_pending = false WHERE id = $1 AND current_attempt_token = $2`,
      [id, attemptToken],
    );
  } else {
    await pool.query(
      `UPDATE login.tasks SET status = 'success', finished_at = now(), failure_reason = NULL, result_pending = false WHERE id = $1`,
      [id],
    );
  }
  return (await getTask(id))!;
}

export async function markFailed(id: string, reason: string, attemptToken?: string): Promise<LoginTaskRecord> {
  const pool = getGeneralPool();
  if (attemptToken) {
    await pool.query(
      `UPDATE login.tasks SET status = 'failed', finished_at = now(), failure_reason = $1 WHERE id = $2 AND current_attempt_token = $3`,
      [reason.slice(0, 2000), id, attemptToken],
    );
  } else {
    await pool.query(
      `UPDATE login.tasks SET status = 'failed', finished_at = now(), failure_reason = $1 WHERE id = $2`,
      [reason.slice(0, 2000), id],
    );
  }
  return (await getTask(id))!;
}

export async function markCancelled(id: string): Promise<LoginTaskRecord | undefined> {
  const task = await getTask(id);
  if (!task || task.status === 'success' || task.status === 'failed') return task;
  const pool = getGeneralPool();
  await pool.query(
    `UPDATE login.tasks SET status = 'cancelled', finished_at = now(), failure_reason = 'Cancelled by request.' WHERE id = $1`,
    [id],
  );
  return getTask(id);
}

export async function deleteTask(id: string): Promise<'deleted' | 'not_found' | 'not_allowed'> {
  const task = await getTask(id);
  if (!task) return 'not_found';
  if (task.status === 'pending' || task.status === 'running') return 'not_allowed';
  const pool = getGeneralPool();
  await pool.query('DELETE FROM login.tasks WHERE id = $1', [id]);
  return 'deleted';
}

/**
 * Get active task for identity (pending or running), used for duplicate detection.
 */
export async function getActiveTaskForIdentity(identity: string): Promise<LoginTaskRecord | undefined> {
  const pool = getGeneralPool();
  const res = await pool.query<TaskRow>(
    `SELECT * FROM login.tasks WHERE identity = $1 AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1`,
    [identity],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : undefined;
}

/**
 * Mark tasks with result_pending=true that have been retried too many times as failed.
 * Used by startup recovery.
 */
export async function recoverResultPendingTasks(): Promise<void> {
  const pool = getGeneralPool();
  await pool.query(
    `UPDATE login.tasks SET status = 'failed', finished_at = now(), failure_reason = 'Login service restarted before result was written back.'
     WHERE result_pending = true AND status = 'success'
       AND finished_at < now() - interval '1 hour'`,
  );
}
