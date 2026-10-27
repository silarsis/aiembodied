import { describe, expect, it, vi } from 'vitest';
import { createAvatarAnimationBus, type AvatarAnimationEvent } from '../../src/avatar/animation-bus.js';
import { extractAvatarTags, extractMoveTags } from '../../src/avatar/animation-tags.js';
import {
  LIVE_MOTION_SOURCE,
  MoveRequestFilter,
  base64ToArrayBuffer,
  enqueueMotionChunk,
} from '../../src/avatar/live-motion.js';

describe('extractMoveTags', () => {
  it('extracts free-text movement descriptions', () => {
    expect(extractMoveTags('Sure {move:shrugs  with both shoulders} and {MOVE: bows deeply }.')).toEqual([
      { type: 'move', text: 'shrugs with both shoulders' },
      { type: 'move', text: 'bows deeply' },
    ]);
  });

  it('is not picked up as an animation tag', () => {
    expect(extractAvatarTags('{move:wave} {anim:wave}', { allowedAnimationSlugs: ['wave'] })).toEqual([
      { type: 'anim', slug: 'wave' },
    ]);
  });
});

describe('MoveRequestFilter', () => {
  it('starts a description once per window', () => {
    let time = 0;
    const filter = new MoveRequestFilter(5000, () => time);

    expect(filter.shouldStart('Shrugs')).toBe(true);
    expect(filter.shouldStart('shrugs')).toBe(false);
    expect(filter.shouldStart('bows')).toBe(true);
    time = 6000;
    expect(filter.shouldStart('shrugs')).toBe(true);
  });
});

describe('enqueueMotionChunk', () => {
  it('enqueues the decoded chunk under a per-stream slug', () => {
    const bus = createAvatarAnimationBus();
    const listener = vi.fn<(event: AvatarAnimationEvent) => void>();
    bus.subscribe(listener);

    enqueueMotionChunk(bus, {
      streamId: 'abc',
      index: 2,
      start: 4,
      name: 'wave-2',
      duration: 2,
      data: Buffer.from('glTF').toString('base64'),
    });

    const event = listener.mock.calls[0]?.[0];
    expect(event?.type).toBe('enqueue');
    if (event?.type !== 'enqueue') {
      return;
    }
    expect(event.request).toMatchObject({ slug: 'live-abc-2', intent: 'play', source: LIVE_MOTION_SOURCE });
    expect(new TextDecoder().decode(event.request.vrmaBinary)).toBe('glTF');
  });

  it('decodes base64 into bytes', () => {
    expect(Array.from(new Uint8Array(base64ToArrayBuffer('AAEC')))).toEqual([0, 1, 2]);
  });
});
