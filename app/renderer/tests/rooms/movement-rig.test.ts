import { describe, expect, it } from 'vitest';
import { MAX_TRACKED_STREAMS, MovementRigs } from '../../src/rooms/movement-rig.js';

describe('MovementRigs', () => {
  it('maps streams to avatars and forgets them when they end', () => {
    const rigs = new MovementRigs();
    rigs.registerStream('a', 'sage');
    rigs.registerStream('b', 'rex');
    expect(rigs.avatarForStream('a')).toBe('sage');
    expect(rigs.avatarForStream('b')).toBe('rex');
    expect(rigs.streamIds()).toEqual(['a', 'b']);
    rigs.endStream('a');
    expect(rigs.avatarForStream('a')).toBeUndefined();
    expect(rigs.avatarForStream('nope')).toBeUndefined();
  });

  it('caps the number of tracked streams, dropping the oldest', () => {
    const rigs = new MovementRigs();
    for (let i = 0; i < MAX_TRACKED_STREAMS + 5; i += 1) rigs.registerStream(`s${i}`, 'sage');
    expect(rigs.streamIds()).toHaveLength(MAX_TRACKED_STREAMS);
    expect(rigs.avatarForStream('s0')).toBeUndefined();
    expect(rigs.avatarForStream(`s${MAX_TRACKED_STREAMS + 4}`)).toBe('sage');
  });

  it('gives each avatar its own repeat filter', () => {
    const rigs = new MovementRigs();
    expect(rigs.filterFor('sage')).toBe(rigs.filterFor('sage'));
    expect(rigs.filterFor('sage').shouldStart('waves')).toBe(true);
    expect(rigs.filterFor('sage').shouldStart('waves')).toBe(false);
    expect(rigs.filterFor('rex').shouldStart('waves')).toBe(true);
  });

  it('drops an avatar with its streams and filter', () => {
    const rigs = new MovementRigs();
    rigs.registerStream('a', 'sage');
    rigs.registerStream('b', 'rex');
    rigs.filterFor('sage').shouldStart('waves');
    rigs.drop('sage');
    expect(rigs.avatarForStream('a')).toBeUndefined();
    expect(rigs.avatarForStream('b')).toBe('rex');
    expect(rigs.filterFor('sage').shouldStart('waves')).toBe(true);
  });
});
