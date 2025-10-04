export interface SecretStore {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  private store = new Map<string, string>();

  async getSecret(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async deleteSecret(key: string): Promise<void> {
    this.store.delete(key);
  }
}
