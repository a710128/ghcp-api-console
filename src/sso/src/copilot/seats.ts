import { loggerFor } from '@ghcp/shared';
import { config } from '../config.js';

export interface CopilotSeatMutationResult {
  ghLogin: string;
  operation: 'assign' | 'remove';
  status: number;
  response: unknown;
}

const logger = loggerFor('sso', 'copilot-seats');

export async function assignCopilotSeat(ghLogin: string): Promise<CopilotSeatMutationResult> {
  return mutateCopilotSeat('assign', ghLogin);
}

export async function removeCopilotSeat(ghLogin: string): Promise<CopilotSeatMutationResult> {
  return mutateCopilotSeat('remove', ghLogin);
}

async function mutateCopilotSeat(operation: 'assign' | 'remove', ghLogin: string): Promise<CopilotSeatMutationResult> {
  const username = ghLogin.trim();
  if (!username) throw new Error('ghLogin is required for Copilot seat management.');
  if (!config.githubCopilotSeatPat) throw new Error('GITHUB_COPILOT_SEAT_PAT is required for Copilot seat management.');
  const method = operation === 'assign' ? 'POST' : 'DELETE';
  const res = await fetch(copilotSelectedUsersUrl(), {
    method,
    headers: {
      Authorization: `Bearer ${config.githubCopilotSeatPat}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    body: JSON.stringify({ selected_usernames: [username] }),
  });
  const response = await readJsonOrText(res);
  if (!res.ok) throw new Error(`GitHub Copilot seat ${operation} failed for "${username}": ${res.status} ${formatResponse(response)}`);
  logger.info(operation, 'GitHub Copilot seat mutation completed', { operation, ghLogin: username, status: res.status });
  return { ghLogin: username, operation, status: res.status, response };
}

function copilotSelectedUsersUrl(): string {
  return `${config.githubApiBaseUrl.replace(/\/+$/, '')}/enterprises/${encodeURIComponent(config.enterpriseSlug)}/copilot/billing/selected_users`;
}

async function readJsonOrText(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function formatResponse(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
