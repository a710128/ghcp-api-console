import { JsonHttpClient } from '@ghcp/shared';
import { config } from '../config.js';

const client = new JsonHttpClient({
  baseUrl: config.proxyBaseUrl,
  internalToken: config.internalApiToken,
});

export async function saveGithubToken(identity: string, ghToken: string, ghLogin?: string): Promise<void> {
  await client.request(`/internal/accounts/${encodeURIComponent(identity)}/gh-token`, {
    method: 'PUT',
    body: { ghToken, ghLogin },
  });
}

export async function markGithubTokenFailed(identity: string, failureReason: string): Promise<void> {
  await client.request(`/internal/accounts/${encodeURIComponent(identity)}/mark-gh-token-failed`, {
    method: 'POST',
    body: { failureReason },
  });
}
