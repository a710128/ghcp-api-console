import * as pg from 'pg';
import type { DatabaseConfig } from './config.js';

export type PoolRole = 'general' | 'coordination' | 'pgboss';

export interface PoolOptions {
  role: PoolRole;
  /** Override max connections (default: config.poolSize for general, 4 for coordination) */
  maxConnections?: number;
}

/** Coordination pool: max 4, acquire timeout 250ms */
const COORDINATION_MAX = 4;
const COORDINATION_ACQUIRE_TIMEOUT_MS = 250;

export function createPool(config: DatabaseConfig, opts: PoolOptions): pg.Pool {
  const isCoordination = opts.role === 'coordination';
  const max = opts.maxConnections ?? (isCoordination ? COORDINATION_MAX : config.poolSize);

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max,
    statement_timeout: config.statementTimeoutMs,
    lock_timeout: isCoordination ? COORDINATION_ACQUIRE_TIMEOUT_MS : config.lockTimeoutMs,
    application_name: `${config.applicationName}/${opts.role}`,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: isCoordination ? COORDINATION_ACQUIRE_TIMEOUT_MS : 10_000,
  });

  pool.on('error', (err) => {
    console.error(`[db:pool:${opts.role}] Unexpected client error`, (err as Error).message);
  });

  return pool;
}

export type { Pool } from 'pg';
