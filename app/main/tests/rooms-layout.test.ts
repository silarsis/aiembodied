import { describe, expect, it, vi } from 'vitest';
import { validateLayout, LayoutError } from '../src/rooms/room-layout.js';
import { buildLayoutPrompt } from '../src/rooms/room-layout-prompt.js';
import { extractJson, generateRoomLayout } from '../src/rooms/room-layout-llm.js';
import { builtInServers, defaultRoutes, resolveModelRouting } from '../src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';
import { resolveColor } from '../src/rooms/room-palette.js';
import type { ChatClient } from '../src/local-voice/voice-engines.js';

const good = {
  name: 'Study',
  shell: { width: 12, depth: 4, height: 2.8, floor: 'oak', walls: 'cream', windows: [{ wall: 'north', width: 1.5 }], door: { wall: 'east' } },
  lighting: 'Warm evening light',
  objects: [
    { id: 'Desk', name: 'desk', search: 'desk', category: 'table', size: [1.4, 0.75, 0.7], place: { against: 'north', near: null, on: null, facing: null, corner: false }, surface: true },
    { id: 'lamp', name: 'lamp', category: 'lamp', size: [0.3, 0.5, 0.3], place: { on: 'desk', near: 'ghost' } },
  ],
};

describe('validateLayout', () => {
  it('normalises: clamps the shell, slugs ids, maps lighting, drops unknown references', () => {
    const layout = validateLayout(structuredClone(good));
    expect(layout.shell.width).toBe(10);
    expect(layout.objects.map((o) => o.id)).toEqual(['desk', 'lamp']);
    expect(layout.lighting).toBe('warm evening');
    expect(layout.objects[1].place).toMatchObject({ on: 'desk', near: null, against: null });
    expect(layout.objects[1].search).toBe('lamp');
  });
  it('limits to 14 objects', () => {
    const many = { ...good, objects: Array.from({ length: 20 }, (_, i) => ({ name: `box ${i}`, category: 'prop', size: [0.2, 0.2, 0.2] })) };
    expect(validateLayout(many).objects).toHaveLength(14);
  });
  it.each([
    ['not an object', 'nope', /JSON object/],
    ['no shell', { objects: good.objects }, /shell/],
    ['no objects', { ...good, objects: [] }, /objects/],
    ['bad category', { ...good, objects: [{ name: 'x', category: 'spaceship', size: [1, 1, 1] }] }, /category/],
    ['bad size', { ...good, objects: [{ name: 'x', category: 'prop', size: [1, 1] }] }, /size/],
    ['bad wall', { ...good, shell: { ...good.shell, door: { wall: 'up' } } }, /wall/],
  ])('rejects %s', (_name, input, message) => {
    expect(() => validateLayout(input)).toThrow(LayoutError);
    expect(() => validateLayout(input)).toThrow(message);
  });
});

describe('prompt and palette', () => {
  it('lists the categories, the lighting presets, the limit and a complete example', () => {
    const { system, user } = buildLayoutPrompt('  a messy attic ');
    for (const word of ['seat', 'appliance', 'warm evening', 'at most 14', '"coffee_table"', 'seat_height']) expect(system).toContain(word);
    expect(user).toBe('Design this room: a messy attic');
    const example = system.slice(system.indexOf('{"name"'));
    expect(() => validateLayout(JSON.parse(example))).not.toThrow();
  });
  it('maps colour words and accepts hex', () => {
    expect(resolveColor('warm oak')).toMatch(/^#/);
    expect(resolveColor('#ABC')).toBe('#abc');
    expect(resolveColor('very dark navy')).toBe(resolveColor('navy'));
    expect(resolveColor('zzz', '#123456')).toBe('#123456');
  });
});

describe('extractJson', () => {
  it('strips think blocks, fences and chatter', () => {
    expect(extractJson('<think>hm {x}</think>Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('sure {"a":2} done')).toEqual({ a: 2 });
    expect(() => extractJson('no json')).toThrow(LayoutError);
    expect(() => extractJson('{"a":')).toThrow(LayoutError);
  });
});

function client(replies: Array<string | Error>, calls: unknown[][] = []): ChatClient {
  return {
    baseUrl: 'x', model: 'm', flavor: 'llama-server',
    isAvailable: async () => true,
    async *streamChat(messages) {
      calls.push(messages);
      const next = replies.shift();
      if (next instanceof Error) throw next;
      yield { type: 'text', text: next ?? '' };
    },
  };
}

describe('generateRoomLayout', () => {
  it('returns the validated layout from one request', async () => {
    const calls: unknown[][] = [];
    const layout = await generateRoomLayout('study', { routing: undefined as never, keyFor: () => undefined, makeClients: () => [client([JSON.stringify(good)], calls)] });
    expect(layout.name).toBe('Study');
    expect(calls).toHaveLength(1);
  });
  it('retries once with the validation error, then succeeds', async () => {
    const calls: Array<Array<{ role: string; content: string }>> = [];
    const c = client(['{"name":"x"}', JSON.stringify(good)], calls as unknown[][]);
    const layout = await generateRoomLayout('study', { routing: undefined as never, keyFor: () => undefined, makeClients: () => [c] });
    expect(layout.objects).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1].at(-1)?.content).toMatch(/could not be used: "shell"/);
  });
  it('fails clearly after the retry', async () => {
    const c = client(['nope', 'still nope']);
    await expect(generateRoomLayout('study', { routing: undefined as never, keyFor: () => undefined, makeClients: () => [c], logger: { warn: vi.fn() } })).rejects.toThrow(/did not return a usable layout/);
  });
  it('falls back to a plain request when JSON mode is rejected', async () => {
    const modes: boolean[] = [];
    const layout = await generateRoomLayout('study', {
      routing: undefined as never,
      keyFor: () => undefined,
      makeClients: (json) => {
        modes.push(json);
        return [client([json ? new Error('Local LLM request failed: HTTP 400 response_format') : JSON.stringify(good)])];
      },
    });
    expect(layout.name).toBe('Study');
    expect(modes).toEqual([true, false]);
  });
  it('sends response_format and the layout settings through the real client', async () => {
    const routing = resolveModelRouting(builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), {
      servers: [{ id: 'gpu', type: 'chat', url: 'http://gpu:8000/v1' }],
      routes: { scenelayout: { server: 'gpu', model: 'big' } },
    });
    const fetchFn = vi.fn(async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(good) } }] })}\n\ndata: [DONE]\n\n`, { status: 200 })) as unknown as typeof fetch;
    await generateRoomLayout('study', { routing, keyFor: () => undefined, fetchFn });
    const body = JSON.parse(String(vi.mocked(fetchFn).mock.calls[0][1]?.body));
    expect(body).toMatchObject({ model: 'big', temperature: 0.4, max_tokens: 2500, response_format: { type: 'json_object' } });
  });
  it('follows Thinking by default', () => {
    const routing = resolveModelRouting(builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), {
      servers: [{ id: 'gpu', type: 'chat', url: 'http://gpu:8000/v1' }],
      routes: { llm: { server: 'gpu', model: 'qwen', backups: [{ server: 'openai' }] } },
    });
    expect(routing.routes.scenelayout).toEqual(routing.routes.llm);
  });
});
