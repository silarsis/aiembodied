import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { encryptToken, decryptToken } from '../encryption.js';

/** Port of the loopback page the browser returns to. Fixed, because a dynamically registered client is reused. */
export const DEFAULT_OAUTH_CALLBACK_PORT = 8797;
export const OAUTH_CALLBACK_PATH = '/mcp/oauth/callback';
/** How long we wait for the person to finish signing in. */
export const OAUTH_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

/** The port to use: MCP_OAUTH_CALLBACK_PORT if it is a valid port number, else the default. */
export function resolveCallbackPort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.MCP_OAUTH_CALLBACK_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_OAUTH_CALLBACK_PORT;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Keeps OAuth data per MCP server in the `mcp_oauth` table (migration 10).
 * Every column holds JSON that was encrypted with Electron safeStorage (see encryption.ts),
 * so a copy of the database file does not reveal tokens.
 */
export class McpOAuthStore {
  constructor(private db: Database) {}

  async getClientInformation(serverId: string): Promise<OAuthClientInformationMixed | undefined> {
    return await this.read<OAuthClientInformationMixed>(serverId, 'client_info_encrypted');
  }

  async saveClientInformation(serverId: string, info: OAuthClientInformationMixed): Promise<void> {
    await this.write(serverId, 'client_info_encrypted', info);
  }

  async getTokens(serverId: string): Promise<OAuthTokens | undefined> {
    return await this.read<OAuthTokens>(serverId, 'tokens_encrypted');
  }

  async saveTokens(serverId: string, tokens: OAuthTokens): Promise<void> {
    await this.write(serverId, 'tokens_encrypted', tokens);
  }

  async getCodeVerifier(serverId: string): Promise<string | undefined> {
    return await this.read<string>(serverId, 'code_verifier_encrypted');
  }

  async saveCodeVerifier(serverId: string, verifier: string): Promise<void> {
    await this.write(serverId, 'code_verifier_encrypted', verifier);
  }

  /** Forget the tokens and the verifier but keep the client registration (so sign-in need not register again). */
  clearTokens(serverId: string): void {
    this.db
      .prepare(
        'UPDATE mcp_oauth SET tokens_encrypted = NULL, code_verifier_encrypted = NULL, updated_at = ? WHERE server_id = ?',
      )
      .run(Date.now(), serverId);
  }

  /** Forget the client registration only (the server no longer knows it). */
  clearClientInformation(serverId: string): void {
    this.db
      .prepare(
        'UPDATE mcp_oauth SET client_info_encrypted = NULL, updated_at = ? WHERE server_id = ?',
      )
      .run(Date.now(), serverId);
  }

  /** Forget the PKCE verifier of an unfinished sign-in. */
  clearCodeVerifier(serverId: string): void {
    this.db
      .prepare(
        'UPDATE mcp_oauth SET code_verifier_encrypted = NULL, updated_at = ? WHERE server_id = ?',
      )
      .run(Date.now(), serverId);
  }

  /** Forget the client registration too. */
  clearAll(serverId: string): void {
    this.db.prepare('DELETE FROM mcp_oauth WHERE server_id = ?').run(serverId);
  }

  private async read<T>(serverId: string, column: string): Promise<T | undefined> {
    const row = this.db
      .prepare(`SELECT ${column} AS value FROM mcp_oauth WHERE server_id = ?`)
      .get(serverId) as { value: string | null } | undefined;
    if (!row?.value) return undefined;
    try {
      return JSON.parse(await decryptToken(row.value)) as T;
    } catch (error) {
      console.error(`Failed to read MCP OAuth ${column}:`, error);
      return undefined;
    }
  }

  private async write(serverId: string, column: string, value: unknown): Promise<void> {
    const encrypted = await encryptToken(JSON.stringify(value));
    // Make sure the row exists, then set one column. `column` is one of our own constants, never user input.
    this.db
      .prepare('INSERT OR IGNORE INTO mcp_oauth (server_id, updated_at) VALUES (?, ?)')
      .run(serverId, Date.now());
    this.db
      .prepare(`UPDATE mcp_oauth SET ${column} = ?, updated_at = ? WHERE server_id = ?`)
      .run(encrypted, Date.now(), serverId);
  }
}

// ---------------------------------------------------------------------------
// Loopback listener
// ---------------------------------------------------------------------------

// Connection: close so the listener can shut down right after answering.
const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' };

function page(title: string, message: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;text-align:center">` +
    `<h2>${title}</h2><p>${message}</p></body></html>`
  );
}

/**
 * A tiny web server on 127.0.0.1 that waits for the browser to come back with `?code=...&state=...`.
 * It only runs during a sign-in: start() opens it, waitForCode() resolves with the code, stop() closes it.
 */
export class OAuthCallbackListener {
  private server: Server | null = null;
  private expectedState: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private resolveCode!: (code: string) => void;
  private rejectCode!: (error: Error) => void;
  private codePromise: Promise<string>;

  constructor(
    private port: number,
    private timeoutMs: number = OAUTH_SIGN_IN_TIMEOUT_MS,
  ) {
    this.codePromise = new Promise<string>((resolve, reject) => {
      this.resolveCode = resolve;
      this.rejectCode = reject;
    });
    // If nobody is waiting yet when it fails, do not report an unhandled rejection.
    this.codePromise.catch(() => undefined);
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}${OAUTH_CALLBACK_PATH}`;
  }

  /** The `state` we must see in the callback. Set when the sign-in URL is made. */
  setExpectedState(state: string): void {
    this.expectedState = state;
  }

  /** Start listening. Rejects with a friendly message if the port is taken. */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req.url ?? '', res));
      server.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          reject(
            new Error(
              `Sign-in port ${this.port} is already in use. Close the other sign-in or set MCP_OAUTH_CALLBACK_PORT.`,
            ),
          );
        } else {
          reject(error);
        }
      });
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server;
        this.timer = setTimeout(() => {
          this.rejectCode(new Error('Sign-in timed out. Press Sign in to try again.'));
          void this.stop();
        }, this.timeoutMs);
        // Do not keep the app alive just for this timer.
        this.timer.unref?.();
        resolve();
      });
    });
  }

  waitForCode(): Promise<string> {
    return this.codePromise;
  }

  /** Close the listener and the timer. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // If the code never came, anyone still waiting gets an answer.
    this.rejectCode(new Error('Sign-in was cancelled.'));
  }

  private handle(url: string, res: import('node:http').ServerResponse): void {
    const parsed = new URL(url, 'http://127.0.0.1');
    if (parsed.pathname !== OAUTH_CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain', Connection: 'close' }).end('Not found');
      return;
    }
    const state = parsed.searchParams.get('state');
    if (!this.expectedState || state !== this.expectedState) {
      // Not our sign-in (or a stray request): ignore it and keep waiting.
      res
        .writeHead(400, HTML_HEADERS)
        .end(
          page('Sign-in failed', 'This sign-in link did not match. Please try again from the app.'),
        );
      return;
    }
    const error = parsed.searchParams.get('error');
    const code = parsed.searchParams.get('code');
    if (error || !code) {
      res
        .writeHead(400, HTML_HEADERS)
        .end(page('Sign-in failed', 'The sign-in was not completed. You can close this tab.'));
      this.rejectCode(
        new Error(error ? `Sign-in was refused: ${error}` : 'Sign-in did not return a code.'),
      );
      void this.stop();
      return;
    }
    res
      .writeHead(200, HTML_HEADERS)
      .end(page('You are signed in', 'You can close this tab and go back to the app.'));
    this.resolveCode(code);
    void this.stop();
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface McpOAuthProviderOptions {
  db: Database;
  serverId: string;
  /** Scope to ask for, e.g. 'papers:read'. */
  scope?: string;
  /** Opens a URL in the system browser (Electron shell.openExternal). Injected so tests can stub it. */
  openExternal: (url: string) => Promise<void>;
  callbackPort?: number;
  timeoutMs?: number;
}

/**
 * Plugs one MCP server into the SDK's OAuth flow (authorization code + PKCE, dynamic client registration).
 * The SDK calls these methods; we keep the data in SQLite and open the browser.
 *
 * The browser is only opened between beginSignIn() and endSignIn(). At any other time (for example
 * auto-start at launch) redirectToAuthorization does nothing, and the SDK still reports UnauthorizedError,
 * which the manager turns into "Sign-in needed".
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private store: McpOAuthStore;
  private port: number;
  private listener: OAuthCallbackListener | null = null;

  constructor(private options: McpOAuthProviderOptions) {
    this.store = new McpOAuthStore(options.db);
    this.port = options.callbackPort ?? resolveCallbackPort();
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}${OAUTH_CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    const metadata: OAuthClientMetadata = {
      client_name: 'AIEmbodied',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
    if (this.options.scope) metadata.scope = this.options.scope;
    return metadata;
  }

  /** A fresh random value per sign-in; the callback must bring it back unchanged. */
  state(): string {
    const state = randomBytes(16).toString('hex');
    this.listener?.setExpectedState(state);
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const info = await this.store.getClientInformation(this.options.serverId);
    // A registration made for another callback port (MCP_OAUTH_CALLBACK_PORT changed) would be
    // refused by the server, so register again instead.
    const uris = (info as { redirect_uris?: unknown } | undefined)?.redirect_uris;
    if (Array.isArray(uris) && !uris.includes(this.redirectUrl)) return undefined;
    return info;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.store.saveClientInformation(this.options.serverId, info);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return await this.store.getTokens(this.options.serverId);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.saveTokens(this.options.serverId, tokens);
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.store.saveCodeVerifier(this.options.serverId, verifier);
  }

  async codeVerifier(): Promise<string> {
    const verifier = await this.store.getCodeVerifier(this.options.serverId);
    if (!verifier) throw new Error('No saved sign-in verifier. Start the sign-in again.');
    return verifier;
  }

  /** The SDK asks us to forget something the server rejected. */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') this.store.clearAll(this.options.serverId);
    else if (scope === 'client') this.store.clearClientInformation(this.options.serverId);
    else if (scope === 'tokens') this.store.clearTokens(this.options.serverId);
    else if (scope === 'verifier') this.store.clearCodeVerifier(this.options.serverId);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // No listener means nobody is signing in right now: never open a browser unprompted.
    if (!this.listener) return;
    await this.options.openExternal(authorizationUrl.toString());
  }

  /** Start the callback listener. Call before connecting for a sign-in. */
  async beginSignIn(): Promise<void> {
    const listener = new OAuthCallbackListener(this.port, this.options.timeoutMs);
    await listener.start();
    this.listener = listener;
  }

  /** Resolves with the authorization code once the browser comes back. */
  waitForCode(): Promise<string> {
    if (!this.listener) return Promise.reject(new Error('Sign-in has not been started.'));
    return this.listener.waitForCode();
  }

  /** Stop the listener (the code, if any, has been read). */
  async endSignIn(): Promise<void> {
    const listener = this.listener;
    this.listener = null;
    await listener?.stop();
  }

  /** Sign out: forget the tokens but keep the client registration. */
  clearTokens(): void {
    this.store.clearTokens(this.options.serverId);
  }
}
