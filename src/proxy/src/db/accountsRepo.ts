/**
 * PostgreSQL implementation of the proxy accounts repository.
 * Preserves all exported function signatures and types from the SQLite version.
 *
 * Credentials (gh_token, copilot_token) are encrypted with AES-256-GCM
 * using DATA_ENCRYPTION_KEY. Plaintext is never stored in the database.
 */
import type { CopilotOauthStatus, CopilotTokenStatus, GhTokenStatus, PageResponse, ProxyAccountDto } from '@ghcp/shared';
import { pageResponse } from '@ghcp/shared';
import { getGeneralPool, getDataEncryptionKey } from './pool.js';
import { encryptCredential, decryptCredential, buildAad } from './crypto.js';

export interface ProxyAccountRecord {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  ghToken?: string;
  ghTokenStatus: GhTokenStatus;
  ghTokenUpdatedAt?: string;
  copilotToken?: string;
  copilotApi?: string;
  copilotTokenExpiresAt?: string;
  copilotTokenStatus: CopilotTokenStatus;
  copilotOauthToken?: string;
  copilotOauthStatus: CopilotOauthStatus;
  copilotOauthUpdatedAt?: string;
  credentialVersion: bigint;
  activeLoginTaskId?: string;
  activeTaskGeneration?: bigint;
  activeAttemptToken?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'identity' | 'ssoUser' | 'ghLogin' | 'ghTokenStatus' | 'copilotTokenStatus' | 'copilotOauthStatus' | 'createdAt' | 'updatedAt';
  dir?: 'asc' | 'desc';
}

export interface DeleteAccountsBySsoUserResult {
  ssoUser: string;
  matchedAccounts: number;
  deletedAccounts: number;
  deletedRequestStats: number;
}

// ============================================================
// Internal row type matching the PostgreSQL table
// ============================================================
interface AccountRow {
  identity: string;
  sso_user: string;
  gh_login: string | null;
  gh_token_cipher: string | null;
  gh_token_nonce: string | null;
  gh_token_status: GhTokenStatus;
  gh_token_updated_at: Date | null;
  copilot_token_cipher: string | null;
  copilot_token_nonce: string | null;
  copilot_api: string | null;
  copilot_token_expires_at: Date | null;
  copilot_token_status: CopilotTokenStatus;
  copilot_oauth_token_cipher: string | null;
  copilot_oauth_token_nonce: string | null;
  copilot_oauth_status: CopilotOauthStatus;
  copilot_oauth_updated_at: Date | null;
  credential_version: bigint;
  active_login_task_id: string | null;
  active_task_generation: bigint | null;
  active_attempt_token: string | null;
  created_at: Date;
  updated_at: Date;
}

// ============================================================
// Crypto helpers
// ============================================================

function encryptGhToken(identity: string, token: string): { cipher: string; nonce: string } {
  const key = getDataEncryptionKey();
  const aad = buildAad(identity, 'gh_token');
  return encryptCredential(token, key, aad);
}

function decryptGhToken(identity: string, cipher: string, nonce: string): string {
  const key = getDataEncryptionKey();
  const aad = buildAad(identity, 'gh_token');
  return decryptCredential({ cipher, nonce }, key, aad);
}

function encryptCopilotToken(identity: string, token: string): { cipher: string; nonce: string } {
  const key = getDataEncryptionKey();
  const aad = buildAad(identity, 'copilot_token');
  return encryptCredential(token, key, aad);
}

function decryptCopilotToken(identity: string, cipher: string, nonce: string): string {
  const key = getDataEncryptionKey();
  const aad = buildAad(identity, 'copilot_token');
  return decryptCredential({ cipher, nonce }, key, aad);
}

function encryptCopilotOauthToken(identity: string, token: string): { cipher: string; nonce: string } {
  const key = getDataEncryptionKey();
  const aad = buildAad(identity, 'copilot_oauth_token');
  return encryptCredential(token, key, aad);
}

function decryptCopilotOauthToken(identity: string, cipher: string, nonce: string): string {
  const key = getDataEncryptionKey();
  const aad = buildAad(identity, 'copilot_oauth_token');
  return decryptCredential({ cipher, nonce }, key, aad);
}

// ============================================================
// Row mapping
// ============================================================

function mapRow(row: AccountRow): ProxyAccountRecord {
  let ghToken: string | undefined;
  if (row.gh_token_cipher && row.gh_token_nonce) {
    try {
      ghToken = decryptGhToken(row.identity, row.gh_token_cipher, row.gh_token_nonce);
    } catch {
      // Decryption failure is a security error — leave ghToken undefined
      // The credential_version/status will handle the retry
    }
  }

  let copilotToken: string | undefined;
  if (row.copilot_token_cipher && row.copilot_token_nonce) {
    try {
      copilotToken = decryptCopilotToken(row.identity, row.copilot_token_cipher, row.copilot_token_nonce);
    } catch {
      // ignore decryption errors for copilot token
    }
  }

  let copilotOauthToken: string | undefined;
  if (row.copilot_oauth_token_cipher && row.copilot_oauth_token_nonce) {
    try {
      copilotOauthToken = decryptCopilotOauthToken(row.identity, row.copilot_oauth_token_cipher, row.copilot_oauth_token_nonce);
    } catch {
      // Decryption failure — leave undefined; getAuth() treats missing token as not-ready.
    }
  }

  return {
    identity: row.identity,
    ssoUser: row.sso_user,
    ghLogin: row.gh_login ?? undefined,
    ghToken,
    ghTokenStatus: row.gh_token_status,
    ghTokenUpdatedAt: row.gh_token_updated_at?.toISOString(),
    copilotToken,
    copilotApi: row.copilot_api ?? undefined,
    copilotTokenExpiresAt: row.copilot_token_expires_at?.toISOString(),
    copilotTokenStatus: row.copilot_token_status,
    copilotOauthToken,
    copilotOauthStatus: row.copilot_oauth_status,
    copilotOauthUpdatedAt: row.copilot_oauth_updated_at?.toISOString(),
    credentialVersion: row.credential_version,
    activeLoginTaskId: row.active_login_task_id ?? undefined,
    activeTaskGeneration: row.active_task_generation ?? undefined,
    activeAttemptToken: row.active_attempt_token ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function sortColumn(sort: AccountListQuery['sort']): string {
  switch (sort) {
    case 'identity': return 'identity';
    case 'ssoUser': return 'sso_user';
    case 'ghLogin': return 'gh_login';
    case 'ghTokenStatus': return 'gh_token_status';
    case 'copilotTokenStatus': return 'copilot_token_status';
    case 'copilotOauthStatus': return 'copilot_oauth_status';
    case 'createdAt': return 'created_at';
    default: return 'updated_at';
  }
}

// ============================================================
// Public repository functions (same signatures as SQLite version)
// ============================================================

export async function listAccounts(query: AccountListQuery = {}): Promise<PageResponse<ProxyAccountRecord>> {
  const pool = getGeneralPool();
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
  const q = query.q?.trim();
  const sort = sortColumn(query.sort);
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';

  let countSql: string;
  let listSql: string;
  let args: unknown[];

  if (q) {
    const pattern = `%${q}%`;
    countSql = `SELECT COUNT(*) AS count FROM proxy.accounts WHERE identity ILIKE $1 OR sso_user ILIKE $1 OR gh_login ILIKE $1`;
    listSql = `SELECT * FROM proxy.accounts WHERE identity ILIKE $1 OR sso_user ILIKE $1 OR gh_login ILIKE $1 ORDER BY ${sort} ${dir} LIMIT $2 OFFSET $3`;
    args = [pattern, pageSize, (page - 1) * pageSize];
  } else {
    countSql = `SELECT COUNT(*) AS count FROM proxy.accounts`;
    listSql = `SELECT * FROM proxy.accounts ORDER BY ${sort} ${dir} LIMIT $1 OFFSET $2`;
    args = [pageSize, (page - 1) * pageSize];
  }

  const [countResult, listResult] = await Promise.all([
    pool.query<{ count: string }>(countSql, q ? [args[0]] : []),
    pool.query<AccountRow>(listSql, args),
  ]);

  const total = parseInt(countResult.rows[0]!.count, 10);
  return pageResponse(listResult.rows.map(mapRow), total, page, pageSize);
}

export async function getAccount(identity: string): Promise<ProxyAccountRecord | undefined> {
  const pool = getGeneralPool();
  const result = await pool.query<AccountRow>(
    'SELECT * FROM proxy.accounts WHERE identity = $1',
    [identity],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : undefined;
}

export async function deleteAccountsBySsoUser(ssoUser: string): Promise<DeleteAccountsBySsoUserResult> {
  const target = ssoUser.trim();
  if (!target) return { ssoUser: target, matchedAccounts: 0, deletedAccounts: 0, deletedRequestStats: 0 };

  const pool = getGeneralPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const matched = await client.query<{ identity: string }>(
      'SELECT identity FROM proxy.accounts WHERE lower(sso_user) = lower($1)',
      [target],
    );
    const deletedResult = await client.query(
      'DELETE FROM proxy.accounts WHERE lower(sso_user) = lower($1)',
      [target],
    );
    await client.query('COMMIT');
    return {
      ssoUser: target,
      matchedAccounts: matched.rowCount ?? 0,
      deletedAccounts: deletedResult.rowCount ?? 0,
      deletedRequestStats: 0, // request stats are not persisted in PostgreSQL
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function createAccount(input: {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  ghTokenStatus?: GhTokenStatus;
  copilotTokenStatus?: CopilotTokenStatus;
  copilotOauthStatus?: CopilotOauthStatus;
}): Promise<ProxyAccountRecord> {
  const pool = getGeneralPool();
  await pool.query(
    `INSERT INTO proxy.accounts (
       identity, sso_user, gh_login, gh_token_status, copilot_token_status, copilot_oauth_status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, now(), now())
     ON CONFLICT(identity) DO UPDATE SET
       sso_user = EXCLUDED.sso_user,
       gh_login = COALESCE(EXCLUDED.gh_login, proxy.accounts.gh_login),
       updated_at = now()`,
    [
      input.identity,
      input.ssoUser,
      input.ghLogin ?? null,
      input.ghTokenStatus ?? 'missing',
      input.copilotTokenStatus ?? 'missing',
      input.copilotOauthStatus ?? 'missing',
    ],
  );
  return (await getAccount(input.identity))!;
}

export async function importGithubToken(input: {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  ghToken: string;
}): Promise<ProxyAccountRecord> {
  const pool = getGeneralPool();
  const encrypted = encryptGhToken(input.identity, input.ghToken);
  await pool.query(
    `INSERT INTO proxy.accounts (
       identity, sso_user, gh_login, gh_token_cipher, gh_token_nonce, gh_token_status,
       gh_token_updated_at, copilot_token_cipher, copilot_token_nonce, copilot_api,
       copilot_token_expires_at, copilot_token_status,
       credential_version, active_login_task_id, active_task_generation, active_attempt_token,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'valid', now(), NULL, NULL, NULL, NULL, 'expired',
               1, NULL, NULL, NULL, now(), now())
     ON CONFLICT(identity) DO UPDATE SET
       sso_user = EXCLUDED.sso_user,
       gh_login = COALESCE(EXCLUDED.gh_login, proxy.accounts.gh_login),
       gh_token_cipher = EXCLUDED.gh_token_cipher,
       gh_token_nonce = EXCLUDED.gh_token_nonce,
       gh_token_status = 'valid',
       gh_token_updated_at = now(),
       copilot_token_cipher = NULL,
       copilot_token_nonce = NULL,
       copilot_api = NULL,
       copilot_token_expires_at = NULL,
       copilot_token_status = 'expired',
       credential_version = proxy.accounts.credential_version + 1,
       active_login_task_id = NULL,
       active_task_generation = NULL,
       active_attempt_token = NULL,
       updated_at = now()`,
    [
      input.identity,
      input.ssoUser,
      input.ghLogin ?? null,
      encrypted.cipher,
      encrypted.nonce,
    ],
  );
  return (await getAccount(input.identity))!;
}

export async function saveGithubToken(
  identity: string,
  ghToken: string,
  ghLogin?: string,
): Promise<ProxyAccountRecord> {
  const pool = getGeneralPool();
  const encrypted = encryptGhToken(identity, ghToken);
  const result = await pool.query(
    `UPDATE proxy.accounts
     SET gh_token_cipher = $1,
         gh_token_nonce = $2,
         gh_login = COALESCE($3, gh_login),
         gh_token_status = 'valid',
         gh_token_updated_at = now(),
         copilot_token_status = 'expired',
         credential_version = credential_version + 1,
         active_login_task_id = NULL,
         active_task_generation = NULL,
         active_attempt_token = NULL,
         updated_at = now()
     WHERE identity = $4`,
    [encrypted.cipher, encrypted.nonce, ghLogin ?? null, identity],
  );
  if (result.rowCount === 0) throw new Error(`Unknown proxy account identity "${identity}".`);
  return (await getAccount(identity))!;
}

export async function markGithubTokenStatus(identity: string, status: GhTokenStatus): Promise<void> {
  const pool = getGeneralPool();
  await pool.query(
    'UPDATE proxy.accounts SET gh_token_status = $1, updated_at = now() WHERE identity = $2',
    [status, identity],
  );
}

export async function saveCopilotToken(input: {
  identity: string;
  token: string;
  api: string;
  expiresAt: string;
}): Promise<ProxyAccountRecord> {
  const pool = getGeneralPool();
  const encrypted = encryptCopilotToken(input.identity, input.token);
  const result = await pool.query(
    `UPDATE proxy.accounts
     SET copilot_token_cipher = $1,
         copilot_token_nonce = $2,
         copilot_api = $3,
         copilot_token_expires_at = $4,
         copilot_token_status = 'valid',
         updated_at = now()
     WHERE identity = $5`,
    [encrypted.cipher, encrypted.nonce, input.api, input.expiresAt, input.identity],
  );
  if (result.rowCount === 0) throw new Error(`Unknown proxy account identity "${input.identity}".`);
  return (await getAccount(input.identity))!;
}

export async function markCopilotTokenStatus(identity: string, status: CopilotTokenStatus): Promise<void> {
  const pool = getGeneralPool();
  await pool.query(
    'UPDATE proxy.accounts SET copilot_token_status = $1, updated_at = now() WHERE identity = $2',
    [status, identity],
  );
}

export async function importCopilotOauthToken(input: {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  copilotOauthToken: string;
}): Promise<ProxyAccountRecord> {
  const pool = getGeneralPool();
  const encrypted = encryptCopilotOauthToken(input.identity, input.copilotOauthToken);
  await pool.query(
    `INSERT INTO proxy.accounts (
       identity, sso_user, gh_login,
       copilot_oauth_token_cipher, copilot_oauth_token_nonce, copilot_oauth_status, copilot_oauth_updated_at,
       gh_token_status, copilot_token_status,
       credential_version, active_login_task_id, active_task_generation, active_attempt_token,
       created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, 'valid', now(), 'missing', 'missing', 1, NULL, NULL, NULL, now(), now())
     ON CONFLICT(identity) DO UPDATE SET
       sso_user = EXCLUDED.sso_user,
       gh_login = COALESCE(EXCLUDED.gh_login, proxy.accounts.gh_login),
       copilot_oauth_token_cipher = EXCLUDED.copilot_oauth_token_cipher,
       copilot_oauth_token_nonce = EXCLUDED.copilot_oauth_token_nonce,
       copilot_oauth_status = 'valid',
       copilot_oauth_updated_at = now(),
       credential_version = proxy.accounts.credential_version + 1,
       active_login_task_id = NULL,
       active_task_generation = NULL,
       active_attempt_token = NULL,
       updated_at = now()`,
    [input.identity, input.ssoUser, input.ghLogin ?? null, encrypted.cipher, encrypted.nonce],
  );
  return (await getAccount(input.identity))!;
}

export interface SaveCopilotOauthTokenInput {
  identity: string;
  taskId: string;
  taskGeneration: bigint;
  attemptToken: string;
  copilotOauthToken: string;
  ghLogin?: string;
}

export type SaveCopilotOauthTokenResult = 'saved' | 'stale' | 'unknown_identity';

/**
 * Fenced OAuth write-back: applies only when the delivered
 * (taskId, generation, attemptToken) still matches the account's active binding,
 * so a stale worker cannot overwrite a newer credential. Bumps credential_version.
 */
export async function saveCopilotOauthToken(input: SaveCopilotOauthTokenInput): Promise<SaveCopilotOauthTokenResult> {
  const pool = getGeneralPool();
  const encrypted = encryptCopilotOauthToken(input.identity, input.copilotOauthToken);
  const result = await pool.query(
    `UPDATE proxy.accounts
     SET copilot_oauth_token_cipher = $1,
         copilot_oauth_token_nonce = $2,
         gh_login = COALESCE($3, gh_login),
         copilot_oauth_status = 'valid',
         copilot_oauth_updated_at = now(),
         credential_version = credential_version + 1,
         active_login_task_id = NULL,
         active_task_generation = NULL,
         active_attempt_token = NULL,
         updated_at = now()
     WHERE identity = $4
       AND active_login_task_id = $5
       AND active_task_generation = $6
       AND active_attempt_token = $7`,
    [
      encrypted.cipher,
      encrypted.nonce,
      input.ghLogin ?? null,
      input.identity,
      input.taskId,
      input.taskGeneration.toString(),
      input.attemptToken,
    ],
  );
  if ((result.rowCount ?? 0) > 0) return 'saved';
  const account = await getAccount(input.identity);
  return account ? 'stale' : 'unknown_identity';
}

/**
 * Fenced failure transition: refreshing -> failed, only when the delivered fence
 * matches the account's active binding.
 */
export async function failCopilotOauthAuthorization(input: {
  identity: string;
  taskId: string;
  taskGeneration: bigint;
  attemptToken: string;
}): Promise<'failed' | 'stale' | 'unknown_identity'> {
  const pool = getGeneralPool();
  const result = await pool.query(
    `UPDATE proxy.accounts
     SET copilot_oauth_status = 'failed',
         active_login_task_id = NULL,
         active_task_generation = NULL,
         active_attempt_token = NULL,
         updated_at = now()
     WHERE identity = $1
       AND active_login_task_id = $2
       AND active_task_generation = $3
       AND active_attempt_token = $4
       AND copilot_oauth_status = 'refreshing'`,
    [input.identity, input.taskId, input.taskGeneration.toString(), input.attemptToken],
  );
  if ((result.rowCount ?? 0) > 0) return 'failed';
  const account = await getAccount(input.identity);
  return account ? 'stale' : 'unknown_identity';
}

export async function markCopilotOauthStatus(identity: string, status: CopilotOauthStatus): Promise<void> {
  const pool = getGeneralPool();
  await pool.query(
    'UPDATE proxy.accounts SET copilot_oauth_status = $1, updated_at = now() WHERE identity = $2',
    [status, identity],
  );
}

/**
 * Invalidate a live OAuth token after an upstream 401. Fences on credential_version
 * (compare-and-set) rather than plaintext token comparison, because the ciphertext is
 * randomized; this avoids clobbering a concurrent import/refresh that already advanced
 * the version.
 */
export async function invalidateCopilotOauthToken(
  identity: string,
  expectedCredentialVersion: bigint,
  status: Extract<CopilotOauthStatus, 'expired' | 'failed'>,
): Promise<boolean> {
  const pool = getGeneralPool();
  const result = await pool.query(
    `UPDATE proxy.accounts
     SET copilot_oauth_token_cipher = NULL,
         copilot_oauth_token_nonce = NULL,
         copilot_oauth_status = $1,
         copilot_oauth_updated_at = now(),
         updated_at = now()
     WHERE identity = $2
       AND credential_version = $3
       AND copilot_oauth_status = 'valid'`,
    [status, identity, expectedCredentialVersion.toString()],
  );
  return (result.rowCount ?? 0) > 0;
}

export function toAccountDto(account: ProxyAccountRecord): ProxyAccountDto {
  return {
    identity: account.identity,
    ssoUser: account.ssoUser,
    ghLogin: account.ghLogin,
    ghTokenStatus: account.ghTokenStatus,
    ghTokenUpdatedAt: account.ghTokenUpdatedAt,
    copilotTokenStatus: account.copilotTokenStatus,
    copilotTokenExpiresAt: account.copilotTokenExpiresAt,
    copilotOauthStatus: account.copilotOauthStatus,
    copilotOauthUpdatedAt: account.copilotOauthUpdatedAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}
