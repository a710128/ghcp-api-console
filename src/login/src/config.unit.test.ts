import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

async function importLoginConfig(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import(`./config.js?bust=${Date.now()}-${Math.random()}`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('config SSO_PROVIDER resolution', () => {
  it('defaults to "custom" when unset', async () => {
    const mod = await importLoginConfig({ SSO_PROVIDER: undefined });
    assert.equal(mod.config.auth.ssoProvider, 'custom');
  });

  it('resolves "custom" explicitly (case-insensitive, trimmed)', async () => {
    const mod = await importLoginConfig({ SSO_PROVIDER: '  Custom  ' });
    assert.equal(mod.config.auth.ssoProvider, 'custom');
  });

  it('resolves "azure" (case-insensitive)', async () => {
    const mod = await importLoginConfig({ SSO_PROVIDER: 'AZURE' });
    assert.equal(mod.config.auth.ssoProvider, 'azure');
  });

  it('throws for an invalid SSO_PROVIDER value', async () => {
    await assert.rejects(() => importLoginConfig({ SSO_PROVIDER: 'okta' }), /Invalid SSO_PROVIDER/);
  });
});

describe('config default values', () => {
  it('applies defaults for optional vars when unset', async () => {
    const mod = await importLoginConfig({
      PORT: undefined,
      PROXY_BASE_URL: undefined,
      LOGIN_CONCURRENCY: undefined,
      LOG_DIR: undefined,
      CLIENT_ID: undefined,
      SCOPE: undefined,
      SSO_URL: undefined,
      AZURE_STAY_SIGNED_IN: undefined,
      AUTH_HEADLESS: undefined,
      AUTH_TIMEOUT_MS: undefined,
      AUTH_DEBUG_LOGS: undefined,
      AUTH_DEBUG_ARTIFACTS: undefined,
      AUTH_DEBUG_ARTIFACT_DIR: undefined,
      INTERNAL_API_TOKEN: undefined,
    });
    assert.equal(mod.config.port, 7003);
    assert.equal(mod.config.proxyBaseUrl, 'http://localhost:3000');
    assert.equal(mod.config.concurrency, 1);
    assert.equal(mod.config.logDir, './logs/login');
    assert.equal(mod.config.clientId, 'Iv1.b507a08c87ecfe98');
    assert.equal(mod.config.scope, 'read:user');
    assert.equal(mod.config.internalApiToken, '');
    assert.equal(mod.config.auth.ssoUrl, undefined);
    assert.equal(mod.config.auth.azureStaySignedIn, false);
    assert.equal(mod.config.auth.headless, true);
    assert.equal(mod.config.auth.timeoutMs, 60_000);
    assert.equal(mod.config.auth.debugLogs, false);
    assert.equal(mod.config.auth.debugArtifacts, false);
    assert.equal(mod.config.auth.debugArtifactsDir, '.auth-debug');
  });

  it('uses the fixed GitHub device flow endpoints', async () => {
    const mod = await importLoginConfig({});
    assert.equal(mod.config.endpoints.deviceCode, 'https://github.com/login/device/code');
    assert.equal(mod.config.endpoints.accessToken, 'https://github.com/login/oauth/access_token');
  });
});

describe('config env parsing overrides', () => {
  it('reads INTERNAL_API_TOKEN from env', async () => {
    const mod = await importLoginConfig({ INTERNAL_API_TOKEN: 'my-secret-token' });
    assert.equal(mod.config.internalApiToken, 'my-secret-token');
  });

  it('parses boolean env vars (true/false forms)', async () => {
    const truthy = await importLoginConfig({ AUTH_HEADLESS: 'no', AUTH_DEBUG_LOGS: 'yes' });
    assert.equal(truthy.config.auth.headless, false);
    assert.equal(truthy.config.auth.debugLogs, true);
  });

  it('parses PORT and timeout as integers', async () => {
    const mod = await importLoginConfig({ PORT: '8080', AUTH_TIMEOUT_MS: '30000' });
    assert.equal(mod.config.port, 8080);
    assert.equal(mod.config.auth.timeoutMs, 30_000);
  });
});

describe('config required/validated vars throw on invalid input', () => {
  it('throws for a non-numeric PORT', async () => {
    await assert.rejects(() => importLoginConfig({ PORT: 'abc' }), /Invalid PORT/);
  });

  it('throws for an out-of-range PORT', async () => {
    await assert.rejects(() => importLoginConfig({ PORT: '70000' }), /Invalid PORT/);
  });

  it('throws for a non-positive LOGIN_CONCURRENCY', async () => {
    await assert.rejects(() => importLoginConfig({ LOGIN_CONCURRENCY: '0' }), /Invalid positive integer/);
  });

  it('throws for an invalid boolean AUTH_HEADLESS', async () => {
    await assert.rejects(() => importLoginConfig({ AUTH_HEADLESS: 'maybe' }), /Invalid boolean/);
  });
});
