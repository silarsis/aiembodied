import { describe, expect, it } from 'vitest';
import { extractMotionTags } from '../../src/avatar/animation-tags.js';
import { nearestFreeSeat, seatFromMove, tagToAction } from '../../src/rooms/scene-actions.js';
import { builtInRoom } from './fixtures.js';

describe('sitting from vague or free-text requests', () => {
  const room = builtInRoom('reading-room');
  const sofa = room.objects.find((object) => object.id === 'sofa')!;
  const armchair = room.objects.find((object) => object.tags?.sit && object.id !== 'sofa')!;

  it('reads a bare {sit} as "sit somewhere"', () => {
    expect(extractMotionTags('Okay. {sit}')).toEqual([{ type: 'sit', object: '' }]);
    expect(extractMotionTags('{go}')).toEqual([]);
  });

  it('matches common synonyms ("couch" is the sofa, "cup" the mug)', () => {
    expect(tagToAction(room, { type: 'sit', object: 'couch' })).toEqual({ kind: 'sit', objectId: 'sofa' });
    expect(tagToAction(room, { type: 'sit', object: 'the settee' })).toEqual({ kind: 'sit', objectId: 'sofa' });
    expect(tagToAction(room, { type: 'pick', object: 'cup' })).toEqual({ kind: 'pick', objectId: 'mug' });
  });

  it('sends {sit} with no seat, an unknown one or a non-seat to the nearest free seat', () => {
    const nearSofa = { position: { x: sofa.position[0], z: sofa.position[2] } };
    expect(tagToAction(room, { type: 'sit', object: '' }, nearSofa)).toEqual({ kind: 'sit', objectId: 'sofa' });
    expect(tagToAction(room, { type: 'sit', object: 'onu' }, nearSofa)).toEqual({ kind: 'sit', objectId: 'sofa' });
    expect(tagToAction(room, { type: 'sit', object: 'bookshelf' }, nearSofa)).toEqual({ kind: 'sit', objectId: 'sofa' });
    // Somebody else is on the sofa: the next nearest seat.
    expect(tagToAction(room, { type: 'sit', object: '' }, { ...nearSofa, takenSeats: new Set(['sofa']) })).toEqual({
      kind: 'sit',
      objectId: armchair.id,
    });
  });

  it('picks the nearest seat even when every seat is taken', () => {
    const near = { position: { x: armchair.position[0], z: armchair.position[2] } };
    const all = new Set(room.objects.filter((object) => object.tags?.sit).map((object) => object.id));
    expect(nearestFreeSeat(room, { ...near, takenSeats: all })?.id).toBe(armchair.id);
  });

  it('turns a {move:} about sitting on a seat into that seat, and leaves other moves alone', () => {
    expect(seatFromMove(room, 'sits on a space on the couch with both hands on the mug')?.id).toBe('sofa');
    expect(seatFromMove(room, `settles into the ${armchair.name}`)?.id).toBe(armchair.id);
    expect(seatFromMove(room, 'waves at the sofa')).toBeNull();
    expect(seatFromMove(room, 'sits up straight')).toBeNull();
    expect(seatFromMove(room, 'sits on the bookshelf')).toBeNull();
  });
});
