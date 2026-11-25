import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import {
  McpOAuthProvider,
  McpOAuthStore,
  OAuthCallbackListener,
  DEFAULT_OAUTH_CALLBACK_PORT,
  resolveCallbackPort,
} from '../../src/mcp/clients/oauth-provider.js';

// safeStorage mocked like encryption.test.ts does: "encryption" is a visible prefix, so the tests can check it happened.
vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async (text: string) => Buffer.from(`enc:${text}`)),
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({ shouldReEncrypt: false, result: buffer.toString().replace(/^enc:/, '') })),
  },
}));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

describe('MCP OAuth', () => {
  let db: Database;
  let dir: string;
  let port: number;
  const openExternal = vi.fn();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-oauth-test-'));
    db = new DatabaseConstructor(join(dir, 'test.db'));
    db.exec(`CREATE TABLE mcp_oauth (
      server_id TEXT PRIMARY KEY, client_info_encrypted TEXT, tokens_encrypted TEXT,
      code_verifier_encrypted TEXT, updated_at INTEGER NOT NULL
    );`);
    port = await freePort();
    openExternal.mockReset();
    openExternal.mockResolvedValue(undefined);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeProvider = (extra: Partial<ConstructorParameters<typeof McpOAuthProvider>[0]> = {}) =>
    new McpOAuthProvider({ db, serverId: 's1', openExternal, callbackPort: port, ...extra });

  describe('storage', () => {
    it('round-trips client information, tokens and verifier, encrypted at rest', async () => {
      const provider = makeProvider();
      await provider.saveClientInformation({ client_id: 'cid', redirect_uris: [`http://127.0.0.1:${port}/mcp/oauth/callback`] } as any);
      await provider.saveTokens({ access_token: 'secret-access', refresh_token: 'secret-refresh', token_type: 'Bearer' });
      await provider.saveCodeVerifier('verifier-123');

      expect(await provider.clientInformation()).toMatchObject({ client_id: 'cid' });
      expect(await provider.tokens()).toEqual({ access_token: 'secret-access', refresh_token: 'secret-refresh', token_type: 'Bearer' });
      expect(await provider.codeVerifier()).toBe('verifier-123');

      // What is on disk is not plain text.
      const row = db.prepare('SELECT * FROM mcp_oauth WHERE server_id = ?').get('s1') as Record<string, string>;
      expect(JSON.stringify(row)).not.toContain('secret-access');
      expect(row.tokens_encrypted).toBe(Buffer.from('enc:' + JSON.stringify(await provider.tokens())).toString('base64'));
    });

    it('keeps servers apart and returns undefined when nothing is saved', async () => {
      await makeProvider().saveTokens({ access_token: 'a', token_type: 'Bearer' });
      const other = new McpOAuthProvider({ db, serverId: 's2', openExternal, callbackPort: port });
      expect(await other.tokens()).toBeUndefined();
      expect(await other.clientInformation()).toBeUndefined();
      await expect(other.codeVerifier()).rejects.toThrow(/verifier/);
    });

    it('clearTokens keeps the client registration; clearAll removes everything', async () => {
      const provider = makeProvider();
      await provider.saveClientInformation({ client_id: 'cid' } as any);
      await provider.saveTokens({ access_token: 'a', token_type: 'Bearer' });
      provider.clearTokens();
      expect(await provider.tokens()).toBeUndefined();
      expect(await provider.clientInformation()).toMatchObject({ client_id: 'cid' });

      new McpOAuthStore(db).clearAll('s1');
      expect(await provider.clientInformation()).toBeUndefined();
    });

    it('invalidateCredentials follows the SDK scopes', async () => {
      const provider = makeProvider();
      await provider.saveClientInformation({ client_id: 'cid' } as any);
      await provider.saveTokens({ access_token: 'a', token_type: 'Bearer' });
      provider.invalidateCredentials('tokens');
      expect(await provider.tokens()).toBeUndefined();
      expect(await provider.clientInformation()).toBeDefined();
      provider.invalidateCredentials('client');
      expect(await provider.clientInformation()).toBeUndefined();
      await provider.saveClientInformation({ client_id: 'cid' } as any);
      await provider.saveCodeVerifier('v');
      provider.invalidateCredentials('verifier');
      await expect(provider.codeVerifier()).rejects.toThrow(/verifier/);
      expect(await provider.clientInformation()).toBeDefined();
      provider.invalidateCredentials('all');
      expect(await provider.clientInformation()).toBeUndefined();
    });

    it('registers again when the saved client was made for another callback port', async () => {
      const provider = makeProvider();
      await provider.saveClientInformation({ client_id: 'old', redirect_uris: ['http://127.0.0.1:1/mcp/oauth/callback'] } as any);
      expect(await provider.clientInformation()).toBeUndefined();
      await provider.saveClientInformation({ client_id: 'new', redirect_uris: [provider.redirectUrl] } as any);
      expect(await provider.clientInformation()).toMatchObject({ client_id: 'new' });
    });
  });

  describe('client metadata', () => {
    it('describes a public PKCE client with the scope', () => {
      const metadata = makeProvider({ scope: 'papers:read' }).clientMetadata;
      expect(metadata).toEqual({
        client_name: 'AIEmbodied',
        redirect_uris: [`http://127.0.0.1:${port}/mcp/oauth/callback`],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'papers:read',
      });
    });

    it('leaves the scope out when none is configured', () => {
      expect(makeProvider().clientMetadata).not.toHaveProperty('scope');
    });

    it('uses a fixed default port, overridable by MCP_OAUTH_CALLBACK_PORT', () => {
      expect(resolveCallbackPort({})).toBe(DEFAULT_OAUTH_CALLBACK_PORT);
      expect(DEFAULT_OAUTH_CALLBACK_PORT).toBe(8797);
      expect(resolveCallbackPort({ MCP_OAUTH_CALLBACK_PORT: '9001' } as any)).toBe(9001);
      expect(resolveCallbackPort({ MCP_OAUTH_CALLBACK_PORT: 'junk' } as any)).toBe(8797);
    });
  });

  describe('browser and callback', () => {
    it('does not open the browser when no sign-in is in progress', async () => {
      await makeProvider().redirectToAuthorization(new URL('https://auth.example/authorize'));
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('opens the browser during a sign-in and resolves with the code when the state matches', async () => {
      const provider = makeProvider();
      await provider.beginSignIn();
      const state = provider.state();
      await provider.redirectToAuthorization(new URL('https://auth.example/authorize?x=1'));
      expect(openExternal).toHaveBeenCalledWith('https://auth.example/authorize?x=1');

      const wait = provider.waitForCode();
      const response = await fetch(`http://127.0.0.1:${port}/mcp/oauth/callback?code=abc&state=${state}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('You can close this tab');
      await expect(wait).resolves.toBe('abc');

      // The listener has shut down again.
      await provider.endSignIn();
      await expect(fetch(`http://127.0.0.1:${port}/mcp/oauth/callback`)).rejects.toThrow();
    });

    it('ignores a callback with the wrong state and keeps waiting', async () => {
      const provider = makeProvider();
      await provider.beginSignIn();
      const state = provider.state();
      const wait = provider.waitForCode();

      const bad = await fetch(`http://127.0.0.1:${port}/mcp/oauth/callback?code=evil&state=wrong`);
      expect(bad.status).toBe(400);

      const good = await fetch(`http://127.0.0.1:${port}/mcp/oauth/callback?code=real&state=${state}`);
      expect(good.status).toBe(200);
      await expect(wait).resolves.toBe('real');
      await provider.endSignIn();
    });

    it('rejects when the server answers with an error', async () => {
      const provider = makeProvider();
      await provider.beginSignIn();
      const state = provider.state();
      const wait = provider.waitForCode();
      const assertion = expect(wait).rejects.toThrow(/access_denied/);
      await fetch(`http://127.0.0.1:${port}/mcp/oauth/callback?error=access_denied&state=${state}`);
      await assertion;
      await provider.endSignIn();
    });

    it('times out', async () => {
      const provider = makeProvider({ timeoutMs: 30 });
      await provider.beginSignIn();
      await expect(provider.waitForCode()).rejects.toThrow(/timed out/);
      await provider.endSignIn();
    });

    it('says so when the port is already in use', async () => {
      const first = new OAuthCallbackListener(port);
      await first.start();
      const second = new OAuthCallbackListener(port);
      await expect(second.start()).rejects.toThrow(/already in use/);
      await first.stop();
    });

    it('answers 404 for other paths', async () => {
      const provider = makeProvider();
      await provider.beginSignIn();
      const response = await fetch(`http://127.0.0.1:${port}/other`);
      expect(response.status).toBe(404);
      await provider.endSignIn();
    });
  });
});
