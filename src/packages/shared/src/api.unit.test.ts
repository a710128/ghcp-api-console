import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apiError, pageResponse, HttpApiError } from './api.js';

describe('apiError', () => {
  it('builds error body with only code and message', () => {
    const result = apiError('not_found', 'Not found');
    assert.deepEqual(result, { error: { code: 'not_found', message: 'Not found', details: undefined, requestId: undefined } });
    assert.equal(result.error.code, 'not_found');
    assert.equal(result.error.message, 'Not found');
    assert.equal(result.error.details, undefined);
    assert.equal(result.error.requestId, undefined);
  });

  it('includes details and requestId when provided', () => {
    const result = apiError('bad', 'Bad', { x: 1 }, 'req-123');
    assert.deepEqual(result.error.details, { x: 1 });
    assert.equal(result.error.requestId, 'req-123');
  });
});

describe('pageResponse', () => {
  it('wraps items with pagination metadata', () => {
    const result = pageResponse([1, 2], 10, 2, 5);
    assert.deepEqual(result, { items: [1, 2], total: 10, page: 2, pageSize: 5 });
  });
});

describe('HttpApiError', () => {
  it('exposes status, code, name, and message', () => {
    const err = new HttpApiError(403, 'forbidden', 'Forbidden');
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden');
    assert.equal(err.name, 'HttpApiError');
    assert.equal(err.message, 'Forbidden');
    assert.ok(err instanceof Error);
  });
});
