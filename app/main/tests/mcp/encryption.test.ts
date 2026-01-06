import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encryptToken, decryptToken } from '../../src/mcp/encryption.js';
import { safeStorage } from 'electron';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

describe('Encryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('encryptToken', () => {
    it('encrypts token when encryption is available', () => {
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
      vi.mocked(safeStorage.encryptString).mockReturnValue(Buffer.from('encrypted-data'));

      const result = encryptToken('my-secret-token');

      expect(safeStorage.isEncryptionAvailable).toHaveBeenCalled();
      expect(safeStorage.encryptString).toHaveBeenCalledWith('my-secret-token');
      // Result should be base64-encoded
      expect(result).toBe(Buffer.from('encrypted-data').toString('base64'));
    });

    it('throws error when encryption is not available', () => {
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);

      expect(() => encryptToken('my-secret-token')).toThrow(
        'Encryption not available on this platform',
      );
      expect(safeStorage.isEncryptionAvailable).toHaveBeenCalled();
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
    });
  });

  describe('decryptToken', () => {
    it('decrypts token when encryption is available', () => {
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
      vi.mocked(safeStorage.decryptString).mockReturnValue('decrypted-token');

      // Input should be base64-encoded
      const encryptedBase64 = Buffer.from('encrypted-data').toString('base64');
      const result = decryptToken(encryptedBase64);

      expect(safeStorage.isEncryptionAvailable).toHaveBeenCalled();
      expect(safeStorage.decryptString).toHaveBeenCalledWith(
        Buffer.from(encryptedBase64, 'base64'),
      );
      expect(result).toBe('decrypted-token');
    });

    it('throws error when encryption is not available', () => {
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);

      expect(() => decryptToken('encrypted')).toThrow(
        'Encryption not available on this platform',
      );
      expect(safeStorage.isEncryptionAvailable).toHaveBeenCalled();
      expect(safeStorage.decryptString).not.toHaveBeenCalled();
    });
  });

  describe('round-trip encryption', () => {
    it('can encrypt and decrypt a token', () => {
      const original = 'original-token';
      const encryptedBuffer = Buffer.from('encrypted-data');

      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
      vi.mocked(safeStorage.encryptString).mockReturnValue(encryptedBuffer);
      vi.mocked(safeStorage.decryptString).mockReturnValue(original);

      const encrypted = encryptToken(original);
      const decrypted = decryptToken(encrypted);

      expect(safeStorage.encryptString).toHaveBeenCalledWith(original);
      expect(safeStorage.decryptString).toHaveBeenCalledWith(
        Buffer.from(encrypted, 'base64'),
      );
      expect(decrypted).toBe(original);
    });
  });
});
