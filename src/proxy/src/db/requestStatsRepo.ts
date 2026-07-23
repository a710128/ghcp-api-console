/**
 * Request statistics repository — persistence is DISABLED in PostgreSQL mode.
 * Per plan spec: remove per-request database writes; return empty arrays for stat endpoints.
 * The route shapes are preserved; empty results indicate persistence is disabled.
 */
import type { ProxyRequestStatDto } from '@ghcp/shared';

type ProxyPath = ProxyRequestStatDto['path'];

/**
 * No-op: request stat persistence is disabled in the PostgreSQL deployment.
 * Use Prometheus counters and Docker log rotation for operational visibility.
 */
export function recordRequestStat(_input: {
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
  // Intentionally empty: no database write for request stats
}

/**
 * Returns empty array; request stat persistence is disabled.
 * Endpoints preserve their response shape but contain no stored history.
 */
export function listRequestStats(_identity?: string, _limit = 100): ProxyRequestStatDto[] {
  return [];
}

/**
 * No-op: no stats to prune.
 */
export function pruneAllRequestStats(): void {
  // Intentionally empty
}
