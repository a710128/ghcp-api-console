import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hashPassword, verifyPassword } from './password.js';

describe('hashPassword', () => {
  it('returns a non-empty passwordHash and salt', () => {
    const { passwordHash, salt } = hashPassword('mypassword');
    assert.equal(typeof passwordHash, 'string');
    assert.equal(typeof salt, 'string');
    assert.ok(passwordHash.length > 0);
    assert.ok(salt.length > 0);
  });

  it('produces a different salt on each call for the same password', () => {
    const first = hashPassword('same');
    const second = hashPassword('same');
    assert.notEqual(first.salt, second.salt);
    assert.notEqual(first.passwordHash, second.passwordHash);
  });
});

describe('verifyPassword', () => {
  it('returns true for the correct password (3-arg signature)', () => {
    const { passwordHash, salt } = hashPassword('mypassword');
    assert.equal(verifyPassword('mypassword', passwordHash, salt), true);
  });

  it('returns false for a wrong password', () => {
    const { passwordHash, salt } = hashPassword('mypassword');
    assert.equal(verifyPassword('wrongpassword', passwordHash, salt), false);
  });

  it('accepts exactly three arguments', () => {
    assert.equal(verifyPassword.length, 3);
  });
});
