import { describe, expect, it, vi } from 'vitest';
import { builtInServers, defaultRoutes, resolveModelRouting } from '../src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';
import { createSystemOne, readAnswer, SystemOneClient } from '../src/decide/system-one.js';

const routing = (stored = {}) =>
  resolveModelRouting(builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), stored);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const questions = {
  who: { type: 'choice', instructions: 'Who?', criteria: { echo: 'Echo', sage: 'Sage' } },
  want: { type: 'score', instructions: 'How much?', criteria: ['no', 'a bit', 'yes'] },
  yes: { type: 'noul', instructions: 'Is it?' },
} as const;

const answers = {
  model: 'english',
  answers: {
    who: { type: 'choice', choice: 'sage', probabilities: { echo: 0.1, sage: 0.9 } },
    want: { type: 'score', score: 1.5, probabilities: { '0': 0, '1': 0.5, '2': 0.5 }, legend: {} },
    yes: { type: 'noul', noul: 0.25 },
  },
  usage: { input_tokens: 10, output_tokens: 0 },
};

describe('SystemOneClient', () => {
  it('posts the state and questions to /v1/systemone and returns typed answers', async () => {
    const fetchFn = vi.fn(async () => json(answers));
    const client = new SystemOneClient({ routing: routing(), fetchFn: fetchFn as unknown as typeof fetch });
    const result = await client.ask({ line: 'hi' }, questions);
    expect(result).toEqual({ who: { echo: 0.1, sage: 0.9 }, want: 0.75, yes: 0.25 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8197/v1/systemone');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'english', state: { line: 'hi' }, questions });
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('sends the route model and the server key', async () => {
    const fetchFn = vi.fn(async () => json(answers));
    const client = new SystemOneClient({
      routing: routing({ routes: { decide: { server: 'local-laya', model: 'multilingual' } } }),
      keyFor: (id) => (id === 'local-laya' ? 'secret' : undefined),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    await client.ask({}, questions);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).model).toBe('multilingual');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
  });

  it('tries the backup when the first server fails', async () => {
    const fetchFn = vi.fn(async (url: string) => (url.startsWith('http://down') ? json({}, 500) : json(answers)));
    const warn = vi.fn();
    const client = new SystemOneClient({
      routing: routing({
        servers: [{ id: 'a', type: 'systemone', url: 'http://down:1' }, { id: 'b', type: 'systemone', url: 'http://up:2' }],
        routes: { decide: { server: 'a', backups: [{ server: 'b' }] } },
      }),
      fetchFn: fetchFn as unknown as typeof fetch,
      logger: { warn },
    });
    await expect(client.ask({}, questions)).resolves.toMatchObject({ yes: 0.25 });
    expect(fetchFn.mock.calls.map((call) => call[0])).toEqual(['http://down:1/v1/systemone', 'http://up:2/v1/systemone']);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('rejects when every server fails or the answer has the wrong shape', async () => {
    const bad = new SystemOneClient({ routing: routing(), fetchFn: (async () => json({ answers: { who: {} } })) as unknown as typeof fetch });
    await expect(bad.ask({}, questions)).rejects.toThrow();
    const down = new SystemOneClient({ routing: routing(), fetchFn: (async () => { throw new Error('refused'); }) as unknown as typeof fetch });
    await expect(down.ask({}, questions)).rejects.toThrow('refused');
  });

  it('stops at once when the caller aborts', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      controller.abort();
      init.signal?.throwIfAborted();
      return json(answers);
    });
    const client = new SystemOneClient({ routing: routing({ servers: [{ id: 'b', type: 'systemone', url: 'http://up:2' }], routes: { decide: { server: 'local-laya', backups: [{ server: 'b' }] } } }), fetchFn: fetchFn as unknown as typeof fetch });
    await expect(client.ask({}, questions, { signal: controller.signal })).rejects.toBeTruthy();
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('times out a server that does not answer', async () => {
    const fetchFn = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('timed out')))));
    const client = new SystemOneClient({ routing: routing(), fetchFn: fetchFn as unknown as typeof fetch });
    await expect(client.ask({}, questions, { timeoutMs: 20 })).rejects.toThrow('timed out');
  });
});

describe('createSystemOne', () => {
  it('is null when the route is off', () => {
    expect(createSystemOne({ routing: routing({ routes: { decide: { server: '' } } }) })).toBeNull();
    expect(createSystemOne({ routing: routing() })).not.toBeNull();
  });
});

describe('readAnswer', () => {
  it('clamps scores and probabilities into 0..1', () => {
    expect(readAnswer(questions.want, { score: 9 })).toBe(1);
    expect(readAnswer(questions.yes, { noul: -1 })).toBe(0);
    expect(readAnswer(questions.who, { probabilities: { echo: 2 } })).toEqual({ echo: 1, sage: 0 });
  });
});
