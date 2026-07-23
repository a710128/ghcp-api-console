import 'dotenv/config';
import { randomUUID } from 'node:crypto';

export interface ProxyConfig {
  port: number;
  apiKey: string;
  identityHeader: string;
  identityHeaderRequired: boolean;
  claudeCodeOptimized: boolean;
  internalApiToken: string;
  ssoBaseUrl: string;
  loginBaseUrl: string;
  enterpriseShortcode: string;
  requestStatsPerAccountLimit: number;
  editorHeaders: EditorHeaders;
  claudeCodeOptimizedEditorHeaders: ClaudeCodeOptimizedEditorHeaders;
}

export interface EditorHeaders {
  'Editor-Version': string;
  'Editor-Plugin-Version': string;
  'User-Agent': string;
  'X-GitHub-Api-Version': string;
  'Copilot-Integration-Id': string;
}

export interface ClaudeCodeOptimizedEditorHeaders {
  'VScode-SessionId': string;
  'VScode-MachineId': string;
  'Editor-Device-Id': string;
  'X-GitHub-Api-Version': string;
  'Copilot-Integration-Id': string;
  'Editor-Version': string;
  'Editor-Plugin-Version': string;
  'User-Agent': string;
}

export const config: ProxyConfig = {
  port: readPort(process.env.PORT, 3000),
  apiKey: process.env.API_KEY ?? '',
  identityHeader: process.env.IDENTITY_HEADER ?? 'X-User-Identity',
  identityHeaderRequired: readBoolean(process.env.IDENTITY_HEADER_REQUIRED, true),
  claudeCodeOptimized: readBoolean(process.env.CLAUDE_CODE_OPTIMIZED, false),
  internalApiToken: process.env.INTERNAL_API_TOKEN ?? '',
  ssoBaseUrl: process.env.SSO_BASE_URL ?? 'http://localhost:7001',
  loginBaseUrl: process.env.LOGIN_BASE_URL ?? 'http://localhost:7003',
  enterpriseShortcode: readOptionalString(process.env.ENTERPRISE_SHORTCODE) ?? 'octo',
  requestStatsPerAccountLimit: readPositiveInteger(process.env.REQUEST_STATS_PER_ACCOUNT_LIMIT, 100),
  editorHeaders: {
    'Editor-Version': process.env.EDITOR_VERSION ?? 'vscode/1.95.0',
    'Editor-Plugin-Version': process.env.EDITOR_PLUGIN_VERSION ?? 'copilot-chat/0.46.0',
    'User-Agent': process.env.USER_AGENT ?? 'GitHubCopilotChat/0.46.0',
    'X-GitHub-Api-Version': process.env.GITHUB_API_VERSION ?? '2026-01-09',
    'Copilot-Integration-Id': process.env.COPILOT_INTEGRATION_ID ?? 'vscode-chat',
  },
  claudeCodeOptimizedEditorHeaders: {
    'VScode-SessionId': readOptionalString(process.env.VSCODE_SESSION_ID) ?? cryptoRandomId(),
    'VScode-MachineId': readOptionalString(process.env.VSCODE_MACHINE_ID) ?? cryptoRandomId(),
    'Editor-Device-Id': readOptionalString(process.env.EDITOR_DEVICE_ID) ?? cryptoRandomId(),
    'X-GitHub-Api-Version': readOptionalString(process.env.CLAUDE_CODE_GITHUB_API_VERSION) ?? '2026-01-09',
    'Copilot-Integration-Id': readOptionalString(process.env.CLAUDE_CODE_COPILOT_INTEGRATION_ID) ?? 'vscode-chat',
    'Editor-Version': readOptionalString(process.env.CLAUDE_CODE_EDITOR_VERSION) ?? process.env.EDITOR_VERSION ?? 'vscode/1.95.0',
    'Editor-Plugin-Version': readOptionalString(process.env.CLAUDE_CODE_EDITOR_PLUGIN_VERSION) ?? process.env.EDITOR_PLUGIN_VERSION ?? 'copilot-chat/0.46.0',
    'User-Agent': readOptionalString(process.env.CLAUDE_CODE_USER_AGENT) ?? process.env.USER_AGENT ?? 'GitHubCopilotChat/0.46.0',
  },
};

function cryptoRandomId(): string {
  return randomUUID();
}

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

function readBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`Invalid boolean "${value}".`);
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
