import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecret, redactFields, shouldRedact } from './redact.js';

describe('maskSecret', () => {
  it('returns empty string for empty input', () => {
    assert.equal(maskSecret(''), '');
  });

  it('redacts short values (len <= visible*2)', () => {
    assert.equal(maskSecret('abc'), '<redacted>');
  });

  it('masks head and tail for long values', () => {
    assert.equal(maskSecret('abcdefghijklmnop'), 'abcd...mnop');
  });
});

describe('redactFields', () => {
  it('redacts secret-like keys and passes through others', () => {
    const result = redactFields({ password: 'secret', name: 'john', token: 'abc' });
    assert.equal(result.password, '<redacted>');
    assert.equal(result.token, '<redacted>');
    assert.equal(result.name, 'john');
  });
});

describe('shouldRedact', () => {
  it('returns true when key contains a secret part (case-insensitive)', () => {
    assert.equal(shouldRedact('X-Authorization'), true);
  });

  it('returns false for non-secret keys', () => {
    assert.equal(shouldRedact('username'), false);
  });
});
