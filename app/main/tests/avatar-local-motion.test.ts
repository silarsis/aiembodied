import { describe, expect, it, vi } from 'vitest';
import { LocalMotionClient } from '../src/avatar/motion/local-motion-client.js';
import {
  LocalMotionGenerationService,
  sanitizeRestSkeleton,
  toSlug,
} from '../src/avatar/motion/local-motion-generation-service.js';
import type { VrmaSchema } from '../src/avatar/vrma-schema.js';
import type {
  AvatarAnimationUploadRequest,
  AvatarMotionChunkEvent,
  AvatarRestSkeleton,
} from '../src/avatar/types.js';

function sampleVrma(name: string): VrmaSchema {
  return {
    meta: { name, fps: 30, loop: false, duration: 1, kind: 'ardy' },
    tracks: [
      {
        bone: 'rightUpperArm',
        keyframes: [
          { t: 0, q: [0, 0, 0, 1] },
          { t: 1, q: [0, 0, 0.38, 0.92] },
        ],
      },
    ],
    hips: { position: { keyframes: [{ t: 0, p: [0, 1, 0] }] } },
    expressions: [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** An NDJSON response whose bytes arrive in awkward pieces, splitting lines mid-way. */
function ndjsonResponse(lines: unknown[], pieceSize = 17): Response {
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += pieceSize) {
        controller.enqueue(bytes.slice(i, i + pieceSize));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
}

describe('LocalMotionClient', () => {
  it('reports health from the service', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ status: 'ok', backend: 'ardy', device: 'cuda:0', ready: true }));
    const client = new LocalMotionClient({ baseUrl: 'http://127.0.0.1:8190/', fetchFn });

    await expect(client.health()).resolves.toEqual({ status: 'ok', backend: 'ardy', device: 'cuda:0', ready: true });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8190/health');
  });

  it('returns null health when the service is unreachable', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const client = new LocalMotionClient({ baseUrl: 'http://127.0.0.1:8190', fetchFn });

    await expect(client.health()).resolves.toBeNull();
  });

  it('posts clip requests and validates the returned VRMA', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ vrma: sampleVrma('wave-hello'), timings: { totalMs: 1900, bogus: 'x' } }));
    const client = new LocalMotionClient({ baseUrl: 'http://127.0.0.1:8190', fetchFn });

    const clip = await client.generateClip({ prompt: 'wave hello', duration: 3 });

    expect(clip.vrma.meta.name).toBe('wave-hello');
    expect(clip.timings).toEqual({ totalMs: 1900 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8190/v1/motion/clip');
    expect(JSON.parse(init.body as string)).toEqual({ prompt: 'wave hello', duration: 3 });
  });

  it('rejects clips that do not match the VRMA schema', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ vrma: { meta: { name: 'Bad Name' } } }));
    const client = new LocalMotionClient({ baseUrl: 'http://127.0.0.1:8190', fetchFn });

    await expect(client.generateClip({ prompt: 'wave' })).rejects.toThrow();
  });

  it('surfaces the service error message on HTTP failures', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: 'model is still loading' }, 503));
    const client = new LocalMotionClient({ baseUrl: 'http://127.0.0.1:8190', fetchFn });

    await expect(client.generateClip({ prompt: 'wave' })).rejects.toThrow('HTTP 503 model is still loading');
  });

  it('yields streamed chunks in order and returns the summary', async () => {
    const fetchFn = vi.fn(async () =>
      ndjsonResponse([
        { type: 'chunk', index: 0, start: 0, vrma: sampleVrma('wave-0'), timings: { totalMs: 750 } },
        { type: 'chunk', index: 1, start: 2, vrma: sampleVrma('wave-1'), timings: { totalMs: 360 } },
        { type: 'done', chunks: 2, timings: { totalMs: 1110 } },
      ]),
    );
    const client = new LocalMotionClient({ baseUrl: 'http://127.0.0.1:8190', fetchFn });

    const stream = client.stream({ prompt: 'wave' });
    const chunks = [];
    let next = await stream.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await stream.next();
    }

    expect(chunks.map((chunk) => [chunk.index, chunk.start, chunk.vrma.meta.name])).toEqual([
      [0, 0, 'wave-0'],
      [1, 2, 'wave-1'],
    ]);
    expect(next.value).toEqual({ chunks: 2, timings: { totalMs: 1110 } });
  });

  it('throws when the stream reports an error', async () => {
    const fetchFn = vi.fn(async () =>
      ndjsonResponse([
        { type: 'chunk', index: 0, start: 0, vrma: sampleVrma('wave-0') },
        { type: 'error', message: 'out of memory' },
      ]),
    );
    const client = new LocalMotionClient({ baseUrl: 'http://127.0.0.1:8190', fetchFn });

    const stream = client.stream({ prompt: 'wave' });
    await stream.next();
    await expect(stream.next()).rejects.toThrow('Motion service failed: out of memory');
  });

  it('throws when the stream ends without a done line', async () => {
    const fetchFn = vi.fn(async () => ndjsonResponse([{ type: 'chunk', index: 0, start: 0, vrma: sampleVrma('wave-0') }]));
    const client = new LocalMotionClient({ baseUrl: 'http://127.0.0.1:8190', fetchFn });

    const stream = client.stream({ prompt: 'wave' });
    await stream.next();
    await expect(stream.next()).rejects.toThrow('Motion stream ended before it finished.');
  });
});

describe('LocalMotionGenerationService', () => {
  function createService(fetchFn: typeof fetch) {
    const uploads: AvatarAnimationUploadRequest[] = [];
    const animationService = {
      uploadAnimation: vi.fn(async (request: AvatarAnimationUploadRequest) => {
        uploads.push(request);
        return {
          animation: { id: 'anim-1', name: request.name ?? 'x', createdAt: 0, fileSha: 'sha', duration: 1, fps: 30 },
        };
      }),
    };
    const service = new LocalMotionGenerationService({
      client: new LocalMotionClient({ baseUrl: 'http://127.0.0.1:8190', fetchFn }),
      animationService,
    });
    return { service, uploads };
  }

  it('saves a generated clip to the animation library as a .vrma', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ vrma: sampleVrma('wave-hello'), timings: {} }));
    const { service, uploads } = createService(fetchFn);

    const result = await service.generateAnimation({ prompt: '  Wave hello!  ', duration: 60 });

    expect(result.animation.id).toBe('anim-1');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.fileName).toBe('wave-hello.vrma');
    expect(Buffer.from(uploads[0]?.data ?? '', 'base64').subarray(0, 4).toString('ascii')).toBe('glTF');
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ prompt: 'Wave hello!', duration: 10, name: 'wave-hello' });
  });

  it('rejects an empty prompt', async () => {
    const { service } = createService(vi.fn());

    await expect(service.generateAnimation({ prompt: '   ' })).rejects.toThrow('Motion prompt is required.');
  });

  it('forwards each streamed chunk as an encoded .vrma', async () => {
    const fetchFn = vi.fn(async () =>
      ndjsonResponse([
        { type: 'chunk', index: 0, start: 0, vrma: sampleVrma('shrug-0') },
        { type: 'chunk', index: 1, start: 2, vrma: sampleVrma('shrug-1') },
        { type: 'done', chunks: 2, timings: {} },
      ]),
    );
    const { service, uploads } = createService(fetchFn);
    const chunks: AvatarMotionChunkEvent[] = [];

    const result = await service.streamMotion({ streamId: 's1', prompt: 'shrug' }, (chunk) => chunks.push(chunk));

    expect(chunks.map((chunk) => [chunk.streamId, chunk.index, chunk.start, chunk.name])).toEqual([
      ['s1', 0, 0, 'shrug-0'],
      ['s1', 1, 2, 'shrug-1'],
    ]);
    expect(Buffer.from(chunks[0]?.data ?? '', 'base64').subarray(0, 4).toString('ascii')).toBe('glTF');
    expect(result).toMatchObject({ streamId: 's1', chunks: 2 });
    expect(result.firstChunkMs).not.toBeNull();
    expect(uploads).toHaveLength(0);
  });

  it('sends the avatar rest skeleton with a stream, and drops a malformed one', async () => {
    const done = () => ndjsonResponse([{ type: 'done', chunks: 0, timings: {} }]);
    const fetchFn = vi.fn(async () => done());
    const { service } = createService(fetchFn);
    const bones = ['hips', 'spine', 'chest', 'upperChest'].concat(
      ...['left', 'right'].map((side) => ['Shoulder', 'UpperArm', 'LowerArm', 'Hand'].map((b) => `${side}${b}`)),
    );
    const avatarRest = Object.fromEntries(bones.map((bone, i) => [bone, [0, 1 + i / 100, 0]])) as AvatarRestSkeleton;

    await service.streamMotion({ streamId: 's1', prompt: 'shrug', avatarRest }, () => undefined);
    await service.streamMotion(
      { streamId: 's2', prompt: 'shrug', avatarRest: { ...avatarRest, leftHand: [0, Number.NaN, 0] } },
      () => undefined,
    );

    const bodies = fetchFn.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string));
    expect(bodies[0].avatar_rest).toEqual(avatarRest);
    expect(bodies[1]).not.toHaveProperty('avatar_rest');
    expect(sanitizeRestSkeleton({ hips: [0, 1, 0] })).toBeUndefined();
  });

  it('builds slugs that satisfy the VRMA name pattern', () => {
    expect(toSlug('Waves hello, then bows!')).toBe('waves-hello-then-bows');
    expect(toSlug('!!!')).toBe('motion');
    expect(toSlug('a'.repeat(39) + ' b')).toBe('a'.repeat(39));
  });
});
