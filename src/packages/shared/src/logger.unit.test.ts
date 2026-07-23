import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loggerFor, errorFields } from './logger.js';

describe('loggerFor', () => {
  it('returns an object with info, warn, error, and debug methods', () => {
    const logger = loggerFor('svc', 'my-scope');
    assert.equal(typeof logger.info, 'function');
    assert.equal(typeof logger.warn, 'function');
    assert.equal(typeof logger.error, 'function');
    assert.equal(typeof logger.debug, 'function');
  });
});

describe('errorFields', () => {
  it('returns only { error } from an Error instance', () => {
    const result = errorFields(new Error('test message'));
    assert.deepEqual(result, { error: 'test message' });
    assert.equal('message' in result, false);
    assert.equal('stack' in result, false);
  });

  it('returns only { error } from a string', () => {
    assert.deepEqual(errorFields('some string'), { error: 'some string' });
  });
});

describe('log level filtering', () => {
  it('suppresses below-min-level output but emits at or above', () => {
    const original = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    const captured: { method: string; line: string }[] = [];
    console.log = (line: string) => captured.push({ method: 'log', line });
    console.info = (line: string) => captured.push({ method: 'info', line });
    console.warn = (line: string) => captured.push({ method: 'warn', line });
    console.error = (line: string) => captured.push({ method: 'error', line });

    try {
      const logger = loggerFor('svc', 'scope', 'warn');
      logger.info('evt', 'info message');
      logger.warn('evt', 'warn message');
    } finally {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    }

    const infoEmitted = captured.some((c) => c.line.includes('info message'));
    const warnEmitted = captured.some((c) => c.line.includes('warn message'));
    assert.equal(infoEmitted, false, 'info should be filtered out at LOG_LEVEL=warn');
    assert.equal(warnEmitted, true, 'warn should be emitted at LOG_LEVEL=warn');
  });
});
