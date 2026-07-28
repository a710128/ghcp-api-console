import { Router } from 'express';
import { apiError } from '@ghcp/shared';
import {
  deleteAccountsBySsoUser,
  failCopilotOauthAuthorization,
  saveCopilotOauthToken,
  getAccount,
  toAccountDto,
} from '../db/accountsRepo.js';
import { clearModelsCache } from '../copilot/copilotClient.js';
import { Logger } from '../logger.js';

export const internalApiRouter = Router();
const logger = new Logger('internal-api');

function parseGeneration(value: unknown): bigint | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value);
  return undefined;
}

internalApiRouter.put('/accounts/:identity/copilot-oauth-token', async (req, res) => {
  const { copilotOauthToken, ghLogin, taskId, taskGeneration, attemptToken } = req.body as {
    copilotOauthToken?: unknown;
    ghLogin?: unknown;
    taskId?: unknown;
    taskGeneration?: unknown;
    attemptToken?: unknown;
  };
  if (typeof copilotOauthToken !== 'string' || !copilotOauthToken.trim()) {
    res.status(400).json(apiError('invalid_oauth_token', 'Request body must include a non-empty copilotOauthToken string.'));
    return;
  }
  const generation = parseGeneration(taskGeneration);
  if (typeof taskId !== 'string' || !taskId || generation === undefined || typeof attemptToken !== 'string' || !attemptToken) {
    res.status(400).json(apiError('invalid_fence', 'taskId, taskGeneration, and attemptToken are required.'));
    return;
  }

  const outcome = await saveCopilotOauthToken({
    identity: req.params.identity,
    taskId,
    taskGeneration: generation,
    attemptToken,
    copilotOauthToken,
    ghLogin: typeof ghLogin === 'string' ? ghLogin : undefined,
  });

  if (outcome === 'unknown_identity') {
    res.status(404).json(apiError('account_not_found', 'Proxy account was not found.'));
    return;
  }
  if (outcome === 'stale') {
    logger.warn('stale-oauth-delivery', 'Rejected stale Copilot OAuth delivery', { identity: req.params.identity, taskId });
    res.status(409).json(apiError('stale_login_attempt', 'The delivered login attempt is no longer active for this identity.'));
    return;
  }

  clearModelsCache(req.params.identity);
  const account = (await getAccount(req.params.identity))!;
  logger.info('save-oauth-token', 'Saved Copilot OAuth token from login service', { identity: req.params.identity, ghLogin: account.ghLogin });
  res.json(toAccountDto(account));
});

internalApiRouter.post('/accounts/:identity/copilot-oauth-failed', async (req, res) => {
  const { taskId, taskGeneration, attemptToken, failureReason } = req.body as {
    taskId?: unknown;
    taskGeneration?: unknown;
    attemptToken?: unknown;
    failureReason?: unknown;
  };
  const generation = parseGeneration(taskGeneration);
  if (typeof taskId !== 'string' || !taskId || generation === undefined || typeof attemptToken !== 'string' || !attemptToken) {
    res.status(400).json(apiError('invalid_fence', 'taskId, taskGeneration, and attemptToken are required.'));
    return;
  }

  const outcome = await failCopilotOauthAuthorization({
    identity: req.params.identity,
    taskId,
    taskGeneration: generation,
    attemptToken,
  });

  if (outcome === 'unknown_identity') {
    res.status(404).json(apiError('account_not_found', 'Proxy account was not found.'));
    return;
  }
  if (outcome === 'stale') {
    res.status(409).json(apiError('stale_login_attempt', 'The delivered login attempt is no longer active for this identity.'));
    return;
  }

  logger.warn('mark-oauth-failed', 'Marked Copilot OAuth authorization failed from login service', {
    identity: req.params.identity,
    reason: typeof failureReason === 'string' ? failureReason.slice(0, 500) : undefined,
  });
  res.json(toAccountDto((await getAccount(req.params.identity))!));
});

internalApiRouter.delete('/accounts/by-sso-user/:ssoUser', async (req, res) => {
  const result = await deleteAccountsBySsoUser(req.params.ssoUser);
  logger.info('delete-by-sso-user', 'Deleted proxy account data by SSO user', { ...result });
  res.json(result);
});
