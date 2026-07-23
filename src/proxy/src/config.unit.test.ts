import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ProxyConfig } from './config.js';

/**
 * Import config.ts fresh with a specific env overlay. config.ts builds its
 * `config` object at module-import time, so a cache-busted dynamic import is
 * used to re-evaluate the module per case. The prior env is restored afterward.
 */
async function importConfig(env: Record<string, string | undefined>): Promise<ProxyConfig> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const mod = (await import(`./config.js?bust=${Date.now()}-${Math.random()}`)) as {
      config: ProxyConfig;
    };
    return mod.config;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Env keys config.ts reads that could otherwise leak from the ambient env. */
const CLEARED: Record<string, undefined> = {
  PORT: undefined,
  API_KEY: undefined,
  IDENTITY_HEADER: undefined,
  IDENTITY_HEADER_REQUIRED: undefined,
  CLAUDE_CODE_OPTIMIZED: undefined,
  INTERNAL_API_TOKEN: undefined,
  SSO_BASE_URL: undefined,
  LOGIN_BASE_URL: undefined,
  ENTERPRISE_SHORTCODE: undefined,
  REQUEST_STATS_PER_ACCOUNT_LIMIT: undefined,
};

describe('config defaults', () => {
  it('applies documented defaults when optional vars are missing', async () => {
    const config = await importConfig(CLEARED);
    assert.equal(config.port, 3000);
    assert.equal(config.apiKey, '');
    assert.equal(config.internalApiToken, '');
    assert.equal(config.identityHeader, 'X-User-Identity');
    assert.equal(config.identityHeaderRequired, true);
    assert.equal(config.claudeCodeOptimized, false);
    assert.equal(config.ssoBaseUrl, 'http://localhost:7001');
    assert.equal(config.loginBaseUrl, 'http://localhost:7003');
    assert.equal(config.enterpriseShortcode, 'octo');
    assert.equal(config.requestStatsPerAccountLimit, 100);
  });

  it('populates default editor headers', async () => {
    const config = await importConfig(CLEARED);
    assert.equal(config.editorHeaders['Editor-Version'], 'vscode/1.95.0');
    assert.equal(config.editorHeaders['Copilot-Integration-Id'], 'vscode-chat');
    assert.equal(config.editorHeaders['X-GitHub-Api-Version'], '2026-01-09');
  });
});

describe('config overrides', () => {
  it('honors provided values', async () => {
    const config = await importConfig({
      ...CLEARED,
      PORT: '4123',
      API_KEY: 'my-key',
      CLAUDE_CODE_OPTIMIZED: 'true',
      IDENTITY_HEADER_REQUIRED: 'false',
      REQUEST_STATS_PER_ACCOUNT_LIMIT: '50',
    });
    assert.equal(config.port, 4123);
    assert.equal(config.apiKey, 'my-key');
    assert.equal(config.claudeCodeOptimized, true);
    assert.equal(config.identityHeaderRequired, false);
    assert.equal(config.requestStatsPerAccountLimit, 50);
  });
});

describe('config validation errors', () => {
  it('throws on a non-numeric PORT', async () => {
    await assert.rejects(() => importConfig({ ...CLEARED, PORT: 'abc' }), /Invalid PORT/);
  });

  it('throws on an out-of-range PORT', async () => {
    await assert.rejects(() => importConfig({ ...CLEARED, PORT: '70000' }), /Invalid PORT/);
  });

  it('throws on an invalid boolean CLAUDE_CODE_OPTIMIZED', async () => {
    await assert.rejects(
      () => importConfig({ ...CLEARED, CLAUDE_CODE_OPTIMIZED: 'maybe' }),
      /Invalid boolean/,
    );
  });

  it('throws on a non-positive REQUEST_STATS_PER_ACCOUNT_LIMIT', async () => {
    await assert.rejects(
      () => importConfig({ ...CLEARED, REQUEST_STATS_PER_ACCOUNT_LIMIT: '0' }),
      /Invalid positive integer/,
    );
  });
});
