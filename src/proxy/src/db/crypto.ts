/**
 * AES-256-GCM encryption/decryption for proxy account credentials.
 * Uses DATA_ENCRYPTION_KEY from the database config.
 *
 * Format: base64(nonce:12bytes || ciphertext || tag:16bytes)
 * AAD (authenticated additional data) is encoded as:
 *   "identity:<identity>\x00credential:<credentialType>\x00version:<payloadVersion>"
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptedPayload {
  cipher: string; // base64-encoded ciphertext + tag
  nonce: string;  // hex-encoded 12-byte nonce
}

/**
 * Build canonical AAD (Additional Authenticated Data) for a credential encryption context.
 * AAD is not secret but must be identical on encrypt and decrypt.
 */
export function buildAad(identity: string, credentialType: string, payloadVersion = '1'): Buffer {
  return Buffer.from(`identity:${identity}\x00credential:${credentialType}\x00version:${payloadVersion}`, 'utf8');
}

/**
 * Encrypt plaintext with AES-256-GCM using the given key and AAD.
 * Returns separate nonce (hex) and cipher (base64: ciphertext+tag) fields.
 */
export function encryptCredential(
  plaintext: string,
  key: Buffer,
  aad: Buffer,
): EncryptedPayload {
  if (key.length !== 32) throw new Error('Encryption key must be exactly 32 bytes.');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const cipherWithTag = Buffer.concat([encrypted, tag]);
  return {
    cipher: cipherWithTag.toString('base64'),
    nonce: nonce.toString('hex'),
  };
}

/**
 * Decrypt a credential payload. Throws on authentication failure (wrong key or tampered data).
 */
export function decryptCredential(
  payload: EncryptedPayload,
  key: Buffer,
  aad: Buffer,
): string {
  if (key.length !== 32) throw new Error('Encryption key must be exactly 32 bytes.');
  const nonce = Buffer.from(payload.nonce, 'hex');
  const cipherWithTag = Buffer.from(payload.cipher, 'base64');
  const ciphertext = cipherWithTag.subarray(0, cipherWithTag.length - TAG_BYTES);
  const tag = cipherWithTag.subarray(cipherWithTag.length - TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
