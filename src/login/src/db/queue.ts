/**
 * PostgreSQL-backed login queue.
 * Replaces the in-memory LoginQueue with durable pg-boss jobs via createOrCoalesceLoginTaskTx.
 *
 * The queue's public API is preserved for route compatibility.
 * Under the hood:
 * - enqueue() → createOrCoalesceLoginTaskTx() (atomic task + secret + outbox creation)
 * - cancel() → marks the task cancelled in PostgreSQL
 * - retry() → creates a new task via createOrCoalesceLoginTaskTx()
 */
import type { CreateLoginTaskRequest } from '@ghcp/shared';
import { loggerFor } from '@ghcp/shared';
import { createOrCoalesceLoginTaskTx } from '@ghcp/database';
import { getGeneralPool, getLoginJobEncryptionKey } from './pool.js';
import { markCancelled, getTask, getActiveTaskForIdentity, type LoginTaskRecord } from './tasksRepo.js';

const logger = loggerFor('login', 'queue');

/**
 * Enqueue a login task via the durable createOrCoalesceLoginTaskTx primitive.
 * Returns the existing task if one is already pending/running for this identity.
 */
export async function enqueueLoginTask(request: CreateLoginTaskRequest): Promise<LoginTaskRecord> {
  const pool = getGeneralPool();
  const loginKey = getLoginJobEncryptionKey();

  const result = await createOrCoalesceLoginTaskTx(pool, loginKey, {
    identity: request.identity,
    ssoUser: request.ssoUser,
    ghLogin: request.ghLogin,
    ssoType: request.ssoType,
    ssoUrl: request.ssoUrl,
    ssoPassword: request.ssoPassword,
    selectorOverrides: request.selectorOverrides,
  });

  if (result.created) {
    logger.info('enqueue', 'Created new durable login task', {
      taskId: result.task.id,
      identity: result.task.identity,
      ssoUser: result.task.sso_user,
      taskGeneration: result.task.task_generation?.toString(),
    });
  } else {
    logger.info('enqueue-coalesced', 'Returning existing active task (duplicate request)', {
      taskId: result.task.id,
      identity: result.task.identity,
      status: result.task.status,
    });
  }

  // Map LoginTaskRow to LoginTaskRecord
  const task = await getTask(result.task.id);
  return task!;
}

/**
 * Cancel a login task. Returns the updated task or undefined if not found.
 */
export async function cancelLoginTask(id: string): Promise<LoginTaskRecord | undefined> {
  const task = await markCancelled(id);
  logger.info('cancel', 'Cancelled login task', { taskId: id, status: task?.status });
  return task;
}

/**
 * Retry a login task by creating a new task for the same identity.
 * Returns the new task.
 */
export async function retryLoginTask(taskId: string, request: CreateLoginTaskRequest): Promise<LoginTaskRecord> {
  return enqueueLoginTask(request);
}

// Compatibility: named exports matching old queue interface
export const loginQueue = {
  async enqueue(request: CreateLoginTaskRequest): Promise<LoginTaskRecord> {
    return enqueueLoginTask(request);
  },
  async cancel(id: string): Promise<LoginTaskRecord | undefined> {
    return cancelLoginTask(id);
  },
  async retry(task: LoginTaskRecord, request: CreateLoginTaskRequest): Promise<LoginTaskRecord> {
    return retryLoginTask(task.id, request);
  },
};
