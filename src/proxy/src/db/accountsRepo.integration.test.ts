/**
 * Integration tests for the proxy accountsRepo against a real PostgreSQL database.
 *
 * Requires TEST_DATABASE_URL to be set (e.g. the docker postgres-test container).
 * When TEST_DATABASE_URL is unset, the whole suite is skipped and the process
 * still exits 0.
 *
 * Setup sequence (must not deviate):
 *   applyTestEncryptionEnv -> bare pool -> resetDatabase -> bare pool end -> initPool
 * initPool() runs validateClusterKeys which INSERTs the cluster_metadata row, so
 * resetDatabase (which drops it) must run BEFORE initPool.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hasTestDatabase, applyTestEncryptionEnv, resetDatabase } from '@ghcp/database/test-support';
import { initPool, getGeneralPool, closePool, getDataEncryptionKey } from '../db/pool.js';
import { decryptCredential, buildAad } from '../db/crypto.js';
import * as accountsRepo from '../db/accountsRepo.js';

if (!hasTestDatabase()) {
  describe('proxy accountsRepo integration (skipped)', () => {
    it('skip', { skip: 'TEST_DATABASE_URL not set' }, () => {});
  });
} else {
  describe('proxy accountsRepo integration', () => {
    let barePool: pg.Pool;

    before(async () => {
      // Step 1: Set encryption env vars FIRST.
      applyTestEncryptionEnv();

      // Step 2: Open a BARE pool to reset the database.
      barePool = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] });

      // Step 3: Reset (drops proxy/sso/login schemas + public tables + re-migrates).
      // This gives us a clean cluster with NO cluster_metadata row.
      await resetDatabase(barePool);

      // Step 4: Close the bare pool.
      await barePool.end();

      // Step 5: Initialize the PROXY service's singleton pool.
      // initPool() calls validateClusterKeys which INSERTS the cluster_metadata row.
      await initPool();
    });

    beforeEach(async () => {
      // TRUNCATE only proxy.accounts - do NOT call resetDatabase here (it would drop
      // cluster_metadata which initPool created). request stats are not a PG table.
      await getGeneralPool().query('TRUNCATE proxy.accounts RESTART IDENTITY CASCADE');
    });

    after(async () => {
      await closePool();
    });

    it('createAccount creates an account retrievable by getAccount', async () => {
      const created = await accountsRepo.createAccount({
        identity: 'alice',
        ssoUser: 'alice_sso',
        ghLogin: 'alice-gh',
      });
      assert.equal(created.identity, 'alice');
      assert.equal(created.ssoUser, 'alice_sso');
      assert.equal(created.ghLogin, 'alice-gh');
      assert.equal(created.ghTokenStatus, 'missing');
      assert.equal(created.copilotTokenStatus, 'missing');

      const fetched = await accountsRepo.getAccount('alice');
      assert.ok(fetched);
      assert.equal(fetched.identity, 'alice');
      assert.equal(fetched.ssoUser, 'alice_sso');
      assert.equal(fetched.ghLogin, 'alice-gh');
    });

    it('getAccount returns undefined for a non-existent identity', async () => {
      const missing = await accountsRepo.getAccount('does-not-exist');
      assert.equal(missing, undefined);
    });

    it('listAccounts returns a page with items and total', async () => {
      await accountsRepo.createAccount({ identity: 'u1', ssoUser: 's1' });
      await accountsRepo.createAccount({ identity: 'u2', ssoUser: 's2' });
      await accountsRepo.createAccount({ identity: 'u3', ssoUser: 's3' });

      const page = await accountsRepo.listAccounts({});
      assert.equal(page.total, 3);
      assert.equal(page.items.length, 3);
      assert.equal(page.page, 1);
      assert.ok(page.pageSize >= 3);

      const identities = page.items.map((a) => a.identity).sort();
      assert.deepEqual(identities, ['u1', 'u2', 'u3']);
    });

    it('listAccounts filters by query and paginates', async () => {
      await accountsRepo.createAccount({ identity: 'alice', ssoUser: 'alice_sso' });
      await accountsRepo.createAccount({ identity: 'bob', ssoUser: 'bob_sso' });

      const filtered = await accountsRepo.listAccounts({ q: 'alice' });
      assert.equal(filtered.total, 1);
      assert.equal(filtered.items.length, 1);
      assert.equal(filtered.items[0]!.identity, 'alice');
    });

    it('importGithubToken saves an encrypted token (crypto round-trip via raw row)', async () => {
      const token = 'ghp_secret_token_value_123';
      const account = await accountsRepo.importGithubToken({
        identity: 'carol',
        ssoUser: 'carol_sso',
        ghLogin: 'carol-gh',
        ghToken: token,
      });
      assert.equal(account.identity, 'carol');
      assert.equal(account.ghTokenStatus, 'valid');
      // mapRow decrypts the token on read; verify it round-trips.
      assert.equal(account.ghToken, token);

      // Verify the token is actually encrypted at rest and round-trips manually.
      const raw = await getGeneralPool().query<{
        gh_token_cipher: string;
        gh_token_nonce: string;
      }>('SELECT gh_token_cipher, gh_token_nonce FROM proxy.accounts WHERE identity = $1', [
        'carol',
      ]);
      const row = raw.rows[0]!;
      assert.ok(row.gh_token_cipher);
      assert.ok(row.gh_token_nonce);
      // Ciphertext must not equal the plaintext.
      assert.notEqual(row.gh_token_cipher, token);

      const decrypted = decryptCredential(
        { cipher: row.gh_token_cipher, nonce: row.gh_token_nonce },
        getDataEncryptionKey(),
        buildAad('carol', 'gh_token'),
      );
      assert.equal(decrypted, token);
    });

    it('saveGithubToken updates the encrypted token for an existing account', async () => {
      await accountsRepo.createAccount({ identity: 'dave', ssoUser: 'dave_sso' });
      const token = 'ghp_dave_token_456';
      const updated = await accountsRepo.saveGithubToken('dave', token, 'dave-gh');
      assert.equal(updated.ghTokenStatus, 'valid');
      assert.equal(updated.ghLogin, 'dave-gh');
      assert.equal(updated.ghToken, token);
    });

    it('markGithubTokenStatus updates the gh token status', async () => {
      await accountsRepo.importGithubToken({
        identity: 'erin',
        ssoUser: 'erin_sso',
        ghToken: 'ghp_erin_token',
      });
      await accountsRepo.markGithubTokenStatus('erin', 'expired');
      const account = await accountsRepo.getAccount('erin');
      assert.ok(account);
      assert.equal(account.ghTokenStatus, 'expired');
    });

    it('saveCopilotToken saves an encrypted copilot token', async () => {
      await accountsRepo.createAccount({ identity: 'frank', ssoUser: 'frank_sso' });
      const copToken = 'cop_secret_789';
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const account = await accountsRepo.saveCopilotToken({
        identity: 'frank',
        token: copToken,
        api: 'https://api.githubcopilot.com',
        expiresAt,
      });
      assert.equal(account.copilotTokenStatus, 'valid');
      assert.equal(account.copilotApi, 'https://api.githubcopilot.com');
      assert.equal(account.copilotToken, copToken);

      // Verify encrypted at rest and round-trips manually.
      const raw = await getGeneralPool().query<{
        copilot_token_cipher: string;
        copilot_token_nonce: string;
      }>(
        'SELECT copilot_token_cipher, copilot_token_nonce FROM proxy.accounts WHERE identity = $1',
        ['frank'],
      );
      const row = raw.rows[0]!;
      assert.ok(row.copilot_token_cipher);
      assert.notEqual(row.copilot_token_cipher, copToken);
      const decrypted = decryptCredential(
        { cipher: row.copilot_token_cipher, nonce: row.copilot_token_nonce },
        getDataEncryptionKey(),
        buildAad('frank', 'copilot_token'),
      );
      assert.equal(decrypted, copToken);
    });

    it('markCopilotTokenStatus updates the copilot token status', async () => {
      await accountsRepo.createAccount({ identity: 'grace', ssoUser: 'grace_sso' });
      await accountsRepo.saveCopilotToken({
        identity: 'grace',
        token: 'cop_grace',
        api: 'https://api.githubcopilot.com',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await accountsRepo.markCopilotTokenStatus('grace', 'expired');
      const account = await accountsRepo.getAccount('grace');
      assert.ok(account);
      assert.equal(account.copilotTokenStatus, 'expired');
    });

    it('deleteAccountsBySsoUser deletes matching accounts and returns counts', async () => {
      await accountsRepo.createAccount({ identity: 'h1', ssoUser: 'shared_sso' });
      await accountsRepo.createAccount({ identity: 'h2', ssoUser: 'shared_sso' });
      await accountsRepo.createAccount({ identity: 'h3', ssoUser: 'other_sso' });

      const result = await accountsRepo.deleteAccountsBySsoUser('shared_sso');
      assert.equal(result.ssoUser, 'shared_sso');
      assert.equal(result.matchedAccounts, 2);
      assert.equal(result.deletedAccounts, 2);

      assert.equal(await accountsRepo.getAccount('h1'), undefined);
      assert.equal(await accountsRepo.getAccount('h2'), undefined);
      const survivor = await accountsRepo.getAccount('h3');
      assert.ok(survivor);
      assert.equal(survivor.ssoUser, 'other_sso');
    });

    it('deleteAccountsBySsoUser is case-insensitive on sso_user', async () => {
      await accountsRepo.createAccount({ identity: 'i1', ssoUser: 'MixedCase' });
      const result = await accountsRepo.deleteAccountsBySsoUser('mixedcase');
      assert.equal(result.matchedAccounts, 1);
      assert.equal(result.deletedAccounts, 1);
    });

    it('deleteAccountsBySsoUser with a blank ssoUser deletes nothing', async () => {
      await accountsRepo.createAccount({ identity: 'j1', ssoUser: 'j_sso' });
      const result = await accountsRepo.deleteAccountsBySsoUser('   ');
      assert.equal(result.matchedAccounts, 0);
      assert.equal(result.deletedAccounts, 0);
      assert.ok(await accountsRepo.getAccount('j1'));
    });

    it('toAccountDto omits ghToken and copilotToken secret fields', async () => {
      const account = await accountsRepo.importGithubToken({
        identity: 'kate',
        ssoUser: 'kate_sso',
        ghLogin: 'kate-gh',
        ghToken: 'ghp_kate_secret',
      });
      await accountsRepo.saveCopilotToken({
        identity: 'kate',
        token: 'cop_kate_secret',
        api: 'https://api.githubcopilot.com',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const fresh = await accountsRepo.getAccount('kate');
      assert.ok(fresh);
      // The internal record still exposes decrypted secrets...
      assert.equal(fresh.ghToken, 'ghp_kate_secret');
      assert.equal(fresh.copilotToken, 'cop_kate_secret');

      // ...but the DTO must NOT.
      const dto = accountsRepo.toAccountDto(fresh);
      assert.equal(Object.prototype.hasOwnProperty.call(dto, 'ghToken'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(dto, 'copilotToken'), false);
      assert.equal((dto as unknown as Record<string, unknown>)['ghToken'], undefined);
      assert.equal((dto as unknown as Record<string, unknown>)['copilotToken'], undefined);
      // Non-secret status fields are preserved.
      assert.equal(dto.identity, 'kate');
      assert.equal(dto.ghTokenStatus, 'valid');
      assert.equal(dto.copilotTokenStatus, 'valid');
      assert.equal(dto.ghLogin, 'kate-gh');
    });
  });
}
