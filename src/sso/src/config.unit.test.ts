import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

async function importSsoConfig(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import(`./config.js?bust=${Date.now()}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('sso config', () => {
  it('uses documented default values when optional vars are unset', async () => {
    const mod = await importSsoConfig({
      PORT: undefined,
      INTERNAL_API_TOKEN: undefined,
      BASE_URL: undefined,
      PROXY_BASE_URL: undefined,
      MOCK_GITHUB_BASE_URL: undefined,
      SESSION_SECRET: undefined,
      SSO_EMAIL_DOMAIN: undefined,
      USER_PREFIX: undefined,
      ENTERPRISE_SLUG: undefined,
      ENTERPRISE_SHORTCODE: undefined,
      GITHUB_API_BASE_URL: undefined,
      GITHUB_COPILOT_SEAT_PAT: undefined,
      SCIM_BASE_URL: undefined,
      SCIM_TOKEN: undefined,
      SCIM_REQUEST_DELAY_MS: undefined,
      SCIM_MAX_RETRIES: undefined,
      SCIM_RETRY_BASE_DELAY_MS: undefined,
      BULK_SYNC_CONCURRENCY: undefined,
      CERT_DIR: undefined,
      SP_ENTITY_ID: undefined,
      SP_ACS_URL: undefined,
    });
    const { config } = mod;
    assert.equal(config.port, 7001);
    assert.equal(config.internalApiToken, '');
    assert.equal(config.baseUrl, 'http://localhost:7001');
    assert.equal(config.proxyBaseUrl, 'http://localhost:3000');
    assert.equal(config.mockGithubBaseUrl, 'http://localhost:8002');
    assert.equal(config.sessionSecret, 'dev-secret-change-me');
    assert.equal(config.emailDomain, 'customsso.com');
    assert.equal(config.userPrefix, 'user');
    assert.equal(config.enterpriseSlug, 'acme');
    assert.equal(config.enterpriseShortcode, 'octo');
    assert.equal(config.githubApiBaseUrl, 'https://api.github.com');
    assert.equal(config.githubCopilotSeatPat, undefined);
    assert.equal(config.scimBaseUrl, '');
    assert.equal(config.scimToken, '');
    assert.equal(config.scimRequestDelayMs, 250);
    assert.equal(config.scimMaxRetries, 3);
    assert.equal(config.scimRetryBaseDelayMs, 1000);
    assert.equal(config.bulkSyncConcurrency, 3);
    assert.equal(config.certDir, '../../certs');
    assert.equal(config.spEntityId, '');
    assert.equal(config.spAcsUrl, '');
  });

  it('reads overridden values from the environment', async () => {
    const { config } = await importSsoConfig({
      PORT: '8123',
      INTERNAL_API_TOKEN: 'tok',
      SSO_EMAIL_DOMAIN: 'example.org',
      ENTERPRISE_SLUG: 'megacorp',
      ENTERPRISE_SHORTCODE: 'mc',
      SCIM_MAX_RETRIES: '7',
    });
    assert.equal(config.port, 8123);
    assert.equal(config.internalApiToken, 'tok');
    assert.equal(config.emailDomain, 'example.org');
    assert.equal(config.enterpriseSlug, 'megacorp');
    assert.equal(config.enterpriseShortcode, 'mc');
    assert.equal(config.scimMaxRetries, 7);
  });

  it('throws when PORT is invalid', async () => {
    await assert.rejects(() => importSsoConfig({ PORT: 'not-a-number' }));
  });

  it('throws when a non-negative integer var is negative', async () => {
    await assert.rejects(() => importSsoConfig({ SCIM_REQUEST_DELAY_MS: '-5' }));
  });

  it('throws when a positive integer var is zero', async () => {
    await assert.rejects(() => importSsoConfig({ BULK_SYNC_CONCURRENCY: '0' }));
  });
});
