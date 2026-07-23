/**
 * Drizzle schema definitions for the `login` PostgreSQL schema.
 */

export interface LoginTaskRow {
  id: string;
  identity: string;
  sso_user: string;
  gh_login: string | null;
  sso_type: 'azure' | 'custom';
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  attempts: number;
  failure_reason: string | null;
  task_generation: bigint;
  current_attempt_token: string | null;
  result_pending: boolean;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface LoginTaskSecretRow {
  task_id: string;
  secret_cipher: string;
  secret_nonce: string;
  created_at: Date;
}

export interface LoginJobOutboxRow {
  task_id: string;
  task_generation: bigint;
  pg_boss_key: string;
  state: 'pending' | 'delivered' | 'failed';
  locked_at: Date | null;
  locked_by: string | null;
  lease_expires_at: Date | null;
  lease_token: string | null;
  delivered_at: Date | null;
  created_at: Date;
}

export interface LoginResultOutboxRow {
  task_id: string;
  task_generation: bigint;
  attempt_token: string;
  gh_token_cipher: string;
  gh_token_nonce: string;
  gh_login: string | null;
  state: 'pending' | 'delivered' | 'failed';
  locked_at: Date | null;
  locked_by: string | null;
  lease_expires_at: Date | null;
  delivered_at: Date | null;
  retry_count: number;
  created_at: Date;
}

export type LoginTaskStatus = LoginTaskRow['status'];
export type SsoType = LoginTaskRow['sso_type'];
