/**
 * PostgreSQL pool singleton for the SSO service.
 */
import { getDatabaseConfig, createPool, validateClusterKeys, type Pool } from '@ghcp/database';

let _generalPool: Pool | null = null;

export function getGeneralPool(): Pool {
  if (!_generalPool) throw new Error('Database pool not initialized. Call initPool() first.');
  return _generalPool;
}

export async function initPool(): Promise<void> {
  if (_generalPool) return;
  const dbConfig = getDatabaseConfig({ defaults: { poolSize: 8 } });
  _generalPool = createPool(dbConfig, { role: 'general', maxConnections: 8 });
  await validateClusterKeys(_generalPool, dbConfig.dataEncryptionKey, dbConfig.loginJobEncryptionKey);
}

export async function closePool(): Promise<void> {
  await _generalPool?.end();
  _generalPool = null;
}
