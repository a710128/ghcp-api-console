/**
 * Drizzle schema definitions for the `proxy` PostgreSQL schema.
 * These are TypeScript type definitions mirroring the SQL migration.
 * Used by proxy service repository implementations.
 */

export interface ProxyAccountRow {
  identity: string;
  sso_user: string;
  gh_login: string | null;
  gh_token_cipher: string | null;
  gh_token_nonce: string | null;
  gh_token_status: 'valid' | 'expired' | 'missing' | 'refreshing' | 'failed';
  gh_token_updated_at: Date | null;
  copilot_token_cipher: string | null;
  copilot_token_nonce: string | null;
  copilot_api: string | null;
  copilot_token_expires_at: Date | null;
  copilot_token_status: 'valid' | 'expired' | 'missing' | 'refreshing' | 'failed';
  credential_version: bigint;
  active_login_task_id: string | null;
  active_task_generation: bigint | null;
  active_attempt_token: string | null;
  created_at: Date;
  updated_at: Date;
}

export type GhTokenStatus = ProxyAccountRow['gh_token_status'];
export type CopilotTokenStatus = ProxyAccountRow['copilot_token_status'];
