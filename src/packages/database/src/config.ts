import { createHash } from 'node:crypto';

export interface DatabaseConfig {
  databaseUrl: string;
  poolSize: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  applicationName: string;
  dataEncryptionKey: Buffer;
  loginJobEncryptionKey: Buffer;
}

export interface DatabaseConfigOptions {
  /** Defaults: pool=10, statementTimeout=30000, lockTimeout=5000 */
  defaults?: {
    poolSize?: number;
    statementTimeoutMs?: number;
    lockTimeoutMs?: number;
  };
}

export function getDatabaseConfig(opts?: DatabaseConfigOptions): DatabaseConfig {
  const url = process.env['DATABASE_URL'];
  if (!url || !url.startsWith('postgres')) {
    throw new Error(
      'DATABASE_URL is required and must be a valid PostgreSQL connection string (postgres://...).',
    );
  }

  const poolSize = parsePositiveInt('DB_POOL_SIZE', opts?.defaults?.poolSize ?? 10);
  const statementTimeoutMs = parsePositiveInt(
    'DB_STATEMENT_TIMEOUT_MS',
    opts?.defaults?.statementTimeoutMs ?? 30_000,
  );
  const lockTimeoutMs = parsePositiveInt(
    'DB_LOCK_TIMEOUT_MS',
    opts?.defaults?.lockTimeoutMs ?? 5_000,
  );

  const appName = process.env['DB_APPLICATION_NAME'];
  if (!appName) {
    throw new Error('DB_APPLICATION_NAME is required.');
  }

  const dataKeyB64 = process.env['DATA_ENCRYPTION_KEY'];
  if (!dataKeyB64) throw new Error('DATA_ENCRYPTION_KEY is required.');
  const dataEncryptionKey = Buffer.from(dataKeyB64, 'base64');
  if (dataEncryptionKey.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY must be exactly 32 bytes when base64-decoded.');
  }

  const loginKeyB64 = process.env['LOGIN_JOB_ENCRYPTION_KEY'];
  if (!loginKeyB64) throw new Error('LOGIN_JOB_ENCRYPTION_KEY is required.');
  const loginJobEncryptionKey = Buffer.from(loginKeyB64, 'base64');
  if (loginJobEncryptionKey.length !== 32) {
    throw new Error('LOGIN_JOB_ENCRYPTION_KEY must be exactly 32 bytes when base64-decoded.');
  }

  return {
    databaseUrl: url,
    poolSize,
    statementTimeoutMs,
    lockTimeoutMs,
    applicationName: appName,
    dataEncryptionKey,
    loginJobEncryptionKey,
  };
}

function parsePositiveInt(envVar: string, defaultValue: number): number {
  const raw = process.env[envVar];
  if (!raw) return defaultValue;
  const val = parseInt(raw, 10);
  if (!Number.isInteger(val) || val <= 0) {
    throw new Error(`${envVar} must be a positive integer, got: ${JSON.stringify(raw)}`);
  }
  return val;
}

export function sha256Fingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex');
}
