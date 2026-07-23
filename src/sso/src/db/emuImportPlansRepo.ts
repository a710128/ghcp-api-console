/**
 * PostgreSQL implementation of EMU import plans repository.
 * password_for_login column removed (was in SQLite, not in PostgreSQL per plan spec).
 * Apply uses internal lease fields (apply_lease_owner, apply_lease_expires_at, FOR UPDATE SKIP LOCKED).
 */
import type { ImportEmuPlanDto, ImportEmuPlanStatus, ImportEmuPlanSummary, ImportEmuUserRow, ImportEmuUserStatus, PageResponse } from '@ghcp/shared';
import { pageResponse } from '@ghcp/shared';
import { randomUUID } from 'node:crypto';
import { getGeneralPool } from './pool.js';

export type EmuImportAction = 'create' | 'update' | 'skip';

export interface EmuImportPlanRowRecord extends ImportEmuUserRow {
  rowIndex: number;
  action?: EmuImportAction;
}

interface PlanRow {
  id: string;
  sso_user: string | null;
  status: ImportEmuPlanStatus;
  apply_lease_owner: string | null;
  apply_lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  applied_at: Date | null;
}

interface RowRecord {
  plan_id: string;
  row_index: number;
  sso_user: string;
  email: string | null;
  gh_login: string | null;
  gh_scim_id: string | null;
  emu_status: ImportEmuUserRow['emuStatus'];
  status: ImportEmuUserStatus;
  detail: string;
  action: EmuImportAction | null;
  created_at: Date;
  updated_at: Date;
}

async function summarizeEmuImportPlan(planId: string): Promise<ImportEmuPlanSummary> {
  const pool = getGeneralPool();
  const res = await pool.query<{ status: ImportEmuUserStatus; count: string }>(
    'SELECT status, COUNT(*) AS count FROM sso.emu_import_plan_rows WHERE plan_id = $1 GROUP BY status',
    [planId],
  );
  const counts = new Map(res.rows.map((r) => [r.status, parseInt(r.count, 10)]));
  const pendingCreate = counts.get('pending_create') ?? 0;
  const pendingUpdate = counts.get('pending_update') ?? 0;
  return {
    total: Array.from(counts.values()).reduce((s, c) => s + c, 0),
    pendingCreate,
    pendingUpdate,
    created: counts.get('created') ?? 0,
    updated: counts.get('updated') ?? 0,
    skipped: counts.get('skipped') ?? 0,
    conflict: counts.get('conflict') ?? 0,
    failed: counts.get('failed') ?? 0,
    actionable: pendingCreate + pendingUpdate,
  };
}

function toPlanDto(row: PlanRow, summary: ImportEmuPlanSummary): ImportEmuPlanDto {
  return {
    planId: row.id,
    ssoUser: row.sso_user ?? undefined,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    appliedAt: row.applied_at?.toISOString(),
    summary,
  };
}

function toImportRow(row: RowRecord): ImportEmuUserRow {
  return {
    rowIndex: row.row_index,
    ssoUser: row.sso_user,
    email: row.email ?? undefined,
    ghLogin: row.gh_login ?? undefined,
    ghScimId: row.gh_scim_id ?? undefined,
    emuStatus: row.emu_status,
    status: row.status,
    detail: row.detail,
    // passwordForLogin intentionally omitted (removed from schema)
  };
}

function toPlanRowRecord(row: RowRecord): EmuImportPlanRowRecord {
  return { ...toImportRow(row), rowIndex: row.row_index, action: row.action ?? undefined };
}

export async function createEmuImportPlanRecord(input: {
  id: string;
  ssoUser?: string;
  rows: Omit<EmuImportPlanRowRecord, 'rowIndex'>[];
}): Promise<ImportEmuPlanDto> {
  const pool = getGeneralPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO sso.emu_import_plans (id, sso_user, status, created_at, updated_at) VALUES ($1, $2, \'planned\', now(), now())',
      [input.id, input.ssoUser ?? null],
    );
    for (let i = 0; i < input.rows.length; i++) {
      const row = input.rows[i]!;
      await client.query(
        `INSERT INTO sso.emu_import_plan_rows
         (plan_id, row_index, sso_user, email, gh_login, gh_scim_id, emu_status, status, detail, action, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())`,
        [input.id, i + 1, row.ssoUser, row.email ?? null, row.ghLogin ?? null, row.ghScimId ?? null, row.emuStatus ?? null, row.status, row.detail, row.action ?? null],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return requireEmuImportPlan(input.id);
}

export async function requireEmuImportPlan(planId: string): Promise<ImportEmuPlanDto> {
  const pool = getGeneralPool();
  const res = await pool.query<PlanRow>('SELECT * FROM sso.emu_import_plans WHERE id = $1', [planId]);
  if (!res.rows[0]) throw new Error(`EMU import plan "${planId}" was not found.`);
  const summary = await summarizeEmuImportPlan(planId);
  return toPlanDto(res.rows[0], summary);
}

export async function listEmuImportPlanRows(
  planId: string,
  query: { status?: ImportEmuUserStatus; page?: number; pageSize?: number } = {},
): Promise<PageResponse<ImportEmuUserRow>> {
  await requireEmuImportPlan(planId);
  const pool = getGeneralPool();
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.trunc(query.pageSize ?? 100), 500));

  if (query.status) {
    const [countRes, listRes] = await Promise.all([
      pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM sso.emu_import_plan_rows WHERE plan_id = $1 AND status = $2', [planId, query.status]),
      pool.query<RowRecord>('SELECT * FROM sso.emu_import_plan_rows WHERE plan_id = $1 AND status = $2 ORDER BY row_index ASC LIMIT $3 OFFSET $4', [planId, query.status, pageSize, (page - 1) * pageSize]),
    ]);
    return pageResponse(listRes.rows.map(toImportRow), parseInt(countRes.rows[0]!.count, 10), page, pageSize);
  }

  const [countRes, listRes] = await Promise.all([
    pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM sso.emu_import_plan_rows WHERE plan_id = $1', [planId]),
    pool.query<RowRecord>('SELECT * FROM sso.emu_import_plan_rows WHERE plan_id = $1 ORDER BY row_index ASC LIMIT $2 OFFSET $3', [planId, pageSize, (page - 1) * pageSize]),
  ]);
  return pageResponse(listRes.rows.map(toImportRow), parseInt(countRes.rows[0]!.count, 10), page, pageSize);
}

export async function listPendingEmuImportPlanRows(planId: string): Promise<EmuImportPlanRowRecord[]> {
  await requireEmuImportPlan(planId);
  const pool = getGeneralPool();
  const res = await pool.query<RowRecord>(
    `SELECT * FROM sso.emu_import_plan_rows WHERE plan_id = $1 AND status IN ('pending_create', 'pending_update') ORDER BY row_index ASC`,
    [planId],
  );
  return res.rows.map(toPlanRowRecord);
}

export async function updateEmuImportPlanRow(planId: string, row: EmuImportPlanRowRecord): Promise<void> {
  const pool = getGeneralPool();
  await pool.query(
    `UPDATE sso.emu_import_plan_rows
     SET email = $1, gh_login = $2, gh_scim_id = $3, emu_status = $4, status = $5, detail = $6, action = $7, updated_at = now()
     WHERE plan_id = $8 AND row_index = $9`,
    [row.email ?? null, row.ghLogin ?? null, row.ghScimId ?? null, row.emuStatus ?? null, row.status, row.detail, row.action ?? null, planId, row.rowIndex],
  );
}

export async function markEmuImportPlanApplied(planId: string): Promise<ImportEmuPlanDto> {
  const pool = getGeneralPool();
  await pool.query(
    `UPDATE sso.emu_import_plans SET status = 'applied', applied_at = COALESCE(applied_at, now()), updated_at = now() WHERE id = $1`,
    [planId],
  );
  return requireEmuImportPlan(planId);
}

export async function deleteEmuImportPlanRecord(planId: string): Promise<boolean> {
  await requireEmuImportPlan(planId);
  const pool = getGeneralPool();
  const res = await pool.query('DELETE FROM sso.emu_import_plans WHERE id = $1', [planId]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Acquire an apply lease for a plan using FOR UPDATE SKIP LOCKED.
 * Returns the lease owner UUID if acquired, null if plan is already being applied or not found.
 */
export async function acquireApplyLease(planId: string): Promise<string | null> {
  const pool = getGeneralPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<PlanRow>(
      `SELECT * FROM sso.emu_import_plans
       WHERE id = $1
         AND status = 'planned'
         AND (apply_lease_expires_at IS NULL OR apply_lease_expires_at < now())
       FOR UPDATE SKIP LOCKED`,
      [planId],
    );
    if (!res.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const leaseOwner = randomUUID();
    await client.query(
      `UPDATE sso.emu_import_plans SET apply_lease_owner = $1, apply_lease_expires_at = now() + interval '5 minutes', updated_at = now() WHERE id = $2`,
      [leaseOwner, planId],
    );
    await client.query('COMMIT');
    return leaseOwner;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function releaseApplyLease(planId: string, leaseOwner: string): Promise<void> {
  const pool = getGeneralPool();
  await pool.query(
    `UPDATE sso.emu_import_plans SET apply_lease_owner = NULL, apply_lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND apply_lease_owner = $2`,
    [planId, leaseOwner],
  );
}
