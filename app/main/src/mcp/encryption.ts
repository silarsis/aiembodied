import { safeStorage } from 'electron';

/**
 * Encrypts a token using Electron's safeStorage API.
 * Returns base64-encoded encrypted data.
 *
 * @param token - The plain text token to encrypt
 * @returns Base64-encoded encrypted string
 * @throws Error if encryption is not available on the platform
 */
export function encryptToken(token: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available on this platform');
  }
  const buffer = safeStorage.encryptString(token);
  return buffer.toString('base64');
}

/**
 * Decrypts a token that was encrypted with encryptToken.
 *
 * @param encrypted - Base64-encoded encrypted string
 * @returns Decrypted plain text token
 * @throws Error if encryption is not available on the platform
 */
export function decryptToken(encrypted: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available on this platform');
  }
  const buffer = Buffer.from(encrypted, 'base64');
  return safeStorage.decryptString(buffer);
}
