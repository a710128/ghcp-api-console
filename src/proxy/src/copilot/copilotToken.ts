import { config } from '../config.js';

export interface CopilotTokenData {
  token: string;
  expiresAt: number;
  refreshIn: number;
  api: string;
  fetchedAt: number;
}

interface CopilotTokenResponse {
  token: string;
  expires_at: number;
  refresh_in: number;
  endpoints?: { api?: string };
}

const DEFAULT_API = 'https://api.githubcopilot.com';
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

export async function exchangeCopilotToken(githubToken: string): Promise<CopilotTokenData> {
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: 'application/json',
      ...config.editorHeaders,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Copilot token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as CopilotTokenResponse;
  return {
    token: data.token,
    expiresAt: data.expires_at,
    refreshIn: data.refresh_in,
    api: data.endpoints?.api ?? DEFAULT_API,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}
