import { describe, expect, it, vi } from 'vitest';
import { builtInServers, defaultRoutes, resolveModelRouting, type StoredModels } from '../src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';
import type { CodingConfig } from '../src/coding/config.js';
import { RunnerError } from '../src/coding/runner-client.js';
import { buildCodingSyncPayload, CodingSync } from '../src/coding/sync.js';

const routing = (stored: StoredModels = {}) =>
  resolveModelRouting(builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), stored);

const coding: CodingConfig = {
  runner: 'local-coder-runner',
  workspaces: [{ id: 'aiembodied', name: 'aiembodied', path: '/src/aiembodied', kind: 'self', baseBranch: 'main', checks: 'pnpm test' }],
};
const keys: Record<string, string> = { openai: 'sk-openai', anthropic: 'sk-ant', github: 'ghp_x' };
const keyFor = (id: string) => keys[id];

describe('buildCodingSyncPayload', () => {
  it('uses the local coder server for the local model and as the default', () => {
    const payload = buildCodingSyncPayload(routing(), coding, keyFor);
    expect(payload.settings).toEqual({
      local_llm_url: 'http://127.0.0.1:1236/v1',
      local_model: 'qwen3-coder-next',
      default_model: { provider: 'local', id: 'qwen3-coder-next' },
    });
    expect(payload.keys).toEqual({ openai: 'sk-openai', anthropic: 'sk-ant', github: 'ghp_x' });
    expect(payload.workspaces).toHaveLength(1);
    expect(payload.workspaces[0]).toMatchObject({ id: 'aiembodied', kind: 'self', base_branch: 'main', checks: 'pnpm test' });
  });

  it('follows another chat server, OpenAI and Anthropic', () => {
    const chat = buildCodingSyncPayload(
      routing({ servers: [{ id: 'rack', type: 'chat', url: 'http://rack:8000/v1' }], routes: { coding: { server: 'rack', model: 'big-coder' } } }),
      coding,
      keyFor,
    );
    expect(chat.settings).toEqual({ local_llm_url: 'http://rack:8000/v1', local_model: 'big-coder', default_model: { provider: 'local', id: 'big-coder' } });
    const openai = buildCodingSyncPayload(routing({ routes: { coding: { server: 'openai', model: 'gpt-5' } } }), coding, keyFor);
    expect(openai.settings?.default_model).toEqual({ provider: 'openai', id: 'gpt-5' });
    expect(openai.settings?.local_llm_url).toBe('http://127.0.0.1:1236/v1');
    const anthropic = buildCodingSyncPayload(routing({ routes: { coding: { server: 'anthropic', model: 'claude-sonnet-4-5' } } }), coding, keyFor);
    expect(anthropic.settings?.default_model).toEqual({ provider: 'anthropic', id: 'claude-sonnet-4-5' });
  });

  it('sends null for a missing key so the runner forgets it, and no settings when a hosted model has none picked', () => {
    const payload = buildCodingSyncPayload(routing({ routes: { coding: { server: 'openai' } } }), coding, (id) => (id === 'github' ? '  ' : undefined));
    expect(payload.keys).toEqual({ openai: null, anthropic: null, github: null });
    expect(payload.settings).toBeUndefined();
  });
});

function setup(overrides: Partial<Record<'putSettings' | 'putWorkspaces' | 'putKeys' | 'getKeys', ReturnType<typeof vi.fn>>> = {}) {
  const client = {
    putSettings: vi.fn(async () => ({})),
    putWorkspaces: vi.fn(async () => []),
    putKeys: vi.fn(async () => undefined),
    getKeys: vi.fn(async () => ({ openai: true, anthropic: true, github: true })),
    ...overrides,
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const sync = new CodingSync({ client: client as never, logger, retryMs: 5, checkMs: 1_000_000 });
  return { client, logger, sync };
}

describe('CodingSync', () => {
  const payload = () => buildCodingSyncPayload(routing(), coding, keyFor);

  it('sends everything once, and nothing when it is repeated', async () => {
    const { client, sync } = setup();
    await sync.apply(payload());
    await sync.apply(payload());
    expect(client.putSettings).toHaveBeenCalledTimes(1);
    expect(client.putWorkspaces).toHaveBeenCalledTimes(1);
    expect(client.putKeys).toHaveBeenCalledWith({ openai: 'sk-openai', anthropic: 'sk-ant', github: 'ghp_x' });
    sync.stop();
  });

  it('never logs a key', async () => {
    const { logger, sync } = setup({ putKeys: vi.fn(async () => Promise.reject(new RunnerError('boom', 500))) });
    await sync.apply(payload());
    sync.stop();
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(logged).not.toContain('sk-openai');
    expect(logged).not.toContain('ghp_x');
  });

  it('sends again after a change, and only the part that changed', async () => {
    const { client, sync } = setup();
    await sync.apply(payload());
    await sync.apply(buildCodingSyncPayload(routing(), { ...coding, workspaces: [] }, keyFor));
    expect(client.putWorkspaces).toHaveBeenCalledTimes(2);
    expect(client.putKeys).toHaveBeenCalledTimes(1);
    expect(client.putSettings).toHaveBeenCalledTimes(1);
    sync.stop();
  });

  it('retries when the runner is down, and does not retry what the runner refuses', async () => {
    const down = vi.fn().mockRejectedValueOnce(new RunnerError('The coding runner is not answering at x.')).mockResolvedValue([]);
    const refused = setup({ putWorkspaces: down });
    await refused.sync.apply(payload());
    await new Promise((resolve) => setTimeout(resolve, 40));
    await refused.sync.check();
    expect(down).toHaveBeenCalledTimes(2);
    refused.sync.stop();

    const bad = vi.fn(async () => Promise.reject(new RunnerError('"/x" is not a git repository', 400)));
    const { sync, client } = setup({ putWorkspaces: bad });
    await sync.apply(payload());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bad).toHaveBeenCalledTimes(1);
    expect(sync.workspaceError).toBe('"/x" is not a git repository');
    expect(client.putKeys).toHaveBeenCalledTimes(1);
    sync.stop();
  });

  it('sends everything again after a reset, or when the runner has lost a key', async () => {
    const getKeys = vi.fn(async () => ({ openai: true, anthropic: true, github: true }));
    const { client, sync } = setup({ getKeys });
    await sync.apply(payload());
    await sync.check();
    expect(client.putKeys).toHaveBeenCalledTimes(1);
    getKeys.mockResolvedValueOnce({ openai: true, anthropic: true, github: false });
    await sync.check();
    expect(client.putKeys).toHaveBeenCalledTimes(2);
    await sync.reset();
    expect(client.putKeys).toHaveBeenCalledTimes(3);
    expect(client.putWorkspaces).toHaveBeenCalledTimes(3);
    sync.stop();
  });

  it('sends again after the runner was unreachable for a check', async () => {
    const getKeys = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue({ openai: true, anthropic: true, github: true });
    const { client, sync } = setup({ getKeys });
    await sync.apply(payload());
    await sync.check();
    await sync.check();
    expect(client.putKeys).toHaveBeenCalledTimes(2);
    sync.stop();
  });
});
