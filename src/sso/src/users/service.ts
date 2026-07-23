import type { BatchResult, CreateImportEmuPlanRequest, EnsureSsoUserResponse, ImportEmuPlanDto, ImportEmuUserRow, ImportEmuUsersRequest, ImportEmuUserStatus, PageResponse, SsoUserBatchRequest, SsoUserBatchRow, SsoUserDto } from '@ghcp/shared';
import { errorFields, loggerFor } from '@ghcp/shared';
import { newBatchId, nowIso } from '@ghcp/shared';
import { config } from '../config.js';
import { hashPassword } from '../auth/password.js';
import { assignCopilotSeat, removeCopilotSeat } from '../copilot/seats.js';
import {
  createEmuImportPlanRecord,
  deleteEmuImportPlanRecord,
  listEmuImportPlanRows as listStoredEmuImportPlanRows,
  listPendingEmuImportPlanRows,
  markEmuImportPlanApplied,
  requireEmuImportPlan,
  updateEmuImportPlanRow,
  acquireApplyLease,
  releaseApplyLease,
  type EmuImportPlanRowRecord,
} from '../db/emuImportPlansRepo.js';
import { appendUserEvent } from '../db/eventLog.js';
import { deleteProxyAccountsBySsoUser } from '../clients/proxyClient.js';
import {
  createUser,
  deleteUser,
  getUser,
  getUserByGhLogin,
  listAllUsers,
  toDto,
  updateEmu,
  updateCopilotSeat,
  updateUser,
  type SsoUserRecord,
} from '../db/usersRepo.js';
import { deleteProvisionedUser, findScimUserByUsername, listScimUsers, suspendUser, syncUser, type ScimEnterpriseRole, type ScimUserResource } from '../scim/scimClient.js';
import { normalizeHandle } from '../scim/handle.js';
import { parseBulkImportText } from './bulkImport.js';

const logger = loggerFor('sso', 'users');

type PlannedEmuAction = 'create' | 'update' | 'skip';

interface PlannedEmuImportRow extends ImportEmuUserRow {
  action?: PlannedEmuAction;
  scimUser?: ScimUserResource;
}

export async function ensureUser(identity: string, preferredSsoUser?: string): Promise<EnsureSsoUserResponse> {
  const candidates = ensureSsoUserCandidates(identity, preferredSsoUser);
  const baseSsoUser = candidates[0] ?? ssoUserFromEnsureInput(identity);
  const existing = await findExistingEnsureUser(identity, preferredSsoUser, candidates);
  if (existing) {
    logger.info('ensure-user', 'SSO user already exists', { identity, ssoUser: existing.ssoUser });
    return { user: toDto(existing), created: false };
  }
  const ssoUser = await nextAvailableSsoUser(baseSsoUser || identity);
  const password = ssoUser;
  const { passwordHash, salt } = hashPassword(password);
  const user = await createUser({
    ssoUser,
    passwordHash,
    salt,
    email: `${ssoUser}@${config.emailDomain}`,
    role: 'user',
    credentialSource: 'generated_default',
  });
  appendUserEvent('create', user);
  logger.info('ensure-user-created', 'Created SSO user for identity', { identity, ssoUser: user.ssoUser });
  return { user: toDto(user), passwordForLogin: password, created: true };
}

export async function createSsoUser(input: { ssoUser: string; password?: string; email?: string; role?: 'user' | 'admin' }): Promise<SsoUserDto> {
  const ssoUser = sanitizeSsoUser(input.ssoUser);
  if (!ssoUser) throw new Error('ssoUser is required');
  if (await getUser(ssoUser)) throw new Error(`SSO user "${ssoUser}" already exists.`);
  const password = input.password || ssoUser;
  const { passwordHash, salt } = hashPassword(password);
  const credentialSource = input.password ? 'operator_managed' : 'generated_default';
  const user = await createUser({
    ssoUser,
    passwordHash,
    salt,
    email: input.email || `${ssoUser}@${config.emailDomain}`,
    role: input.role ?? 'user',
    credentialSource,
  });
  appendUserEvent('create', user);
  logger.info('create-user', 'Created SSO user', { ssoUser: user.ssoUser, email: user.email, role: user.role });
  return toDto(user);
}

export async function patchSsoUser(ssoUser: string, input: { password?: string; email?: string; role?: 'user' | 'admin' }): Promise<SsoUserDto | undefined> {
  const patch: Parameters<typeof updateUser>[1] = {};
  if (input.email !== undefined) patch.email = input.email;
  if (input.role !== undefined) patch.role = input.role;
  if (input.password) {
    const hashed = hashPassword(input.password);
    patch.passwordHash = hashed.passwordHash;
    patch.salt = hashed.salt;
    patch.credentialSource = 'operator_managed';
  }
  const user = await updateUser(ssoUser, patch);
  if (user) logger.info('patch-user', 'Updated SSO user', { ssoUser: user.ssoUser, changedPassword: Boolean(input.password), emailChanged: input.email !== undefined, roleChanged: input.role !== undefined });
  return user ? toDto(user) : undefined;
}

export async function deleteSsoUser(ssoUser: string): Promise<boolean> {
  const user = await getUser(ssoUser);
  if (!user) return false;
  logger.info('delete-user-start', 'Deleting SSO user', { ssoUser });
  await removeCopilotSeatForUser(user);
  await deleteProvisionedUser(user);
  const proxyDelete = await deleteProxyAccountsBySsoUser(user.ssoUser);
  logger.info('delete-user-proxy-cleaned', 'Deleted proxy data for SSO user', { ...proxyDelete });
  const deleted = await deleteUser(ssoUser);
  if (deleted) appendUserEvent('delete', user);
  logger.info('delete-user-done', 'Deleted SSO user', { ssoUser, deleted });
  return deleted;
}

export async function syncSsoUser(ssoUser: string, enterpriseRole?: ScimEnterpriseRole): Promise<SsoUserDto> {
  const user = await requireUser(ssoUser);
  const resolvedEnterpriseRole = enterpriseRole ?? enterpriseRoleForSsoUser(user);
  logger.info('sync-emu-start', 'Syncing SSO user to GH login', { ssoUser, enterpriseRole: resolvedEnterpriseRole });
  const provisioned = await syncUser(user, resolvedEnterpriseRole);
  const updated = await updateEmu(ssoUser, {
    ghLogin: provisioned.ghLogin,
    ghScimId: provisioned.scimId,
    emuStatus: 'active',
  });
  const withSeat = await assignCopilotSeatForUser(updated, provisioned.ghLogin);
  logger.info('sync-emu-done', 'Synced SSO user to GH login and assigned Copilot seat', { ssoUser, ghLogin: withSeat.ghLogin, ghScimId: withSeat.ghScimId });
  return toDto(withSeat);
}

export async function suspendSsoUser(ssoUser: string): Promise<SsoUserDto> {
  const user = await requireUser(ssoUser);
  if (!user.ghScimId) throw new Error(`SSO user "${ssoUser}" is not synced to a GH login.`);
  logger.info('suspend-emu-start', 'Suspending GH login', { ssoUser, ghScimId: user.ghScimId });
  await suspendUser(user.ghScimId);
  const updated = await updateEmu(ssoUser, { ghLogin: user.ghLogin, ghScimId: user.ghScimId, emuStatus: 'suspended' });
  logger.info('suspend-emu-done', 'Suspended GH login', { ssoUser, ghScimId: user.ghScimId });
  return toDto(updated);
}

export async function deleteEmuUser(ssoUser: string): Promise<SsoUserDto> {
  const user = await requireUser(ssoUser);
  logger.info('delete-emu-start', 'Deleting provisioned GH login', { ssoUser, ghScimId: user.ghScimId });
  await removeCopilotSeatForUser(user);
  await deleteProvisionedUser(user);
  const updated = await updateEmu(ssoUser, { emuStatus: 'not_synced' });
  logger.info('delete-emu-done', 'Deleted provisioned GH login', { ssoUser });
  return toDto(updated);
}

export async function assignCopilotSeatForSsoUser(ssoUser: string): Promise<SsoUserDto> {
  const user = await requireUser(ssoUser);
  const updated = await assignCopilotSeatForUser(user);
  logger.info('assign-copilot-seat', 'Assigned GitHub Copilot seat', { ssoUser, ghLogin: updated.ghLogin });
  return toDto(updated);
}

export async function removeCopilotSeatForSsoUser(ssoUser: string): Promise<SsoUserDto> {
  const user = await requireUser(ssoUser);
  const updated = await removeCopilotSeatForUser(user);
  logger.info('remove-copilot-seat', 'Removed GitHub Copilot seat', { ssoUser, ghLogin: updated.ghLogin });
  return toDto(updated);
}

export async function runSsoUserBatch(input: SsoUserBatchRequest): Promise<BatchResult<SsoUserBatchRow>> {
  const startedAt = nowIso();
  const ssoUsers = uniqueSsoUsers(input.ssoUsers);
  const rows: SsoUserBatchRow[] = [];
  logger.info('batch-start', 'Starting SSO user batch operation', { operation: input.operation, total: ssoUsers.length, enterpriseRole: input.enterpriseRole });
  for (const ssoUser of ssoUsers) {
    try {
      const user = await runSsoUserBatchRow(ssoUser, input);
      rows.push({ ssoUser, status: 'success', detail: batchSuccessDetail(input.operation), user });
    } catch (err) {
      rows.push({ ssoUser, status: 'failed', detail: (err as Error).message });
    }
  }
  const failed = rows.filter((row) => row.status === 'failed').length;
  logger.info('batch-done', 'Finished SSO user batch operation', { operation: input.operation, total: rows.length, success: rows.length - failed, failed });
  return {
    batchId: newBatchId(),
    startedAt,
    finishedAt: nowIso(),
    summary: { total: rows.length, success: rows.length - failed, failed },
    rows,
  };
}

export async function importEmuUsers(input: ImportEmuUsersRequest = {}): Promise<BatchResult<ImportEmuUserRow>> {
  const startedAt = nowIso();
  const plan = await createEmuImportPlan({ ssoUser: input.ssoUser });
  const appliedPlan = input.dryRun ? plan : await applyEmuImportPlan(plan.planId);
  const rows = await listAllStoredEmuImportPlanRows(appliedPlan.planId);
  return batchResult(startedAt, rows);
}

export async function createEmuImportPlan(input: CreateImportEmuPlanRequest = {}): Promise<ImportEmuPlanDto> {
  const targetSsoUser = input.ssoUser?.trim();
  const scimUsers = await loadScimUsersForImport(targetSsoUser);
  const localUsers = await listAllUsers();
  const localBySsoUser = new Map(localUsers.map((user) => [user.ssoUser.toLowerCase(), user]));
  const localByScimId = new Map(localUsers.filter((user) => user.ghScimId).map((user) => [user.ghScimId!, user]));
  const plannedRows = scimUsers.length > 0
    ? buildEmuImportPlan(scimUsers, localBySsoUser, localByScimId)
    : [{ ssoUser: targetSsoUser ?? '', status: 'failed', detail: 'GH SCIM user was not found.' } satisfies PlannedEmuImportRow];
  const plan = await createEmuImportPlanRecord({
    id: newBatchId(),
    ssoUser: targetSsoUser || undefined,
    rows: plannedRows.map(withoutScimUser),
  });
  logger.info('create-emu-import-plan', 'Created GH login import alignment plan', { planId: plan.planId, ssoUser: targetSsoUser, ...plan.summary });
  return plan;
}

export async function getEmuImportPlan(planId: string): Promise<ImportEmuPlanDto> {
  return requireEmuImportPlan(planId);
}

export async function listEmuImportPlanRows(planId: string, query: { status?: ImportEmuUserStatus; page?: number; pageSize?: number } = {}): Promise<PageResponse<ImportEmuUserRow>> {
  return listStoredEmuImportPlanRows(planId, query);
}

export async function applyEmuImportPlan(planId: string): Promise<ImportEmuPlanDto> {
  await requireEmuImportPlan(planId);
  
  // Acquire apply lease (FOR UPDATE SKIP LOCKED)
  const leaseOwner = await acquireApplyLease(planId);
  if (!leaseOwner) {
    throw new Error(`EMU import plan "${planId}" is currently being applied by another process or has already been applied.`);
  }
  
  try {
    const pendingRows = await listPendingEmuImportPlanRows(planId);
    const localUsers = await listAllUsers();
    const localBySsoUser = new Map(localUsers.map((user) => [user.ssoUser.toLowerCase(), user]));
    const localByScimId = new Map(localUsers.filter((user) => user.ghScimId).map((user) => [user.ghScimId!, user]));
    
    for (const row of pendingRows) {
      const applied = await applyStoredEmuImportRow(row, localBySsoUser, localByScimId);
      await updateEmuImportPlanRow(planId, applied);
    }
    await markEmuImportPlanApplied(planId);
    const plan = await requireEmuImportPlan(planId);
    logger.info('apply-emu-import-plan', 'Applied EMU import alignment plan', { planId, ...plan.summary });
    return plan;
  } finally {
    await releaseApplyLease(planId, leaseOwner);
  }
}

export async function deleteEmuImportPlan(planId: string): Promise<boolean> {
  const deleted = await deleteEmuImportPlanRecord(planId);
  logger.info('delete-emu-import-plan', 'Deleted EMU import alignment plan data', { planId, deleted });
  return deleted;
}

export async function importUsers(csvText: string): Promise<BatchResult<{ line: number; ssoUser: string; status: string; detail: string }>> {
  const startedAt = nowIso();
  const parsed = parseBulkImportText(csvText);
  const rows: { line: number; ssoUser: string; status: string; detail: string }[] = [];
  for (const row of parsed.rows) {
    try {
      const existing = await getUser(row.ssoUser);
      if (existing) {
        const hashed = hashPassword(row.password);
        await updateUser(row.ssoUser, { passwordHash: hashed.passwordHash, salt: hashed.salt, credentialSource: 'operator_managed' });
        rows.push({ line: row.line, ssoUser: row.ssoUser, status: 'updated', detail: 'Updated password' });
      } else {
        await createSsoUser({ ssoUser: row.ssoUser, password: row.password });
        rows.push({ line: row.line, ssoUser: row.ssoUser, status: 'created', detail: 'Created SSO user' });
      }
    } catch (err) {
      rows.push({ line: row.line, ssoUser: row.ssoUser, status: 'failed', detail: (err as Error).message });
    }
  }
  for (const error of parsed.errors) {
    rows.push({ line: error.line, ssoUser: error.ssoUser ?? '', status: 'failed', detail: error.error });
  }
  const failed = rows.filter((r) => r.status === 'failed').length;
  logger.info('import-users', 'Imported SSO users', { total: rows.length, success: rows.length - failed, failed });
  return {
    batchId: newBatchId(),
    startedAt,
    finishedAt: nowIso(),
    summary: { total: rows.length, success: rows.length - failed, failed },
    rows: rows.sort((a, b) => a.line - b.line),
  };
}

async function requireUser(ssoUser: string): Promise<SsoUserRecord> {
  const user = await getUser(ssoUser);
  if (!user) throw new Error(`SSO user "${ssoUser}" was not found.`);
  return user;
}

async function runSsoUserBatchRow(ssoUser: string, input: SsoUserBatchRequest): Promise<SsoUserDto | undefined> {
  switch (input.operation) {
    case 'sync_emu':
      return syncSsoUser(ssoUser, input.enterpriseRole);
    case 'assign_copilot':
      return assignCopilotSeatForSsoUser(ssoUser);
    case 'remove_copilot':
      return removeCopilotSeatForSsoUser(ssoUser);
    case 'suspend_emu':
      return suspendSsoUser(ssoUser);
    case 'delete_emu':
      return deleteEmuUser(ssoUser);
    case 'delete_sso': {
      const deleted = await deleteSsoUser(ssoUser);
      if (!deleted) throw new Error(`SSO user "${ssoUser}" was not found.`);
      return undefined;
    }
  }
}

function uniqueSsoUsers(ssoUsers: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ssoUsers) {
    const ssoUser = raw.trim();
    const key = ssoUser.toLowerCase();
    if (!ssoUser || seen.has(key)) continue;
    seen.add(key);
    result.push(ssoUser);
  }
  return result;
}

function batchSuccessDetail(operation: SsoUserBatchRequest['operation']): string {
  switch (operation) {
    case 'sync_emu':
      return 'Synced to EMU and assigned Copilot seat.';
    case 'assign_copilot':
      return 'Assigned Copilot seat.';
    case 'remove_copilot':
      return 'Removed Copilot seat.';
    case 'suspend_emu':
      return 'Suspended in EMU.';
    case 'delete_emu':
      return 'Deleted EMU provisioning data.';
    case 'delete_sso':
      return 'Deleted local SSO user.';
  }
}

async function assignCopilotSeatForUser(user: SsoUserRecord, ghLogin = user.ghLogin): Promise<SsoUserRecord> {
  if (!ghLogin?.trim()) {
    const message = `SSO user "${user.ssoUser}" is not synced to a GH login.`;
    const updated = await updateCopilotSeat(user.ssoUser, { status: 'assign_failed', lastOperation: 'assign', lastError: message });
    logger.warn('assign-copilot-seat-missing-gh-login', 'Cannot assign Copilot seat without GH login', { ssoUser: updated.ssoUser });
    throw new Error(message);
  }
  try {
    await assignCopilotSeat(ghLogin);
    return updateCopilotSeat(user.ssoUser, { status: 'assigned', lastOperation: 'assign' });
  } catch (err) {
    const updated = await updateCopilotSeat(user.ssoUser, { status: 'assign_failed', lastOperation: 'assign', lastError: errorMessage(err) });
    logger.error('assign-copilot-seat-failed', 'Failed to assign GitHub Copilot seat', { ssoUser: updated.ssoUser, ghLogin, ...errorFields(err) });
    throw err;
  }
}

async function removeCopilotSeatForUser(user: SsoUserRecord): Promise<SsoUserRecord> {
  if (!user.ghLogin) {
    logger.info('remove-copilot-seat-skipped', 'SSO user has no GH login for Copilot seat removal', { ssoUser: user.ssoUser });
    return updateCopilotSeat(user.ssoUser, { status: 'unassigned', lastOperation: 'remove' });
  }
  try {
    await removeCopilotSeat(user.ghLogin);
    return updateCopilotSeat(user.ssoUser, { status: 'unassigned', lastOperation: 'remove' });
  } catch (err) {
    const updated = await updateCopilotSeat(user.ssoUser, { status: 'remove_failed', lastOperation: 'remove', lastError: errorMessage(err) });
    logger.error('remove-copilot-seat-failed', 'Failed to remove GitHub Copilot seat', { ssoUser: updated.ssoUser, ghLogin: user.ghLogin, ...errorFields(err) });
    throw err;
  }
}

function enterpriseRoleForSsoUser(user: SsoUserRecord): ScimEnterpriseRole {
  return user.role === 'admin' ? 'enterprise_owner' : 'user';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadScimUsersForImport(targetSsoUser: string | undefined): Promise<ScimUserResource[]> {
  if (!targetSsoUser) return listScimUsers();
  const byUserName = await findScimUserByUsername(targetSsoUser);
  if (byUserName) return [byUserName];
  const target = targetSsoUser.toLowerCase();
  return (await listScimUsers()).filter((scimUser) => {
    const ssoUser = ssoUserFromScimUser(scimUser).toLowerCase();
    const ghLogin = ghLoginFromScimUser(scimUser, ssoUser).toLowerCase();
    return ssoUser === target || ghLogin === target || scimUser.userName.toLowerCase() === target || scimUser.externalId?.toLowerCase() === target;
  });
}

async function listAllStoredEmuImportPlanRows(planId: string): Promise<ImportEmuUserRow[]> {
  const rows: ImportEmuUserRow[] = [];
  for (let page = 1; ; page += 1) {
    const result = await listStoredEmuImportPlanRows(planId, { page, pageSize: 500 });
    rows.push(...result.items);
    if (rows.length >= result.total || result.items.length === 0) return rows;
  }
}

function buildEmuImportPlan(scimUsers: ScimUserResource[], localBySsoUser: Map<string, SsoUserRecord>, localByScimId: Map<string, SsoUserRecord>): PlannedEmuImportRow[] {
  const candidates = scimUsers.map(toPlannedCandidate);
  const duplicateSsoUsers = duplicateValues(candidates.filter(hasScimUser).map((row) => row.ssoUser));
  return candidates.map((candidate) => {
    if (!candidate.scimUser || candidate.status === 'failed') return candidate;
    if (duplicateSsoUsers.has(candidate.ssoUser)) {
      return { ...withoutAction(candidate), status: 'conflict', detail: `Multiple GH SCIM users map to SSO user "${candidate.ssoUser}".` };
    }
    const existing = localBySsoUser.get(candidate.ssoUser.toLowerCase());
    const boundLocalUser = localByScimId.get(candidate.ghScimId!);
    if (boundLocalUser && boundLocalUser.ssoUser.toLowerCase() !== candidate.ssoUser.toLowerCase()) {
      return {
        ...withoutAction(candidate),
        status: 'conflict',
        detail: `GH SCIM id is already bound to SSO user "${boundLocalUser.ssoUser}". Rename is not applied automatically.`,
      };
    }
    if (existing?.ghScimId && existing.ghScimId !== candidate.ghScimId) {
      return {
        ...withoutAction(candidate),
        status: 'conflict',
        detail: `SSO user is already bound to different GH SCIM id "${existing.ghScimId}".`,
      };
    }
    if (!existing) {
      return { ...candidate, action: 'create', status: 'pending_create', detail: 'Will create SSO user; password will default to ssoUser.' };
    }
    if (isAlreadyAligned(existing, candidate)) {
      return { ...candidate, action: 'skip', status: 'skipped', detail: 'SSO user is already aligned with GH SCIM.' };
    }
    return { ...candidate, action: 'update', status: 'pending_update', detail: 'Will update email and GH login metadata.' };
  });
}

function toPlannedCandidate(scimUser: ScimUserResource): PlannedEmuImportRow {
  if (!scimUser.id) {
    return {
      ssoUser: ssoUserFromScimUser(scimUser),
      status: 'failed',
      detail: `GH SCIM user "${scimUser.userName}" does not include an id.`,
    };
  }
  const rawSsoUser = ssoUserFromScimUser(scimUser);
  const ssoUser = sanitizeSsoUser(rawSsoUser);
  if (!ssoUser) {
    return {
      ssoUser: rawSsoUser || scimUser.externalId || scimUser.userName,
      ghLogin: ghLoginFromScimUser(scimUser, rawSsoUser),
      ghScimId: scimUser.id,
      status: 'failed',
      detail: `GH SCIM user "${scimUser.userName}" cannot be mapped to an SSO user.`,
    };
  }
  const ghLogin = ghLoginFromScimUser(scimUser, ssoUser);
  const emuStatus = scimUser.active === false ? 'suspended' : 'active';
  return {
    ssoUser,
    email: primaryEmail(scimUser) || `${ssoUser}@${config.emailDomain}`,
    ghLogin,
    ghScimId: scimUser.id,
    emuStatus,
    status: 'pending_update',
    detail: '',
    scimUser,
  };
}

async function applyStoredEmuImportRow(row: EmuImportPlanRowRecord, localBySsoUser: Map<string, SsoUserRecord>, localByScimId: Map<string, SsoUserRecord>): Promise<EmuImportPlanRowRecord> {
  const staleConflict = staleConflictForRow(row, localBySsoUser, localByScimId);
  if (staleConflict) return { ...row, action: undefined, status: 'conflict', detail: staleConflict };
  return { ...(await applyEmuImportRow({ ...row, scimUser: undefined })), rowIndex: row.rowIndex, action: undefined };
}

async function applyEmuImportRow(row: PlannedEmuImportRow): Promise<ImportEmuUserRow> {
  if (row.action === 'skip' || row.status === 'conflict' || row.status === 'failed') return toImportRow(row);
  if (!row.ghScimId || !row.ghLogin || !row.email || !row.emuStatus) return { ...toImportRow(row), status: 'failed', detail: 'Import plan row is incomplete.' };
  if (row.action === 'create') {
    // Per plan spec: create with deterministic initial password (ssoUser value), mark as generated_default
    const password = row.ssoUser;
    const { passwordHash, salt } = hashPassword(password);
    const created = await createUser({ ssoUser: row.ssoUser, passwordHash, salt, email: row.email, role: 'user', credentialSource: 'generated_default' });
    const updated = await updateEmu(created.ssoUser, { ghLogin: row.ghLogin, ghScimId: row.ghScimId, emuStatus: row.emuStatus });
    appendUserEvent('import_emu_create', updated);
    logger.info('import-emu-user-created', 'Recreated SSO user from GH SCIM user', { ssoUser: row.ssoUser, ghLogin: row.ghLogin, ghScimId: row.ghScimId, emuStatus: row.emuStatus });
    return {
      ...toImportRow(row),
      email: updated.email,
      ghLogin: updated.ghLogin,
      ghScimId: updated.ghScimId,
      emuStatus: updated.emuStatus,
      status: 'created',
      detail: 'Created SSO user from GH SCIM; password defaults to ssoUser. Copilot seat status remains unknown.',
      // passwordForLogin OMITTED per plan spec (never returned in DTO)
    };
  }
  if (row.action === 'update') {
    await updateUser(row.ssoUser, { email: row.email });
    const updated = await updateEmu(row.ssoUser, { ghLogin: row.ghLogin, ghScimId: row.ghScimId, emuStatus: row.emuStatus });
    logger.info('import-emu-user-updated', 'Updated SSO user from GH SCIM user', { ssoUser: row.ssoUser, ghLogin: row.ghLogin, ghScimId: row.ghScimId, emuStatus: row.emuStatus });
    return {
      ...toImportRow(row),
      email: updated.email,
      ghLogin: updated.ghLogin,
      ghScimId: updated.ghScimId,
      emuStatus: updated.emuStatus,
      status: 'updated',
      detail: 'Updated SSO user from GH SCIM. Copilot seat status was not changed.',
    };
  }
  return { ...toImportRow(row), status: 'failed', detail: 'Import plan row has no applicable action.' };
}

function staleConflictForRow(row: EmuImportPlanRowRecord, localBySsoUser: Map<string, SsoUserRecord>, localByScimId: Map<string, SsoUserRecord>): string | undefined {
  if (!row.ghScimId || !row.ghLogin || !row.email || !row.emuStatus) return 'Import plan row is incomplete.';
  const existing = localBySsoUser.get(row.ssoUser.toLowerCase());
  const boundLocalUser = localByScimId.get(row.ghScimId);
  if (boundLocalUser && boundLocalUser.ssoUser.toLowerCase() !== row.ssoUser.toLowerCase()) {
    return `GH SCIM id is already bound to SSO user "${boundLocalUser.ssoUser}". Preview again before applying.`;
  }
  if (existing?.ghScimId && existing.ghScimId !== row.ghScimId) {
    return `SSO user is already bound to different GH SCIM id "${existing.ghScimId}". Preview again before applying.`;
  }
  if (row.action === 'create' && existing) return 'SSO user now exists. Preview again before applying.';
  if (row.action === 'update' && !existing) return 'SSO user disappeared after preview. Preview again before applying.';
  return undefined;
}

function toImportRow(row: PlannedEmuImportRow): ImportEmuUserRow {
  return {
    ssoUser: row.ssoUser,
    email: row.email,
    ghLogin: row.ghLogin,
    ghScimId: row.ghScimId,
    emuStatus: row.emuStatus,
    status: row.status,
    detail: row.detail,
    // passwordForLogin intentionally omitted per plan spec
  };
}

function withoutAction(row: PlannedEmuImportRow): PlannedEmuImportRow {
  return { ...row, action: undefined };
}

function withoutScimUser(row: PlannedEmuImportRow): Omit<EmuImportPlanRowRecord, 'rowIndex'> {
  const { scimUser: _scimUser, ...stored } = row;
  return stored;
}

function hasScimUser(row: PlannedEmuImportRow): boolean {
  return Boolean(row.scimUser);
}

function duplicateValues(values: string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function isAlreadyAligned(existing: SsoUserRecord, row: PlannedEmuImportRow): boolean {
  return existing.email === row.email
    && existing.ghLogin === row.ghLogin
    && existing.ghScimId === row.ghScimId
    && existing.emuStatus === row.emuStatus;
}

function batchResult(startedAt: string, rows: ImportEmuUserRow[]): BatchResult<ImportEmuUserRow> {
  const counts = summaryCounts(rows);
  return {
    batchId: newBatchId(),
    startedAt,
    finishedAt: nowIso(),
    summary: { total: rows.length, success: counts.success, skipped: counts.skipped, failed: counts.failed },
    rows,
  };
}

function summaryCounts(rows: ImportEmuUserRow[]): { success: number; skipped: number; failed: number } {
  const skipped = rows.filter((row) => row.status === 'skipped').length;
  const failed = rows.filter((row) => row.status === 'failed' || row.status === 'conflict').length;
  return { success: rows.length - skipped - failed, skipped, failed };
}

function ssoUserFromScimUser(scimUser: ScimUserResource): string {
  return scimUser.userName || scimUser.externalId || '';
}

function ghLoginFromScimUser(scimUser: ScimUserResource, ssoUser: string): string {
  return scimUser.githubLogin || normalizeHandle(ssoUser || scimUser.userName, config.enterpriseShortcode);
}

function primaryEmail(scimUser: ScimUserResource): string | undefined {
  return scimUser.emails?.find((email) => email.primary)?.value ?? scimUser.emails?.[0]?.value;
}

async function nextAvailableSsoUser(raw: string): Promise<string> {
  const base = sanitizeSsoUser(raw) || config.userPrefix;
  if (!await getUser(base)) return base;
  for (let i = 2; i < 100_000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!await getUser(candidate)) return candidate;
  }
  const allUsers = await listAllUsers();
  const count = allUsers.length + 1;
  return `${config.userPrefix}${count}`;
}

function sanitizeSsoUser(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function ssoUserFromEnsureInput(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stripEnterpriseShortcode(normalized).slice(0, 32);
}

function ensureSsoUserCandidates(identity: string, preferredSsoUser?: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of [preferredSsoUser, identity]) {
    if (typeof raw !== 'string') continue;
    const ssoUser = ssoUserFromEnsureInput(raw);
    const key = ssoUser.toLowerCase();
    if (!ssoUser || seen.has(key)) continue;
    seen.add(key);
    candidates.push(ssoUser);
  }
  return candidates;
}

async function findExistingEnsureUser(identity: string, preferredSsoUser: string | undefined, ssoUserCandidates: string[]): Promise<SsoUserRecord | undefined> {
  for (const ssoUser of ssoUserCandidates) {
    const user = await getUser(ssoUser);
    if (user) return user;
  }
  for (const ghLogin of ensureGhLoginCandidates(identity, preferredSsoUser)) {
    const user = await getUserByGhLogin(ghLogin);
    if (user) return user;
  }
  return undefined;
}

function ensureGhLoginCandidates(identity: string, preferredSsoUser?: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of [identity, preferredSsoUser]) {
    if (typeof raw !== 'string') continue;
    const ghLogin = raw.trim();
    const key = ghLogin.toLowerCase();
    if (!ghLogin || seen.has(key)) continue;
    seen.add(key);
    candidates.push(ghLogin);
  }
  return candidates;
}

function stripEnterpriseShortcode(value: string): string {
  const shortcode = config.enterpriseShortcode.trim().toLowerCase();
  if (!shortcode) return value;
  const suffix = `_${shortcode}`;
  if (!value.endsWith(suffix)) return value;
  const stripped = value.slice(0, -suffix.length);
  return stripped || value;
}
