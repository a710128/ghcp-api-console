import { JsonHttpClient } from '@ghcp/shared';
import { config } from '../config.js';

const client = new JsonHttpClient({
  baseUrl: config.proxyBaseUrl,
  internalToken: config.internalApiToken,
});

export interface OauthDeliveryFence {
  taskId: string;
  taskGeneration: string;
  attemptToken: string;
}

export async function saveCopilotOauthToken(
  identity: string,
  copilotOauthToken: string,
  fence: OauthDeliveryFence,
  ghLogin?: string,
): Promise<void> {
  await client.request(`/internal/accounts/${encodeURIComponent(identity)}/copilot-oauth-token`, {
    method: 'PUT',
    body: { copilotOauthToken, ghLogin, ...fence },
  });
}

export async function markCopilotOauthFailed(
  identity: string,
  fence: OauthDeliveryFence,
  failureReason: string,
): Promise<void> {
  await client.request(`/internal/accounts/${encodeURIComponent(identity)}/copilot-oauth-failed`, {
    method: 'POST',
    body: { ...fence, failureReason },
  });
}
