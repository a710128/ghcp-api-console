import 'dotenv/config';

export interface SsoConfig {
  port: number;
  dbPath: string;
  internalApiToken: string;
  baseUrl: string;
  proxyBaseUrl: string;
  mockGithubBaseUrl: string;
  sessionSecret: string;
  emailDomain: string;
  userPrefix: string;
  eventLogPath: string;
  enterpriseSlug: string;
  enterpriseShortcode: string;
  githubApiBaseUrl: string;
  githubCopilotSeatPat?: string;
  scimBaseUrl: string;
  scimToken: string;
  scimRequestDelayMs: number;
  scimMaxRetries: number;
  scimRetryBaseDelayMs: number;
  bulkSyncConcurrency: number;
  certDir: string;
  spEntityId: string;
  spAcsUrl: string;
}

export const config: SsoConfig = {
  port: readPort(process.env.PORT, 7001),
  dbPath: process.env.DB_PATH ?? './data/sso.sqlite',
  internalApiToken: process.env.INTERNAL_API_TOKEN ?? '',
  baseUrl: process.env.BASE_URL ?? 'http://localhost:7001',
  proxyBaseUrl: process.env.PROXY_BASE_URL ?? 'http://localhost:3000',
  mockGithubBaseUrl: process.env.MOCK_GITHUB_BASE_URL ?? 'http://localhost:8002',
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',
  emailDomain: process.env.SSO_EMAIL_DOMAIN ?? 'customsso.com',
  userPrefix: process.env.USER_PREFIX ?? 'user',
  eventLogPath: process.env.SSO_USER_EVENTS_LOG ?? './data/sso-user-events.log',
  enterpriseSlug: process.env.ENTERPRISE_SLUG ?? 'acme',
  enterpriseShortcode: process.env.ENTERPRISE_SHORTCODE ?? 'octo',
  githubApiBaseUrl: process.env.GITHUB_API_BASE_URL ?? 'https://api.github.com',
  githubCopilotSeatPat: process.env.GITHUB_COPILOT_SEAT_PAT,
  scimBaseUrl: process.env.SCIM_BASE_URL ?? '',
  scimToken: process.env.SCIM_TOKEN ?? '',
  scimRequestDelayMs: readNonNegativeInteger(process.env.SCIM_REQUEST_DELAY_MS, 250),
  scimMaxRetries: readNonNegativeInteger(process.env.SCIM_MAX_RETRIES, 3),
  scimRetryBaseDelayMs: readNonNegativeInteger(process.env.SCIM_RETRY_BASE_DELAY_MS, 1000),
  bulkSyncConcurrency: readPositiveInteger(process.env.BULK_SYNC_CONCURRENCY, 3),
  certDir: process.env.CERT_DIR ?? '../../certs',
  spEntityId: process.env.SP_ENTITY_ID ?? '',
  spAcsUrl: process.env.SP_ACS_URL ?? '',
};

function readPort(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) throw new Error(`Invalid PORT "${value}".`);
  return parsed;
}

function readPositiveInteger(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Invalid positive integer "${value}".`);
  return parsed;
}

function readNonNegativeInteger(value: string | undefined, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid non-negative integer "${value}".`);
  return parsed;
}
