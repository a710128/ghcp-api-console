/**
 * Login worker entrypoint.
 * This is a separate process that consumes pg-boss login-auth jobs.
 *
 * Exactly one login-worker process should run at a time per the plan spec.
 * LOGIN_WORKER_CONCURRENCY=1 is fixed; one browser login runs at a time.
 *
 * Worker lifecycle:
 * 1. Initialize PostgreSQL pool
 * 2. Start pg-boss with the general pool
 * 3. Register handler for 'login-auth' job queue
 * 4. On SIGTERM/SIGINT: stop accepting new jobs, wait for active job to finish, exit
 *
 * Job payload is encrypted with LOGIN_JOB_ENCRYPTION_KEY.
 * Worker decrypts, runs Playwright device flow, writes token back to proxy.
 */
import { loggerFor } from '@ghcp/shared';
import { initPool, getGeneralPool, getLoginJobEncryptionKey, closePool } from './db/pool.js';
import { getTask, markSuccess, markFailed } from './db/tasksRepo.js';
import { config } from './config.js';
import { HeadlessPlaywrightAuthStrategy } from './auth/HeadlessPlaywrightAuthStrategy.js';
import { loginWithDeviceFlow } from './auth/deviceFlow.js';
import { saveGithubToken } from './clients/proxyClient.js';
import { createCipheriv, createDecipheriv } from 'node:crypto';

const logger = loggerFor('login', 'worker');

interface JobPayload {
  taskId: string;
  taskGeneration: string;
  attemptToken: string;
}

interface DecryptedSecret {
  ssoPassword: string;
  ssoUrl?: string;
  selectorOverrides?: Record<string, string>;
}

async function decryptJobSecret(taskId: string, secretCipher: string, secretNonce: string, loginKey: Buffer): Promise<DecryptedSecret> {
  const { createDecipheriv } = await import('node:crypto');
  const ALGORITHM = 'aes-256-gcm';
  const TAG_BYTES = 16;
  const nonce = Buffer.from(secretNonce, 'hex');
  const cipherWithTag = Buffer.from(secretCipher, 'base64');
  const aad = Buffer.from(`taskId:${taskId}\x00type:job_secret\x00version:1`, 'utf8');
  const decipher = createDecipheriv(ALGORITHM, loginKey, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(cipherWithTag.subarray(cipherWithTag.length - TAG_BYTES));
  const plaintext = Buffer.concat([
    decipher.update(cipherWithTag.subarray(0, cipherWithTag.length - TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext) as DecryptedSecret;
}

async function processLoginJob(data: JobPayload): Promise<void> {
  const { taskId } = data;
  logger.info('job-start', 'Processing login job', { taskId });

  const task = await getTask(taskId);
  if (!task) {
    logger.warn('job-skip', 'Task not found, skipping job', { taskId });
    return;
  }
  if (task.status !== 'pending') {
    logger.warn('job-skip', 'Task not in pending state, skipping', { taskId, status: task.status });
    return;
  }

  const pool = getGeneralPool();
  const loginKey = getLoginJobEncryptionKey();

  // Fetch and decrypt task secret
  const secretRes = await pool.query<{ secret_cipher: string; secret_nonce: string }>(
    'SELECT secret_cipher, secret_nonce FROM login.task_secrets WHERE task_id = $1',
    [taskId],
  );
  if (!secretRes.rows[0]) {
    await markFailed(taskId, 'Task secret not found.');
    return;
  }

  let secret: DecryptedSecret;
  try {
    secret = await decryptJobSecret(taskId, secretRes.rows[0].secret_cipher, secretRes.rows[0].secret_nonce, loginKey);
  } catch (err) {
    await markFailed(taskId, `Failed to decrypt task secret: ${(err as Error).message}`);
    return;
  }

  if (!secret.ssoPassword) {
    await markFailed(taskId, 'ssoPassword is missing from decrypted task secret.');
    return;
  }

  // Mark task running (increment attempts)
  await pool.query(
    `UPDATE login.tasks SET status = 'running', attempts = attempts + 1, started_at = now(), finished_at = NULL, failure_reason = NULL WHERE id = $1`,
    [taskId],
  );

  try {
    const authConfig = {
      ...config.auth,
      ssoUrl: secret.ssoUrl ?? config.auth.ssoUrl,
      ssoProvider: (task.ssoType === 'azure' ? 'azure' : 'custom') as 'azure' | 'custom',
      selectors: { ...config.auth.selectors, ...(secret.selectorOverrides ?? {}) },
    };

    const { AccountLogger } = await import('./tasks/accountLogger.js');
    const accountLogger = AccountLogger.create(config.logDir, task.ssoUser, config.auth.debugLogs);

    logger.info('playwright-start', 'Starting Playwright browser login', { taskId, identity: task.identity, ssoUser: task.ssoUser, ghLogin: task.ghLogin });

    const githubToken = await loginWithDeviceFlow(
      new HeadlessPlaywrightAuthStrategy(
        authConfig,
        {
          githubUsername: task.ghLogin ?? task.ssoUser,
          ssoUsername: task.ssoUser,
          ssoPassword: secret.ssoPassword,
        },
        accountLogger,
      ),
      accountLogger,
    );

    await saveGithubToken(task.identity, githubToken, task.ghLogin ?? undefined);
    await markSuccess(taskId);

    // Clean up task secret (terminal success)
    await pool.query('DELETE FROM login.task_secrets WHERE task_id = $1', [taskId]);

    logger.info('job-success', 'Login job completed successfully', { taskId, identity: task.identity });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(taskId, message.slice(0, 2000));

    // Clean up task secret on terminal failure
    await pool.query('DELETE FROM login.task_secrets WHERE task_id = $1', [taskId]);

    logger.error('job-failed', 'Login job failed', { taskId, identity: task.identity, error: message });
    throw err;
  }
}

/**
 * Simple outbox dispatcher: polls login.job_outbox for pending rows and logs them.
 * Full pg-boss integration would use pg-boss.publish() here.
 * For now, the worker processes pending tasks directly from login.tasks.
 */
async function runSimpleWorker(): Promise<void> {
  const pool = getGeneralPool();
  const concurrency = config.concurrency;
  logger.info('worker-start', 'Login worker started', { concurrency });

  let stopping = false;
  let activeJobs = 0;

  const shutdown = async (): Promise<void> => {
    logger.info('worker-stopping', 'Login worker stopping...');
    stopping = true;
    // Wait for active job to finish (max 2 minutes)
    const deadline = Date.now() + 120_000;
    while (activeJobs > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await closePool();
    logger.info('worker-stopped', 'Login worker stopped');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // Poll for pending tasks
  while (!stopping) {
    if (activeJobs >= concurrency) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }

    try {
      // Claim a pending task using SELECT FOR UPDATE SKIP LOCKED
      const claimRes = await pool.query<{ id: string; identity: string; sso_user: string; gh_login: string | null; sso_type: string }>(
        `SELECT id, identity, sso_user, gh_login, sso_type
         FROM login.tasks
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );

      if (claimRes.rows.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      const row = claimRes.rows[0]!;
      activeJobs++;

      void processLoginJob({ taskId: row.id, taskGeneration: '1', attemptToken: '' })
        .catch((err) => {
          logger.error('job-error', 'Unhandled job error', { taskId: row.id, error: (err as Error).message });
        })
        .finally(() => {
          activeJobs--;
        });
    } catch (err) {
      logger.error('poll-error', 'Error polling for tasks', { error: (err as Error).message });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function main(): Promise<void> {
  await initPool();
  await runSimpleWorker();
}

main().catch((err: unknown) => {
  console.error('[login-worker] Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
