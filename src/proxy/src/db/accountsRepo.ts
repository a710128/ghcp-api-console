import type { CopilotTokenStatus, GhTokenStatus, PageResponse, ProxyAccountDto } from '@ghcp/shared';
import { nowIso, pageResponse } from '@ghcp/shared';
import { getDb } from './connection.js';

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
  createdAt: string;
  updatedAt: string;
}

interface AccountRow {
  identity: string;
  sso_user: string;
  gh_login?: string;
  gh_token?: string;
  gh_token_status: GhTokenStatus;
  gh_token_updated_at?: string;
  copilot_token?: string;
  copilot_api?: string;
  copilot_token_expires_at?: string;
  copilot_token_status: CopilotTokenStatus;
  created_at: string;
  updated_at: string;
}

export interface AccountListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'identity' | 'ssoUser' | 'ghLogin' | 'ghTokenStatus' | 'copilotTokenStatus' | 'createdAt' | 'updatedAt';
  dir?: 'asc' | 'desc';
}

export interface DeleteAccountsBySsoUserResult {
  ssoUser: string;
  matchedAccounts: number;
  deletedAccounts: number;
  deletedRequestStats: number;
}

export function listAccounts(query: AccountListQuery = {}): PageResponse<ProxyAccountRecord> {
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
  const q = query.q?.trim();
  const where = q ? 'WHERE identity LIKE ? OR sso_user LIKE ? OR gh_login LIKE ?' : '';
  const args = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
  const sort = sortColumn(query.sort);
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  const total = (getDb().prepare(`SELECT COUNT(*) AS count FROM proxy_accounts ${where}`).get(...args) as { count: number }).count;
  const rows = getDb()
    .prepare(`SELECT * FROM proxy_accounts ${where} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize) as AccountRow[];
  return pageResponse(rows.map(mapRow), total, page, pageSize);
}

export function getAccount(identity: string): ProxyAccountRecord | undefined {
  const row = getDb().prepare('SELECT * FROM proxy_accounts WHERE identity = ?').get(identity) as AccountRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function deleteAccountsBySsoUser(ssoUser: string): DeleteAccountsBySsoUserResult {
  const target = ssoUser.trim();
  if (!target) return { ssoUser: target, matchedAccounts: 0, deletedAccounts: 0, deletedRequestStats: 0 };
  return getDb().transaction(() => {
    const accounts = getDb()
      .prepare('SELECT identity FROM proxy_accounts WHERE lower(sso_user) = lower(?)')
      .all(target) as Array<{ identity: string }>;
    const identities = accounts.map((account) => account.identity);
    let deletedRequestStats = 0;
    if (identities.length > 0) {
      const placeholders = identities.map(() => '?').join(', ');
      deletedRequestStats = getDb()
        .prepare(`DELETE FROM proxy_request_stats WHERE identity IN (${placeholders})`)
        .run(...identities).changes;
    }
    const deletedAccounts = getDb()
      .prepare('DELETE FROM proxy_accounts WHERE lower(sso_user) = lower(?)')
      .run(target).changes;
    return {
      ssoUser: target,
      matchedAccounts: accounts.length,
      deletedAccounts,
      deletedRequestStats,
    };
  })();
}

export function createAccount(input: {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  ghTokenStatus?: GhTokenStatus;
  copilotTokenStatus?: CopilotTokenStatus;
}): ProxyAccountRecord {
  const now = nowIso();
  getDb()
    .prepare(`
      INSERT INTO proxy_accounts (
        identity, sso_user, gh_login, gh_token_status, copilot_token_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity) DO UPDATE SET
        sso_user = excluded.sso_user,
        gh_login = COALESCE(excluded.gh_login, proxy_accounts.gh_login),
        updated_at = excluded.updated_at
    `)
    .run(
      input.identity,
      input.ssoUser,
      input.ghLogin,
      input.ghTokenStatus ?? 'missing',
      input.copilotTokenStatus ?? 'missing',
      now,
      now,
    );
  return getAccount(input.identity)!;
}

export function importGithubToken(input: {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  ghToken: string;
}): ProxyAccountRecord {
  const now = nowIso();
  getDb()
    .prepare(`
      INSERT INTO proxy_accounts (
        identity, sso_user, gh_login, gh_token, gh_token_status, gh_token_updated_at,
        copilot_token, copilot_api, copilot_token_expires_at, copilot_token_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'valid', ?, NULL, NULL, NULL, 'expired', ?, ?)
      ON CONFLICT(identity) DO UPDATE SET
        sso_user = excluded.sso_user,
        gh_login = COALESCE(excluded.gh_login, proxy_accounts.gh_login),
        gh_token = excluded.gh_token,
        gh_token_status = 'valid',
        gh_token_updated_at = excluded.gh_token_updated_at,
        copilot_token = NULL,
        copilot_api = NULL,
        copilot_token_expires_at = NULL,
        copilot_token_status = 'expired',
        updated_at = excluded.updated_at
    `)
    .run(input.identity, input.ssoUser, input.ghLogin, input.ghToken, now, now, now);
  return getAccount(input.identity)!;
}

export function saveGithubToken(identity: string, ghToken: string, ghLogin?: string): ProxyAccountRecord {
  const now = nowIso();
  getDb()
    .prepare(`
      UPDATE proxy_accounts
      SET gh_token = ?, gh_login = COALESCE(?, gh_login), gh_token_status = 'valid',
          gh_token_updated_at = ?, copilot_token_status = 'expired', updated_at = ?
      WHERE identity = ?
    `)
    .run(ghToken, ghLogin, now, now, identity);
  const account = getAccount(identity);
  if (!account) throw new Error(`Unknown proxy account identity "${identity}".`);
  return account;
}

export function markGithubTokenStatus(identity: string, status: GhTokenStatus): void {
  getDb()
    .prepare('UPDATE proxy_accounts SET gh_token_status = ?, updated_at = ? WHERE identity = ?')
    .run(status, nowIso(), identity);
}

export function saveCopilotToken(input: {
  identity: string;
  token: string;
  api: string;
  expiresAt: string;
}): ProxyAccountRecord {
  const now = nowIso();
  getDb()
    .prepare(`
      UPDATE proxy_accounts
      SET copilot_token = ?, copilot_api = ?, copilot_token_expires_at = ?,
          copilot_token_status = 'valid', updated_at = ?
      WHERE identity = ?
    `)
    .run(input.token, input.api, input.expiresAt, now, input.identity);
  const account = getAccount(input.identity);
  if (!account) throw new Error(`Unknown proxy account identity "${input.identity}".`);
  return account;
}

export function markCopilotTokenStatus(identity: string, status: CopilotTokenStatus): void {
  getDb()
    .prepare('UPDATE proxy_accounts SET copilot_token_status = ?, updated_at = ? WHERE identity = ?')
    .run(status, nowIso(), identity);
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
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function mapRow(row: AccountRow): ProxyAccountRecord {
  return {
    identity: row.identity,
    ssoUser: row.sso_user,
    ghLogin: row.gh_login,
    ghToken: row.gh_token,
    ghTokenStatus: row.gh_token_status,
    ghTokenUpdatedAt: row.gh_token_updated_at,
    copilotToken: row.copilot_token,
    copilotApi: row.copilot_api,
    copilotTokenExpiresAt: row.copilot_token_expires_at,
    copilotTokenStatus: row.copilot_token_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sortColumn(sort: AccountListQuery['sort']): string {
  switch (sort) {
    case 'identity':
      return 'identity';
    case 'ssoUser':
      return 'sso_user';
    case 'ghLogin':
      return 'gh_login';
    case 'ghTokenStatus':
      return 'gh_token_status';
    case 'copilotTokenStatus':
      return 'copilot_token_status';
    case 'createdAt':
      return 'created_at';
    default:
      return 'updated_at';
  }
}
