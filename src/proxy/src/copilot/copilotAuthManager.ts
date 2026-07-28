import type { CopilotOauthBatchLoginItem, CopilotOauthBatchLoginRow, SsoType } from '@ghcp/shared';
import type { ProxyAccountRecord } from '../db/accountsRepo.js';
import { createAccount, getAccount, markCopilotOauthStatus, toAccountDto } from '../db/accountsRepo.js';
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
    await this.enqueueOauthRefresh(account, { ssoPassword: options.ssoPassword, ssoType: options.ssoType });
  }

  async batchEnsureAndLogin(items: CopilotOauthBatchLoginItem[]): Promise<CopilotOauthBatchLoginRow[]> {
    const rows: CopilotOauthBatchLoginRow[] = new Array(items.length);
    const CONCURRENCY = 3;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        rows[index] = await this.ensureAndTriggerOauthLogin(items[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    return rows;
  }

  private async ensureAndTriggerOauthLogin(item: CopilotOauthBatchLoginItem): Promise<CopilotOauthBatchLoginRow> {
    const { identity, ssoUser, ssoPassword, ssoType } = item;
    const base = { identity, ssoUser };
    try {
      const lockResult = await withPostgresAdvisoryLock(
        getCoordinationPool(),
        ADVISORY_NAMESPACES.PROXY_INIT,
        identity,
        () => this.ensureAndTriggerOauthLoginLocked({ identity, ssoUser, ssoPassword, ssoType: ssoType ?? 'custom' }),
      );
      if (!lockResult.lockAcquired) {
        return { ...base, status: 'skipped', code: 'identity_busy', detail: 'Identity is being initialized by another operation; retry shortly.', retryable: true };
      }
      return lockResult.result!;
    } catch (err) {
      return { ...base, status: 'failed', code: 'account_create_failed', detail: err instanceof Error ? err.message : String(err), retryable: true };
    }
  }

  private async ensureAndTriggerOauthLoginLocked(item: { identity: string; ssoUser: string; ssoPassword: string; ssoType: SsoType }): Promise<CopilotOauthBatchLoginRow> {
    const { identity, ssoUser, ssoPassword, ssoType } = item;
    const base = { identity, ssoUser };

    let account = await getAccount(identity);
    let accountCreated = false;

    if (account) {
      if (account.ssoUser && account.ssoUser !== ssoUser) {
        return { ...base, status: 'failed', code: 'identity_sso_mismatch', detail: `Identity "${identity}" is already bound to SSO user "${account.ssoUser}".` };
      }
      if (!account.ghLogin) {
        const synced = await syncEmuUser(account.ssoUser);
        if (!synced.ghLogin) return { ...base, status: 'failed', code: 'gh_login_missing', detail: `SSO user "${account.ssoUser}" has no GitHub login after EMU sync.`, retryable: true };
        account = await createAccount({ identity, ssoUser: account.ssoUser, ghLogin: synced.ghLogin });
      }
    } else {
      const provisioned = await this.provisionAccount(identity, ssoUser);
      if ('code' in provisioned) return { ...base, ...provisioned };
      account = provisioned.account;
      accountCreated = true;
    }

    if (account.copilotOauthStatus === 'valid' && account.copilotOauthToken) {
      return { ...base, status: 'skipped', code: 'already_valid', detail: 'Copilot OAuth credential is already valid.', accountCreated, account: toAccountDto(account) };
    }

    const { task, created } = await this.enqueueOauthRefresh(account, { ssoPassword, ssoType });
    const refreshed = await getAccount(identity);
    if (!created) {
      return { ...base, status: 'skipped', code: 'login_in_progress', detail: `A login task is already active for this identity (the supplied password was not applied).`, taskId: task.id, accountCreated, account: refreshed ? toAccountDto(refreshed) : undefined };
    }
    return {
      ...base,
      status: 'success',
      code: accountCreated ? 'account_created_and_queued' : 'account_existing_and_queued',
      detail: accountCreated ? 'Created proxy account and queued login task.' : 'Queued login task for existing account.',
      taskId: task.id,
      accountCreated,
      account: refreshed ? toAccountDto(refreshed) : undefined,
    };
  }

  private async provisionAccount(identity: string, preferredSsoUser: string): Promise<{ account: ProxyAccountRecord } | Pick<CopilotOauthBatchLoginRow, 'status' | 'code' | 'detail' | 'retryable'>> {
    let ensured;
    try {
      ensured = await ensureSsoUser({ identity, preferredSsoUser });
    } catch (err) {
      return { status: 'failed', code: 'sso_user_missing', detail: err instanceof Error ? err.message : String(err), retryable: true };
    }
    if (ensured.user.ssoUser !== preferredSsoUser) {
      return { status: 'failed', code: 'identity_sso_mismatch', detail: `Identity "${identity}" resolves to SSO user "${ensured.user.ssoUser}", not the requested "${preferredSsoUser}".` };
    }
    let synced;
    try {
      synced = await syncEmuUser(ensured.user.ssoUser);
    } catch (err) {
      return { status: 'failed', code: 'emu_sync_failed', detail: err instanceof Error ? err.message : String(err), retryable: true };
    }
    if (!synced.ghLogin) {
      return { status: 'failed', code: 'gh_login_missing', detail: `SSO user "${ensured.user.ssoUser}" did not return a GitHub login.`, retryable: true };
    }
    const account = await createAccount({ identity, ssoUser: ensured.user.ssoUser, ghLogin: synced.ghLogin, copilotOauthStatus: 'missing' });
    return { account };
  }

  private async enqueueOauthRefresh(account: ProxyAccountRecord, options: { ssoPassword: string; ssoType?: SsoType }): Promise<{ task: { id: string }; created: boolean }> {
    const loginKey = getDatabaseConfig().loginJobEncryptionKey;
    const pool = getGeneralPool();
    const result = await createOrCoalesceLoginTaskTx(pool, loginKey, {
      identity: account.identity,
      ssoUser: account.ssoUser,
      ssoPassword: options.ssoPassword,
      ghLogin: account.ghLogin!,
      ssoType: options.ssoType ?? 'custom',
    });
    return { task: result.task, created: result.created };
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
