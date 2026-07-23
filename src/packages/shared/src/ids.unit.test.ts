import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newRequestId, newTaskId, newBatchId } from './ids.js';

describe('newRequestId', () => {
  it('returns a non-empty string', () => {
    const id = newRequestId();
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
  });

  it('returns unique values on successive calls', () => {
    assert.notEqual(newRequestId(), newRequestId());
  });
});

describe('newTaskId', () => {
  it('returns a non-empty string', () => {
    const id = newTaskId();
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
  });

  it('returns unique values on successive calls', () => {
    assert.notEqual(newTaskId(), newTaskId());
  });
});

describe('newBatchId', () => {
  it('returns a non-empty string', () => {
    const id = newBatchId();
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
  });

  it('returns unique values on successive calls', () => {
    assert.notEqual(newBatchId(), newBatchId());
  });
});
