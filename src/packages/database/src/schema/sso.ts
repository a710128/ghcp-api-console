/**
 * Drizzle schema definitions for the `sso` PostgreSQL schema.
 */

export interface SsoUserRow {
  sso_user: string;
  password_hash: string;
  salt: string;
  email: string;
  role: 'user' | 'admin';
  gh_login: string | null;
  gh_scim_id: string | null;
  emu_status: 'active' | 'suspended' | 'deleted' | 'not_synced';
  copilot_seat_status: 'unknown' | 'assigned' | 'unassigned' | 'assign_failed' | 'remove_failed';
  copilot_seat_last_operation: 'assign' | 'remove' | null;
  copilot_seat_last_error: string | null;
  copilot_seat_updated_at: Date | null;
  credential_source: 'generated_default' | 'operator_managed';
  created_at: Date;
  updated_at: Date;
}

export interface SsoScimRateLimitRow {
  id: string;
  next_allowed_at: Date;
}

export interface SsoBudgetCacheRow {
  period_key: string;
  year: number;
  month: number;
  quantity: number;
  unit_type: string | null;
  fetched_at: Date;
}

export interface SsoEmuImportPlanRow {
  id: string;
  sso_user: string | null;
  status: 'planned' | 'applied';
  apply_lease_owner: string | null;
  apply_lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
  applied_at: Date | null;
}

export interface SsoEmuImportPlanRowRecord {
  plan_id: string;
  row_index: number;
  sso_user: string;
  email: string | null;
  gh_login: string | null;
  gh_scim_id: string | null;
  emu_status: 'active' | 'suspended' | 'deleted' | 'not_synced' | null;
  status: 'pending_create' | 'pending_update' | 'created' | 'updated' | 'skipped' | 'conflict' | 'failed';
  detail: string;
  action: 'create' | 'update' | 'skip' | null;
  created_at: Date;
  updated_at: Date;
}

export type EmuStatus = SsoUserRow['emu_status'];
export type CopilotSeatStatus = SsoUserRow['copilot_seat_status'];
export type CopilotSeatOperation = 'assign' | 'remove';
export type CredentialSource = SsoUserRow['credential_source'];
