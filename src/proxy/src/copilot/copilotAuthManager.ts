import type { SsoType } from '@ghcp/shared';
import { createAccount, getAccount, markCopilotOauthStatus } from '../db/accountsRepo.js';
import { getGeneralPool, getCoordinationPool } from '../db/connection.js';
import { ensureSsoUser, syncEmuUser } from '../clients/ssoClient.js';
import { getDatabaseConfig, withPostgresAdvisoryLock, ADVISORY_NAMESPACES, createOrCoalesceLoginTaskTx } from '@ghcp/database';
import { config } from '../config.js';
import { Logger } from '../logger.js';
import type { CopilotAuthContext } from './copilotAuth.js';

const DEFAULT_COPILOT_API = 'https://api.githubcopilot.com';

export class CopilotAuthNotReadyError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'account_initializing' | 'oauth_not_ready',
    message: string,
  ) {
    super(message);
    this.name = 'CopilotAuthNotReadyError';
  }
}

class CopilotAuthManager {
  private readonly logger = new Logger('copilot-auth-manager');
  private readonly initializing = new Map<string, Promise<void>>();

  async getAuth(identity: string): Promise<CopilotAuthContext> {
    const account = await getAccount(identity);
    if (!account) {
      void this.initializeIdentity(identity).catch((err: unknown) => {
        this.logger.error('identity-init', 'Identity initialization failed', {
          identity,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      throw new CopilotAuthNotReadyError(202, 'account_initializing', 'Account initialization has started.');
    }

    if (account.copilotOauthStatus === 'valid' && !account.copilotOauthToken) {
      await markCopilotOauthStatus(identity, 'failed');
      throw new CopilotAuthNotReadyError(503, 'oauth_not_ready', 'Copilot OAuth credential could not be decrypted for this identity.');
    }

    if (!account.copilotOauthToken || account.copilotOauthStatus !== 'valid') {
      const initializing = account.copilotOauthStatus === 'refreshing';
      throw new CopilotAuthNotReadyError(
        initializing ? 202 : 503,
        initializing ? 'account_initializing' : 'oauth_not_ready',
        initializing
          ? 'Copilot OAuth authorization is in progress for this identity.'
          : 'Copilot OAuth authorization is required for this identity.',
      );
    }

    return {
      identity,
      accessToken: account.copilotOauthToken,
      api: account.copilotApi ?? DEFAULT_COPILOT_API,
      credentialVersion: account.credentialVersion,
    };
  }

  async triggerOauthRefresh(identity: string, options: { ssoPassword?: string; ssoType?: SsoType } = {}): Promise<void> {
    const account = await getAccount(identity);
    if (!account) throw new Error(`Unknown identity "${identity}".`);
    if (!account.ssoUser) throw new Error(`Identity "${identity}" is missing an SSO user.`);
    if (!account.ghLogin) throw new Error(`Identity "${identity}" is missing a GitHub login.`);
    if (!options.ssoPassword) throw new Error('ssoPassword is required to reauthorize Copilot OAuth.');

    const loginKey = getDatabaseConfig().loginJobEncryptionKey;
    const pool = getGeneralPool();
    await createOrCoalesceLoginTaskTx(pool, loginKey, {
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
    const existingAccount = await getAccount(identity);
    if (existingAccount) return;

    this.logger.info('identity-init', 'Initializing unknown identity', { identity });

    const coordPool = getCoordinationPool();
    const lockResult = await withPostgresAdvisoryLock(
      coordPool,
      ADVISORY_NAMESPACES.PROXY_INIT,
      identity,
      async () => {
        const account = await getAccount(identity);
        if (account) {
          this.logger.info('identity-init-skip', 'Account created by another replica', { identity });
          return;
        }

        const ensured = await ensureSsoUser({ identity, preferredSsoUser: ssoUserFromIdentity(identity) });
        const synced = await syncEmuUser(ensured.user.ssoUser);
        if (!synced.ghLogin) throw new Error(`SSO user "${ensured.user.ssoUser}" did not return a GH login.`);

        await createAccount({
          identity,
          ssoUser: ensured.user.ssoUser,
          ghLogin: synced.ghLogin,
          copilotOauthStatus: 'refreshing',
        });

        const ssoPassword = ensured.passwordForLogin;
        if (!ssoPassword) {
          this.logger.info('identity-init-no-password', 'SSO user exists with operator-managed credentials; not auto-enqueueing', { identity, ssoUser: ensured.user.ssoUser });
          await markCopilotOauthStatus(identity, 'missing');
          return;
        }

        const loginKey = getDatabaseConfig().loginJobEncryptionKey;
        const pool = getGeneralPool();
        const taskResult = await createOrCoalesceLoginTaskTx(pool, loginKey, {
          identity,
          ssoUser: ensured.user.ssoUser,
          ssoPassword,
          ghLogin: synced.ghLogin,
          ssoType: 'custom',
        });

        this.logger.info('identity-init-task', 'Login task created for new identity', {
          identity,
          taskId: taskResult.task.id,
          created: taskResult.created,
        });
      },
    );

    if (!lockResult.lockAcquired) {
      this.logger.info('identity-init-locked', 'Another replica is initializing this identity', { identity });
    }
  }
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

export const copilotAuthManager = new CopilotAuthManager();
