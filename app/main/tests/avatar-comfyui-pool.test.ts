import { describe, expect, it, vi } from 'vitest';
import { ComfyUIPool } from '../src/avatar/generation/comfyui-pool.js';
import type { ComfyUIRuntime } from '../src/avatar/generation/comfyui-runtime.js';
import { createRemoteComfyModelScanner, remoteModelKind } from '../src/avatar/generation/image-model-service.js';
import { builtInServers, defaultRoutes, resolveModelRouting, type StoredModels } from '../src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';

const routing = (stored: StoredModels) =>
  resolveModelRouting(
    builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }),
    defaultRoutes(DEFAULT_PROVIDER_SETTINGS),
    stored,
  );

const servers: StoredModels['servers'] = [
  { id: 'a', name: 'Rack A', type: 'comfy', url: 'http://a:8188' },
  { id: 'b', name: 'Rack B', type: 'comfy', url: 'http://b:8188' },
];

function fakeFetch(state: Record<string, { up: boolean; queue?: number }>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const host = state[url.hostname];
    if (!host?.up) throw new TypeError('fetch failed');
    if (url.pathname === '/queue') return new Response(JSON.stringify({ queue_running: [], queue_pending: Array(host.queue ?? 0).fill([]) }));
    return new Response('{}');
  }) as unknown as typeof fetch;
}

describe('ComfyUI server choice', () => {
  it('uses the first server that answers, in order', async () => {
    const pool = new ComfyUIPool({
      routing: () => routing({ servers, routes: { image: { server: 'a', backups: [{ server: 'b' }] } } }),
      logDirectory: '/tmp',
      fetchFn: fakeFetch({ a: { up: false }, b: { up: true } }),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    expect((await pool.pick('image')).baseUrl).toBe('http://b:8188');
  });

  it('spreads jobs to the shortest queue when asked', async () => {
    const pool = new ComfyUIPool({
      routing: () => routing({ servers, routes: { mesh: { server: 'a', backups: [{ server: 'b' }], spread: true } } }),
      logDirectory: '/tmp',
      fetchFn: fakeFetch({ a: { up: true, queue: 3 }, b: { up: true, queue: 1 } }),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    expect((await pool.pick('mesh')).baseUrl).toBe('http://b:8188');
  });

  it('starts this PC’s ComfyUI on demand, and explains when nothing answers', async () => {
    const ensureReady = vi.fn(async () => undefined);
    const pool = new ComfyUIPool({
      routing: () => routing({ servers, routes: { image: { server: 'local-comfy', backups: [{ server: 'a' }] } } }),
      logDirectory: '/tmp',
      fetchFn: fakeFetch({ '127.0.0.1': { up: true } }),
      createRuntime: () => ({ ensureReady }) as unknown as ComfyUIRuntime,
    });
    expect((await pool.pick('image')).baseUrl).toBe('http://127.0.0.1:8188');
    expect(ensureReady).toHaveBeenCalled();

    const none = new ComfyUIPool({
      routing: () => routing({ servers, routes: { image: { server: 'a', backups: [{ server: 'b' }] } } }),
      logDirectory: '/tmp',
      fetchFn: fakeFetch({}),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    await expect(none.pick('image')).rejects.toThrow(/No ComfyUI server answered. Rack A: .* Rack B:/);
  });
});

describe('model discovery on another machine', () => {
  it('reads ComfyUI’s model folders and guesses each file’s kind from its name', async () => {
    const lists: Record<string, string[]> = {
      diffusion_models: ['qwen_image_2.1_bf16.safetensors', 'trellis_2_bf16.safetensors', 'mystery.safetensors'],
      text_encoders: ['qwen3vl_8b_int8_convrot.safetensors'],
      vae: ['qwen_image_2.1_vae_bf16.safetensors', 'trellis_2_shape_vae_bf16.safetensors', 'trellis_2_texture_vae_bf16.safetensors'],
      checkpoints: ['juggernautXL.safetensors'],
    };
    const fetchFn = vi.fn(async (input: string | URL | Request) =>
      // No aiembodied add-on there: ComfyUI answers 404, so file names decide the kind.
      String(input).includes('/aiembodied/')
        ? new Response('Not Found', { status: 404 })
        : new Response(JSON.stringify(lists[String(input).split('/models/')[1]] ?? [])),
    ) as unknown as typeof fetch;
    const files = await createRemoteComfyModelScanner('http://rack:8188/', fetchFn)();
    expect(files.map((file) => [file.name, file.kind])).toEqual([
      ['qwen_image_2.1_bf16.safetensors', 'qwen-image-2.1'],
      ['trellis_2_bf16.safetensors', 'trellis2'],
      ['qwen3vl_8b_int8_convrot.safetensors', 'qwen3-vl'],
      ['qwen_image_2.1_vae_bf16.safetensors', 'qwen-image-vae'],
      ['trellis_2_shape_vae_bf16.safetensors', 'trellis2-shape-vae'],
      ['trellis_2_texture_vae_bf16.safetensors', 'trellis2-texture-vae'],
      ['juggernautXL.safetensors', 'sdxl'],
    ]);
    expect(files.at(-1)).toMatchObject({ embeddedVae: true, embeddedClip: true, embeddedClip2: true });
    expect(remoteModelKind('vae', 'ae.safetensors')).toBe('flux-ae');
  });
});
