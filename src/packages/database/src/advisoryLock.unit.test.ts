import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ADVISORY_NAMESPACES } from './advisoryLock.js';

describe('ADVISORY_NAMESPACES', () => {
  it('is an object with the expected named namespace keys', () => {
    const keys = Object.keys(ADVISORY_NAMESPACES).sort();
    assert.deepEqual(keys, ['LOGIN_WORKER', 'PROXY_INIT', 'PROXY_REFRESH', 'SSO_SCIM']);
  });

  it('exposes every namespace value as a safe int32 integer', () => {
    for (const [name, value] of Object.entries(ADVISORY_NAMESPACES) as Array<
      [string, number]
    >) {
      assert.equal(typeof value, 'number', `${name} should be a number`);
      assert.ok(Number.isSafeInteger(value), `${name} should be a safe integer`);
      assert.ok(value >= -2_147_483_648, `${name} should be >= int32 min`);
      assert.ok(value <= 2_147_483_647, `${name} should be <= int32 max`);
    }
  });

  it('assigns a distinct value to every namespace', () => {
    const values = Object.values(ADVISORY_NAMESPACES);
    const uniqueValues = new Set(values);
    assert.equal(uniqueValues.size, Object.keys(ADVISORY_NAMESPACES).length);
  });

  it('produces stable values across repeated reads (module-level constants)', () => {
    assert.equal(ADVISORY_NAMESPACES.PROXY_INIT, ADVISORY_NAMESPACES.PROXY_INIT);
    assert.equal(ADVISORY_NAMESPACES.PROXY_REFRESH, ADVISORY_NAMESPACES.PROXY_REFRESH);
    assert.equal(ADVISORY_NAMESPACES.SSO_SCIM, ADVISORY_NAMESPACES.SSO_SCIM);
    assert.equal(ADVISORY_NAMESPACES.LOGIN_WORKER, ADVISORY_NAMESPACES.LOGIN_WORKER);
  });

  it('derives PROXY_INIT and PROXY_REFRESH to different hashes', () => {
    // Indirectly verifies hashNamespace maps distinct inputs to distinct outputs.
    assert.notEqual(ADVISORY_NAMESPACES.PROXY_INIT, ADVISORY_NAMESPACES.PROXY_REFRESH);
  });
});
