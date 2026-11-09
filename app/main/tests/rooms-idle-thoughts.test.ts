import { describe, expect, it, vi } from 'vitest';
import { builtInServers, defaultRoutes, resolveModelRouting } from '../src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';
import { BackgroundService } from '../src/backgrounds/background-service.js';
import { DEFAULT_IDLE_SETTINGS, RESTLESSNESS_MEAN_SECONDS, parseIdleSettings, sanitizeIdleSettings } from '../src/rooms/idle-settings.js';
import { MAX_IDLE_HABITS_LENGTH, normalizeIdleHabits } from '../src/rooms/idle-habits.js';
import { pickIdleActions } from '../src/rooms/idle-thoughts.js';
import type { ChatClient } from '../src/local-voice/voice-engines.js';

function routing(routes: Parameters<typeof resolveModelRouting>[2]) {
  return resolveModelRouting(
    builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }),
    defaultRoutes(DEFAULT_PROVIDER_SETTINGS),
    { servers: [{ id: 'gpu', type: 'chat', url: 'http://gpu:8000/v1' }], ...routes },
  );
}

function sse(text: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const CONTEXT = { system: 'You decide what Mei does.', user: 'Room: reading room' };

describe('pickIdleActions', () => {
  it('sends one small request with no tools to the idle route and returns the reply', async () => {
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => sse('{go:window}{wait}')) as unknown as typeof fetch;
    const result = await pickIdleActions(CONTEXT, {
      routing: routing({ routes: { idle: { server: 'gpu', model: 'tiny' } } }),
      keyFor: (id) => (id === 'gpu' ? 'secret' : undefined),
      fetchFn,
    });
    expect(result).toEqual({ text: '{go:window}{wait}' });
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]!;
    expect(String(url)).toBe('http://gpu:8000/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'tiny', temperature: 0.9, max_tokens: 80, stream: true });
    expect(body.messages).toEqual([
      { role: 'system', content: CONTEXT.system },
      { role: 'user', content: CONTEXT.user },
    ]);
    expect(body.tools).toBeUndefined();
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
  });

  it('follows Thinking by default and tries the backup when the first server is down', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith('http://127.0.0.1:1234')) throw new TypeError('fetch failed');
      return sse('{sit:armchair}');
    }) as unknown as typeof fetch;
    const logger = { warn: vi.fn() };
    const result = await pickIdleActions(CONTEXT, {
      routing: routing({ routes: { llm: { server: 'local-llm', backups: [{ server: 'gpu' }] } } }),
      keyFor: () => undefined,
      fetchFn,
      logger,
    });
    expect(result).toEqual({ text: '{sit:armchair}' });
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('returns null on a server error, an empty reply, a timeout or a bad context', async () => {
    const options = { routing: routing({}), keyFor: () => undefined };
    const failing = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await pickIdleActions(CONTEXT, { ...options, fetchFn: failing, logger: { warn: vi.fn() } })).toBeNull();
    const empty = vi.fn(async () => sse('<think>hmm</think>  ')) as unknown as typeof fetch;
    expect(await pickIdleActions(CONTEXT, { ...options, fetchFn: empty })).toBeNull();
    const hanging = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    ) as unknown as typeof fetch;
    expect(await pickIdleActions(CONTEXT, { ...options, fetchFn: hanging, timeoutMs: 20, logger: { warn: vi.fn() } })).toBeNull();
    const never = vi.fn() as unknown as typeof fetch;
    expect(await pickIdleActions({ system: '', user: 'x' }, { ...options, fetchFn: never })).toBeNull();
    expect(await pickIdleActions(null as never, { ...options, fetchFn: never })).toBeNull();
    expect(never).not.toHaveBeenCalled();
  });

  it('works with injected chat clients and drops thinking blocks', async () => {
    const client: ChatClient = {
      baseUrl: 'x',
      model: 'm',
      flavor: 'llama-server',
      isAvailable: async () => true,
      async *streamChat() {
        yield { type: 'text', text: '<think>plan</think>{look:' };
        yield { type: 'text', text: 'bookshelf}' };
      },
    };
    expect(await pickIdleActions(CONTEXT, { routing: routing({}), keyFor: () => undefined, clients: [client] })).toEqual({
      text: '{look:bookshelf}',
    });
  });
});

describe('idle habits', () => {
  it('trims and caps the text and ignores anything that is not text', () => {
    expect(normalizeIdleHabits('  sits by the window with tea  ')).toBe('sits by the window with tea');
    expect(normalizeIdleHabits('a'.repeat(900))).toHaveLength(MAX_IDLE_HABITS_LENGTH);
    expect(normalizeIdleHabits(undefined)).toBe('');
    expect(normalizeIdleHabits(42)).toBe('');
  });
});

describe('idle settings', () => {
  it('defaults to wandering, normal restlessness and turning where it is', () => {
    expect(parseIdleSettings(null)).toEqual({ enabled: true, restlessness: 'normal', onTalk: 'turn' });
    expect(parseIdleSettings('not json')).toEqual(DEFAULT_IDLE_SETTINGS);
    expect(RESTLESSNESS_MEAN_SECONDS).toEqual({ calm: 180, normal: 90, restless: 40 });
  });

  it('keeps valid fields and falls back per field', () => {
    expect(sanitizeIdleSettings({ enabled: false, restlessness: 'wild', onTalk: 'come-back' })).toEqual({
      enabled: false,
      restlessness: 'normal',
      onTalk: 'come-back',
    });
    expect(sanitizeIdleSettings('x')).toEqual(DEFAULT_IDLE_SETTINGS);
  });

  it('is saved under rooms.idle by the background service', () => {
    const values = new Map<string, string>();
    const service = new BackgroundService({
      store: { getValue: (key) => values.get(key) ?? null, setValue: (key, value) => void values.set(key, value) },
      assetsDirectory: '',
      backgroundsDirectory: '',
      comfy: { isAvailable: async () => false, run: async () => Buffer.alloc(0) } as never,
    });
    expect(service.getIdleSettings()).toEqual(DEFAULT_IDLE_SETTINGS);
    service.setIdleSettings({ enabled: false, restlessness: 'restless', onTalk: 'turn' });
    expect(JSON.parse(values.get('rooms.idle')!)).toEqual({ enabled: false, restlessness: 'restless', onTalk: 'turn' });
    expect(service.getIdleSettings().restlessness).toBe('restless');
    expect(service.setIdleSettings({ restlessness: 'nope' })).toEqual(DEFAULT_IDLE_SETTINGS);
  });
});
