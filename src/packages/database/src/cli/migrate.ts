import * as pg from 'pg';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabaseConfig } from '../config.js';
import { runMigrations } from '../migrate.js';
import { validateClusterKeys } from '../keyFingerprint.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  // Allow --database-url override for test isolation
  const urlOverride = process.argv.find((a) => a.startsWith('--database-url='))?.split('=')[1];
  if (urlOverride) {
    process.env['DATABASE_URL'] = urlOverride;
  }

  let config;
  try {
    config = getDatabaseConfig({ defaults: { poolSize: 1 } });
  } catch (err) {
    console.error('[db:migrate] Config error:', (err as Error).message);
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 1,
    statement_timeout: config.statementTimeoutMs,
    application_name: `${config.applicationName}/migrate`,
  });

  try {
    // Validate connectivity
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();

    // Run migrations from the migrations directory
    const migrationsDir = join(__dirname, '../../migrations');
    await runMigrations(pool, migrationsDir);

    // Initialize/validate cluster key fingerprints
    await validateClusterKeys(pool, config.dataEncryptionKey, config.loginJobEncryptionKey);

    console.log('[db:migrate] Migrations completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('[db:migrate] Fatal error:', (err as Error).message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
