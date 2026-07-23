import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { buildAad, encryptCredential, decryptCredential } from './crypto.js';

describe('crypto.buildAad', () => {
  it('returns a canonical Buffer with \\x00 separators', () => {
    const aad = buildAad('alice', 'github', '1');
    assert.ok(Buffer.isBuffer(aad));
    assert.equal(aad.toString('utf8'), 'identity:alice\x00credential:github\x00version:1');
  });

  it('defaults payloadVersion to "1"', () => {
    const aad = buildAad('bob', 'copilot');
    assert.equal(aad.toString('utf8'), 'identity:bob\x00credential:copilot\x00version:1');
  });

  it('embeds the given values into the canonical string', () => {
    const aad = buildAad('carol', 'gh-token', '2');
    const text = aad.toString('utf8');
    assert.ok(text.includes('identity:carol'));
    assert.ok(text.includes('credential:gh-token'));
    assert.ok(text.includes('version:2'));
    assert.equal(text.split('\x00').length, 3);
  });
});

describe('crypto encrypt/decrypt round-trip', () => {
  it('decrypts back to the original plaintext', () => {
    const key = randomBytes(32);
    const aad = buildAad('alice', 'github');
    const plaintext = 'ghp_super_secret_token_value';

    const payload = encryptCredential(plaintext, key, aad);
    assert.equal(typeof payload.cipher, 'string');
    assert.equal(typeof payload.nonce, 'string');
    assert.notEqual(payload.cipher, plaintext);

    const decrypted = decryptCredential(payload, key, aad);
    assert.equal(decrypted, plaintext);
  });

  it('round-trips unicode plaintext', () => {
    const key = randomBytes(32);
    const aad = buildAad('user', 'cred');
    const plaintext = '密码-🔐-secret';

    const payload = encryptCredential(plaintext, key, aad);
    assert.equal(decryptCredential(payload, key, aad), plaintext);
  });

  it('uses a 12-byte (24 hex chars) nonce', () => {
    const key = randomBytes(32);
    const aad = buildAad('user', 'cred');
    const payload = encryptCredential('data', key, aad);
    assert.equal(payload.nonce.length, 24);
  });
});

describe('crypto encrypt key-length validation', () => {
  it('throws when encrypt key is 16 bytes', () => {
    const key = randomBytes(16);
    const aad = buildAad('alice', 'github');
    assert.throws(() => encryptCredential('secret', key, aad), /32 bytes/);
  });

  it('throws when decrypt key is not 32 bytes', () => {
    const key = randomBytes(16);
    const aad = buildAad('alice', 'github');
    assert.throws(() => decryptCredential({ cipher: 'AA==', nonce: '00'.repeat(12) }, key, aad), /32 bytes/);
  });
});

describe('crypto authentication failures', () => {
  it('throws when cipher bytes are tampered', () => {
    const key = randomBytes(32);
    const aad = buildAad('alice', 'github');
    const payload = encryptCredential('secret-value', key, aad);

    const cipherBytes = Buffer.from(payload.cipher, 'base64');
    cipherBytes[0] ^= 0xff;
    const tampered = { cipher: cipherBytes.toString('base64'), nonce: payload.nonce };

    assert.throws(() => decryptCredential(tampered, key, aad));
  });

  it('throws when decrypting with the wrong key', () => {
    const key = randomBytes(32);
    const wrongKey = randomBytes(32);
    const aad = buildAad('alice', 'github');
    const payload = encryptCredential('secret-value', key, aad);

    assert.throws(() => decryptCredential(payload, wrongKey, aad));
  });

  it('throws when decrypting with the wrong AAD', () => {
    const key = randomBytes(32);
    const aad = buildAad('alice', 'github');
    const wrongAad = buildAad('mallory', 'github');
    const payload = encryptCredential('secret-value', key, aad);

    assert.throws(() => decryptCredential(payload, key, wrongAad));
  });
});
