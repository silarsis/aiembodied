import { describe, expect, it } from 'vitest';
import type { RoomFile } from '../../../main/src/rooms/types.js';
import { validateRoomFile } from '../../../main/src/shared/rooms/validate.js';
import type { AvatarState, PlanWorld } from '../../src/rooms/scene-actions.js';
import { chooseSurface, planRelease, planSit, planTake, resolveBodyPlan } from '../../src/rooms/station-body.js';
import { builtInRoom } from './fixtures.js';

const reading = builtInRoom('reading-room');
const body = { prop: 'book', seat: 'armchair', browse: 'browses', read: 'reads', note: 'notes' };
const standing: AvatarState = { posture: 'standing', held: null };
const holdingBook: AvatarState = { posture: 'standing', held: { objectId: 'book', hand: 'right' } };
const seatedWithBook: AvatarState = { posture: 'seated', held: { objectId: 'book', hand: 'right' } };

function worldAt(room: RoomFile, x: number, z: number): PlanWorld {
  return { room, frame: { origin: { x, z, yaw: 0 } } } as unknown as PlanWorld;
}

describe('the Reading room with a book', () => {
  it('validates, with a dynamic book that can be grabbed and a bookshelf that takes things', () => {
    expect(() => validateRoomFile(JSON.parse(JSON.stringify(reading)))).not.toThrow();
    const book = reading.objects.find((object) => object.id === 'book');
    expect(book).toMatchObject({ dynamic: true, tags: { grab: expect.anything() } });
    const shelf = reading.objects.find((object) => object.id === 'bookshelf');
    expect(shelf?.tags?.surface?.height).toBeCloseTo(1.025);
    // The book lies on the shelf board.
    expect(book?.position[1]).toBeCloseTo(shelf!.position[1] + shelf!.tags!.surface!.height);
  });
});

describe('resolveBodyPlan', () => {
  it('keeps a prop, seat and texts the room can use', () => {
    expect(resolveBodyPlan(reading, 'bookshelf', body, 'station activity')).toEqual({
      objectId: 'bookshelf',
      prop: 'book',
      seat: 'armchair',
      surfaceId: 'bookshelf',
      browse: 'browses',
      read: 'reads',
      note: 'notes',
    });
  });

  it('drops a prop or seat the room lacks, and a seat without a book; texts fall back', () => {
    expect(resolveBodyPlan(reading, 'bookshelf', { prop: 'tome', seat: 'armchair' }, 'activity')).toMatchObject({ prop: null, seat: null, browse: 'activity', read: 'reads', note: 'jots down notes' });
    expect(resolveBodyPlan(reading, 'bookshelf', { prop: 'book', seat: 'rug' }, 'a')).toMatchObject({ prop: 'book', seat: null });
    // The mug is dynamic with a grab tag, the sofa is not dynamic.
    expect(resolveBodyPlan(reading, 'bookshelf', { prop: 'sofa' }, 'a')?.prop).toBeNull();
    expect(resolveBodyPlan(reading, 'nothing', body, 'a')).toBeNull();
  });
});

describe('planTake and planSit', () => {
  const plan = resolveBodyPlan(reading, 'bookshelf', body, 'a')!;

  it('takes the book, then sits once it is in the hand', () => {
    expect(planTake(plan, standing)).toEqual([{ kind: 'pick', objectId: 'book' }]);
    expect(planSit(plan, holdingBook)).toEqual([{ kind: 'sit', objectId: 'armchair' }]);
  });

  it('does not sit when the pick failed, nor take or sit twice', () => {
    expect(planSit(plan, standing)).toEqual([]);
    expect(planTake(plan, holdingBook)).toEqual([]);
    expect(planSit(plan, seatedWithBook)).toEqual([]);
  });

  it('does nothing without a prop or seat', () => {
    const bare = resolveBodyPlan(reading, 'bookshelf', {}, 'a')!;
    expect(planTake(bare, standing)).toEqual([]);
    expect(planSit(bare, holdingBook)).toEqual([]);
  });
});

describe('planRelease', () => {
  const plan = resolveBodyPlan(reading, 'bookshelf', body, 'a')!;
  const world = worldAt(reading, 0, 0);

  it('stands up and puts the book back on the shelf', () => {
    expect(planRelease(plan, world, seatedWithBook, false)).toEqual([
      { kind: 'stand' },
      { kind: 'put', objectId: 'book', surfaceId: 'bookshelf' },
    ]);
  });

  it('adds {come} when the session was cut short', () => {
    expect(planRelease(plan, world, holdingBook, true)).toEqual([{ kind: 'put', objectId: 'book', surfaceId: 'bookshelf' }, { kind: 'come' }]);
  });

  it('does nothing when the avatar stands with empty hands', () => {
    expect(planRelease(plan, world, standing, false)).toEqual([]);
  });

  it('uses the nearest surface when the station object has none', () => {
    const noSurface: RoomFile = { ...reading, objects: reading.objects.map((o) => (o.id === 'bookshelf' ? { ...o, tags: { ...o.tags, surface: undefined } } : o)) };
    const bare = resolveBodyPlan(noSurface, 'bookshelf', body, 'a')!;
    expect(bare.surfaceId).toBeNull();
    const table = reading.objects.find((o) => o.id === 'coffee-table')!;
    expect(chooseSurface(worldAt(noSurface, table.position[0], table.position[2]), bare)).toBe('coffee-table');
  });
});
