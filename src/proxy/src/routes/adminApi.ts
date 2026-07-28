import { Router } from 'express';
import { apiError, errorFields, newBatchId, nowIso, type CopilotOauthBatchLoginItem, type CopilotOauthBatchLoginRequest, type CopilotOauthBatchLoginRow, type ImportCopilotOauthTokensRequest, type SsoType } from '@ghcp/shared';
import { importCopilotOauthTokens } from '../accounts/copilotOauthTokenImport.js';
import { getAccount, listAccounts, toAccountDto } from '../db/accountsRepo.js';
import { listRequestStats } from '../db/requestStatsRepo.js';
import { copilotAuthManager } from '../copilot/copilotAuthManager.js';
import { Logger } from '../logger.js';

export const adminApiRouter = Router();
const logger = new Logger('admin-api');

const BATCH_LOGIN_MAX_ITEMS = 50;

adminApiRouter.get('/accounts', async (req, res) => {
  const result = await listAccounts({
    q: stringQuery(req.query.q),
    page: numberQuery(req.query.page),
    pageSize: numberQuery(req.query.pageSize),
    sort: stringQuery(req.query.sort) as never,
    dir: stringQuery(req.query.dir) as never,
  });
  res.json({ ...result, items: result.items.map(toAccountDto) });
});

adminApiRouter.get('/accounts/:identity', async (req, res) => {
  const account = await getAccount(req.params.identity);
  if (!account) {
    res.status(404).json(apiError('account_not_found', 'Proxy account was not found.'));
    return;
  }
  res.json(toAccountDto(account));
});

adminApiRouter.post('/accounts/copilot-oauth-token/import', async (req, res) => {
  const body = req.body as ImportCopilotOauthTokensRequest;
  if (typeof body.csvText !== 'string' || !body.csvText.trim()) {
    res.status(400).json(apiError('invalid_import', 'csvText is required.'));
    return;
  }
  try {
    logger.info('import-oauth-tokens-start', 'Copilot OAuth token CSV import requested');
    const result = await importCopilotOauthTokens(body.csvText);
    logger.info('import-oauth-tokens-done', 'Copilot OAuth token CSV import completed', { total: result.summary.total, success: result.summary.success, failed: result.summary.failed });
    res.json(result);
  } catch (err) {
    logger.error('import-oauth-tokens-failed', 'Copilot OAuth token CSV import failed', { ...errorFields(err) });
    res.status(400).json(apiError('copilot_oauth_token_import_failed', err instanceof Error ? err.message : String(err)));
  }
});

adminApiRouter.get('/accounts/:identity/request-stats', (req, res) => {
  // Request stat persistence is disabled in PostgreSQL mode.
  // Returning empty array; use /metrics or Docker logs for request visibility.
  logger.info('request-stats-disabled', 'Request stats endpoint called; persistence is disabled', { identity: req.params.identity });
  res.json(listRequestStats(req.params.identity, readLimit(req.query.limit)));
});

adminApiRouter.get('/request-stats', (req, res) => {
  // Request stat persistence is disabled in PostgreSQL mode.
  logger.info('request-stats-disabled', 'Global request stats endpoint called; persistence is disabled');
  res.json(listRequestStats(undefined, readLimit(req.query.limit)));
});

adminApiRouter.post('/accounts/:identity/copilot-oauth/reauthorize', async (req, res) => {
  try {
    const body = req.body as { ssoPassword?: unknown; ssoType?: unknown };
    logger.info('reauthorize-oauth-start', 'Manual Copilot OAuth reauthorization requested', { identity: req.params.identity, ssoType: body.ssoType });
    await copilotAuthManager.triggerOauthRefresh(req.params.identity, {
      ssoPassword: typeof body.ssoPassword === 'string' ? body.ssoPassword : undefined,
      ssoType: body.ssoType === 'azure' || body.ssoType === 'custom' ? body.ssoType : undefined,
    });
    const account = await getAccount(req.params.identity);
    logger.info('reauthorize-oauth-queued', 'Manual Copilot OAuth reauthorization queued login task', { identity: req.params.identity, copilotOauthStatus: account?.copilotOauthStatus });
    res.json(account ? toAccountDto(account) : undefined);
  } catch (err) {
    logger.error('reauthorize-oauth-failed', 'Manual Copilot OAuth reauthorization failed', { identity: req.params.identity, ...errorFields(err) });
    res.status(400).json(apiError('copilot_oauth_reauthorize_failed', err instanceof Error ? err.message : String(err)));
  }
});

adminApiRouter.post('/accounts/copilot-oauth/batch-login', async (req, res) => {
  const parsed = parseBatchLoginItems((req.body as CopilotOauthBatchLoginRequest | undefined)?.items);
  if ('error' in parsed) {
    res.status(400).json(apiError('invalid_batch_login', parsed.error));
    return;
  }
  const startedAt = nowIso();
  logger.info('batch-login-start', 'Batch Copilot OAuth provisioning + login requested', { total: parsed.items.length });
  try {
    const rows = await copilotAuthManager.batchEnsureAndLogin(parsed.items);
    const summary = summarizeBatchLogin(rows);
    logger.info('batch-login-done', 'Batch Copilot OAuth provisioning + login completed', { ...summary });
    res.json({ batchId: newBatchId(), startedAt, finishedAt: nowIso(), summary, rows });
  } catch (err) {
    logger.error('batch-login-failed', 'Batch Copilot OAuth provisioning + login failed', { ...errorFields(err) });
    res.status(400).json(apiError('copilot_oauth_batch_login_failed', err instanceof Error ? err.message : String(err)));
  }
});

function parseBatchLoginItems(raw: unknown): { items: CopilotOauthBatchLoginItem[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'items must be a non-empty array.' };
  if (raw.length > BATCH_LOGIN_MAX_ITEMS) return { error: `items exceeds the maximum of ${BATCH_LOGIN_MAX_ITEMS}.` };
  const items: CopilotOauthBatchLoginItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const item = entry as Record<string, unknown>;
    const identity = typeof item.identity === 'string' ? item.identity.trim() : '';
    const ssoUser = typeof item.ssoUser === 'string' ? item.ssoUser.trim() : '';
    const ssoPassword = typeof item.ssoPassword === 'string' ? item.ssoPassword : '';
    if (!identity || !ssoUser || !ssoPassword) return { error: 'each item requires non-empty identity, ssoUser, and ssoPassword.' };
    if (seen.has(identity)) return { error: `duplicate identity "${identity}" in batch.` };
    seen.add(identity);
    const ssoType: SsoType = item.ssoType === 'azure' ? 'azure' : 'custom';
    items.push({ identity, ssoUser, ssoPassword, ssoType });
  }
  return { items };
}

function summarizeBatchLogin(rows: CopilotOauthBatchLoginRow[]): { total: number; success: number; skipped: number; failed: number } {
  let success = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.status === 'success') success++;
    else if (row.status === 'skipped') skipped++;
    else failed++;
  }
  return { total: rows.length, success, skipped, failed };
}

function readLimit(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw ?? 100);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 100;
}

function stringQuery(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === 'string' ? raw : undefined;
}

function numberQuery(value: unknown): number | undefined {
  const raw = stringQuery(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
