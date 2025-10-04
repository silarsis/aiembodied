import keytar from 'keytar';
import type { SecretStore } from './secret-store.js';

export class KeytarSecretStore implements SecretStore {
  constructor(private readonly service: string) {}

  async getSecret(key: string): Promise<string | null> {
    return keytar.getPassword(this.service, key);
  }

  async setSecret(key: string, value: string): Promise<void> {
    await keytar.setPassword(this.service, key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    await keytar.deletePassword(this.service, key);
  }
}
