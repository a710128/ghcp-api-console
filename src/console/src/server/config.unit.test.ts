import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

async function importConsoleConfig(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const mod = await import(`./config.js?v=${Date.now()}-${Math.random()}`);
    return mod.config as {
      port: number;
      adminsFile: string;
      sessionSecret: string;
      internalApiToken: string;
      proxyBaseUrl: string;
      ssoBaseUrl: string;
      loginBaseUrl: string;
    };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('console config', () => {
  it('defaults PORT to 7004 when not set', async () => {
    const config = await importConsoleConfig({ PORT: undefined });
    assert.strictEqual(config.port, 7004);
  });

  it('applies a custom PORT value', async () => {
    const config = await importConsoleConfig({ PORT: '8123' });
    assert.strictEqual(config.port, 8123);
  });

  it('defaults ADMINS_FILE when not set', async () => {
    const config = await importConsoleConfig({ ADMINS_FILE: undefined });
    assert.strictEqual(config.adminsFile, './data/admins.json');
  });

  it('applies a custom ADMINS_FILE value', async () => {
    const config = await importConsoleConfig({ ADMINS_FILE: '/tmp/custom-admins.json' });
    assert.strictEqual(config.adminsFile, '/tmp/custom-admins.json');
  });

  it('defaults session secret when not set', async () => {
    const config = await importConsoleConfig({ SESSION_SECRET: undefined });
    assert.strictEqual(config.sessionSecret, 'dev-secret-change-me');
  });

  it('defaults base urls when not set', async () => {
    const config = await importConsoleConfig({
      PROXY_BASE_URL: undefined,
      SSO_BASE_URL: undefined,
      LOGIN_BASE_URL: undefined,
    });
    assert.strictEqual(config.proxyBaseUrl, 'http://localhost:3000');
    assert.strictEqual(config.ssoBaseUrl, 'http://localhost:7001');
    assert.strictEqual(config.loginBaseUrl, 'http://localhost:7003');
  });

  it('throws for an invalid PORT', async () => {
    await assert.rejects(() => importConsoleConfig({ PORT: 'not-a-number' }));
  });

  it('throws for an out-of-range PORT', async () => {
    await assert.rejects(() => importConsoleConfig({ PORT: '70000' }));
  });
});
