import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigManager } from '../src/config/config-manager.js';
import {
  ADDABLE_SERVER_TYPES,
  USE_SERVER_TYPES,
  builtInServers,
  defaultRoutes,
  resolveModelRouting,
  routeTargets,
  routeTargetsWithOverride,
  sanitizeStoredModels,
  serverUrl,
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
    expect(routes.posecheck).toEqual({ server: 'local-vision', model: 'qwen3-vl' });
    expect(routes.describe).toEqual({ server: 'local-vision', model: 'qwen3-vl' });
    expect(routes.posegen).toEqual({ server: 'openai', model: 'gpt-4.1-mini' });
    // Idle thoughts start on whatever Thinking starts on.
    expect(routes.idle).toEqual({ server: 'openai', model: 'gpt-4.1' });
    expect(defaultRoutes(DEFAULT_PROVIDER_SETTINGS).idle).toEqual(defaultRoutes(DEFAULT_PROVIDER_SETTINGS).llm);
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

  it('lets Idle thoughts follow Thinking until they are pointed elsewhere, and take a smaller model', () => {
    const base = defaultRoutes(DEFAULT_PROVIDER_SETTINGS);
    const follows = resolveModelRouting(builtIns(), base, {
      servers: [{ id: 'gpu', type: 'chat', url: 'http://gpu:8000/v1' }],
      routes: { llm: { server: 'gpu', model: 'big', backups: [{ server: 'openai' }] } },
    });
    expect(follows.routes.idle).toEqual({ server: 'gpu', model: 'big', backups: [{ server: 'openai' }] });
    // Animation clips (Moving's fallback when ARDY isn't running) follow Thinking too, without backups.
    expect(follows.routes.clips).toEqual({ server: 'gpu', model: 'big' });
    expect(base.clips).toEqual(base.llm);
    expect(USE_SERVER_TYPES.idle).toEqual(['chat', 'openai']);

    const own = resolveModelRouting(builtIns(), base, {
      routes: { llm: { server: 'openai', model: 'gpt-4.1' }, idle: { server: 'local-llm', model: 'qwen-tiny', backups: [{ server: 'openai' }] } },
    });
    expect(own.routes.idle).toEqual({ server: 'local-llm', model: 'qwen-tiny', backups: [{ server: 'openai' }] });
    expect(routeTargets(own, 'idle').map(({ server, model }) => [server.id, model])).toEqual([
      ['local-llm', 'qwen-tiny'],
      ['openai', undefined],
    ]);
    // A saved route that cannot do the job falls back to following Thinking.
    const bad = resolveModelRouting(builtIns(), base, { routes: { idle: { server: 'local-comfy' } } });
    expect(bad.routes.idle).toEqual(bad.routes.llm);
    expect(sanitizeStoredModels({ routes: { idle: { server: 'local-llm', model: ' tiny ' } } }).routes?.idle).toEqual({
      server: 'local-llm',
      model: 'tiny',
    });
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

  it('keeps a Home Assistant server’s base address and gives it no use', () => {
    expect(serverUrl('homeassistant', 'http://ha.local:8123/')).toBe('http://ha.local:8123');
    expect(serverUrl('homeassistant', 'http://ha.local:8123/api/')).toBe('http://ha.local:8123');
    expect(serverUrl('homeassistant', 'https://ha.example.com/api')).toBe('https://ha.example.com');
    expect(ADDABLE_SERVER_TYPES).toContain('homeassistant');
    expect(Object.values(USE_SERVER_TYPES).flat()).not.toContain('homeassistant');
    const routing = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), {
      servers: [{ id: 'ha1', name: 'Penang', type: 'homeassistant', url: 'http://ha.local:8123/api/' }],
    });
    expect(routing.servers.find((server) => server.id === 'ha1')).toMatchObject({ type: 'homeassistant', url: 'http://ha.local:8123', builtIn: false });
  });

  it('adds /v1 to a chat or transcription server given with no path', () => {
    expect(serverUrl('chat', 'http://gpu:1234/')).toBe('http://gpu:1234/v1');
    expect(serverUrl('transcribe', 'http://gpu:8000')).toBe('http://gpu:8000/v1');
    expect(serverUrl('chat', 'http://gpu:11434/v1/')).toBe('http://gpu:11434/v1');
    expect(serverUrl('comfy', 'http://rack:8188/')).toBe('http://rack:8188');
    const routing = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), {
      servers: [{ id: 'lm', type: 'chat', url: 'http://lm-studio:1234' }],
    });
    expect(routing.servers.find((server) => server.id === 'lm')?.url).toBe('http://lm-studio:1234/v1');
  });

  it('has a built-in vision server that Describe the avatar uses until the user picks another, and a saved route wins', () => {
    const routing = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS));
    const vision = routing.servers.find((server) => server.id === 'local-vision');
    expect(vision).toMatchObject({ name: 'Vision model on this PC', type: 'chat', url: 'http://127.0.0.1:1237/v1', builtIn: true, managed: true });
    expect(routing.routes.describe).toEqual({ server: 'local-vision', model: 'qwen3-vl' });
    const saved = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), {
      routes: { describe: { server: 'openai', model: 'gpt-4.1-mini' } },
    });
    expect(saved.routes.describe).toEqual({ server: 'openai', model: 'gpt-4.1-mini' });
    expect(saved.routes.posecheck).toEqual({ server: 'local-vision', model: 'qwen3-vl' });
  });

  it('has built-in coding servers, a coding use that cannot be off, and online accounts that are key only', () => {
    const routing = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS));
    const byId = Object.fromEntries(routing.servers.map((server) => [server.id, server]));
    expect(byId['local-coder-runner']).toMatchObject({ type: 'coder', url: 'http://127.0.0.1:8195', builtIn: true, managed: true });
    expect(byId['local-coder-llm']).toMatchObject({ name: 'Qwen3-Coder-Next (coding)', type: 'chat', url: 'http://127.0.0.1:1236/v1', managed: true });
    expect(byId.anthropic).toMatchObject({ type: 'anthropic', url: 'https://api.anthropic.com', builtIn: true, managed: false });
    expect(byId.github).toMatchObject({ type: 'github', url: 'https://api.github.com', builtIn: true, managed: false });
    expect(routing.routes.coding).toEqual({ server: 'local-coder-llm', model: 'qwen3-coder-next' });
    expect(USE_SERVER_TYPES.coding).toEqual(['chat', 'openai', 'anthropic']);
    expect(Object.values(USE_SERVER_TYPES).flat()).not.toContain('github');
    expect(Object.values(USE_SERVER_TYPES).flat()).not.toContain('coder');
    expect(ADDABLE_SERVER_TYPES).toContain('coder');
    expect(ADDABLE_SERVER_TYPES).not.toContain('anthropic');
    expect(ADDABLE_SERVER_TYPES).not.toContain('github');

    // Anthropic works for coding, has no backups, and the coding use cannot be switched off or sent to a runner.
    const saved = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), {
      routes: { coding: { server: 'anthropic', model: 'claude-sonnet', backups: [{ server: 'openai' }] } },
    });
    expect(saved.routes.coding).toEqual({ server: 'anthropic', model: 'claude-sonnet' });
    const off = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), { routes: { coding: { server: '' } } });
    expect(off.routes.coding.server).toBe('local-coder-llm');
    const wrong = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), { routes: { coding: { server: 'local-coder-runner' } } });
    expect(wrong.routes.coding.server).toBe('local-coder-llm');
  });

  it('takes the coder and runner addresses from the environment, and keeps the key-only addresses fixed', () => {
    const servers = builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188', coderRunnerUrl: 'http://127.0.0.1:9000/', coderLlmUrl: 'http://192.168.1.9:1236/v1' });
    const routing = resolveModelRouting(servers, defaultRoutes(DEFAULT_PROVIDER_SETTINGS), {
      servers: [{ id: 'anthropic', url: 'http://evil.example' }, { id: 'rack-coder', name: 'Runner on rack', type: 'coder', url: 'http://rack:8195/' }],
    });
    expect(routing.servers.find((server) => server.id === 'local-coder-runner')?.url).toBe('http://127.0.0.1:9000');
    const coderLlm = routing.servers.find((server) => server.id === 'local-coder-llm');
    expect(coderLlm).toMatchObject({ url: 'http://192.168.1.9:1236/v1', managed: false });
    expect(routing.servers.find((server) => server.id === 'anthropic')?.url).toBe('https://api.anthropic.com');
    expect(routing.servers.find((server) => server.id === 'rack-coder')).toMatchObject({ type: 'coder', url: 'http://rack:8195', builtIn: false });
  });

  it('puts an override first for a use and leaves its excluded servers out', () => {
    const routing = resolveModelRouting(builtIns(), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), {
      routes: { llm: { server: 'local-llm', model: 'flash', backups: [{ server: 'openai', model: 'gpt-4.1' }] } },
    });
    const coder = routing.servers.find((server) => server.id === 'local-coder-llm')!;
    expect(routeTargetsWithOverride(routing, 'llm', null).map((t) => t.server.id)).toEqual(['local-llm', 'openai']);
    const targets = routeTargetsWithOverride(routing, 'llm', { server: coder, model: 'qwen3-coder-next', exclude: ['local-llm'] });
    expect(targets.map((t) => [t.server.id, t.model])).toEqual([
      ['local-coder-llm', 'qwen3-coder-next'],
      ['openai', 'gpt-4.1'],
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

  it('keeps the Anthropic and GitHub keys in the key store, and an environment variable wins', async () => {
    const { config, secretStore } = await manager();
    await config.setServerKey('anthropic', 'sk-ant-1');
    await config.setServerKey('github', 'ghp_1');
    expect(config.getServerKey('anthropic')).toBe('sk-ant-1');
    expect(await secretStore.getSecret('MODEL_SERVER_KEY:anthropic')).toBe('sk-ant-1');
    expect(await secretStore.getSecret('MODEL_SERVER_KEY:github')).toBe('ghp_1');
    const view = config.getModelRoutingView();
    expect(view.servers.find((server) => server.id === 'github')).toMatchObject({ hasKey: true });
    expect(JSON.stringify(view)).not.toContain('ghp_1');
    const again = await manager({ GITHUB_TOKEN: 'from-env' });
    expect(again.config.getServerKey('github')).toBe('from-env');
    await config.setServerKey('github', '');
    expect(config.getServerKey('github')).toBeUndefined();
  });

  it('seeds the first coding workspace once, only from a git checkout, and remembers changes', async () => {
    const preferencesStore = new InMemoryPreferencesStore();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const first = new ConfigManager({ env: {}, preferencesStore, logger, repoRoot: '/work/aiembodied', pathExists: (file) => file.endsWith('.git') });
    await first.load();
    expect(first.getCoding()).toEqual({
      runner: 'local-coder-runner',
      workspaces: [
        { id: 'aiembodied', name: 'aiembodied', path: path.resolve('/work/aiembodied'), kind: 'self', baseBranch: 'main', checks: 'pnpm -w typecheck && pnpm test', setup: 'pnpm install --frozen-lockfile --prefer-offline && pnpm --filter @aiembodied/main exec install-electron' },
      ],
    });
    expect((await preferencesStore.load()).coding?.workspaces).toHaveLength(1);

    // Removing it sticks: the saved section exists, so nothing is seeded again.
    await first.setCoding({ runner: 'local-coder-runner', workspaces: [], coderGguf: 'D:\\m\\coder-Q4_K_M-00001-of-00003.gguf' });
    const second = new ConfigManager({ env: {}, preferencesStore, logger, repoRoot: '/work/aiembodied', pathExists: () => true });
    await second.load();
    expect(second.getCoding()).toEqual({ runner: 'local-coder-runner', workspaces: [], coderGguf: 'D:\\m\\coder-Q4_K_M-00001-of-00003.gguf' });

    // A checkout without .git seeds nothing.
    const bare = new ConfigManager({ env: {}, preferencesStore: new InMemoryPreferencesStore(), logger, repoRoot: '/opt/app', pathExists: () => false });
    await bare.load();
    expect(bare.getCoding().workspaces).toEqual([]);
  });

  it('falls back to the built-in runner when the saved one is not a runner', async () => {
    const { config } = await manager();
    const saved = await config.setCoding({ runner: 'local-llm', workspaces: [] });
    expect(saved.runner).toBe('local-coder-runner');
    const id = await config.saveModelServer({ name: 'Runner on rack', type: 'coder', url: 'http://rack:8195' });
    expect((await config.setCoding({ runner: id, workspaces: [] })).runner).toBe(id);
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

    const civitai = await manager({ CIVITAI_API_KEY: 'env-civitai' });
    expect(civitai.config.getServerKey('civitai')).toBe('env-civitai');
    expect(civitai.config.getModelRoutingView().servers.find((server) => server.id === 'civitai')).toMatchObject({ type: 'civitai', hasKey: true, keyFromEnv: true });
    await stored.config.setServerKey('civitai', 'saved-civitai');
    expect(await stored.secretStore.getSecret('CIVITAI_API_KEY')).toBe('saved-civitai');
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

  it('checks Home Assistant with its token', async () => {
    const server = { type: 'homeassistant' as const, url: 'http://ha.local:8123' };
    const calls: Array<[string, string | undefined]> = [];
    const answer = (status: number) =>
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push([String(url), (init?.headers as Record<string, string>).Authorization]);
        return json({ message: 'API running.' }, status);
      }) as unknown as typeof fetch;
    await expect(probeModelServer(server, 'tok', answer(200))).resolves.toMatchObject({ status: 'up' });
    expect(calls[0]).toEqual(['http://ha.local:8123/api/', 'Bearer tok']);
    await expect(probeModelServer(server, 'bad', answer(401))).resolves.toMatchObject({ status: 'down', message: 'token refused' });
    await expect(probeModelServer(server, 'bad', answer(403))).resolves.toMatchObject({ status: 'down', message: 'token refused' });
    await expect(probeModelServer(server, undefined, answer(200))).resolves.toMatchObject({ status: 'down', message: 'no token' });
    const unreachable = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(probeModelServer(server, 'tok', unreachable)).resolves.toMatchObject({ status: 'down' });
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

  it('checks Anthropic, GitHub and the coding runner', async () => {
    const seen: Array<[string, Record<string, string>]> = [];
    const answer = (body: unknown, status = 200) =>
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        seen.push([String(url), init?.headers as Record<string, string>]);
        return json(body, status);
      }) as unknown as typeof fetch;
    const anthropic = { type: 'anthropic' as const, url: 'https://api.anthropic.com' };
    await expect(probeModelServer(anthropic, undefined, answer({}))).resolves.toMatchObject({ status: 'needs-key' });
    await expect(probeModelServer(anthropic, 'sk-ant', answer({ data: [{ id: 'claude-b' }, { id: 'claude-a' }] }))).resolves.toMatchObject({
      status: 'up',
      models: { chat: ['claude-a', 'claude-b'] },
    });
    expect(seen[0][0]).toBe('https://api.anthropic.com/v1/models?limit=100');
    expect(seen[0][1]).toMatchObject({ 'x-api-key': 'sk-ant', 'anthropic-version': '2023-06-01' });
    await expect(probeModelServer(anthropic, 'bad', answer({}, 401))).resolves.toMatchObject({ status: 'needs-key' });

    const github = { type: 'github' as const, url: 'https://api.github.com' };
    await expect(probeModelServer(github, undefined, answer({}))).resolves.toMatchObject({ status: 'needs-key' });
    await expect(probeModelServer(github, 'ghp', answer({ login: 'me' }))).resolves.toMatchObject({ status: 'up' });
    expect(seen.at(-1)).toEqual(['https://api.github.com/user', expect.objectContaining({ Authorization: 'Bearer ghp' })]);

    const coder = { type: 'coder' as const, url: 'http://127.0.0.1:8195' };
    await expect(probeModelServer(coder, undefined, answer({ ok: true, pi: { found: true } }))).resolves.toMatchObject({ status: 'up' });
    expect(seen.at(-1)?.[0]).toBe('http://127.0.0.1:8195/v1/health');
    await expect(probeModelServer(coder, undefined, answer({ ok: true, pi: { found: false } }))).resolves.toMatchObject({ status: 'error' });
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(probeModelServer(coder, undefined, down)).resolves.toMatchObject({ status: 'down' });
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
