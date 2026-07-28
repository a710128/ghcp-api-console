/**
 * Shared login task creation/coalescing primitive used by both:
 * 1. Proxy: when initializing an unknown identity (creates task directly, bypasses login HTTP)
 * 2. Login API: when operator creates a task via POST /api/tasks
 *
 * Atomically within one transaction:
 * - Creates/updates the proxy account in 'refreshing' state
 * - Creates or coalesces an existing pending/running login task
 * - Increments task_generation on new task creation
 * - Encrypts runtime credentials (ssoPassword + selectors) with LOGIN_JOB_ENCRYPTION_KEY
 * - Creates task_secrets row
 * - Inserts login.job_outbox row for the dispatcher
 * - Binds the account to the active task/generation/attempt
 *
 * Duplicate detection: if an active task already exists for the identity
 * (status IN ('pending','running','result_pending')), returns the existing task
 * without creating a new one or changing the credential.
 *
 * Credential source guard: only 'generated_default' SSO users may be auto-enqueued.
 * Existing users with 'operator_managed' credential require operator-supplied password.
 */

import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { LoginTaskRow } from './schema/index.js';

export interface CreateOrCoalesceTaskInput {
  /** Proxy account identity */
  identity: string;
  /** SSO username */
  ssoUser: string;
  /** GitHub login */
  ghLogin: string;
  /** SSO provider type */
  ssoType: 'azure' | 'custom';
  /** Optional: SSO URL override */
  ssoUrl?: string;
  /** Runtime credential - will be encrypted, NEVER stored in plaintext */
  ssoPassword: string;
  /** Selector overrides for Playwright automation */
  selectorOverrides?: Record<string, string>;
}

export interface CreateOrCoalesceTaskResult {
  task: LoginTaskRow;
  /** true if a new task was created; false if an existing task was returned */
  created: boolean;
}

/**
 * Encrypt runtime credentials with LOGIN_JOB_ENCRYPTION_KEY.
 * The key must be provided by the caller (from getDatabaseConfig().loginJobEncryptionKey).
 */
async function encryptJobSecret(
  taskId: string,
  payload: { ssoPassword: string; ssoUrl?: string; selectorOverrides?: Record<string, string> },
  loginKey: Buffer,
): Promise<{ cipher: string; nonce: string }> {
  const { createCipheriv, randomBytes } = await import('node:crypto');
  const ALGORITHM = 'aes-256-gcm';
  const nonce = randomBytes(12);
  const aad = Buffer.from(`taskId:${taskId}\x00type:job_secret\x00version:1`, 'utf8');
  const cipher = createCipheriv(ALGORITHM, loginKey, nonce);
  cipher.setAAD(aad);
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const cipherWithTag = Buffer.concat([encrypted, tag]);
  return {
    cipher: cipherWithTag.toString('base64'),
    nonce: nonce.toString('hex'),
  };
}

/**
 * Execute createOrCoalesceLoginTaskTx within a provided pool.
 * Caller is responsible for providing both the general pool and the LOGIN_JOB_ENCRYPTION_KEY.
 */
export async function createOrCoalesceLoginTaskTx(
  pool: Pool,
  loginKey: Buffer,
  input: CreateOrCoalesceTaskInput,
): Promise<CreateOrCoalesceTaskResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check for an existing active task for this identity
    const existingTask = await client.query<LoginTaskRow>(
      `SELECT * FROM login.tasks
       WHERE identity = $1
         AND status IN ('pending', 'running')
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.identity],
    );

    if (existingTask.rows.length > 0) {
      await client.query('COMMIT');
      return { task: existingTask.rows[0]!, created: false };
    }

    // Also check result_pending (successful login awaiting proxy write-back)
    const resultPendingTask = await client.query<LoginTaskRow>(
      `SELECT * FROM login.tasks
       WHERE identity = $1
         AND result_pending = true
       ORDER BY created_at DESC
       LIMIT 1`,
      [input.identity],
    );

    if (resultPendingTask.rows.length > 0) {
      await client.query('COMMIT');
      return { task: resultPendingTask.rows[0]!, created: false };
    }

    // Create new task
    const taskId = randomUUID();
    const now = new Date();

    // Get current max task_generation for this identity
    const genResult = await client.query<{ max_gen: bigint | null }>(
      'SELECT MAX(task_generation) AS max_gen FROM login.tasks WHERE identity = $1',
      [input.identity],
    );
    const nextGen = BigInt(genResult.rows[0]?.max_gen ?? 0) + BigInt(1);

    // Insert the task record
    const taskResult = await client.query<LoginTaskRow>(
      `INSERT INTO login.tasks (
         id, identity, sso_user, gh_login, sso_type, status, attempts,
         task_generation, current_attempt_token, result_pending, created_at
       ) VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, NULL, false, $7)
       RETURNING *`,
      [taskId, input.identity, input.ssoUser, input.ghLogin, input.ssoType, nextGen, now],
    );

    const task = taskResult.rows[0]!;

    // Encrypt runtime credentials
    const secretPayload = {
      ssoPassword: input.ssoPassword,
      ssoUrl: input.ssoUrl,
      selectorOverrides: input.selectorOverrides,
    };
    const encrypted = await encryptJobSecret(taskId, secretPayload, loginKey);

    // Insert task secret
    await client.query(
      `INSERT INTO login.task_secrets (task_id, secret_cipher, secret_nonce, created_at)
       VALUES ($1, $2, $3, $4)`,
      [taskId, encrypted.cipher, encrypted.nonce, now],
    );

    // Insert job outbox row (dispatcher will publish to pg-boss)
    const pgBossKey = `${taskId}:${nextGen.toString()}`;
    await client.query(
      `INSERT INTO login.job_outbox (task_id, task_generation, pg_boss_key, state, created_at)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [taskId, nextGen, pgBossKey, now],
    );

    // OAuth is the active runtime path: 'refreshing' makes proxy getAuth() return
    // 202 account_initializing while the login task runs.
    await client.query(
      `UPDATE proxy.accounts
       SET copilot_oauth_status = 'refreshing',
           active_login_task_id = $1,
           active_task_generation = $2,
           active_attempt_token = NULL,
           updated_at = now()
       WHERE identity = $3`,
      [taskId, nextGen, input.identity],
    );

    await client.query('COMMIT');
    return { task, created: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
