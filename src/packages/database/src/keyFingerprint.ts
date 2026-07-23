import * as pg from 'pg';
import { sha256Fingerprint } from './config.js';

const METADATA_TABLE = `
  CREATE TABLE IF NOT EXISTS cluster_metadata (
    id TEXT PRIMARY KEY DEFAULT 'singleton',
    data_key_fingerprint TEXT NOT NULL,
    login_job_key_fingerprint TEXT NOT NULL,
    initialized_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

/**
 * Validate that the PostgreSQL cluster has been initialized with matching key fingerprints.
 * On first run, inserts the fingerprints. On subsequent runs, verifies they match exactly.
 * Throws if fingerprints do not match — the process should exit non-zero.
 */
export async function validateClusterKeys(
  pool: pg.Pool,
  dataKey: Buffer,
  loginKey: Buffer,
): Promise<void> {
  const dataFp = sha256Fingerprint(dataKey);
  const loginFp = sha256Fingerprint(loginKey);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(METADATA_TABLE);

    const existing = await client.query<{
      data_key_fingerprint: string;
      login_job_key_fingerprint: string;
    }>(
      `SELECT data_key_fingerprint, login_job_key_fingerprint FROM cluster_metadata WHERE id = 'singleton'`,
    );

    if (existing.rows.length === 0) {
      // First initialization
      await client.query(
        `INSERT INTO cluster_metadata (id, data_key_fingerprint, login_job_key_fingerprint)
         VALUES ('singleton', $1, $2)`,
        [dataFp, loginFp],
      );
      await client.query('COMMIT');
      return;
    }

    const row = existing.rows[0]!;
    if (row.data_key_fingerprint !== dataFp) {
      await client.query('ROLLBACK');
      throw new Error(
        `DATA_ENCRYPTION_KEY fingerprint mismatch. The PostgreSQL cluster was initialized with a different key. ` +
          `To change the key, reprovision the database from empty state.`,
      );
    }
    if (row.login_job_key_fingerprint !== loginFp) {
      await client.query('ROLLBACK');
      throw new Error(
        `LOGIN_JOB_ENCRYPTION_KEY fingerprint mismatch. The PostgreSQL cluster was initialized with a different key. ` +
          `To change the key, reprovision the database from empty state.`,
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}
