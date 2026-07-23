import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, readdirSync, rmSync } from 'node:fs';

import { AccountLogger } from './accountLogger.js';

const logDir = join(tmpdir(), `test-accountLogger-${Date.now()}-${process.pid}`);

after(() => {
  rmSync(logDir, { recursive: true, force: true });
});

function readLoggedFile(logger: AccountLogger): string {
  return readFileSync(logger.path, 'utf8');
}

describe('AccountLogger redaction', () => {
  it('redacts secret fields and passes through non-secret fields', () => {
    const logger = AccountLogger.create(logDir, 'testAccount', false);
    logger.info('step', 'message', { password: 'secret123', name: 'alice' });
    const contents = readLoggedFile(logger);

    assert.equal(contents.includes('secret123'), false, 'secret value must not appear');
    assert.equal(contents.includes('<redacted>'), true, 'redaction placeholder must appear');
    assert.equal(contents.includes('name'), true, 'non-secret key must pass through');
    assert.equal(contents.includes('alice'), true, 'non-secret value must pass through');
  });

  it('writes the log file into a hashed bucket subdirectory of logDir', () => {
    const logger = AccountLogger.create(logDir, 'bucketAccount', false);
    assert.ok(logger.path.startsWith(logDir), 'log path is under the configured logDir');
    const contents = readLoggedFile(logger);
    assert.equal(contents.includes('Starting login task log'), true);
  });

  it('does not write debug lines when debug is disabled', () => {
    const logger = AccountLogger.create(logDir, 'debugOffAccount', false);
    logger.debug('dbg', 'should-not-appear', { detail: 'x' });
    const contents = readLoggedFile(logger);
    assert.equal(contents.includes('should-not-appear'), false);
  });

  it('writes debug lines when debug is enabled', () => {
    const logger = AccountLogger.create(logDir, 'debugOnAccount', true);
    logger.debug('dbg', 'debug-visible', { detail: 'x' });
    const contents = readLoggedFile(logger);
    assert.equal(contents.includes('debug-visible'), true);
  });

  it('redacts token/secret keys in warn/error output too', () => {
    const logger = AccountLogger.create(logDir, 'multiLevelAccount', false);
    logger.warn('warnStep', 'warn message', { token: 'abcdef' });
    logger.error('errStep', 'err message', { secret: 'topsecret', ok: 'plain' });
    const contents = readLoggedFile(logger);
    assert.equal(contents.includes('abcdef'), false);
    assert.equal(contents.includes('topsecret'), false);
    assert.equal(contents.includes('<redacted>'), true);
    assert.equal(contents.includes('plain'), true);
  });

  it('creates the log directory tree lazily', () => {
    // At least one bucket directory should exist after the loggers above ran.
    const entries = readdirSync(logDir);
    assert.ok(entries.length > 0, 'expected bucket subdirectories to be created');
  });
});
