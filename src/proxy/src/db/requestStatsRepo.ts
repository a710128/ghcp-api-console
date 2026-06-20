import type { ProxyRequestStatDto } from '@ghcp/shared';
import { newRequestId, nowIso } from '@ghcp/shared';
import { config } from '../config.js';
import { getDb } from './connection.js';

type ProxyPath = ProxyRequestStatDto['path'];

interface StatRow {
  id: string;
  identity: string;
  gh_login?: string;
  requested_at: string;
  path: ProxyPath;
  model?: string;
  success: 0 | 1;
  failure_reason?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_tokens?: number;
  cache_input_tokens?: number;
  cache_write_tokens?: number;
}

export function recordRequestStat(input: {
  identity: string;
  ghLogin?: string;
  path: ProxyPath;
  model?: string;
  success: boolean;
  failureReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  cacheInputTokens?: number;
  cacheWriteTokens?: number;
}): void {
  getDb()
    .prepare(`
      INSERT INTO proxy_request_stats (
        id, identity, gh_login, requested_at, path, model, success, failure_reason,
        input_tokens, output_tokens, cache_tokens, cache_input_tokens, cache_write_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      newRequestId(),
      input.identity,
      input.ghLogin,
      nowIso(),
      input.path,
      input.model,
      input.success ? 1 : 0,
      input.failureReason,
      input.inputTokens,
      input.outputTokens,
      input.cacheTokens,
      input.cacheInputTokens,
      input.cacheWriteTokens,
    );
  pruneStats(input.identity);
}

export function listRequestStats(identity?: string, limit = 100): ProxyRequestStatDto[] {
  const boundedLimit = Math.max(1, Math.min(limit, 1000));
  const rows = identity
    ? getDb()
        .prepare('SELECT * FROM proxy_request_stats WHERE identity = ? ORDER BY requested_at DESC LIMIT ?')
        .all(identity, boundedLimit)
    : getDb().prepare('SELECT * FROM proxy_request_stats ORDER BY requested_at DESC LIMIT ?').all(boundedLimit);
  return (rows as StatRow[]).map(mapRow);
}

export function pruneAllRequestStats(): void {
  const identities = getDb().prepare('SELECT DISTINCT identity FROM proxy_request_stats').all() as Array<{ identity: string }>;
  for (const { identity } of identities) pruneStats(identity);
}

function pruneStats(identity: string): void {
  getDb()
    .prepare(`
      DELETE FROM proxy_request_stats
      WHERE identity = ?
        AND id NOT IN (
          SELECT id FROM proxy_request_stats
          WHERE identity = ?
          ORDER BY requested_at DESC
          LIMIT ?
        )
    `)
    .run(identity, identity, config.requestStatsPerAccountLimit);
}

function mapRow(row: StatRow): ProxyRequestStatDto {
  return {
    id: row.id,
    identity: row.identity,
    ghLogin: row.gh_login,
    requestedAt: row.requested_at,
    path: row.path,
    model: row.model,
    success: row.success === 1,
    failureReason: row.failure_reason,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheTokens: row.cache_tokens,
    cacheInputTokens: row.cache_input_tokens,
    cacheWriteTokens: row.cache_write_tokens,
  };
}
