import { Router } from 'express';
import { apiError, errorFields, type ImportGithubTokensRequest } from '@ghcp/shared';
import { importGithubTokens } from '../accounts/githubTokenImport.js';
import { getAccount, listAccounts, toAccountDto } from '../db/accountsRepo.js';
import { listRequestStats } from '../db/requestStatsRepo.js';
import { tokenManager } from '../copilot/tokenManager.js';
import { Logger } from '../logger.js';

export const adminApiRouter = Router();
const logger = new Logger('admin-api');

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

adminApiRouter.post('/accounts/gh-token/import', async (req, res) => {
  const body = req.body as ImportGithubTokensRequest;
  if (typeof body.csvText !== 'string' || !body.csvText.trim()) {
    res.status(400).json(apiError('invalid_import', 'csvText is required.'));
    return;
  }
  try {
    logger.info('import-gh-tokens-start', 'GitHub token CSV import requested');
    const result = await importGithubTokens(body.csvText);
    logger.info('import-gh-tokens-done', 'GitHub token CSV import completed', { total: result.summary.total, success: result.summary.success, failed: result.summary.failed });
    res.json(result);
  } catch (err) {
    logger.error('import-gh-tokens-failed', 'GitHub token CSV import failed', { ...errorFields(err) });
    res.status(400).json(apiError('github_token_import_failed', err instanceof Error ? err.message : String(err)));
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

adminApiRouter.post('/accounts/:identity/copilot-token/refresh', async (req, res) => {
  try {
    logger.info('refresh-copilot-start', 'Manual Copilot token refresh requested', { identity: req.params.identity });
    await tokenManager.refreshCopilot(req.params.identity);
    const account = await getAccount(req.params.identity);
    logger.info('refresh-copilot-done', 'Manual Copilot token refresh completed', { identity: req.params.identity, copilotTokenStatus: account?.copilotTokenStatus });
    res.json(account ? toAccountDto(account) : undefined);
  } catch (err) {
    logger.error('refresh-copilot-failed', 'Manual Copilot token refresh failed', { identity: req.params.identity, ...errorFields(err) });
    res.status(502).json(apiError('copilot_refresh_failed', err instanceof Error ? err.message : String(err)));
  }
});

adminApiRouter.post('/accounts/:identity/gh-token/refresh', async (req, res) => {
  try {
    const body = req.body as { ssoPassword?: unknown; ssoType?: unknown };
    logger.info('refresh-github-start', 'Manual GitHub token refresh requested', { identity: req.params.identity, ssoType: body.ssoType });
    await tokenManager.triggerGithubRefresh(req.params.identity, {
      ssoPassword: typeof body.ssoPassword === 'string' ? body.ssoPassword : undefined,
      ssoType: body.ssoType === 'azure' || body.ssoType === 'custom' ? body.ssoType : undefined,
    });
    const account = await getAccount(req.params.identity);
    logger.info('refresh-github-queued', 'Manual GitHub token refresh queued login task', { identity: req.params.identity, ghTokenStatus: account?.ghTokenStatus });
    res.json(account ? toAccountDto(account) : undefined);
  } catch (err) {
    logger.error('refresh-github-failed', 'Manual GitHub token refresh failed', { identity: req.params.identity, ...errorFields(err) });
    res.status(400).json(apiError('github_refresh_failed', err instanceof Error ? err.message : String(err)));
  }
});

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
