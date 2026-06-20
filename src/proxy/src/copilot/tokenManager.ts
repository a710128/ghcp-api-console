import { isoFromEpochSeconds, type SsoType } from '@ghcp/shared';
import { createAccount, getAccount, markCopilotTokenStatus, markGithubTokenStatus, saveCopilotToken } from '../db/accountsRepo.js';
import { ensureSsoUser, syncEmuUser } from '../clients/ssoClient.js';
import { createLoginTask } from '../clients/loginClient.js';
import { config } from '../config.js';
import { Logger } from '../logger.js';
import { exchangeCopilotToken, type CopilotTokenData } from './copilotToken.js';

const DEFAULT_COPILOT_API = 'https://api.githubcopilot.com';

export class TokenNotReadyError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'account_initializing' | 'token_not_ready',
    message: string,
  ) {
    super(message);
    this.name = 'TokenNotReadyError';
  }
}

class TokenManager {
  private readonly logger = new Logger('token-manager');
  private readonly initializing = new Map<string, Promise<void>>();
  private readonly refreshing = new Map<string, Promise<CopilotTokenData>>();

  async getToken(identity: string): Promise<CopilotTokenData> {
    const account = getAccount(identity);
    if (!account) {
      void this.initializeIdentity(identity).catch((err: unknown) => {
        this.logger.error('identity-init', 'Identity initialization failed', {
          identity,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      throw new TokenNotReadyError(202, 'account_initializing', 'Account initialization has started.');
    }
    if (!account.ghToken) {
      throw new TokenNotReadyError(
        account.ghTokenStatus === 'refreshing' ? 202 : 503,
        account.ghTokenStatus === 'refreshing' ? 'account_initializing' : 'token_not_ready',
        'GitHub token is not ready for this identity.',
      );
    }
    if (account.copilotToken && account.copilotTokenExpiresAt && isFuture(account.copilotTokenExpiresAt)) {
      return {
        token: account.copilotToken,
        expiresAt: Math.floor(new Date(account.copilotTokenExpiresAt).getTime() / 1000),
        refreshIn: 0,
        api: account.copilotApi ?? DEFAULT_COPILOT_API,
        fetchedAt: 0,
      };
    }
    return this.refreshCopilot(identity);
  }

  async refreshCopilot(identity: string): Promise<CopilotTokenData> {
    const existing = this.refreshing.get(identity);
    if (existing) return existing;
    const promise = this.refreshCopilotOnce(identity).finally(() => this.refreshing.delete(identity));
    this.refreshing.set(identity, promise);
    return promise;
  }

  async triggerGithubRefresh(identity: string, options: { ssoPassword?: string; ssoType?: SsoType } = {}): Promise<void> {
    const account = getAccount(identity);
    if (!account) throw new Error(`Unknown identity "${identity}".`);
    if (!account.ssoUser) throw new Error(`Identity "${identity}" is missing an SSO user.`);
    if (!account.ghLogin) throw new Error(`Identity "${identity}" is missing a GitHub login.`);
    if (!options.ssoPassword) throw new Error('ssoPassword is required to trigger a GitHub token refresh.');
    markGithubTokenStatus(identity, 'refreshing');
    await createLoginTask({
      identity,
      ssoUser: account.ssoUser,
      ssoPassword: options.ssoPassword,
      ghLogin: account.ghLogin,
      ssoType: options.ssoType ?? 'custom',
    });
  }

  private async initializeIdentity(identity: string): Promise<void> {
    const existing = this.initializing.get(identity);
    if (existing) return existing;
    const promise = this.initializeIdentityOnce(identity).finally(() => this.initializing.delete(identity));
    this.initializing.set(identity, promise);
    return promise;
  }

  private async initializeIdentityOnce(identity: string): Promise<void> {
    this.logger.info('identity-init', 'Initializing unknown identity', { identity });
    const ensured = await ensureSsoUser({ identity, preferredSsoUser: ssoUserFromIdentity(identity) });
    const synced = await syncEmuUser(ensured.user.ssoUser);
    if (!synced.ghLogin) throw new Error(`SSO user "${ensured.user.ssoUser}" did not return a GH login.`);
    createAccount({
      identity,
      ssoUser: ensured.user.ssoUser,
      ghLogin: synced.ghLogin,
      ghTokenStatus: 'refreshing',
      copilotTokenStatus: 'missing',
    });
    const ssoPassword = ensured.passwordForLogin ?? ensured.user.ssoUser;
    if (!ssoPassword) {
      markGithubTokenStatus(identity, 'failed');
      throw new Error(`SSO did not return a login password for newly initialized identity "${identity}".`);
    }
    await createLoginTask({
      identity,
      ssoUser: ensured.user.ssoUser,
      ssoPassword,
      ghLogin: synced.ghLogin,
      ssoType: 'custom',
    });
  }

  private async refreshCopilotOnce(identity: string): Promise<CopilotTokenData> {
    const account = getAccount(identity);
    if (!account?.ghToken) throw new Error(`Identity "${identity}" does not have a GitHub token.`);
    try {
      markCopilotTokenStatus(identity, 'refreshing');
      const token = await exchangeCopilotToken(account.ghToken);
      saveCopilotToken({
        identity,
        token: token.token,
        api: token.api,
        expiresAt: isoFromEpochSeconds(token.expiresAt),
      });
      return token;
    } catch (err) {
      markCopilotTokenStatus(identity, 'failed');
      throw err;
    }
  }
}

function isFuture(iso: string): boolean {
  return new Date(iso).getTime() - Date.now() > 60_000;
}

function ssoUserFromIdentity(identity: string): string {
  const normalized = identity
    .trim()
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stripEnterpriseShortcode(normalized).slice(0, 32);
}

function stripEnterpriseShortcode(value: string): string {
  const shortcode = config.enterpriseShortcode.trim().toLowerCase();
  if (!shortcode) return value;
  const suffix = `_${shortcode}`;
  if (!value.endsWith(suffix)) return value;
  const stripped = value.slice(0, -suffix.length);
  return stripped || value;
}

export const tokenManager = new TokenManager();
