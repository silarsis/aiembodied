import { describe, expect, it, vi } from 'vitest';
import { ComfyUIClient } from '../src/avatar/generation/comfyui-client.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('ComfyUIClient', () => {
  it('queues a graph, polls history, and downloads the saved image', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({ prompt_id: 'p1' }))
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(
        json({
          p1: {
            status: { completed: true },
            outputs: { save: { images: [{ filename: 'a.png', subfolder: 'aiembodied', type: 'output' }] } },
          },
        }),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const client = new ComfyUIClient({ baseUrl: 'http://comfy.test/', fetchFn, sleep: async () => undefined });

    const bytes = await client.run({ save: { class_type: 'SaveImage', inputs: {} } });

    expect([...bytes]).toEqual([1, 2, 3]);
    expect(fetchFn.mock.calls[0][0]).toBe('http://comfy.test/prompt');
    expect(JSON.parse(fetchFn.mock.calls[0][1].body as string).prompt).toHaveProperty('save');
    expect(fetchFn.mock.calls[1][0]).toBe('http://comfy.test/history/p1');
    expect(fetchFn.mock.calls[3][0]).toBe('http://comfy.test/view?filename=a.png&subfolder=aiembodied&type=output');
  });

  it('surfaces workflow errors', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(json({ prompt_id: 'p1' }))
      .mockResolvedValueOnce(json({ p1: { status: { status_str: 'error', messages: ['out of memory'] } } }));
    const client = new ComfyUIClient({ baseUrl: 'http://comfy.test', fetchFn, sleep: async () => undefined });

    await expect(client.run({})).rejects.toThrow(/out of memory/);
  });

  it('reports rejected workflows', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response('node missing', { status: 400 }));
    const client = new ComfyUIClient({ baseUrl: 'http://comfy.test', fetchFn });

    await expect(client.run({})).rejects.toThrow(/rejected the workflow: node missing/);
  });

  it('uploads images and returns the LoadImage name', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(json({ name: 'crop.png', subfolder: 'aiembodied' }));
    const client = new ComfyUIClient({ baseUrl: 'http://comfy.test', fetchFn });

    await expect(client.uploadImage('crop.png', Buffer.from('png'))).resolves.toBe('aiembodied/crop.png');
    const form = fetchFn.mock.calls[0][1].body as FormData;
    expect(form.get('type')).toBe('input');
    expect((form.get('image') as File).name).toBe('crop.png');
  });

  it('treats an unreachable server as unavailable', async () => {
    const client = new ComfyUIClient({
      baseUrl: 'http://comfy.test',
      fetchFn: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    await expect(client.isAvailable()).resolves.toBe(false);
  });
});
