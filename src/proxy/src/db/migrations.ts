import type Database from 'better-sqlite3';

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxy_accounts (
      identity TEXT PRIMARY KEY,
      sso_user TEXT NOT NULL,
      gh_login TEXT,
      gh_token TEXT,
      gh_token_status TEXT NOT NULL DEFAULT 'missing',
      gh_token_updated_at TEXT,
      copilot_token TEXT,
      copilot_api TEXT,
      copilot_token_expires_at TEXT,
      copilot_token_status TEXT NOT NULL DEFAULT 'missing',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS proxy_request_stats (
      id TEXT PRIMARY KEY,
      identity TEXT NOT NULL,
      gh_login TEXT,
      requested_at TEXT NOT NULL,
      path TEXT NOT NULL,
      model TEXT,
      success INTEGER NOT NULL,
      failure_reason TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_tokens INTEGER,
      cache_input_tokens INTEGER,
      cache_write_tokens INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_proxy_request_stats_identity_time
      ON proxy_request_stats(identity, requested_at DESC);
  `);
  addColumnIfMissing(db, 'proxy_request_stats', 'cache_input_tokens', 'INTEGER');
  addColumnIfMissing(db, 'proxy_request_stats', 'cache_write_tokens', 'INTEGER');
  copyLegacyCacheReadTokens(db);
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function copyLegacyCacheReadTokens(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(proxy_request_stats)').all() as Array<{ name: string }>;
  const names = new Set(columns.map((item) => item.name));
  if (!names.has('cache_read_tokens') || !names.has('cache_input_tokens')) return;
  db.exec(`
    UPDATE proxy_request_stats
    SET cache_input_tokens = cache_read_tokens
    WHERE cache_input_tokens IS NULL
      AND cache_read_tokens IS NOT NULL
  `);
}
