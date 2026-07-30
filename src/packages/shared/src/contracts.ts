export type GhTokenStatus = 'valid' | 'expired' | 'missing' | 'refreshing' | 'failed';
export type CopilotTokenStatus = 'valid' | 'expired' | 'missing' | 'refreshing' | 'failed';
export type CopilotOauthStatus = 'valid' | 'expired' | 'missing' | 'refreshing' | 'failed';
export type EmuStatus = 'active' | 'suspended' | 'deleted' | 'not_synced';
export type CopilotSeatStatus = 'unknown' | 'assigned' | 'unassigned' | 'assign_failed' | 'remove_failed';
export type CopilotSeatOperation = 'assign' | 'remove';
export type LoginTaskStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
export type SsoType = 'azure' | 'custom';
export type AccountType = 'business' | 'enterprise';

export interface RequestIdentity {
  identity: string;
  apiKeyName?: string;
}

export interface ProxyAccountDto {
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  ghTokenStatus: GhTokenStatus;
  ghTokenUpdatedAt?: string;
  copilotTokenStatus: CopilotTokenStatus;
  copilotTokenExpiresAt?: string;
  copilotOauthStatus: CopilotOauthStatus;
  copilotOauthUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImportGithubTokensRequest {
  csvText: string;
}

export type ImportGithubTokenRowStatus = 'success' | 'failed';

export interface ImportGithubTokenRow {
  line: number;
  name: string;
  status: ImportGithubTokenRowStatus;
  detail: string;
  account?: ProxyAccountDto;
}

export interface ImportCopilotOauthTokensRequest {
  csvText: string;
}

export type ImportCopilotOauthTokenRowStatus = 'success' | 'failed';

export interface ImportCopilotOauthTokenRow {
  line: number;
  name: string;
  status: ImportCopilotOauthTokenRowStatus;
  detail: string;
  account?: ProxyAccountDto;
}

/** One target for batch Copilot OAuth provisioning + login. */
export interface CopilotOauthBatchLoginItem {
  /** Proxy account identity — MUST equal the header value future LLM requests will send. */
  identity: string;
  ssoUser: string;
  /** Runtime SSO password; encrypted into the login task, never persisted plaintext or echoed back. */
  ssoPassword: string;
  ssoType?: SsoType;
}

export interface CopilotOauthBatchLoginRequest {
  items: CopilotOauthBatchLoginItem[];
}

export type CopilotOauthBatchLoginRowStatus = 'success' | 'skipped' | 'failed';

export type CopilotOauthBatchLoginRowCode =
  | 'account_created_and_queued'
  | 'account_existing_and_queued'
  | 'already_valid'
  | 'login_in_progress'
  | 'identity_busy'
  | 'identity_sso_mismatch'
  | 'sso_user_missing'
  | 'emu_sync_failed'
  | 'gh_login_missing'
  | 'account_create_failed'
  | 'login_enqueue_failed';

export interface CopilotOauthBatchLoginRow {
  identity: string;
  ssoUser: string;
  status: CopilotOauthBatchLoginRowStatus;
  code: CopilotOauthBatchLoginRowCode;
  detail: string;
  accountCreated?: boolean;
  taskId?: string;
  retryable?: boolean;
  account?: ProxyAccountDto;
}

export interface ProxyRequestStatDto {
  id: string;
  identity: string;
  ghLogin?: string;
  requestedAt: string;
  path: '/chat/completions' | '/v1/messages' | '/v1/messages/count_tokens' | '/responses' | '/responses/compact' | '/v1/models';
  model?: string;
  success: boolean;
  failureReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  cacheInputTokens?: number;
  cacheWriteTokens?: number;
}

export interface SsoUserDto {
  ssoUser: string;
  email: string;
  role: 'user' | 'admin';
  ghLogin?: string;
  ghScimId?: string;
  emuStatus: EmuStatus;
  copilotSeatStatus: CopilotSeatStatus;
  copilotSeatLastOperation?: CopilotSeatOperation;
  copilotSeatLastError?: string;
  copilotSeatUpdatedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnsureSsoUserRequest {
  identity: string;
  preferredSsoUser?: string;
}

export interface EnsureSsoUserResponse {
  user: SsoUserDto;
  passwordForLogin?: string;
  created: boolean;
}

export type SsoUserBatchOperation = 'sync_emu' | 'suspend_emu' | 'delete_emu' | 'delete_sso' | 'assign_copilot' | 'remove_copilot';
export type SsoUserBatchRowStatus = 'success' | 'failed';

export interface SsoUserBatchRequest {
  operation: SsoUserBatchOperation;
  ssoUsers: string[];
  enterpriseRole?: 'user' | 'enterprise_owner';
}

export interface SsoUserBatchRow {
  ssoUser: string;
  status: SsoUserBatchRowStatus;
  detail: string;
  user?: SsoUserDto;
}

export interface ImportEmuUsersRequest {
  ssoUser?: string;
  dryRun?: boolean;
}

export type ImportEmuUserStatus = 'pending_create' | 'pending_update' | 'created' | 'updated' | 'skipped' | 'conflict' | 'failed';
export type ImportEmuPlanStatus = 'planned' | 'applied';

export interface CreateImportEmuPlanRequest {
  ssoUser?: string;
}

export interface ImportEmuUserRow {
  rowIndex?: number;
  ssoUser: string;
  email?: string;
  ghLogin?: string;
  ghScimId?: string;
  emuStatus?: EmuStatus;
  status: ImportEmuUserStatus;
  detail: string;
  passwordForLogin?: string;
}

export interface ImportEmuPlanSummary {
  total: number;
  pendingCreate: number;
  pendingUpdate: number;
  created: number;
  updated: number;
  skipped: number;
  conflict: number;
  failed: number;
  actionable: number;
}

export interface ImportEmuPlanDto {
  planId: string;
  ssoUser?: string;
  status: ImportEmuPlanStatus;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  summary: ImportEmuPlanSummary;
}

export interface AiCreditsPeriodUsageDto {
  year: number;
  month: number;
  quantity: number;
  unitType?: string;
  fetchedAt?: string;
}

export interface AiCreditsUsageDto {
  enterprise: string;
  lastMonth: AiCreditsPeriodUsageDto;
  currentMonth: AiCreditsPeriodUsageDto;
  projectedCurrentMonthQuantity: number;
  assignedSeatCount: number;
  assignedSeatMonthlyCost: number;
  seatPricePerMonth: number;
  fetchedAt: string;
}

export interface CreateLoginTaskRequest {
  identity: string;
  ssoUser: string;
  ssoPassword: string;
  ghLogin: string;
  ssoType: SsoType;
  ssoUrl?: string;
  accountType?: AccountType;
  selectorOverrides?: Record<string, string>;
}

export interface LoginTaskDto {
  id: string;
  identity: string;
  ssoUser: string;
  ghLogin?: string;
  ssoType: SsoType;
  status: LoginTaskStatus;
  attempts: number;
  failureReason?: string;
  logPath?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
