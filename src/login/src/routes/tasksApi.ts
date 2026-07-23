import { Router } from 'express';
import { apiError, type CreateLoginTaskRequest, type LoginTaskStatus } from '@ghcp/shared';
import { deleteTask, getTask, listTasks, listTasksPage, type LoginTaskRecord } from '../db/tasksRepo.js';
import { loginQueue } from '../db/queue.js';

export const tasksApiRouter = Router();
const LOGIN_TASK_STATUSES = new Set<LoginTaskStatus>(['pending', 'running', 'success', 'failed', 'cancelled']);

tasksApiRouter.get('/tasks', async (req, res) => {
  if (req.query.page !== undefined || req.query.pageSize !== undefined || req.query.q !== undefined || req.query.status !== undefined) {
    const status = stringQuery(req.query.status);
    if (status && !LOGIN_TASK_STATUSES.has(status as LoginTaskStatus)) {
      res.status(400).json(apiError('invalid_status', 'status is not a valid login task status.'));
      return;
    }
    res.json(await listTasksPage({
      q: stringQuery(req.query.q),
      status: status as LoginTaskStatus | undefined,
      page: numberQuery(req.query.page),
      pageSize: numberQuery(req.query.pageSize),
    }));
    return;
  }
  const limit = Number(req.query.limit ?? 100);
  res.json(await listTasks(Number.isInteger(limit) && limit > 0 ? limit : 100));
});

tasksApiRouter.post('/tasks', async (req, res) => {
  const parsed = readCreateTask(req.body);
  if (!parsed.ok) {
    res.status(400).json(apiError('invalid_login_task', parsed.error));
    return;
  }
  const task = await loginQueue.enqueue(parsed.value);
  res.status(202).json(taskToDto(task));
});

tasksApiRouter.get('/tasks/:id', async (req, res) => {
  const task = await getTask(req.params.id);
  if (!task) {
    res.status(404).json(apiError('task_not_found', 'Login task was not found.'));
    return;
  }
  res.json(taskToDto(task));
});

tasksApiRouter.post('/tasks/:id/cancel', async (req, res) => {
  const task = await loginQueue.cancel(req.params.id);
  if (!task) {
    res.status(404).json(apiError('task_not_found', 'Login task was not found.'));
    return;
  }
  res.json(taskToDto(task));
});

tasksApiRouter.delete('/tasks/:id', async (req, res) => {
  const result = await deleteTask(req.params.id);
  if (result === 'not_found') {
    res.status(404).json(apiError('task_not_found', 'Login task was not found.'));
    return;
  }
  if (result === 'not_allowed') {
    res.status(400).json(apiError('task_delete_not_allowed', 'Pending or running login tasks cannot be deleted.'));
    return;
  }
  res.status(204).end();
});

tasksApiRouter.post('/tasks/:id/retry', async (req, res) => {
  const task = await getTask(req.params.id);
  if (!task) {
    res.status(404).json(apiError('task_not_found', 'Login task was not found.'));
    return;
  }
  const parsed = readCreateTask({ ...req.body, identity: task.identity, ssoUser: task.ssoUser, ghLogin: task.ghLogin, ssoType: task.ssoType });
  if (!parsed.ok) {
    res.status(400).json(apiError('invalid_login_task', parsed.error));
    return;
  }
  const retried = await loginQueue.retry(task, parsed.value);
  res.status(202).json(taskToDto(retried));
});

function taskToDto(task: LoginTaskRecord) {
  return {
    id: task.id,
    identity: task.identity,
    ssoUser: task.ssoUser,
    ghLogin: task.ghLogin,
    ssoType: task.ssoType,
    status: task.status,
    attempts: task.attempts,
    failureReason: task.failureReason,
    // logPath omitted (removed from PostgreSQL schema)
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}

type ParseResult = { ok: true; value: CreateLoginTaskRequest } | { ok: false; error: string };

function readCreateTask(body: unknown): ParseResult {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (typeof value.identity !== 'string' || !value.identity.trim()) return { ok: false, error: 'identity is required.' };
  if (typeof value.ssoUser !== 'string' || !value.ssoUser.trim()) return { ok: false, error: 'ssoUser is required.' };
  if (typeof value.ghLogin !== 'string' || !value.ghLogin.trim()) return { ok: false, error: 'ghLogin is required.' };
  if (value.ssoType !== 'azure' && value.ssoType !== 'custom') return { ok: false, error: 'ssoType must be custom or azure.' };
  return {
    ok: true,
    value: {
      identity: value.identity.trim(),
      ssoUser: value.ssoUser.trim(),
      ssoPassword: typeof value.ssoPassword === 'string' ? value.ssoPassword : '',
      ghLogin: value.ghLogin.trim(),
      ssoType: value.ssoType,
      ssoUrl: typeof value.ssoUrl === 'string' && value.ssoUrl.trim() ? value.ssoUrl.trim() : undefined,
      accountType: value.accountType === 'business' || value.accountType === 'enterprise' ? value.accountType : undefined,
      selectorOverrides: isStringRecord(value.selectorOverrides) ? value.selectorOverrides : undefined,
    },
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && Object.values(value).every((v) => typeof v === 'string');
}

function stringQuery(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function numberQuery(value: unknown): number | undefined {
  const raw = typeof value === 'string' ? Number(value) : undefined;
  return Number.isFinite(raw) ? raw : undefined;
}
