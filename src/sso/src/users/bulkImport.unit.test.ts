import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseBulkImportText } from './bulkImport.js';

describe('parseBulkImportText', () => {
  it('parses valid two-column rows', () => {
    const result = parseBulkImportText('alice,pass123\nbob,pass456');
    assert.equal(result.rows.length, 2);
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.rows[0], { line: 1, ssoUser: 'alice', password: 'pass123' });
    assert.deepEqual(result.rows[1], { line: 2, ssoUser: 'bob', password: 'pass456' });
  });

  it('skips the header row', () => {
    const result = parseBulkImportText('ssoUser,password\nalice,pass123');
    assert.equal(result.rows.length, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(result.rows[0]!.ssoUser, 'alice');
    assert.equal(result.rows[0]!.password, 'pass123');
  });

  it('detects duplicate sso users', () => {
    const result = parseBulkImportText('alice,pass1\nalice,pass2');
    assert.equal(result.rows.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.error, /[Dd]uplicate/);
    assert.equal(result.errors[0]!.ssoUser, 'alice');
  });

  it('collects an error for malformed quoted lines', () => {
    const result = parseBulkImportText('"unclosed');
    assert.equal(result.rows.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.error, /[Uu]nclosed/);
  });

  it('returns nothing for empty input', () => {
    const result = parseBulkImportText('');
    assert.equal(result.rows.length, 0);
    assert.equal(result.errors.length, 0);
  });

  it('treats a single column as password equal to ssoUser', () => {
    const result = parseBulkImportText('alice');
    assert.equal(result.rows.length, 1);
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.rows[0], { line: 1, ssoUser: 'alice', password: 'alice' });
  });
});
