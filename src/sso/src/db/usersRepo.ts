/**
 * PostgreSQL implementation of the SSO users repository.
 * Preserves all exported function signatures from the SQLite version.
 */
import type { CopilotSeatOperation, CopilotSeatStatus, EmuStatus, PageResponse, SsoUserDto } from '@ghcp/shared';
import { pageResponse } from '@ghcp/shared';
import { getGeneralPool } from './pool.js';

export interface SsoUserRecord extends SsoUserDto {
  passwordHash: string;
  salt: string;
}

interface UserRow {
  sso_user: string;
  password_hash: string;
  salt: string;
  email: string;
  role: 'user' | 'admin';
  gh_login: string | null;
  gh_scim_id: string | null;
  emu_status: EmuStatus;
  copilot_seat_status: CopilotSeatStatus;
  copilot_seat_last_operation: CopilotSeatOperation | null;
  copilot_seat_last_error: string | null;
  copilot_seat_updated_at: Date | null;
  credential_source: 'generated_default' | 'operator_managed';
  created_at: Date;
  updated_at: Date;
}

export interface UserListQuery {
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: 'ssoUser' | 'email' | 'role' | 'emuStatus' | 'createdAt';
  dir?: 'asc' | 'desc';
}

function mapRow(row: UserRow): SsoUserRecord {
  return {
    ssoUser: row.sso_user,
    passwordHash: row.password_hash,
    salt: row.salt,
    email: row.email,
    role: row.role,
    ghLogin: row.gh_login ?? undefined,
    ghScimId: row.gh_scim_id ?? undefined,
    emuStatus: row.emu_status,
    copilotSeatStatus: row.copilot_seat_status ?? 'unknown',
    copilotSeatLastOperation: row.copilot_seat_last_operation ?? undefined,
    copilotSeatLastError: row.copilot_seat_last_error ?? undefined,
    copilotSeatUpdatedAt: row.copilot_seat_updated_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function sortColumn(sort: UserListQuery['sort']): string {
  switch (sort) {
    case 'email': return 'email';
    case 'role': return 'role';
    case 'emuStatus': return 'emu_status';
    case 'createdAt': return 'created_at';
    default: return 'sso_user';
  }
}

export async function listUsers(query: UserListQuery = {}): Promise<PageResponse<SsoUserDto>> {
  const pool = getGeneralPool();
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 25), 100));
  const q = query.q?.trim();
  const sort = sortColumn(query.sort);
  const dir = query.dir === 'desc' ? 'DESC' : 'ASC';

  if (q) {
    const pattern = `%${q}%`;
    const [countRes, listRes] = await Promise.all([
      pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM sso.users WHERE sso_user ILIKE $1 OR email ILIKE $1 OR gh_login ILIKE $1`, [pattern]),
      pool.query<UserRow>(`SELECT * FROM sso.users WHERE sso_user ILIKE $1 OR email ILIKE $1 OR gh_login ILIKE $1 ORDER BY ${sort} ${dir} LIMIT $2 OFFSET $3`, [pattern, pageSize, (page - 1) * pageSize]),
    ]);
    return pageResponse(listRes.rows.map(mapRow).map(toDto), parseInt(countRes.rows[0]!.count, 10), page, pageSize);
  }

  const [countRes, listRes] = await Promise.all([
    pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM sso.users'),
    pool.query<UserRow>(`SELECT * FROM sso.users ORDER BY ${sort} ${dir} LIMIT $1 OFFSET $2`, [pageSize, (page - 1) * pageSize]),
  ]);
  return pageResponse(listRes.rows.map(mapRow).map(toDto), parseInt(countRes.rows[0]!.count, 10), page, pageSize);
}

export async function listAllUsers(): Promise<SsoUserRecord[]> {
  const pool = getGeneralPool();
  const res = await pool.query<UserRow>('SELECT * FROM sso.users ORDER BY sso_user ASC');
  return res.rows.map(mapRow);
}

export async function getUser(ssoUser: string): Promise<SsoUserRecord | undefined> {
  const pool = getGeneralPool();
  const res = await pool.query<UserRow>('SELECT * FROM sso.users WHERE lower(sso_user) = lower($1)', [ssoUser]);
  return res.rows[0] ? mapRow(res.rows[0]) : undefined;
}

export async function getUserByGhLogin(ghLogin: string): Promise<SsoUserRecord | undefined> {
  const trimmed = ghLogin.trim();
  if (!trimmed) return undefined;
  const pool = getGeneralPool();
  const res = await pool.query<UserRow>('SELECT * FROM sso.users WHERE lower(gh_login) = lower($1)', [trimmed]);
  return res.rows[0] ? mapRow(res.rows[0]) : undefined;
}

export async function createUser(input: {
  ssoUser: string;
  passwordHash: string;
  salt: string;
  email: string;
  role?: 'user' | 'admin';
  credentialSource?: 'generated_default' | 'operator_managed';
}): Promise<SsoUserRecord> {
  const pool = getGeneralPool();
  await pool.query(
    `INSERT INTO sso.users (sso_user, password_hash, salt, email, role, emu_status, credential_source, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'not_synced', $6, now(), now())`,
    [input.ssoUser, input.passwordHash, input.salt, input.email, input.role ?? 'user', input.credentialSource ?? 'generated_default'],
  );
  return (await getUser(input.ssoUser))!;
}

export async function updateUser(
  ssoUser: string,
  patch: Partial<Pick<SsoUserRecord, 'email' | 'role' | 'passwordHash' | 'salt'> & { credentialSource: 'generated_default' | 'operator_managed' }>,
): Promise<SsoUserRecord | undefined> {
  const current = await getUser(ssoUser);
  if (!current) return undefined;
  const pool = getGeneralPool();
  await pool.query(
    `UPDATE sso.users
     SET email = $1, role = $2, password_hash = $3, salt = $4, credential_source = $5, updated_at = now()
     WHERE lower(sso_user) = lower($6)`,
    [
      patch.email ?? current.email,
      patch.role ?? current.role,
      patch.passwordHash ?? current.passwordHash,
      patch.salt ?? current.salt,
      patch.credentialSource ?? (patch.passwordHash ? 'operator_managed' : undefined) ?? (current as unknown as { credentialSource?: string }).credentialSource ?? 'generated_default',
      ssoUser,
    ],
  );
  return getUser(ssoUser);
}

export async function updateEmu(
  ssoUser: string,
  patch: { ghLogin?: string; ghScimId?: string; emuStatus: EmuStatus },
): Promise<SsoUserRecord> {
  const pool = getGeneralPool();
  await pool.query(
    'UPDATE sso.users SET gh_login = $1, gh_scim_id = $2, emu_status = $3, updated_at = now() WHERE lower(sso_user) = lower($4)',
    [patch.ghLogin ?? null, patch.ghScimId ?? null, patch.emuStatus, ssoUser],
  );
  const user = await getUser(ssoUser);
  if (!user) throw new Error(`Unknown SSO user "${ssoUser}".`);
  return user;
}

export async function updateCopilotSeat(
  ssoUser: string,
  patch: { status: CopilotSeatStatus; lastOperation: CopilotSeatOperation; lastError?: string },
): Promise<SsoUserRecord> {
  const pool = getGeneralPool();
  await pool.query(
    `UPDATE sso.users
     SET copilot_seat_status = $1, copilot_seat_last_operation = $2, copilot_seat_last_error = $3,
         copilot_seat_updated_at = now(), updated_at = now()
     WHERE lower(sso_user) = lower($4)`,
    [patch.status, patch.lastOperation, patch.lastError ?? null, ssoUser],
  );
  const user = await getUser(ssoUser);
  if (!user) throw new Error(`Unknown SSO user "${ssoUser}".`);
  return user;
}

export async function deleteUser(ssoUser: string): Promise<boolean> {
  const pool = getGeneralPool();
  const res = await pool.query('DELETE FROM sso.users WHERE lower(sso_user) = lower($1)', [ssoUser]);
  return (res.rowCount ?? 0) > 0;
}

export function toDto(user: SsoUserRecord): SsoUserDto {
  return {
    ssoUser: user.ssoUser,
    email: user.email,
    role: user.role,
    ghLogin: user.ghLogin,
    ghScimId: user.ghScimId,
    emuStatus: user.emuStatus,
    copilotSeatStatus: user.copilotSeatStatus,
    copilotSeatLastOperation: user.copilotSeatLastOperation,
    copilotSeatLastError: user.copilotSeatLastError,
    copilotSeatUpdatedAt: user.copilotSeatUpdatedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
