import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encryptToken, decryptToken } from '../../src/mcp/encryption.js';
import { safeStorage } from 'electron';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(),
    encryptStringAsync: vi.fn(),
    decryptStringAsync: vi.fn(),
  },
}));

describe('Encryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('encryptToken', () => {
    it('encrypts token when encryption is available', async () => {
      vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
      vi.mocked(safeStorage.encryptStringAsync).mockResolvedValue(Buffer.from('encrypted-data'));

      const result = await encryptToken('my-secret-token');

      expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalled();
      expect(safeStorage.encryptStringAsync).toHaveBeenCalledWith('my-secret-token');
      // Result should be base64-encoded
      expect(result).toBe(Buffer.from('encrypted-data').toString('base64'));
    });

    it('throws error when encryption is not available', async () => {
      vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);

      await expect(encryptToken('my-secret-token')).rejects.toThrow(
        'Encryption not available on this platform',
      );
      expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalled();
      expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    });
  });

  describe('decryptToken', () => {
    it('decrypts token when encryption is available', async () => {
      vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
      vi.mocked(safeStorage.decryptStringAsync).mockResolvedValue({ shouldReEncrypt: false, result: 'decrypted-token' });

      // Input should be base64-encoded
      const encryptedBase64 = Buffer.from('encrypted-data').toString('base64');
      const result = await decryptToken(encryptedBase64);

      expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalled();
      expect(safeStorage.decryptStringAsync).toHaveBeenCalledWith(
        Buffer.from(encryptedBase64, 'base64'),
      );
      expect(result).toBe('decrypted-token');
    });

    it('throws error when encryption is not available', async () => {
      vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(false);

      await expect(decryptToken('encrypted')).rejects.toThrow(
        'Encryption not available on this platform',
      );
      expect(safeStorage.isAsyncEncryptionAvailable).toHaveBeenCalled();
      expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled();
    });
  });

  describe('round-trip encryption', () => {
    it('can encrypt and decrypt a token', async () => {
      const original = 'original-token';
      const encryptedBuffer = Buffer.from('encrypted-data');

      vi.mocked(safeStorage.isAsyncEncryptionAvailable).mockResolvedValue(true);
      vi.mocked(safeStorage.encryptStringAsync).mockResolvedValue(encryptedBuffer);
      vi.mocked(safeStorage.decryptStringAsync).mockResolvedValue({ shouldReEncrypt: false, result: original });

      const encrypted = await encryptToken(original);
      const decrypted = await decryptToken(encrypted);

      expect(safeStorage.encryptStringAsync).toHaveBeenCalledWith(original);
      expect(safeStorage.decryptStringAsync).toHaveBeenCalledWith(
        Buffer.from(encrypted, 'base64'),
      );
      expect(decrypted).toBe(original);
    });
  });
});
