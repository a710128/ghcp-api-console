/**
 * PostgreSQL pool singleton for the login service.
 * Two pools: general (API/task queries) and coordination (advisory locks for worker claims).
 */
import { getDatabaseConfig, createPool, validateClusterKeys, type Pool } from '@ghcp/database';

let _generalPool: Pool | null = null;
let _coordinationPool: Pool | null = null;
let _loginKey: Buffer | null = null;

export function getGeneralPool(): Pool {
  if (!_generalPool) throw new Error('Database pool not initialized. Call initPool() first.');
  return _generalPool;
}

export function getCoordinationPool(): Pool {
  if (!_coordinationPool) throw new Error('Database pool not initialized. Call initPool() first.');
  return _coordinationPool;
}

export function getLoginJobEncryptionKey(): Buffer {
  if (!_loginKey) throw new Error('Database pool not initialized. Call initPool() first.');
  return _loginKey;
}

export async function initPool(): Promise<void> {
  if (_generalPool) return;
  // Login API: application=5, pgboss=5 pools
  const dbConfig = getDatabaseConfig({ defaults: { poolSize: 5 } });
  _loginKey = dbConfig.loginJobEncryptionKey;
  _generalPool = createPool(dbConfig, { role: 'general', maxConnections: 5 });
  _coordinationPool = createPool(dbConfig, { role: 'coordination', maxConnections: 1 });
  await validateClusterKeys(_generalPool, dbConfig.dataEncryptionKey, dbConfig.loginJobEncryptionKey);
}

export async function closePool(): Promise<void> {
  await Promise.all([_generalPool?.end(), _coordinationPool?.end()]);
  _generalPool = null;
  _coordinationPool = null;
  _loginKey = null;
}
