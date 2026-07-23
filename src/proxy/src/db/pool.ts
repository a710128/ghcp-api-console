/**
 * PostgreSQL pool singleton for the proxy service.
 * Reads DATABASE_URL and related config from environment.
 * Provides two pools: general (for account queries) and coordination (for advisory locks).
 */
import { getDatabaseConfig, createPool, validateClusterKeys, type Pool } from '@ghcp/database';

let _generalPool: Pool | null = null;
let _coordinationPool: Pool | null = null;
let _dataKey: Buffer | null = null;

export function getDataEncryptionKey(): Buffer {
  if (!_dataKey) throw new Error('Database pool not initialized. Call initPool() first.');
  return _dataKey;
}

export function getGeneralPool(): Pool {
  if (!_generalPool) throw new Error('Database pool not initialized. Call initPool() first.');
  return _generalPool;
}

export function getCoordinationPool(): Pool {
  if (!_coordinationPool) throw new Error('Database pool not initialized. Call initPool() first.');
  return _coordinationPool;
}

/**
 * Initialize the PostgreSQL pools for proxy.
 * Must be called at startup before any database operations.
 * Validates key fingerprints against the cluster metadata.
 */
export async function initPool(): Promise<void> {
  if (_generalPool) return; // already initialized

  const dbConfig = getDatabaseConfig({
    defaults: {
      poolSize: 10,
      statementTimeoutMs: 30_000,
      lockTimeoutMs: 5_000,
    },
  });

  _dataKey = dbConfig.dataEncryptionKey;

  _generalPool = createPool(dbConfig, { role: 'general', maxConnections: 10 });
  _coordinationPool = createPool(dbConfig, { role: 'coordination', maxConnections: 4 });

  // Validate key fingerprints against cluster_metadata
  await validateClusterKeys(_generalPool, dbConfig.dataEncryptionKey, dbConfig.loginJobEncryptionKey);
}

export async function closePool(): Promise<void> {
  await Promise.all([
    _generalPool?.end(),
    _coordinationPool?.end(),
  ]);
  _generalPool = null;
  _coordinationPool = null;
  _dataKey = null;
}
