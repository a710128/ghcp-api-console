import { Router } from 'express';
import { apiError } from '@ghcp/shared';
import { deleteAccountsBySsoUser, getAccount, markGithubTokenStatus, saveGithubToken, toAccountDto } from '../db/accountsRepo.js';
import { Logger } from '../logger.js';

export const internalApiRouter = Router();
const logger = new Logger('internal-api');

internalApiRouter.put('/accounts/:identity/gh-token', (req, res) => {
  const { ghToken, ghLogin } = req.body as { ghToken?: unknown; ghLogin?: unknown };
  if (typeof ghToken !== 'string' || !ghToken.trim()) {
    res.status(400).json(apiError('invalid_gh_token', 'Request body must include a non-empty ghToken string.'));
    return;
  }
  const account = saveGithubToken(req.params.identity, ghToken, typeof ghLogin === 'string' ? ghLogin : undefined);
  logger.info('save-gh-token', 'Saved GitHub token from login service', { identity: req.params.identity, ghLogin: account.ghLogin, ghTokenStatus: account.ghTokenStatus });
  res.json(toAccountDto(account));
});

internalApiRouter.delete('/accounts/by-sso-user/:ssoUser', (req, res) => {
  const result = deleteAccountsBySsoUser(req.params.ssoUser);
  logger.info('delete-by-sso-user', 'Deleted proxy account data by SSO user', { ...result });
  res.json(result);
});

internalApiRouter.post('/accounts/:identity/mark-gh-token-failed', (req, res) => {
  const account = getAccount(req.params.identity);
  if (!account) {
    res.status(404).json(apiError('account_not_found', 'Proxy account was not found.'));
    return;
  }
  markGithubTokenStatus(req.params.identity, 'failed');
  logger.warn('mark-gh-token-failed', 'Marked GitHub token failed from login service', { identity: req.params.identity });
  res.json(toAccountDto(getAccount(req.params.identity)!));
});
