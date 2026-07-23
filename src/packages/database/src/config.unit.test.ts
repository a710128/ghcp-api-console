import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getDatabaseConfig, sha256Fingerprint } from './config.js';

// A valid 32-byte base64 key (from testSupport TEST_DATA_ENCRYPTION_KEY).
const VALID_KEY = 'oZF04IP6wOOEd0hGhTWE9C/wNAogY/NZorDNyDiqwLc=';
// A different valid 32-byte base64 key (from testSupport TEST_LOGIN_JOB_ENCRYPTION_KEY).
const ANOTHER_KEY = 'eZVg99hIYJ9tjiSAN2kO4JV6m5TzMvBDZYMZe368+8o=';
// A 16-byte base64 key (too short).
const SHORT_KEY = Buffer.alloc(16).toString('base64');

// The env vars getDatabaseConfig() reads at call time.
const RELEVANT_ENV_KEYS = [
  'DATABASE_URL',
  'DB_APPLICATION_NAME',
  'DATA_ENCRYPTION_KEY',
  'LOGIN_JOB_ENCRYPTION_KEY',
  'DB_POOL_SIZE',
  'DB_STATEMENT_TIMEOUT_MS',
  'DB_LOCK_TIMEOUT_MS',
] as const;

let savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv = {};
}

/**
 * Clears all relevant env vars so each test starts from a known-empty baseline.
 * Original values are recorded via setEnv() for restoration in afterEach.
 */
function clearRelevantEnv(): void {
  const cleared: Record<string, string | undefined> = {};
  for (const key of RELEVANT_ENV_KEYS) cleared[key] = undefined;
  setEnv(cleared);
}

/** Env combination that satisfies all validations. */
function validEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    DB_APPLICATION_NAME: 'ghcp-test',
    DATA_ENCRYPTION_KEY: VALID_KEY,
    LOGIN_JOB_ENCRYPTION_KEY: ANOTHER_KEY,
  };
}

describe('getDatabaseConfig', () => {
  beforeEach(() => {
    clearRelevantEnv();
  });

  afterEach(() => {
    restoreEnv();
  });

  it('throws when DATABASE_URL is missing', () => {
    assert.throws(() => getDatabaseConfig(), /DATABASE_URL is required/);
  });

  it('throws when DATABASE_URL does not start with "postgres"', () => {
    setEnv({ DATABASE_URL: 'mysql://x' });
    assert.throws(() => getDatabaseConfig(), /must be a valid PostgreSQL/);
  });

  it('throws when DB_APPLICATION_NAME is missing', () => {
    setEnv({ DATABASE_URL: 'postgres://x' });
    assert.throws(() => getDatabaseConfig(), /DB_APPLICATION_NAME is required/);
  });

  it('throws when DATA_ENCRYPTION_KEY is missing', () => {
    setEnv({ DATABASE_URL: 'postgres://x', DB_APPLICATION_NAME: 'app' });
    assert.throws(() => getDatabaseConfig(), /DATA_ENCRYPTION_KEY is required/);
  });

  it('throws when DATA_ENCRYPTION_KEY decodes to fewer than 32 bytes', () => {
    setEnv({
      DATABASE_URL: 'postgres://x',
      DB_APPLICATION_NAME: 'app',
      DATA_ENCRYPTION_KEY: SHORT_KEY,
    });
    assert.throws(() => getDatabaseConfig(), /must be exactly 32 bytes/);
  });

  it('throws when LOGIN_JOB_ENCRYPTION_KEY is missing', () => {
    setEnv({
      DATABASE_URL: 'postgres://x',
      DB_APPLICATION_NAME: 'app',
      DATA_ENCRYPTION_KEY: VALID_KEY,
    });
    assert.throws(() => getDatabaseConfig(), /LOGIN_JOB_ENCRYPTION_KEY is required/);
  });

  it('throws when LOGIN_JOB_ENCRYPTION_KEY decodes to fewer than 32 bytes', () => {
    setEnv({
      DATABASE_URL: 'postgres://x',
      DB_APPLICATION_NAME: 'app',
      DATA_ENCRYPTION_KEY: VALID_KEY,
      LOGIN_JOB_ENCRYPTION_KEY: SHORT_KEY,
    });
    assert.throws(() => getDatabaseConfig(), /must be exactly 32 bytes/);
  });

  it('returns a config object with default numeric settings when all env vars are valid', () => {
    setEnv(validEnv());
    const config = getDatabaseConfig();

    assert.equal(config.databaseUrl, 'postgres://user:pass@localhost:5432/db');
    assert.equal(config.applicationName, 'ghcp-test');
    assert.equal(config.poolSize, 10);
    assert.equal(config.statementTimeoutMs, 30_000);
    assert.equal(config.lockTimeoutMs, 5_000);
    assert.ok(Buffer.isBuffer(config.dataEncryptionKey));
    assert.equal(config.dataEncryptionKey.length, 32);
    assert.ok(Buffer.isBuffer(config.loginJobEncryptionKey));
    assert.equal(config.loginJobEncryptionKey.length, 32);
  });

  it('honors caller-provided defaults when env overrides are absent', () => {
    setEnv(validEnv());
    const config = getDatabaseConfig({
      defaults: { poolSize: 4, statementTimeoutMs: 1234, lockTimeoutMs: 567 },
    });

    assert.equal(config.poolSize, 4);
    assert.equal(config.statementTimeoutMs, 1234);
    assert.equal(config.lockTimeoutMs, 567);
  });

  it('reads numeric overrides from env when present', () => {
    setEnv({ ...validEnv(), DB_POOL_SIZE: '25' });
    const config = getDatabaseConfig();
    assert.equal(config.poolSize, 25);
  });

  it('throws when DB_POOL_SIZE is not a positive integer', () => {
    setEnv({ ...validEnv(), DB_POOL_SIZE: 'invalid' });
    assert.throws(() => getDatabaseConfig(), /positive integer/);
  });

  it('throws when DB_POOL_SIZE is zero or negative', () => {
    setEnv({ ...validEnv(), DB_POOL_SIZE: '0' });
    assert.throws(() => getDatabaseConfig(), /positive integer/);
  });
});

describe('sha256Fingerprint', () => {
  it('produces a stable 64-char hex string for a given key', () => {
    const key = Buffer.from(VALID_KEY, 'base64');
    const fp1 = sha256Fingerprint(key);
    const fp2 = sha256Fingerprint(Buffer.from(VALID_KEY, 'base64'));

    assert.equal(fp1, fp2);
    assert.match(fp1, /^[0-9a-f]{64}$/);
  });

  it('produces different fingerprints for different keys', () => {
    const fpA = sha256Fingerprint(Buffer.from(VALID_KEY, 'base64'));
    const fpB = sha256Fingerprint(Buffer.from(ANOTHER_KEY, 'base64'));
    assert.notEqual(fpA, fpB);
  });
});
