import { describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '../src/config/config-manager.js';
import {
  builtInServers,
  defaultRoutes,
  resolveModelRouting,
  routeTargets,
  sanitizeStoredModels,
} from '../src/config/model-routing.js';
import { comfyQueueLength, openAiRoles, probeModelServer } from '../src/config/model-server-probe.js';
import { InMemoryPreferencesStore } from '../src/config/preferences-store.js';
import { DEFAULT_PROVIDER_SETTINGS, resolveProviderSettings } from '../src/config/provider-settings.js';
import { InMemorySecretStore } from '../src/config/secret-store.js';

const builtIns = () => builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' });

describe('model routing', () => {
  it('starts from what the provider settings and env already say', () => {
    const providers = resolveProviderSettings({ LLM_PROVIDER: 'openai', OPENAI_LLM_MODEL: 'gpt-4.1' }, {});
    const routes = defaultRoutes(providers, 'searxng,brave');
    expect(routes.llm).toEqual({ server: 'openai', model: 'gpt-4.1' });
    expect(routes.stt).toEqual({ server: 'local-speech' });
    expect(routes.motion).toEqual({ server: 'local-motion', model: 'ardy' });
    expect(routes.search).toEqual({ server: 'local-searxng', backups: [{ server: 'brave' }] });
    expect(routes.posecheck).toEqual({ server: 'openai', model: 'gpt-4o' });
    expect(defaultRoutes(providers, 'off').search).toEqual({ server: '' });
  });

  it('adds saved servers, applies renames, and refuses a server that cannot do the job', () => {
    const routing = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), {
      servers: [
        { id: 'rack', name: 'ComfyUI on rack-1', type: 'comfy', url: 'http://rack-1:8188/' },
        { id: 'local-llm', url: 'http://10.0.0.5:1234/v1' },
        { id: 'broken', type: 'openai', url: 'http://x' },
      ],
      routes: {
        image: { server: 'rack', backups: [{ server: 'local-comfy' }, { server: 'rack' }, { server: 'openai' }], spread: true },
        llm: { server: 'rack' },
        describe: { server: 'local-llm', backups: [{ server: 'openai' }] },
      },
    });
    expect(routing.servers.find((server) => server.id === 'rack')).toMatchObject({ url: 'http://rack-1:8188', builtIn: false, managed: false });
    // A built-in pointed at another machine is no longer started on this PC.
    expect(routing.servers.find((server) => server.id === 'local-llm')).toMatchObject({ url: 'http://10.0.0.5:1234/v1', managed: false });
    expect(routing.servers.some((server) => server.id === 'broken')).toBe(false);
    expect(routing.routes.image).toEqual({ server: 'rack', backups: [{ server: 'local-comfy' }], spread: true });
    expect(routing.routes.llm).toEqual({ server: 'local-llm', model: 'qwen-next-flash' });
    // Helpers use only their first server.
    expect(routing.routes.describe).toEqual({ server: 'local-llm' });
  });

  it('gives a backup the first server model only when it is the same kind of server', () => {
    const routing = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), {
      servers: [{ id: 'gpu', type: 'chat', url: 'http://gpu:8000/v1' }],
      routes: { llm: { server: 'local-llm', model: 'qwen', backups: [{ server: 'gpu' }, { server: 'openai' }] } },
    });
    expect(routeTargets(routing, 'llm').map(({ server, model }) => [server.id, model])).toEqual([
      ['local-llm', 'qwen'],
      ['gpu', 'qwen'],
      ['openai', undefined],
    ]);
  });

  it('drops malformed saved data', () => {
    expect(
      sanitizeStoredModels({
        servers: [{ id: 'a', type: 'comfy', url: 'ftp://nope' }, { name: 'no id' }, 'junk'],
        routes: { llm: { server: 'a', backups: [{ model: 'x' }, { server: 'b' }] }, bogus: { server: 'a' }, tts: 'x' },
      }),
    ).toEqual({ servers: [{ id: 'a', type: 'comfy' }], routes: { llm: { server: 'a', backups: [{ server: 'b' }] } } });
  });
});

describe('ConfigManager model servers', () => {
  async function manager(env: NodeJS.ProcessEnv = {}) {
    const preferencesStore = new InMemoryPreferencesStore();
    const secretStore = new InMemorySecretStore();
    const config = new ConfigManager({ env, preferencesStore, secretStore, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    await config.load();
    return { config, preferencesStore, secretStore };
  }

  it('adds a server with a key, routes a use to it, and remembers both after a restart', async () => {
    const { config, preferencesStore, secretStore } = await manager();
    const id = await config.saveModelServer({ name: 'vLLM on rack-1', type: 'chat', url: 'http://rack-1:8000/v1' });
    await config.setServerKey(id, 'secret-token');
    await config.setModelRoute('llm', { server: id, model: 'Qwen3-235B', backups: [{ server: 'local-llm' }] });

    const view = config.getModelRoutingView();
    expect(view.servers.find((server) => server.id === id)).toMatchObject({ name: 'vLLM on rack-1', hasKey: true, builtIn: false });
    expect(JSON.stringify(view)).not.toContain('secret-token');
    expect(config.getServerKey(id)).toBe('secret-token');

    const again = new ConfigManager({ env: {}, preferencesStore, secretStore, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    await again.load();
    expect(again.getConfig().models.routes.llm).toEqual({ server: id, model: 'Qwen3-235B', backups: [{ server: 'local-llm' }] });
    expect(again.getServerKey(id)).toBe('secret-token');
  });

  it('keeps saved servers when audio preferences are saved', async () => {
    const { config, preferencesStore } = await manager();
    await config.saveModelServer({ type: 'comfy', url: 'http://rack-1:8188' });
    await config.setAudioDevicePreferences({ audioInputDeviceId: 'mic' });
    expect((await preferencesStore.load()).models?.servers).toHaveLength(1);
  });

  it('refuses bad addresses, a job the server cannot do, and removing a built-in server', async () => {
    const { config } = await manager();
    await expect(config.saveModelServer({ type: 'comfy', url: 'not a url' })).rejects.toThrow(/URL/);
    await expect(config.saveModelServer({ type: 'openai', url: 'http://x' })).rejects.toThrow(/kind of server/);
    const id = await config.saveModelServer({ type: 'comfy', url: 'http://rack-1:8188' });
    await expect(config.setModelRoute('llm', { server: id })).rejects.toThrow(/can't do this job/);
    await expect(config.removeModelServer('local-comfy')).rejects.toThrow(/not removed/);
  });

  it('sends uses back to their defaults when their server is removed', async () => {
    const { config } = await manager();
    const id = await config.saveModelServer({ type: 'comfy', url: 'http://rack-1:8188' });
    await config.setModelRoute('mesh', { server: id });
    await config.removeModelServer(id);
    expect(config.getConfig().models.routes.mesh).toEqual({ server: 'local-comfy' });
  });

  it('reads the Brave key from the environment or the secret store', async () => {
    const fromEnv = await manager({ BRAVE_SEARCH_API_KEY: 'env-brave' });
    expect(fromEnv.config.getServerKey('brave')).toBe('env-brave');
    expect(fromEnv.config.getModelRoutingView().servers.find((server) => server.id === 'brave')).toMatchObject({ hasKey: true, keyFromEnv: true });

    const stored = await manager();
    await stored.config.setServerKey('brave', 'saved-brave');
    expect(stored.config.getConfig().webSearch.braveApiKey).toBe('saved-brave');
    expect(await stored.secretStore.getSecret('BRAVE_SEARCH_API_KEY')).toBe('saved-brave');
  });
});

describe('probing model servers', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('lists an OpenAI-compatible server’s models and sends its key', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer k');
      return json({ data: [{ id: 'qwen' }, { id: 'gemma' }] });
    }) as unknown as typeof fetch;
    await expect(probeModelServer({ type: 'chat', url: 'http://gpu:8000/v1' }, 'k', fetchFn)).resolves.toMatchObject({
      status: 'up',
      models: { chat: ['qwen', 'gemma'] },
    });
  });

  it('reports a refused key, a missing OpenAI key and an unreachable server', async () => {
    const refused = vi.fn(async () => json({}, 401)) as unknown as typeof fetch;
    await expect(probeModelServer({ type: 'chat', url: 'http://gpu/v1' }, undefined, refused)).resolves.toMatchObject({ status: 'needs-key' });
    await expect(probeModelServer({ type: 'openai', url: 'https://api.openai.com/v1' }, '', refused)).resolves.toMatchObject({ status: 'needs-key' });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(probeModelServer({ type: 'comfy', url: 'http://rack:8188' }, undefined, down)).resolves.toMatchObject({
      status: 'down',
      message: 'Not reachable at http://rack:8188.',
    });
  });

  it('splits ComfyUI models into image and 3D, and counts its queue', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/models/diffusion_models')) return json(['qwen_image_2.1_int8.safetensors', 'trellis_2_bf16.safetensors']);
      if (url.endsWith('/models/checkpoints')) return json(['sdxl.safetensors']);
      return json({ queue_running: [[1]], queue_pending: [[2], [3]] });
    }) as unknown as typeof fetch;
    await expect(probeModelServer({ type: 'comfy', url: 'http://rack:8188' }, undefined, fetchFn)).resolves.toMatchObject({
      status: 'up',
      models: { image: ['qwen_image_2.1_int8.safetensors', 'sdxl.safetensors'], mesh: ['trellis_2_bf16.safetensors'] },
      queue: 3,
    });
    expect(comfyQueueLength(null)).toBe(0);
  });

  it('sorts OpenAI models by job and never calls Brave', async () => {
    expect(openAiRoles(['gpt-4.1', 'gpt-realtime-2.1', 'gpt-4o-transcribe', 'text-embedding-3', 'gpt-4o-realtime-preview'])).toEqual({
      chat: ['gpt-4.1'],
      motion: ['gpt-4.1'],
      transcribe: ['gpt-4o-transcribe'],
      realtime: ['gpt-realtime-2.1'],
    });
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await expect(probeModelServer({ type: 'brave', url: 'https://api.search.brave.com' }, 'b', fetchFn)).resolves.toMatchObject({ status: 'up' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
