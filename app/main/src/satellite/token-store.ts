/**
 * Where a satellite keeps its device token: the system keychain (keytar), service `aiembodied-room-link`,
 * account = the hub URL. If the keychain cannot be used (a Linux box with no secret service), the token is
 * kept in memory for this run only and `lastError` says so, so the pairing is lost when the app closes
 * rather than the token being written to a plain file.
 */
export const TOKEN_SERVICE = 'aiembodied-room-link';

export interface TokenStore {
  get(hubUrl: string): Promise<string | null>;
  set(hubUrl: string, token: string): Promise<void>;
  delete(hubUrl: string): Promise<void>;
  /** Why the keychain was not used, when it was not. */
  readonly lastError: string | null;
}

export interface KeychainLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

export class KeychainTokenStore implements TokenStore {
  private readonly memory = new Map<string, string>();
  lastError: string | null = null;

  /** `load` imports keytar on first use, so a PC without it still starts. */
  constructor(private readonly load: () => Promise<KeychainLike>) {}

  async get(hubUrl: string): Promise<string | null> {
    try {
      const keychain = await this.load();
      return (await keychain.getPassword(TOKEN_SERVICE, hubUrl)) ?? this.memory.get(hubUrl) ?? null;
    } catch (error) {
      this.lastError = describe(error);
      return this.memory.get(hubUrl) ?? null;
    }
  }

  async set(hubUrl: string, token: string): Promise<void> {
    try {
      const keychain = await this.load();
      await keychain.setPassword(TOKEN_SERVICE, hubUrl, token);
      this.lastError = null;
      this.memory.delete(hubUrl);
    } catch (error) {
      this.lastError = describe(error);
      this.memory.set(hubUrl, token);
    }
  }

  async delete(hubUrl: string): Promise<void> {
    this.memory.delete(hubUrl);
    try {
      await (await this.load()).deletePassword(TOKEN_SERVICE, hubUrl);
    } catch (error) {
      this.lastError = describe(error);
    }
  }
}

function describe(error: unknown): string {
  return `The system keychain is not available (${error instanceof Error ? error.message : String(error)}). The pairing will be forgotten when the app closes.`;
}

/** A store that keeps tokens in memory only (tests, and `AIEMBODIED_TOKEN_STORE=memory`). */
export class MemoryTokenStore implements TokenStore {
  readonly lastError: string | null = null;
  private readonly tokens = new Map<string, string>();
  async get(hubUrl: string): Promise<string | null> {
    return this.tokens.get(hubUrl) ?? null;
  }
  async set(hubUrl: string, token: string): Promise<void> {
    this.tokens.set(hubUrl, token);
  }
  async delete(hubUrl: string): Promise<void> {
    this.tokens.delete(hubUrl);
  }
}
