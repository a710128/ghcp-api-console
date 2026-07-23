import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHandle } from './handle.js';

describe('normalizeHandle', () => {
  it('lowercases the handle and appends the shortcode', () => {
    const result = normalizeHandle('Alice', 'shorty');
    assert.equal(result, 'alice_shorty');
  });

  it('strips the domain and uses the local part of an email', () => {
    const result = normalizeHandle('alice@company.com', 'myco');
    assert.equal(result, 'alice_myco');
  });

  it('replaces invalid characters with hyphens', () => {
    const result = normalizeHandle('Alice Smith!', 'co');
    assert.equal(result, 'alice-smith_co');
  });

  it('truncates the local part so the total fits within 39 chars', () => {
    const shortcode = 'shortcode';
    const result = normalizeHandle('a'.repeat(50), shortcode);
    const maxLocal = 39 - (shortcode.length + 1);
    assert.equal(result, `${'a'.repeat(maxLocal)}_${shortcode}`);
    assert.ok(result.length <= 39);
  });

  it('always ends with _${shortcode}', () => {
    for (const [name, code] of [
      ['Alice', 'shorty'],
      ['alice@company.com', 'myco'],
      ['Alice Smith!', 'co'],
      ['a'.repeat(50), 'shortcode'],
    ] as const) {
      const result = normalizeHandle(name, code);
      assert.ok(result.endsWith(`_${code}`), `expected ${result} to end with _${code}`);
    }
  });
});
