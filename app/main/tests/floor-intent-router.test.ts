import { describe, expect, it, vi } from 'vitest';
import { builtInServers, defaultRoutes, resolveModelRouting } from '../src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';
import { buildIntentPrompt, createIntentRouter, intentSchema, parseIntentAnswer } from '../src/floor/intent-router.js';
import type { IntentInput } from '../src/floor/floor-manager.js';

function routing(routes: Parameters<typeof resolveModelRouting>[2]) {
  return resolveModelRouting(
    builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }),
    defaultRoutes(DEFAULT_PROVIDER_SETTINGS),
    { servers: [{ id: 'gpu', type: 'chat', url: 'http://gpu:8000/v1' }], ...routes },
  );
}

const sse = (text: string): Response =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

const NAMES: Record<string, string> = { echo: 'Echo', sage: 'Sage', rex: 'Rex' };
const speakerName = (from: string) => (from.startsWith('avatar:') ? (NAMES[from.slice(7)] ?? from) : 'Kevin');
const input = (overrides: Partial<IntentInput> = {}): IntentInput => ({
  text: 'Not you, Echo. Sage, what do you think?',
  recent: [],
  candidates: [
    { avatarId: 'echo', name: 'Echo' },
    { avatarId: 'sage', name: 'Sage' },
  ],
  hostId: 'echo',
  partnerId: 'sage',
  ...overrides,
});

describe('buildIntentPrompt', () => {
  it('writes the variant d prompt for a two-avatar scene', () => {
    const prompt = buildIntentPrompt(input(), speakerName);
    expect(prompt.system).toBe(
      [
        'Kevin is talking to avatars in a room. Read his last line and fill in three fields.',
        '"addressed": the avatar Kevin is speaking TO in this line, the one who should act on it. It is NOT the avatar he wants them to go and talk to, ask, or talk about. Use "everyone" when he speaks to all of them. Use "unclear" when the line names no one as the listener (then the app picks).',
        '"wants": "answer" = just reply to Kevin; "converse" = go and have a conversation with another avatar; "relay" = ask or tell another avatar something for Kevin.',
        '"other": that other avatar when wants is converse or relay, else "none".',
        'Examples from another room (avatars: Mira (host), Tobin):',
        'Kevin: "Tobin, did you sleep well?" -> {"addressed": "tobin", "wants": "answer", "other": "none"}',
        'Kevin: "Is it cold out?" -> {"addressed": "unclear", "wants": "answer", "other": "none"}',
        'Kevin: "Mira, go and chat with Tobin for a bit." -> {"addressed": "mira", "wants": "converse", "other": "tobin"}',
        'Kevin: "Why not have a natter with Tobin?" -> {"addressed": "unclear", "wants": "converse", "other": "tobin"}',
        'Kevin: "Tobin, find out if Mira is hungry." -> {"addressed": "tobin", "wants": "relay", "other": "mira"}',
        'Kevin: "Mira, is Tobin always this grumpy?" -> {"addressed": "mira", "wants": "answer", "other": "none"}',
        'Now the actual room: Echo (host), Sage. Kevin last spoke with Sage.',
        'Allowed values, lower case: addressed = echo | sage | everyone | unclear; wants = answer | converse | relay; other = echo | sage | none.',
        'Reply with only a JSON object: {"addressed": "...", "wants": "...", "other": "..."}',
      ].join('\n'),
    );
    expect(prompt.user).toBe('Kevin: Not you, Echo. Sage, what do you think?');
  });

  it('says nobody when Kevin has not spoken with anyone, and marks the host wherever it sits', () => {
    const prompt = buildIntentPrompt(input({ partnerId: null, hostId: 'sage' }), speakerName);
    expect(prompt.system).toContain('Now the actual room: Echo, Sage (host). Kevin last spoke with nobody yet.');
  });

  it('puts the last four recent lines before Kevin, as Name: text, each clipped to 200 characters', () => {
    const recent = [
      { from: 'person:kevin' as const, text: 'one' },
      { from: 'avatar:echo' as const, text: 'two' },
      { from: 'person:kevin' as const, text: 'three' },
      { from: 'avatar:sage' as const, text: `four\n  ${'x'.repeat(300)}` },
      { from: 'avatar:echo' as const, text: 'five' },
    ];
    const lines = buildIntentPrompt(input({ recent, text: 'Hello  there' }), speakerName).user.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('Echo: two');
    expect(lines[1]).toBe('Kevin: three');
    expect(lines[2]).toMatch(/^Sage: four x{10}/);
    expect(lines[2].length).toBe('Sage: '.length + 200 + 1);
    expect(lines[2].endsWith('…')).toBe(true);
    expect(lines[3]).toBe('Echo: five');
    expect(lines[4]).toBe('Kevin: Hello there');
  });

  it('keys options by lower-case name, made unique, and builds enums from them', () => {
    const prompt = buildIntentPrompt(
      input({
        candidates: [
          { avatarId: 'a1', name: 'Sage' },
          { avatarId: 'a2', name: 'sage' },
          { avatarId: 'a3', name: 'Everyone' },
        ],
        hostId: 'a1',
        partnerId: 'a2',
      }),
      speakerName,
    );
    expect([...prompt.keys.entries()].map(([key, candidate]) => [key, candidate.avatarId])).toEqual([
      ['sage', 'a1'],
      ['sage 2', 'a2'],
      ['everyone 2', 'a3'],
    ]);
    expect(prompt.schema).toEqual(intentSchema(['sage', 'sage 2', 'everyone 2']));
    expect(prompt.system).toContain('addressed = sage | sage 2 | everyone 2 | everyone | unclear');
  });

  it('builds a strict schema with the three fields', () => {
    expect(intentSchema(['echo', 'sage'])).toEqual({
      type: 'object',
      properties: {
        addressed: { type: 'string', enum: ['echo', 'sage', 'everyone', 'unclear'] },
        wants: { type: 'string', enum: ['answer', 'converse', 'relay'] },
        other: { type: 'string', enum: ['echo', 'sage', 'none'] },
      },
      required: ['addressed', 'wants', 'other'],
      additionalProperties: false,
    });
  });
});

describe('parseIntentAnswer', () => {
  const keys = buildIntentPrompt(input(), speakerName).keys;
  it('maps names back to avatar ids and none to null', () => {
    expect(parseIntentAnswer('{"addressed": "sage", "wants": "answer", "other": "none"}', keys)).toEqual({ addressed: 'sage', wants: 'answer', other: null });
    expect(parseIntentAnswer('{"addressed":"Echo","wants":"CONVERSE","other":"Sage"}', keys)).toEqual({ addressed: 'echo', wants: 'converse', other: 'sage' });
    expect(parseIntentAnswer('{"addressed":"everyone","wants":"answer","other":null}', keys)).toEqual({ addressed: 'everyone', wants: 'answer', other: null });
    // A missing or empty "other" means none.
    expect(parseIntentAnswer('{"addressed": "sage", "wants": "answer"}', keys)).toEqual({ addressed: 'sage', wants: 'answer', other: null });
    expect(parseIntentAnswer('{"addressed": "sage", "wants": "answer", "other": ""}', keys)?.other).toBeNull();
    expect(parseIntentAnswer('{"addressed":"unclear","wants":"relay","other":"echo"}', keys)).toEqual({ addressed: 'unclear', wants: 'relay', other: 'echo' });
  });

  it('tolerates think blocks, code fences and text around the object', () => {
    const answer = '{"addressed": "sage", "wants": "relay", "other": "echo"}';
    expect(parseIntentAnswer(`<think>hmm {x}</think>\n\`\`\`json\n${answer}\n\`\`\``, keys)).toEqual({ addressed: 'sage', wants: 'relay', other: 'echo' });
    expect(parseIntentAnswer(`Sure: ${answer} done`, keys)?.wants).toBe('relay');
  });

  it('rejects anything outside the lists or missing a field', () => {
    for (const bad of [
      '',
      'no json here',
      '{"addressed": "rex", "wants": "answer", "other": "none"}',
      '{"addressed": "sage", "wants": "shout", "other": "none"}',
      '{"addressed": "sage", "wants": "answer", "other": "rex"}',
      '{"wants": "answer", "other": "none"}',
      '{"addressed": 3, "wants": "answer", "other": "none"}',
      '[1,2]',
    ]) {
      expect([bad, parseIntentAnswer(bad, keys)]).toEqual([bad, null]);
    }
  });
});

describe('createIntentRouter', () => {
  const answer = '{"addressed": "sage", "wants": "answer", "other": "none"}';
  const signal = () => new AbortController().signal;

  it('makes one request on the idle route with the schema, temperature 0, 60 tokens and thinking off', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => sse(answer)) as unknown as typeof fetch;
    const route = createIntentRouter({ routing: () => routing({ routes: { idle: { server: 'gpu', model: 'tiny' } } }), keyFor: () => 'k', nameOf: (id) => NAMES[id] ?? id, fetchFn });
    const result = await route(input(), signal());
    expect(result).toEqual({ addressed: 'sage', wants: 'answer', other: null });
    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchFn).mock.calls[0]!;
    expect(String(url)).toBe('http://gpu:8000/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'tiny', temperature: 0, max_tokens: 60, chat_template_kwargs: { enable_thinking: false } });
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'floor_intent', strict: true } });
    expect(body.response_format.json_schema.schema.properties.addressed.enum).toEqual(['echo', 'sage', 'everyone', 'unclear']);
    expect(body.tools).toBeUndefined();
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
  });

  it('retries once with json_object on HTTP 400, then without a format', async () => {
    const formats: unknown[] = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      formats.push(body.response_format?.type);
      return formats.length < 3 ? new Response('bad format', { status: 400 }) : sse(answer);
    }) as unknown as typeof fetch;
    const route = createIntentRouter({ routing: () => routing({ routes: { idle: { server: 'gpu' } } }), keyFor: () => undefined, nameOf: (id) => id, fetchFn });
    expect(await route(input(), signal())).toEqual({ addressed: 'sage', wants: 'answer', other: null });
    expect(formats).toEqual(['json_schema', 'json_object', undefined]);
  });

  it('retries with json_object only on a 400', async () => {
    const fetchFn = vi.fn(async () => new Response('down', { status: 500 })) as unknown as typeof fetch;
    const route = createIntentRouter({ routing: () => routing({ routes: { idle: { server: 'gpu' } } }), keyFor: () => undefined, nameOf: (id) => id, fetchFn });
    await expect(route(input(), signal())).rejects.toThrow(/HTTP 500/);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('rejects an unusable or out-of-list answer', async () => {
    for (const text of ['I think Sage.', '{"addressed": "rex", "wants": "answer", "other": "none"}']) {
      const fetchFn = vi.fn(async () => sse(text)) as unknown as typeof fetch;
      const route = createIntentRouter({ routing: () => routing({ routes: { idle: { server: 'gpu' } } }), keyFor: () => undefined, nameOf: (id) => id, fetchFn });
      await expect(route(input(), signal())).rejects.toThrow('made no sense');
    }
  });

  it('rejects when no model is configured', async () => {
    const route = createIntentRouter({ nameOf: (id) => id });
    await expect(route(input(), signal())).rejects.toThrow('No idle model');
  });

  it('shows recent speakers by name in the user message', async () => {
    const bodies: Array<{ messages: Array<{ content: string }> }> = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sse(answer);
    }) as unknown as typeof fetch;
    const route = createIntentRouter({ routing: () => routing({ routes: { idle: { server: 'gpu' } } }), keyFor: () => undefined, nameOf: (id) => NAMES[id] ?? id, fetchFn });
    await route(input({ recent: [{ from: 'avatar:echo', text: 'Hello Kevin.' }], text: 'Tell me about Sage.' }), signal());
    expect(bodies[0].messages[1].content).toBe('Echo: Hello Kevin.\nKevin: Tell me about Sage.');
  });
});
