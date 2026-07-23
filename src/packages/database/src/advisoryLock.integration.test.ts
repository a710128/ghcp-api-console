import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hasTestDatabase, applyTestEncryptionEnv } from '@ghcp/database/test-support';
import { withPostgresAdvisoryLock, ADVISORY_NAMESPACES } from './advisoryLock.js';

if (!hasTestDatabase()) {
  describe('advisoryLock integration tests (skipped: no TEST_DATABASE_URL)', () => {
    it('skip', { skip: 'TEST_DATABASE_URL not set' }, () => {});
  });
} else {
  describe('withPostgresAdvisoryLock integration', () => {
    const ns = ADVISORY_NAMESPACES.PROXY_INIT;
    let poolA: pg.Pool;
    let poolB: pg.Pool;

    before(() => {
      applyTestEncryptionEnv();
      poolA = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
      poolB = new pg.Pool({ connectionString: process.env['TEST_DATABASE_URL'] });
    });

    after(async () => {
      await poolA.end();
      await poolB.end();
    });

    it('acquires the lock, runs the work function, and returns the result', async () => {
      const outcome = await withPostgresAdvisoryLock(poolA, ns, 'acquire-key', async () => 'ok');
      assert.equal(outcome.lockAcquired, true);
      assert.equal(outcome.result, 'ok');
    });

    it('returns lockAcquired=false when the same ns+key is already held', async () => {
      const key = 'contended-key';

      // Gate that keeps the first work function pending until we release it.
      let releaseFirst!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      // Signals that the first holder has actually acquired the lock.
      let heldResolve!: () => void;
      const held = new Promise<void>((resolve) => {
        heldResolve = resolve;
      });

      const firstPromise = withPostgresAdvisoryLock(poolA, ns, key, async () => {
        heldResolve();
        await gate;
        return 'first';
      });

      // Wait until the first holder is confirmed to hold the lock (no sleeps).
      await held;

      // Second attempt from a DIFFERENT pool/client must fail immediately.
      const second = await withPostgresAdvisoryLock(poolB, ns, key, async () => 'second');
      assert.equal(second.lockAcquired, false);
      assert.equal(second.result, undefined);

      // Release the first holder and confirm it completed successfully.
      releaseFirst();
      const first = await firstPromise;
      assert.equal(first.lockAcquired, true);
      assert.equal(first.result, 'first');

      // After release, the lock is free again for the second pool.
      const third = await withPostgresAdvisoryLock(poolB, ns, key, async () => 'third');
      assert.equal(third.lockAcquired, true);
      assert.equal(third.result, 'third');
    });

    it('different keys do not collide (simultaneous acquires both succeed)', async () => {
      let releaseA!: () => void;
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      let heldAResolve!: () => void;
      const heldA = new Promise<void>((resolve) => {
        heldAResolve = resolve;
      });

      const promiseA = withPostgresAdvisoryLock(poolA, ns, 'key-alpha', async () => {
        heldAResolve();
        await gateA;
        return 'alpha';
      });

      await heldA;

      // Different key on a different pool must succeed while 'key-alpha' is held.
      const b = await withPostgresAdvisoryLock(poolB, ns, 'key-beta', async () => 'beta');
      assert.equal(b.lockAcquired, true);
      assert.equal(b.result, 'beta');

      releaseA();
      const a = await promiseA;
      assert.equal(a.lockAcquired, true);
      assert.equal(a.result, 'alpha');
    });
  });
}
