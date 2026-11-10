import { describe, expect, it, vi } from 'vitest';
import { AvatarDescriptionService } from '../src/avatar/avatar-description-service.js';
import { createChatCompletionsResponsesClient } from '../src/openai/chat-completions-responses.js';

describe('AvatarDescriptionService on a chat server', () => {
  it('sends the thumbnail as an image_url part with a short, low-temperature reply on /chat/completions', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'A friendly anime girl in a school uniform.' } }] }), { status: 200 }));
    const client = createChatCompletionsResponsesClient({ baseUrl: 'http://127.0.0.1:1237/v1', model: 'qwen3-vl', fetchFn: fetchFn as unknown as typeof fetch });
    const service = new AvatarDescriptionService({ client: client as never, model: 'qwen3-vl' });
    await expect(service.generateDescription('data:image/png;base64,AAAA')).resolves.toBe('A friendly anime girl in a school uniform.');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('http://127.0.0.1:1237/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('qwen3-vl');
    expect(body.max_tokens).toBe(300);
    expect(body.temperature).toBe(0.3);
    const user = body.messages.find((message: { role: string }) => message.role === 'user');
    expect(user.content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  });

  it('rejects a thumbnail that is not an image data URL', async () => {
    const service = new AvatarDescriptionService({ client: { responses: { create: vi.fn() } } as never });
    await expect(service.generateDescription('http://x/y.png')).rejects.toThrow('Invalid thumbnail');
  });
});
