import { safeStorage } from 'electron';

/**
 * Encrypts a token using Electron's safeStorage async API.
 * Returns base64-encoded encrypted data.
 *
 * @param token - The plain text token to encrypt
 * @returns Base64-encoded encrypted string
 * @throws Error if encryption is not available on the platform
 */
export async function encryptToken(token: string): Promise<string> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error('Encryption not available on this platform');
  }
  const buffer = await safeStorage.encryptStringAsync(token);
  return buffer.toString('base64');
}

/**
 * Decrypts a token that was encrypted with encryptToken (data written by the older sync safeStorage API is compatible).
 *
 * decryptStringAsync also reports `shouldReEncrypt` (the data was protected with an outdated key or scheme).
 * We ignore it and return only the text; stored values stay readable and are re-encrypted whenever they are next saved.
 *
 * @param encrypted - Base64-encoded encrypted string
 * @returns Decrypted plain text token
 * @throws Error if encryption is not available on the platform
 */
export async function decryptToken(encrypted: string): Promise<string> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error('Encryption not available on this platform');
  }
  const buffer = Buffer.from(encrypted, 'base64');
  const { result } = await safeStorage.decryptStringAsync(buffer);
  return result;
}
