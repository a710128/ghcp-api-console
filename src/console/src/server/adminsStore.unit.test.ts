import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

interface AdminRecord {
  username: string;
  password_hash: string;
  salt: string;
  role: 'admin';
  enabled: boolean;
}

const TEMP_FILE = join(tmpdir(), `test-admins-${Date.now()}-${process.pid}.json`);

let isInitialized: () => boolean;
let setupAdmin: (username: string, password: string) => AdminRecord;
let verifyAdmin: (username: string, password: string) => AdminRecord | undefined;

before(async () => {
  // Set env BEFORE dynamic import so config.ts captures the temp path at load time.
  process.env['ADMINS_FILE'] = TEMP_FILE;
  const mod = await import(`./adminsStore.js?v=${Date.now()}`);
  isInitialized = mod.isInitialized;
  setupAdmin = mod.setupAdmin;
  verifyAdmin = mod.verifyAdmin;
});

after(() => {
  rmSync(TEMP_FILE, { force: true });
});

// Tests run in order and share the single temp file: setupAdmin creates it,
// later tests observe the initialized state. This is deterministic.
describe('adminsStore', () => {
  it('isInitialized returns false when no admins', () => {
    assert.strictEqual(isInitialized(), false);
  });

  it('setupAdmin creates admin record', () => {
    const record = setupAdmin('alice', 'pass1');
    assert.strictEqual(record.username, 'alice');
    assert.strictEqual(record.role, 'admin');
    assert.strictEqual(record.enabled, true);
    assert.ok(record.password_hash.length > 0);
    assert.ok(record.salt.length > 0);
  });

  it('isInitialized returns true after setup', () => {
    assert.strictEqual(isInitialized(), true);
  });

  it('setupAdmin throws if already initialized', () => {
    assert.throws(() => setupAdmin('bob', 'pass2'));
  });

  it('verifyAdmin returns AdminRecord for correct password', () => {
    const result = verifyAdmin('alice', 'pass1');
    assert.ok(result !== undefined);
    assert.strictEqual(result?.username, 'alice');
  });

  it('verifyAdmin returns undefined for wrong password', () => {
    const result = verifyAdmin('alice', 'wrong');
    assert.strictEqual(result, undefined);
  });

  it('verifyAdmin returns undefined for wrong username', () => {
    const result = verifyAdmin('nonexistent', 'pass1');
    assert.strictEqual(result, undefined);
  });
});
