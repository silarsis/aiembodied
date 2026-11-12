import { describe, expect, it, vi } from 'vitest';
import { validateLayout, normaliseCategory, LayoutError } from '../src/rooms/room-layout.js';
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
    ['bad size', { ...good, objects: [{ name: 'x', category: 'prop', size: [1, 1] }] }, /size/],
    ['only unusable objects', { ...good, objects: [{ category: 'prop', size: [1, 1, 1] }, 'junk'] }, /objects\[0\]\.name/],
  ])('rejects %s', (_name, input, message) => {
    expect(() => validateLayout(input)).toThrow(LayoutError);
    expect(() => validateLayout(input)).toThrow(message);
  });
});

describe('free-form categories', () => {
  it('keeps known categories as they are', () => {
    expect(normaliseCategory(' Seat ')).toEqual({ category: 'seat' });
    expect(normaliseCategory('appliance', 'fridge')).toEqual({ category: 'appliance' });
  });
  it.each([
    ['sofa', 'big sofa', 'seat'],
    ['armchairs', 'armchair', 'seat'],
    ['Bookcase', 'tall bookcase', 'storage'],
    ['rug', 'round rug', 'decor'],
    ['lighting', 'floor lamp', 'lamp'],
    ['electronics', 'record player', 'appliance'],
    ['furniture', 'coffee table', 'table'],
    ['item', 'paperback book', 'prop'],
    ['aquarium', 'fish tank', 'prop'],
    ['spaceship', 'model spaceship', 'prop'],
  ])('maps %s to a known category and keeps the word as its label', (word, name, category) => {
    expect(normaliseCategory(word, name)).toEqual({ category, label: word.toLowerCase() });
  });
  it('falls back to the name, then to prop', () => {
    expect(normaliseCategory('thingamajig', 'reading lamp')).toEqual({ category: 'lamp', label: 'thingamajig' });
    expect(normaliseCategory(undefined, 'coffee table')).toEqual({ category: 'table' });
    expect(normaliseCategory(42, 'box')).toEqual({ category: 'prop' });
  });
  it('accepts any category in a layout and keeps the behaviour of the mapped one', () => {
    const layout = validateLayout({
      ...good,
      objects: [
        { name: 'loveseat', category: 'couch', size: [1.5, 0.8, 0.8], seat_height: '0.42' },
        { name: 'fish tank', category: 'aquarium', size: [1, 0.6, 0.4] },
        { name: 'desk', category: 'table', size: [1.2, 0.75, 0.6] },
      ],
    });
    expect(layout.objects.map((o) => [o.category, o.label])).toEqual([
      ['seat', 'couch'],
      ['prop', 'aquarium'],
      ['table', undefined],
    ]);
    expect(layout.objects[0].seatHeight).toBeCloseTo(0.42);
    expect('label' in layout.objects[2]).toBe(false);
  });
});

describe('lenient validation', () => {
  it('leaves out an unusable object instead of failing the room, and says so', () => {
    const notes: string[] = [];
    const layout = validateLayout(
      {
        ...good,
        objects: [
          ...good.objects,
          { name: 'ghost chair', category: 'seat', size: [1, 1] },
          { category: 'prop', size: [1, 1, 1] },
          'not an object',
          { name: 'stool', category: 'seat', size: [0.4, 'tall', 0.4] },
        ],
      },
      notes,
    );
    expect(layout.objects.map((o) => o.id)).toEqual(['desk', 'lamp']);
    expect(notes).toHaveLength(4);
    expect(notes[0]).toMatch(/objects\[2\]\.size/);
  });
  it('treats bad walls as none instead of failing', () => {
    const notes: string[] = [];
    const layout = validateLayout(
      {
        ...good,
        shell: { ...good.shell, windows: [{ wall: 'up', width: 1 }, { wall: 'south', width: 'wide' }], door: { wall: 'up' } },
        objects: [{ name: 'shelf', category: 'storage', size: [1, 2, 0.4], place: { against: 'ceiling' }, seat_height: 'n/a' }],
      },
      notes,
    );
    expect(layout.shell.door).toBeNull();
    expect(layout.shell.windows).toEqual([{ wall: 'south', width: 1.4 }]);
    expect(layout.objects[0].place.against).toBeNull();
    expect(layout.objects[0].seatHeight).toBeNull();
    expect(notes).toHaveLength(2);
  });
});

describe('seat size clamp', () => {
  const read = (entry: object) =>
    validateLayout({ ...good, objects: [{ category: 'seat', size: [1, 0.9, 1], ...entry }] }).objects[0];
  it('limits armchair width and depth and the seat height, keeping the back height', () => {
    const chair = read({ name: 'armchair', size: [1.8, 1.2, 1.6], seat_height: 0.7 });
    expect(chair.size).toEqual([1, 1.2, 0.95]);
    expect(chair.seatHeight).toBe(0.55);
    expect(read({ name: 'chair', size: [0.5, 0.9, 0.5], seat_height: 0.2 }).seatHeight).toBe(0.35);
  });
  it('lets sofas, couches and benches be wide, up to 2.4 m', () => {
    expect(read({ name: 'big sofa', size: [3.5, 0.9, 1.4] }).size).toEqual([2.4, 0.9, 0.95]);
    expect(read({ name: 'Park Bench', size: [1.8, 0.8, 0.5] }).size).toEqual([1.8, 0.8, 0.5]);
  });
  it('leaves an absent seat height absent and other categories alone', () => {
    expect(read({ name: 'stool' }).seatHeight).toBeNull();
    const bed = validateLayout({ ...good, objects: [{ name: 'bed', category: 'bed', size: [2, 0.6, 2.2], seat_height: 0.6 }] }).objects[0];
    expect(bed.size).toEqual([2, 0.6, 2.2]);
    expect(bed.seatHeight).toBe(0.6);
  });
  it('is part of the prompt', () => {
    expect(buildLayoutPrompt('a room').system).toContain('seat height about 0.45 m');
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
