import { describe, expect, it, vi } from 'vitest';
import {
  appendTracks,
  requestMotion,
  toWire,
  tracksFromChunks,
} from '../../src/sit-lab/motion-source.js';
import type { Vec3 } from '../../src/sit-lab/pose-math.js';
import { SIT_REQUEST } from './helpers.js';

const hipsAt: Vec3 = [0, 1, 0];
const chunk = (start: number, keys: Array<[number, [number, number, number, number]]>) => ({
  type: 'chunk',
  start,
  vrma: {
    meta: { fps: 30, duration: 1 },
    tracks: [{ bone: 'spine', keyframes: keys.map(([t, q]) => ({ t, q })) }],
    hips: { position: { keyframes: [{ t: 0, p: hipsAt }] } },
  },
});

describe('motion source', () => {
  it('puts the seed and the plan on the wire', () => {
    const wire = toWire(SIT_REQUEST, null, 7);
    expect(wire.seed).toBe(7);
    expect(wire.prompt).toBe(SIT_REQUEST.prompt);
    expect(wire.phases).toEqual([
      { prompt: 'a person turns around and sits down on a chair', start_s: 2 },
    ]);
  });

  it('reads an NDJSON answer and fails on an error line, a missing end or an HTTP error', async () => {
    const answer = (body: string, status = 200) =>
      vi.stubGlobal('fetch', () => Promise.resolve(new Response(body, { status })));
    answer(
      [
        JSON.stringify(chunk(0, [[0, [0, 0, 0, 1]]])),
        JSON.stringify({ type: 'done', session: 's-9' }),
      ].join('\n'),
    );
    const stream = await requestMotion('http://x', { seed: 1 });
    expect(stream.chunks).toHaveLength(1);
    expect(stream.session).toBe('s-9');
    answer(JSON.stringify(chunk(0, [])));
    await expect(requestMotion('http://x', {})).rejects.toThrow(/before it finished/);
    answer(JSON.stringify({ type: 'error', message: 'boom' }));
    await expect(requestMotion('http://x', {})).rejects.toThrow(/boom/);
    answer('nope', 500);
    await expect(requestMotion('http://x', {})).rejects.toThrow(/answered 500/);
    vi.unstubAllGlobals();
  });

  it('lays chunks on the frame grid, holding unkeyed frames, and appends continuations', () => {
    const a = tracksFromChunks([
      { start: 0, vrma: chunk(0, [[0, [0, 0, 0, 1]]]).vrma },
      { start: 0.1, vrma: chunk(0, [[0, [0.1, 0, 0, 0.995]]]).vrma },
    ]);
    expect(a.frames).toBe(4);
    expect(a.bones.spine?.[2]).toEqual([0, 0, 0, 1]);
    expect(a.bones.spine?.[3]).toEqual([0.1, 0, 0, 0.995]);
    const joined = appendTracks(a, a);
    expect(joined.frames).toBe(8);
    expect(joined.hips).toHaveLength(8);
  });
});
