import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { hasTestDatabase, applyTestEncryptionEnv, resetDatabase } from '@ghcp/database/test-support';
import { initPool, getGeneralPool, closePool } from './pool.js';
import type { EmuImportPlanRowRecord } from './emuImportPlansRepo.js';
import {
  createEmuImportPlanRecord,
  requireEmuImportPlan,
  listEmuImportPlanRows,
  listPendingEmuImportPlanRows,
  updateEmuImportPlanRow,
  markEmuImportPlanApplied,
  deleteEmuImportPlanRecord,
  acquireApplyLease,
  releaseApplyLease,
} from './emuImportPlansRepo.js';

function planRow(overrides: Partial<Omit<EmuImportPlanRowRecord, 'rowIndex'>> = {}): Omit<EmuImportPlanRowRecord, 'rowIndex'> {
  return {
    ssoUser: overrides.ssoUser ?? 'alice',
    email: overrides.email ?? 'alice@example.com',
    ghLogin: overrides.ghLogin,
    ghScimId: overrides.ghScimId,
    emuStatus: overrides.emuStatus ?? 'active',
    status: overrides.status ?? 'pending_create',
    detail: overrides.detail ?? 'new user',
    action: overrides.action ?? 'create',
  };
}

async function seedPlan(id: string, rows: Omit<EmuImportPlanRowRecord, 'rowIndex'>[]) {
  return createEmuImportPlanRecord({ id, ssoUser: 'alice', rows });
}

if (!hasTestDatabase()) {
  describe('sso emuImportPlansRepo integration (skipped: no TEST_DATABASE_URL)', () => {
    it('skip', { skip: 'TEST_DATABASE_URL not set' }, () => {});
  });
} else {
  describe('sso emuImportPlansRepo integration', () => {
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

    it('createEmuImportPlanRecord creates a plan with rows and summary', async () => {
      const plan = await seedPlan('plan-1', [
        planRow({ ssoUser: 'alice', status: 'pending_create', action: 'create' }),
        planRow({ ssoUser: 'bob', email: 'bob@example.com', status: 'pending_update', action: 'update' }),
      ]);
      assert.equal(plan.planId, 'plan-1');
      assert.equal(plan.ssoUser, 'alice');
      assert.equal(plan.status, 'planned');
      assert.equal(plan.summary.total, 2);
      assert.equal(plan.summary.pendingCreate, 1);
      assert.equal(plan.summary.pendingUpdate, 1);
      assert.equal(plan.summary.actionable, 2);
      assert.ok(plan.createdAt);
    });

    it('requireEmuImportPlan returns a known plan and throws on unknown id', async () => {
      await seedPlan('plan-1', [planRow()]);
      const plan = await requireEmuImportPlan('plan-1');
      assert.equal(plan.planId, 'plan-1');

      await assert.rejects(
        () => requireEmuImportPlan('does-not-exist'),
        /was not found/,
      );
    });

    it('listEmuImportPlanRows returns rows with pagination and status filter', async () => {
      await seedPlan('plan-1', [
        planRow({ ssoUser: 'alice', status: 'pending_create' }),
        planRow({ ssoUser: 'bob', email: 'bob@example.com', status: 'pending_update', action: 'update' }),
        planRow({ ssoUser: 'carol', email: 'carol@example.com', status: 'skipped', action: 'skip' }),
      ]);

      const allRows = await listEmuImportPlanRows('plan-1', { page: 1, pageSize: 10 });
      assert.equal(allRows.total, 3);
      assert.equal(allRows.items.length, 3);
      assert.equal(allRows.items[0]!.rowIndex, 1);

      const paged = await listEmuImportPlanRows('plan-1', { page: 1, pageSize: 2 });
      assert.equal(paged.total, 3);
      assert.equal(paged.items.length, 2);

      const filtered = await listEmuImportPlanRows('plan-1', { status: 'pending_update' });
      assert.equal(filtered.total, 1);
      assert.equal(filtered.items[0]!.ssoUser, 'bob');
    });

    it('listPendingEmuImportPlanRows returns only pending rows', async () => {
      await seedPlan('plan-1', [
        planRow({ ssoUser: 'alice', status: 'pending_create' }),
        planRow({ ssoUser: 'bob', email: 'bob@example.com', status: 'pending_update', action: 'update' }),
        planRow({ ssoUser: 'carol', email: 'carol@example.com', status: 'created', action: 'create' }),
      ]);

      const pending = await listPendingEmuImportPlanRows('plan-1');
      assert.equal(pending.length, 2);
      const users = pending.map((r) => r.ssoUser).sort();
      assert.deepEqual(users, ['alice', 'bob']);
    });

    it('updateEmuImportPlanRow updates a row', async () => {
      await seedPlan('plan-1', [planRow({ ssoUser: 'alice', status: 'pending_create', action: 'create' })]);

      await updateEmuImportPlanRow('plan-1', {
        rowIndex: 1,
        ssoUser: 'alice',
        email: 'alice-new@example.com',
        ghLogin: 'alice_gh',
        ghScimId: 'scim-9',
        emuStatus: 'active',
        status: 'created',
        detail: 'created ok',
        action: 'create',
      });

      const rows = await listEmuImportPlanRows('plan-1');
      assert.equal(rows.items[0]!.status, 'created');
      assert.equal(rows.items[0]!.email, 'alice-new@example.com');
      assert.equal(rows.items[0]!.ghLogin, 'alice_gh');
      assert.equal(rows.items[0]!.ghScimId, 'scim-9');
    });

    it('markEmuImportPlanApplied flips the plan to applied', async () => {
      await seedPlan('plan-1', [planRow()]);
      const applied = await markEmuImportPlanApplied('plan-1');
      assert.equal(applied.status, 'applied');
      assert.ok(applied.appliedAt);
    });

    it('deleteEmuImportPlanRecord removes a plan (and cascades rows)', async () => {
      await seedPlan('plan-1', [planRow(), planRow({ ssoUser: 'bob', email: 'bob@example.com' })]);
      const deleted = await deleteEmuImportPlanRecord('plan-1');
      assert.equal(deleted, true);

      await assert.rejects(() => requireEmuImportPlan('plan-1'), /was not found/);

      const { rows } = await getGeneralPool().query<{ count: string }>(
        'SELECT COUNT(*) AS count FROM sso.emu_import_plan_rows WHERE plan_id = $1',
        ['plan-1'],
      );
      assert.equal(parseInt(rows[0]!.count, 10), 0);
    });

    it('acquireApplyLease grants an exclusive lease', async () => {
      await seedPlan('plan-1', [planRow()]);
      const owner = await acquireApplyLease('plan-1');
      assert.ok(owner, 'expected a lease owner UUID');
      assert.equal(typeof owner, 'string');
    });

    it('a second acquireApplyLease while the first is held returns null', async () => {
      await seedPlan('plan-1', [planRow()]);
      const first = await acquireApplyLease('plan-1');
      assert.ok(first);
      const second = await acquireApplyLease('plan-1');
      assert.equal(second, null);
    });

    it('acquireApplyLease returns null for an unknown plan', async () => {
      const owner = await acquireApplyLease('missing-plan');
      assert.equal(owner, null);
    });

    it('releaseApplyLease frees the lease so it can be re-acquired', async () => {
      await seedPlan('plan-1', [planRow()]);
      const first = await acquireApplyLease('plan-1');
      assert.ok(first);

      await releaseApplyLease('plan-1', first!);

      const second = await acquireApplyLease('plan-1');
      assert.ok(second, 'expected to re-acquire after release');
      assert.notEqual(second, first);
    });

    it('releaseApplyLease with a non-matching owner does not free the lease', async () => {
      await seedPlan('plan-1', [planRow()]);
      const first = await acquireApplyLease('plan-1');
      assert.ok(first);

      await releaseApplyLease('plan-1', randomUUID());

      const second = await acquireApplyLease('plan-1');
      assert.equal(second, null);
    });
  });
}
