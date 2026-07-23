import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nowIso, epochSeconds, isoFromEpochSeconds } from './time.js';

describe('nowIso', () => {
  it('returns an ISO-8601 string containing T and Z', () => {
    const iso = nowIso();
    assert.equal(typeof iso, 'string');
    assert.ok(iso.includes('T'));
    assert.ok(iso.includes('Z'));
  });
});

describe('epochSeconds', () => {
  it('returns an integer', () => {
    const value = epochSeconds();
    assert.equal(Number.isInteger(value), true);
  });
});

describe('isoFromEpochSeconds', () => {
  it('round-trips epochSeconds to an ISO string with T and Z', () => {
    const iso = isoFromEpochSeconds(epochSeconds());
    assert.equal(typeof iso, 'string');
    assert.ok(iso.includes('T'));
    assert.ok(iso.includes('Z'));
  });
});
