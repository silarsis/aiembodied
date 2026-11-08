import { describe, expect, it, vi } from 'vitest';
import { builtInServers, defaultRoutes, resolveModelRouting } from '../src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';
import { CodingService } from '../src/coding/coding-service.js';

const encoder = new TextEncoder();

describe('CodingService', () => {
  it('follows the runner’s events: swaps the models in, sends the setup, and reports the state', async () => {
    const routing = resolveModelRouting(builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }), defaultRoutes(DEFAULT_PROVIDER_SETTINGS));
    const coding = { runner: 'local-coder-runner', workspaces: [{ id: 'aiembodied', name: 'aiembodied', path: '/src/a', kind: 'self' as const, baseBranch: 'main' }] };
    let coderUp = false;
    const requests: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === 'http://127.0.0.1:1236/v1/models') return new Response('{}', { status: coderUp ? 200 : 503 });
      if (url.endsWith('/v1/events')) {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode(': connected\n\ndata: {"task_id":null,"local_model_needed":false}\n\n'));
              controller.enqueue(encoder.encode('data: {"task_id":"t1","status":"working","local_model_needed":true}\n\n'));
              await held;
              controller.close();
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/v1/status')) return new Response(JSON.stringify({ local_model_needed: true, active: ['t1'] }), { status: 200 });
      if (url.endsWith('/v1/keys') && init?.method === 'GET') return new Response(JSON.stringify({ openai: false, anthropic: false, github: false }), { status: 200 });
      return new Response(init?.method === 'PUT' && url.endsWith('/v1/keys') ? null : '[]', { status: init?.method === 'PUT' && url.endsWith('/v1/keys') ? 204 : 200 });
    });
    const echo = { stop: vi.fn(async () => true), start: vi.fn(async () => undefined) };
    const coder = {
      stop: vi.fn(async () => true),
      start: vi.fn(async () => {
        coderUp = true;
      }),
    };
    const onOverrideChange = vi.fn();
    const service = new CodingService({
      settings: () => ({ models: routing, coding }),
      keyFor: () => undefined,
      echoControl: echo,
      coderControl: () => coder,
      onOverrideChange,
      logger: { info: vi.fn(), warn: vi.fn() },
      env: { CODER_LLM_GGUF: 'D:\\m\\coder-Q4_K_M-00001-of-00003.gguf' },
      fetchFn: fetchFn as unknown as typeof fetch,
      platform: 'win32',
    });

    const seen: unknown[] = [];
    service.onRunnerEvent((event) => seen.push(event));
    await service.apply();
    await vi.waitFor(() => expect(service.swap.getState().phase).toBe('coder-loaded'));
    await vi.waitFor(() => expect(seen).toContainEqual(expect.objectContaining({ task_id: 't1', status: 'working' })));
    expect(service.runnerClient()?.baseUrl).toBe('http://127.0.0.1:8195');
    expect(echo.stop).toHaveBeenCalledTimes(1);
    expect(coder.start).toHaveBeenCalledTimes(1);
    expect(service.chatOverride()?.server.id).toBe('local-coder-llm');
    expect(requests).toContain('PUT http://127.0.0.1:8195/v1/workspaces');
    expect(requests).toContain('PUT http://127.0.0.1:8195/v1/settings');
    const status = service.status();
    expect(status).toMatchObject({ runnerUp: true, runnerUrl: 'http://127.0.0.1:8195', localModelNeeded: true, detectedGguf: 'D:\\m\\coder-Q4_K_M-00001-of-00003.gguf' });
    expect(status.swap.phase).toBe('coder-loaded');

    // The stream ends: the runner is down, and the model counts as not needed any more.
    release();
    await vi.waitFor(() => expect(service.status().runnerUp).toBe(false));
    expect(service.status().localModelNeeded).toBe(false);
    service.stop();
  });

  it('asks the runner for a checks suggestion', async () => {
    const routing = resolveModelRouting(builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }), defaultRoutes(DEFAULT_PROVIDER_SETTINGS));
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/v1/capabilities')) {
        return new Response(JSON.stringify({ workspaces: [{ id: 'a', detected: { checks_suggestion: 'pnpm -w typecheck && pnpm test' } }, { id: 'b', detected: {} }] }), { status: 200 });
      }
      if (url.endsWith('/v1/events')) return new Response(new ReadableStream({ start() {} }), { status: 200 });
      return new Response('[]', { status: 200 });
    });
    const service = new CodingService({
      settings: () => ({ models: routing, coding: { runner: 'local-coder-runner', workspaces: [] } }),
      keyFor: () => undefined,
      echoControl: { stop: vi.fn(), start: vi.fn() },
      coderControl: () => ({ stop: vi.fn(), start: vi.fn() }),
      onOverrideChange: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
      env: {},
      fetchFn: fetchFn as unknown as typeof fetch,
      platform: 'linux',
    });
    await service.apply();
    await expect(service.suggestChecks('a')).resolves.toBe('pnpm -w typecheck && pnpm test');
    await expect(service.suggestChecks('b')).resolves.toBeNull();
    service.stop();
  });
});
