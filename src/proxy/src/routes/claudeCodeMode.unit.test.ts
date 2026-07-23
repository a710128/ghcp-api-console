import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';

// config.ts reads env vars at import time. Set a deterministic default for
// CLAUDE_CODE_OPTIMIZED BEFORE importing the module under test (which imports config).
process.env.CLAUDE_CODE_OPTIMIZED = 'false';
process.env.API_KEY = process.env.API_KEY ?? 'test-api-key';
process.env.INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN ?? 'test-internal-token';

type ModeModule = typeof import('./claudeCodeMode.js');
type ConfigModule = typeof import('../config.js');

let resolveClaudeCodeOptimized: ModeModule['resolveClaudeCodeOptimized'];
let CLAUDE_CODE_OPTIMIZED_HEADER: ModeModule['CLAUDE_CODE_OPTIMIZED_HEADER'];
let configDefault: boolean;

before(async () => {
  const mode = await import('./claudeCodeMode.js');
  resolveClaudeCodeOptimized = mode.resolveClaudeCodeOptimized;
  CLAUDE_CODE_OPTIMIZED_HEADER = mode.CLAUDE_CODE_OPTIMIZED_HEADER;
  const cfg = (await import('../config.js')) as ConfigModule;
  configDefault = cfg.config.claudeCodeOptimized;
});

/** Minimal fake Express Request exposing only header(). */
function fakeRequest(value: string | undefined): Request {
  return {
    header(name: string): string | undefined {
      return name === CLAUDE_CODE_OPTIMIZED_HEADER ? value : undefined;
    },
  } as unknown as Request;
}

describe('resolveClaudeCodeOptimized: missing header', () => {
  it('returns the config default when header is undefined', () => {
    const result = resolveClaudeCodeOptimized(fakeRequest(undefined));
    assert.deepEqual(result, { ok: true, enabled: configDefault });
  });
});

describe('resolveClaudeCodeOptimized: truthy values', () => {
  for (const value of ['true', '1', 'yes', 'on', 'TRUE', 'Yes', 'ON', ' true ']) {
    it(`treats "${value}" as enabled=true`, () => {
      const result = resolveClaudeCodeOptimized(fakeRequest(value));
      assert.deepEqual(result, { ok: true, enabled: true });
    });
  }
});

describe('resolveClaudeCodeOptimized: falsy values', () => {
  for (const value of ['false', '0', 'no', 'off', 'FALSE', 'No', 'OFF', ' off ']) {
    it(`treats "${value}" as enabled=false`, () => {
      const result = resolveClaudeCodeOptimized(fakeRequest(value));
      assert.deepEqual(result, { ok: true, enabled: false });
    });
  }
});

describe('resolveClaudeCodeOptimized: invalid values', () => {
  it('returns an error for "maybe"', () => {
    const result = resolveClaudeCodeOptimized(fakeRequest('maybe'));
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.match(result.message, /Invalid/);
    }
  });

  it('returns an error for an empty-string header', () => {
    const result = resolveClaudeCodeOptimized(fakeRequest(''));
    assert.equal(result.ok, false);
  });
});
