import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hasTestDatabase, applyTestEncryptionEnv, resetDatabase } from '@ghcp/database/test-support';
import { initPool, getGeneralPool, closePool } from './pool.js';
import {
  createUser,
  getUser,
  getUserByGhLogin,
  listUsers,
  listAllUsers,
  updateUser,
  updateEmu,
  updateCopilotSeat,
  deleteUser,
  toDto,
} from './usersRepo.js';

async function seedUser(overrides: Partial<{
  ssoUser: string;
  passwordHash: string;
  salt: string;
  email: string;
  role: 'user' | 'admin';
  credentialSource: 'generated_default' | 'operator_managed';
}> = {}) {
  return createUser({
    ssoUser: overrides.ssoUser ?? 'alice',
    passwordHash: overrides.passwordHash ?? 'hash-alice',
    salt: overrides.salt ?? 'salt-alice',
    email: overrides.email ?? 'alice@example.com',
    role: overrides.role,
    credentialSource: overrides.credentialSource,
  });
}

if (!hasTestDatabase()) {
  describe('sso usersRepo integration (skipped: no TEST_DATABASE_URL)', () => {
    it('skip', { skip: 'TEST_DATABASE_URL not set' }, () => {});
  });
} else {
  describe('sso usersRepo integration', () => {
    let barePool: pg.Pool;

    before(async () => {
      applyTestEncryptionEnv();
      barePool = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
      await resetDatabase(barePool);
      await barePool.end();
      await initPool();
    });

    beforeEach(async () => {
      await getGeneralPool().query(`
        TRUNCATE sso.users,
                 sso.emu_import_plans,
                 sso.emu_import_plan_rows,
                 sso.budget_cache
        RESTART IDENTITY CASCADE
      `);
    });

    after(async () => {
      await closePool();
    });

    it('createUser inserts a user and returns the created record', async () => {
      const created = await seedUser();
      assert.equal(created.ssoUser, 'alice');
      assert.equal(created.email, 'alice@example.com');
      assert.equal(created.role, 'user');
      assert.equal(created.emuStatus, 'not_synced');
      assert.equal(created.copilotSeatStatus, 'unknown');
      assert.equal(created.passwordHash, 'hash-alice');
      assert.equal(created.salt, 'salt-alice');
      assert.ok(created.createdAt);
      assert.ok(created.updatedAt);
    });

    it('createUser honors role and credentialSource', async () => {
      const created = await seedUser({
        ssoUser: 'admin1',
        email: 'admin1@example.com',
        role: 'admin',
        credentialSource: 'operator_managed',
      });
      assert.equal(created.role, 'admin');
    });

    it('getUser returns a user by ssoUser (case-insensitive) and undefined for unknown', async () => {
      await seedUser();
      const found = await getUser('ALICE');
      assert.ok(found);
      assert.equal(found!.ssoUser, 'alice');

      const missing = await getUser('nobody');
      assert.equal(missing, undefined);
    });

    it('getUserByGhLogin returns a user by ghLogin', async () => {
      await seedUser();
      await updateEmu('alice', { ghLogin: 'alice_gh', ghScimId: 'scim-1', emuStatus: 'active' });

      const found = await getUserByGhLogin('ALICE_GH');
      assert.ok(found);
      assert.equal(found!.ssoUser, 'alice');
      assert.equal(found!.ghLogin, 'alice_gh');

      const missing = await getUserByGhLogin('unknown_gh');
      assert.equal(missing, undefined);

      const empty = await getUserByGhLogin('   ');
      assert.equal(empty, undefined);
    });

    it('listUsers returns a page with items and total', async () => {
      await seedUser({ ssoUser: 'alice', email: 'alice@example.com' });
      await seedUser({ ssoUser: 'bob', email: 'bob@example.com' });
      await seedUser({ ssoUser: 'carol', email: 'carol@example.com' });

      const page = await listUsers({ page: 1, pageSize: 10 });
      assert.equal(page.total, 3);
      assert.equal(page.items.length, 3);
      assert.equal(page.page, 1);
      assert.equal(page.pageSize, 10);
      // Items are DTOs and must not contain raw password material.
      for (const item of page.items) {
        assert.equal((item as unknown as Record<string, unknown>)['passwordHash'], undefined);
        assert.equal((item as unknown as Record<string, unknown>)['salt'], undefined);
      }
    });

    it('listUsers respects pageSize pagination and search query', async () => {
      await seedUser({ ssoUser: 'alice', email: 'alice@example.com' });
      await seedUser({ ssoUser: 'bob', email: 'bob@example.com' });
      await seedUser({ ssoUser: 'carol', email: 'carol@example.com' });

      const firstPage = await listUsers({ page: 1, pageSize: 2 });
      assert.equal(firstPage.total, 3);
      assert.equal(firstPage.items.length, 2);

      const secondPage = await listUsers({ page: 2, pageSize: 2 });
      assert.equal(secondPage.total, 3);
      assert.equal(secondPage.items.length, 1);

      const searched = await listUsers({ q: 'bob' });
      assert.equal(searched.total, 1);
      assert.equal(searched.items[0]!.ssoUser, 'bob');
    });

    it('listAllUsers returns every user as records', async () => {
      await seedUser({ ssoUser: 'alice', email: 'alice@example.com' });
      await seedUser({ ssoUser: 'bob', email: 'bob@example.com' });

      const all = await listAllUsers();
      assert.equal(all.length, 2);
      const users = all.map((u) => u.ssoUser).sort();
      assert.deepEqual(users, ['alice', 'bob']);
      // Records DO carry passwordHash/salt.
      assert.ok(all[0]!.passwordHash);
      assert.ok(all[0]!.salt);
    });

    it('updateUser updates fields and returns the updated record', async () => {
      await seedUser();
      const updated = await updateUser('alice', {
        email: 'alice2@example.com',
        role: 'admin',
        passwordHash: 'new-hash',
        salt: 'new-salt',
      });
      assert.ok(updated);
      assert.equal(updated!.email, 'alice2@example.com');
      assert.equal(updated!.role, 'admin');
      assert.equal(updated!.passwordHash, 'new-hash');
      assert.equal(updated!.salt, 'new-salt');
    });

    it('updateUser returns undefined for an unknown user', async () => {
      const result = await updateUser('nobody', { email: 'x@example.com' });
      assert.equal(result, undefined);
    });

    it('updateEmu updates EMU status and gh identifiers', async () => {
      await seedUser();
      const updated = await updateEmu('alice', {
        ghLogin: 'alice_gh',
        ghScimId: 'scim-42',
        emuStatus: 'active',
      });
      assert.equal(updated.emuStatus, 'active');
      assert.equal(updated.ghLogin, 'alice_gh');
      assert.equal(updated.ghScimId, 'scim-42');

      const suspended = await updateEmu('alice', { emuStatus: 'suspended' });
      assert.equal(suspended.emuStatus, 'suspended');
      // ghLogin/ghScimId are reset to null when not provided.
      assert.equal(suspended.ghLogin, undefined);
      assert.equal(suspended.ghScimId, undefined);
    });

    it('updateEmu throws for an unknown user', async () => {
      await assert.rejects(
        () => updateEmu('nobody', { emuStatus: 'active' }),
        /Unknown SSO user/,
      );
    });

    it('updateCopilotSeat updates the copilot seat status', async () => {
      await seedUser();
      const updated = await updateCopilotSeat('alice', {
        status: 'assigned',
        lastOperation: 'assign',
      });
      assert.equal(updated.copilotSeatStatus, 'assigned');
      assert.equal(updated.copilotSeatLastOperation, 'assign');
      assert.ok(updated.copilotSeatUpdatedAt);

      const failed = await updateCopilotSeat('alice', {
        status: 'assign_failed',
        lastOperation: 'assign',
        lastError: 'boom',
      });
      assert.equal(failed.copilotSeatStatus, 'assign_failed');
      assert.equal(failed.copilotSeatLastError, 'boom');
    });

    it('deleteUser removes the user', async () => {
      await seedUser();
      const deleted = await deleteUser('alice');
      assert.equal(deleted, true);
      assert.equal(await getUser('alice'), undefined);

      const again = await deleteUser('alice');
      assert.equal(again, false);
    });

    it('toDto strips password material from a record', async () => {
      const created = await seedUser();
      const dto = toDto(created);
      assert.equal((dto as unknown as Record<string, unknown>)['passwordHash'], undefined);
      assert.equal((dto as unknown as Record<string, unknown>)['salt'], undefined);
      assert.equal(dto.ssoUser, 'alice');
      assert.equal(dto.email, 'alice@example.com');
      assert.equal(dto.role, 'user');
      assert.equal(dto.emuStatus, 'not_synced');
    });
  });
}
