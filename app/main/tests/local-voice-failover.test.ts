import { describe, expect, it, vi } from 'vitest';
import { builtInServers, defaultRoutes, resolveModelRouting } from '../src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';
import { createRoutedSearchProvider } from '../src/tools/web-search.js';
import { buildVoiceEngines, FailoverChatClient, FailoverStt, type ChatClient } from '../src/local-voice/voice-engines.js';
import { createChatCompletionsResponsesClient, toChatMessages } from '../src/openai/chat-completions-responses.js';

function sse(text: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('backup servers for talking', () => {
  it('sends a reply to the backup chat server when the first one is down', async () => {
    const routing = resolveModelRouting(
      builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }),
      defaultRoutes(DEFAULT_PROVIDER_SETTINGS),
      {
        servers: [{ id: 'gpu', type: 'chat', url: 'http://gpu:8000/v1' }],
        routes: { llm: { server: 'local-llm', model: 'qwen', backups: [{ server: 'gpu' }] } },
      },
    );
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:1234')) throw new TypeError('fetch failed');
      expect(JSON.parse(String(init?.body)).model).toBe('qwen');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer rack-key');
      return sse('Hello from the rack.');
    }) as unknown as typeof fetch;
    const { llm } = buildVoiceEngines(routing, (id) => (id === 'gpu' ? 'rack-key' : undefined), { fetchFn, logger: { warn: vi.fn() } });
    const parts = [];
    for await (const part of llm.streamChat([{ role: 'user', content: 'hi' }])) parts.push(part);
    expect(parts).toEqual([{ type: 'text', text: 'Hello from the rack.' }]);
    expect(llm.baseUrl).toBe('http://gpu:8000/v1');
  });

  it('does not retry elsewhere once a reply has started, or after the user stops it', async () => {
    const failing: ChatClient = {
      baseUrl: 'a',
      model: 'm',
      flavor: 'llama-server',
      isAvailable: async () => true,
      async *streamChat() {
        yield { type: 'text', text: 'Half a' };
        throw new Error('connection reset');
      },
    };
    const backup = { ...failing, baseUrl: 'b', streamChat: vi.fn() };
    const chat = new FailoverChatClient([failing, backup as unknown as ChatClient]);
    const consume = async () => {
      for await (const part of chat.streamChat([])) void part;
    };
    await expect(consume()).rejects.toThrow('connection reset');
    expect(backup.streamChat).not.toHaveBeenCalled();

    const stopped = new FailoverStt([
      { transcribe: vi.fn(async () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))), status: vi.fn() },
      { transcribe: vi.fn(), status: vi.fn() },
    ]);
    await expect(stopped.transcribe(new Uint8Array())).rejects.toThrow('aborted');
  });
});

describe('web search servers', () => {
  it('tries each picked server in order and leaves out Brave without a key', () => {
    const warn = vi.fn();
    expect(createRoutedSearchProvider([{ type: 'brave', url: 'https://api.search.brave.com' }], { warn })).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(createRoutedSearchProvider([{ type: 'search', url: 'http://a:8888' }])?.name).toBe('searxng');
    expect(createRoutedSearchProvider([{ type: 'search', url: 'http://a:8888' }, { type: 'brave', url: '', key: 'k' }])?.name).toContain('brave');
  });
});

describe('helper jobs on a chat server', () => {
  it('turns a Responses request into a chat completion with images and a JSON schema', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('gemma');
      expect(body.messages).toEqual([
        { role: 'system', content: 'Describe it.' },
        { role: 'user', content: [{ type: 'text', text: 'This one:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] },
      ]);
      expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'pose', schema: { type: 'object' }, strict: true } });
      return new Response(JSON.stringify({ choices: [{ message: { content: '<think>hmm</think>{"ok":true}' } }] }));
    }) as unknown as typeof fetch;
    const client = createChatCompletionsResponsesClient({ baseUrl: 'http://gpu:8000/v1/', model: 'gemma', fetchFn });
    const reply = await client.responses.create({
      model: 'gpt-4o',
      input: [
        { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Describe it.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'This one:' }, { type: 'input_image', image_url: 'data:image/png;base64,x' }] },
      ],
      text: { format: { type: 'json_schema', name: 'pose', schema: { type: 'object' }, strict: true } },
    });
    expect(reply.output_text).toBe('{"ok":true}');
    expect(toChatMessages({ instructions: 'Be brief.', input: 'hi' })).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('explains a server error', async () => {
    const fetchFn = vi.fn(async () => new Response('model not loaded', { status: 503 })) as unknown as typeof fetch;
    const client = createChatCompletionsResponsesClient({ baseUrl: 'http://gpu/v1', fetchFn });
    await expect(client.responses.create({ input: 'hi' })).rejects.toThrow('The chat server at http://gpu/v1 answered 503: model not loaded');
  });
});
