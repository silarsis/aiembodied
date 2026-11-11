import { beforeAll, describe, expect, it } from 'vitest';
import type { RoomFile, Vec3 } from '../../../main/src/rooms/types.js';
import { RoomStage } from '../../src/rooms/room-stage.js';
import {
  INITIAL_STATE,
  frontOfFace,
  nearestFootprintPoint,
  pathStartHeading,
  planAction,
  resolveObjectRef,
  tagToAction,
  type ActionPlan,
  type AvatarState,
  type PlanWorld,
  type PlannedStream,
  type SceneAction,
  walkStart,
} from '../../src/rooms/scene-actions.js';
import type { AvatarMotionTarget } from '../../src/avatar/types.js';
import { motionToWorld, worldToMotion, type MotionFrame } from '../../src/rooms/scene-frames.js';
import { RoomOccupancy } from '../../src/rooms/room-occupancy.js';
import { sideStepPath } from '../../src/rooms/scene-actions.js';
import { builtInRoom } from './fixtures.js';

const REST_HIPS = 0.95;

let room: RoomFile;
let stage: RoomStage;

beforeAll(async () => {
  room = builtInRoom('reading-room');
  stage = await RoomStage.create(room);
});

function worldAt(x: number, z: number, yawDeg: number, scale = 1, positions: Record<string, Vec3> = {}): PlanWorld {
  const frame: MotionFrame = { origin: { x, z, yaw: (yawDeg * Math.PI) / 180 }, scale };
  return {
    room,
    hasNavigation: stage.hasNavigation,
    findPath: (from, to) => stage.findPath(from, to),
    closestWalkable: (p) => stage.closestWalkable(p),
    objectPosition: (id) => positions[id] ?? null,
    frame,
    restHipsHeight: REST_HIPS,
  };
}

function streamOf(plan: ActionPlan): PlannedStream {
  if (plan.type !== 'stream') throw new Error(`expected a stream, got ${JSON.stringify(plan)}`);
  return plan.stream;
}

describe('object references', () => {
  it('matches ids and names ignoring case, articles and plurals', () => {
    expect(resolveObjectRef(room, 'the Mug')?.id).toBe('mug');
    expect(resolveObjectRef(room, 'mugs')?.id).toBe('mug');
    expect(resolveObjectRef(room, 'coffee-table')?.id).toBe('coffee-table');
    expect(resolveObjectRef(room, 'a coffee table')?.id).toBe('coffee-table');
    expect(resolveObjectRef(room, 'bookshelves')).toBeNull();
    expect(resolveObjectRef(room, 'bookshelf')?.id).toBe('bookshelf');
    expect(resolveObjectRef(room, 'lamp')?.id).toBe('floor-lamp');
  });

  it('refuses ambiguous or unknown names', () => {
    expect(resolveObjectRef(room, 'table')).toBeNull();
    expect(resolveObjectRef(room, 'spaceship')).toBeNull();
    expect(resolveObjectRef(room, '')).toBeNull();
  });

  it('turns tags into actions and drops unknown objects', () => {
    expect(tagToAction(room, { type: 'sit', object: 'the sofa' })).toEqual({ kind: 'sit', objectId: 'sofa' });
    expect(tagToAction(room, { type: 'put', object: 'mug', surface: 'side table' })).toEqual({
      kind: 'put',
      objectId: 'mug',
      surfaceId: 'side-table',
    });
    expect(tagToAction(room, { type: 'stand' })).toEqual({ kind: 'stand' });
    expect(tagToAction(room, { type: 'come' })).toEqual({ kind: 'come' });
    expect(tagToAction(room, { type: 'go', object: 'dragon' })).toBeNull();
  });
});

describe('turning before a walk', () => {
  const world = { restHipsHeight: REST_HIPS } as PlanWorld;

  it('walks straight off when the path starts roughly ahead', () => {
    expect(walkStart(world, [[0, 0], [0.3, 2]])).toEqual({ startS: 0.3, targets: [] });
  });

  it('turns on the spot first when the path starts behind, and waits for the turn before walking', () => {
    const { startS, targets } = walkStart(world, [[0, 0], [0, -0.1], [0.05, -2]]);
    expect(targets).toHaveLength(1);
    const [turn] = targets as [AvatarMotionTarget];
    expect(turn.root).toEqual([0, 0]);
    expect(Math.abs(turn.heading!)).toBeGreaterThan(Math.PI * 0.9);
    expect(turn.t).toBeGreaterThan(0.9);
    expect(startS).toBeCloseTo(turn.t + 0.2, 6);
  });

  it('takes a shorter turn for a path that starts to the side', () => {
    const side = walkStart(world, [[0, 0], [-2, 0]]);
    const behind = walkStart(world, [[0, 0], [0, -2]]);
    expect(side.targets[0]!.heading).toBeCloseTo(-Math.PI / 2, 3);
    expect(side.targets[0]!.t).toBeLessThan(behind.targets[0]!.t);
  });

  it('measures the start direction a little way along the path, not from a tiny first leg', () => {
    expect(pathStartHeading([[0, 0], [0.01, -0.01], [1, 0.5], [3, 0.5]])).toBeGreaterThan(0.5);
    expect(pathStartHeading([[0, 0]])).toBeNull();
  });
});

describe('go and come', () => {
  it('walks from the avatar to the stand tag and faces the object', () => {
    const world = worldAt(0, -0.3, 0);
    const stream = streamOf(planAction(world, INITIAL_STATE, { kind: 'go', objectId: 'bookshelf' }));
    const path = stream.request.path!;
    expect(path.points[0]).toEqual([0, 0]);
    expect(path.cornerRadius).toBe(0.6);
    expect(path.speed).toBe(1);
    expect(path.mode).toBe('dense');
    expect(stream.request.prompt).toBe('a person walks calmly');
    // Ends at the bookshelf's stand tag (0.8 m in front of it, along its local +Z).
    const stand = stage.worldTag('bookshelf', 'stand')!;
    const end = path.points[path.points.length - 1]!;
    const [ex, ez] = motionToWorld(world.frame, end[0], end[1]);
    expect(Math.hypot(ex - stand.position[0], ez - stand.position[2])).toBeLessThan(0.35);
    // The path sets off well to the side, so the avatar first turns on the spot to face along it,
    // then walks; one heading target at the end, 0.5 s after arrival, faces the shelf (-X, so -pi/2).
    const targets = stream.request.targets!;
    expect(targets).toHaveLength(2);
    const [turn, arrive] = targets as [AvatarMotionTarget, AvatarMotionTarget];
    const startHeading = pathStartHeading(path.points)!;
    expect(Math.abs(startHeading)).toBeGreaterThan(Math.PI / 3);
    expect(turn.root).toEqual([0, 0]);
    expect(turn.heading).toBeCloseTo(startHeading, 2);
    expect(path.startS).toBeCloseTo(turn.t + 0.2, 3);
    let length = 0;
    for (let i = 1; i < path.points.length; i += 1) {
      length += Math.hypot(path.points[i]![0] - path.points[i - 1]![0], path.points[i]![1] - path.points[i - 1]![1]);
    }
    expect(arrive.t).toBeCloseTo(path.startS! + length + 0.5, 2);
    expect(stream.request.duration).toBeCloseTo(path.startS! + length + 1.5, 2);
    expect(arrive.heading).toBeCloseTo(-Math.PI / 2, 1);
    expect(arrive.height).toBe(REST_HIPS);
    expect(arrive.root).toEqual(end);
  });

  it('expresses the path in the avatar frame whatever way the avatar faces', () => {
    const a = streamOf(planAction(worldAt(0, -0.3, 0), INITIAL_STATE, { kind: 'go', objectId: 'bookshelf' }));
    const b = streamOf(planAction(worldAt(0, -0.3, 90), INITIAL_STATE, { kind: 'go', objectId: 'bookshelf' }));
    // Same world path, but turned by the avatar's yaw, so the second one differs in the frame.
    const endA = a.request.path!.points.at(-1)!;
    const endB = b.request.path!.points.at(-1)!;
    expect(Math.hypot(...endA)).toBeCloseTo(Math.hypot(...endB), 1);
    expect(endA[0]).not.toBeCloseTo(endB[0], 1);
  });

  it('divides by the avatar scale', () => {
    const small = streamOf(planAction(worldAt(0, -0.3, 0, 1), INITIAL_STATE, { kind: 'go', objectId: 'bookshelf' }));
    const big = streamOf(planAction(worldAt(0, -0.3, 0, 2), INITIAL_STATE, { kind: 'go', objectId: 'bookshelf' }));
    const a = small.request.path!.points.at(-1)!;
    const b = big.request.path!.points.at(-1)!;
    expect(b[0]).toBeCloseTo(a[0] / 2, 1);
    expect(b[1]).toBeCloseTo(a[1] / 2, 1);
  });

  it('walks to the closest walkable point in front of an object without a stand tag', () => {
    const world = worldAt(0, -0.3, 0);
    const point = frontOfFace(world, room.objects.find((o) => o.id === 'floor-lamp')!);
    expect(stage.isWalkable(point)).toBe(true);
    const lamp = room.objects.find((o) => o.id === 'floor-lamp')!;
    expect(Math.hypot(point[0] - lamp.position[0], point[2] - lamp.position[2])).toBeLessThan(1.6); // boxed in by the sofa and armchair
    const stream = streamOf(planAction(world, INITIAL_STATE, { kind: 'go', objectId: 'floor-lamp' }));
    expect(stream.request.path!.points.length).toBeGreaterThanOrEqual(2);
  });

  it('comes home facing the home facing', () => {
    const world = worldAt(-2, 1, 90);
    const stream = streamOf(planAction(world, INITIAL_STATE, { kind: 'come' }));
    const end = stream.request.path!.points.at(-1)!;
    const [ex, ez] = motionToWorld(world.frame, end[0], end[1]);
    expect(Math.hypot(ex - room.home.position[0], ez - room.home.position[2])).toBeLessThan(0.35);
    const heading = stream.request.targets![0]!.heading!;
    // Home faces +Z (0); the avatar faces +X (90 degrees), so the heading is -90 degrees.
    expect(heading).toBeCloseTo(-Math.PI / 2, 5);
  });

  it('skips when already there, turning on the spot when only the heading is off', () => {
    const home = room.home.position;
    expect(planAction(worldAt(home[0], home[2], 0), INITIAL_STATE, { kind: 'come' }).type).toBe('skip');
    const turn = streamOf(planAction(worldAt(home[0], home[2], 90), INITIAL_STATE, { kind: 'come' }));
    expect(turn.request.path).toBeUndefined();
    expect(turn.request.prompt).toBe('a person turns to look at something');
  });
});

describe('look', () => {
  it('turns towards the look tag in 2.5 s with the root held', () => {
    const world = worldAt(0, -0.3, 0);
    const stream = streamOf(planAction(world, INITIAL_STATE, { kind: 'look', objectId: 'bookshelf' }));
    expect(stream.request.prompt).toBe('a person turns to look at something');
    expect(stream.request.duration).toBe(2.5);
    expect(stream.request.path).toBeUndefined();
    const target = stream.request.targets![0]!;
    expect(target.t).toBe(1.5);
    expect(target.root).toEqual([0, 0]);
    expect(target.heading!).toBeLessThan(-1.2); // the shelf is on the -X side, mostly
    expect(target.heading!).toBeGreaterThan(-Math.PI / 2 - 0.5);
  });

  it('skips when already within 20 degrees', () => {
    const world = worldAt(0, -0.3, -90);
    expect(planAction(world, INITIAL_STATE, { kind: 'look', objectId: 'bookshelf' }).type).toBe('skip');
  });
});

describe('look at a point', () => {
  const camera: Vec3 = [0, 1.5, 2.1];

  it('turns on the spot towards the point, like a look', () => {
    const stream = streamOf(planAction(worldAt(-2, -1, 0), INITIAL_STATE, { kind: 'lookAtPoint', position: camera, label: 'the camera' }));
    expect(stream.label).toBe('the camera');
    expect(stream.request.prompt).toBe('a person turns to look at something');
    const target = stream.request.targets?.[0];
    if (!target) throw new Error('no target');
    expect(target.root).toEqual([0, 0]);
    // The camera is at +x and +z of the avatar, so the heading is positive (towards +x).
    expect(target.heading ?? NaN).toBeCloseTo(Math.atan2(2, 3.1), 3);
  });

  it('skips when already facing it, and never stands a seated avatar up', () => {
    const facing = planAction(worldAt(0, 0, 0), INITIAL_STATE, { kind: 'lookAtPoint', position: camera });
    expect(facing).toMatchObject({ type: 'skip' });
    const seated: AvatarState = { posture: 'seated', held: null, seat: { objectId: 'sofa', session: 's', frame: worldAt(0, 0, 0).frame, approach: [0, 0, 0], facing: 0 } };
    expect(planAction(worldAt(-2, -1, 0), seated, { kind: 'lookAtPoint', position: camera })).toEqual({ type: 'skip', reason: 'seated' });
  });
});

describe('sit and stand', () => {
  it('walks to the front of the sofa, then sits in a later, chunk-aligned phase', () => {
    const world = worldAt(0, -0.3, 0);
    const stream = streamOf(planAction(world, INITIAL_STATE, { kind: 'sit', objectId: 'sofa' }));
    const { request } = stream;
    expect(request.prompt).toBe('a person walks calmly');
    expect(request.path!.points[0]).toEqual([0, 0]);
    const phase = request.phases![0]!;
    expect(phase.prompt).toBe('a person turns around and sits down on a chair');
    expect(phase.startS % 2).toBe(0);
    let length = 0;
    const pts = request.path!.points;
    for (let i = 1; i < pts.length; i += 1) length += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    const arrival = request.path!.startS! + length;
    expect(phase.startS).toBeGreaterThanOrEqual(arrival);
    expect(phase.startS - arrival).toBeLessThan(2);
    expect(request.duration).toBe(phase.startS + 4);

    const target = request.targets!.at(-1)!;
    const sit = stage.worldTag('sofa', 'sit')!;
    const [sx, sz] = motionToWorld(world.frame, target.root![0], target.root![1]);
    expect(sx).toBeCloseTo(sit.position[0], 6);
    expect(sz).toBeCloseTo(sit.position[2], 6);
    expect(target.height).toBeCloseTo(0.5 + 0.08, 6);
    expect(target.heading).toBeCloseTo(0, 6); // the sofa faces +Z like the avatar
    expect(target.t).toBe(phase.startS + 2);
    expect(target.revealS).toBe(phase.startS);
    expect(target.until).toBeLessThanOrEqual(request.duration);
    expect(stream.outcome).toMatchObject({ posture: 'seated', seat: { objectId: 'sofa' } });
  });

  it('sends the seat height in avatar metres for a scaled avatar', () => {
    const stream = streamOf(planAction(worldAt(0, -0.3, 0, 1.25), INITIAL_STATE, { kind: 'sit', objectId: 'sofa' }));
    expect(stream.request.targets!.at(-1)!.height).toBeCloseTo((0.5 + 0.08) / 1.25, 6);
  });

  it('turns the heading into the avatar frame for a rotated armchair', () => {
    const world = worldAt(0, 0, 0);
    const stream = streamOf(planAction(world, INITIAL_STATE, { kind: 'sit', objectId: 'armchair' }));
    expect(stream.request.targets!.at(-1)!.heading).toBeCloseTo((40 * Math.PI) / 180, 6);
  });

  it('sits straight away, with no phases, when already at the seat', () => {
    const sit = stage.worldTag('sofa', 'sit')!;
    const f = ((sit.facing ?? 0) * Math.PI) / 180;
    const world = worldAt(sit.position[0] + 0.45 * Math.sin(f), sit.position[2] + 0.45 * Math.cos(f), 180);
    const stream = streamOf(planAction(world, INITIAL_STATE, { kind: 'sit', objectId: 'sofa' }));
    expect(stream.request.path).toBeUndefined();
    expect(stream.request.phases).toBeUndefined();
    expect(stream.request.prompt).toBe('a person turns around and sits down on a chair');
    expect(stream.request.duration).toBe(4);
    expect(stream.request.targets![0]!.t).toBe(2);
  });

  it('skips things that cannot be sat on', () => {
    expect(planAction(worldAt(0, 0, 0), INITIAL_STATE, { kind: 'sit', objectId: 'rug' }).type).toBe('skip');
  });

  it('stands up from the seat session towards the spot in front of it', () => {
    const world = worldAt(0, -0.3, 0);
    const sitting = streamOf(planAction(world, INITIAL_STATE, { kind: 'sit', objectId: 'sofa' }));
    if (sitting.outcome.posture !== 'seated') throw new Error('expected a seat');
    const state: AvatarState = {
      posture: 'seated',
      held: null,
      seat: { ...sitting.outcome.seat, session: 's-1' },
    };
    // The avatar object's frame is now the seat frame; a stand uses that, not the current frame.
    const stand = streamOf(planAction(worldAt(0, -2, 0), state, { kind: 'stand' }));
    expect(stand.request.continueFrom).toBe('s-1');
    expect(stand.request.prompt).toBe('a person stands up from the chair');
    expect(stand.request.duration).toBe(3);
    expect(stand.frame).toBe(state.seat!.frame);
    const target = stand.request.targets![0]!;
    expect([target.t, target.until, target.height]).toEqual([2, 2.5, REST_HIPS]);
    const [x, z] = motionToWorld(state.seat!.frame, target.root![0], target.root![1]);
    expect(x).toBeCloseTo(state.seat!.approach[0], 6);
    expect(z).toBeCloseTo(state.seat!.approach[2], 6);
    expect(stand.outcome.posture).toBe('standing');
  });

  it('inserts a stand before walking, looking or reaching when seated, and skips a stand when standing', () => {
    const seated: AvatarState = {
      posture: 'seated',
      held: null,
      seat: { objectId: 'sofa', session: 's', frame: worldAt(0, 0, 0).frame, approach: [0, 0, 0], facing: 0 },
    };
    for (const action of [
      { kind: 'go', objectId: 'bookshelf' },
      { kind: 'come' },
      { kind: 'look', objectId: 'bookshelf' },
      { kind: 'pick', objectId: 'mug' },
      { kind: 'sit', objectId: 'armchair' },
    ] as SceneAction[]) {
      expect(planAction(worldAt(0, 0, 0), seated, action)).toEqual({ type: 'insert', actions: [{ kind: 'stand' }] });
    }
    expect(planAction(worldAt(0, 0, 0), INITIAL_STATE, { kind: 'stand' }).type).toBe('skip');
    expect(planAction(worldAt(0, 0, 0), seated, { kind: 'sit', objectId: 'sofa' }).type).toBe('skip');
  });
});

describe('pick and put', () => {
  const mug = () => room.objects.find((o) => o.id === 'mug')!;

  it('goes near the mug first when it is more than 0.7 m away', () => {
    const plan = planAction(worldAt(0, 1, 0), INITIAL_STATE, { kind: 'pick', objectId: 'mug' });
    expect(plan.type).toBe('insert');
    if (plan.type !== 'insert') return;
    const goto = plan.actions[0]! as Extract<SceneAction, { kind: 'goto' }>;
    expect(goto.kind).toBe('goto');
    expect(stage.isWalkable(goto.position)).toBe(true);
    expect(Math.hypot(goto.position[0] - mug().position[0], goto.position[2] - mug().position[2])).toBeLessThan(1);
  });

  it('plans a reach with the nearer hand, held root and an attach at 1.7 s', () => {
    const grab = stage.worldTag('mug', 'grab')!.position;
    // Stand 0.5 m south of the mug (z + 0.5), facing it (-Z means yaw 180).
    const world = worldAt(grab[0], grab[2] + 0.5, 180);
    const stream = streamOf(planAction(world, INITIAL_STATE, { kind: 'pick', objectId: 'mug' }));
    expect(stream.request.prompt).toBe('a person reaches out and picks something up from a table');
    expect(stream.request.duration).toBe(3);
    const target = stream.request.targets![0]!;
    expect([target.t, target.until]).toEqual([1.5, 1.8]);
    expect(target.root).toEqual([0, 0]);
    expect(target.height).toBe(REST_HIPS);
    expect(target.heading).toBe(0);
    expect(target.position![2]).toBeCloseTo(0.5, 6);
    expect(target.position![1]).toBeCloseTo(grab[1], 6);
    expect(target.position![0]).toBeCloseTo(0, 6);
    expect(stream.events).toEqual([{ t: 1.7, kind: 'attach', objectId: 'mug', hand: target.hand }]);
    expect(stream.held).toEqual({ objectId: 'mug', hand: target.hand });
  });

  it('picks the hand on the side of the object', () => {
    const grab = stage.worldTag('mug', 'grab')!.position;
    // Facing -Z (yaw 180) the character's left is world -X; the mug 0.1 m to the world -X is on the left.
    const left = streamOf(planAction(worldAt(grab[0] + 0.1, grab[2] + 0.5, 180), INITIAL_STATE, { kind: 'pick', objectId: 'mug' }));
    const right = streamOf(planAction(worldAt(grab[0] - 0.1, grab[2] + 0.5, 180), INITIAL_STATE, { kind: 'pick', objectId: 'mug' }));
    expect(left.request.targets![0]!.hand).toBe('left');
    expect(right.request.targets![0]!.hand).toBe('right');
  });

  it('turns to face an object that is off to the side', () => {
    const grab = stage.worldTag('mug', 'grab')!.position;
    const stream = streamOf(planAction(worldAt(grab[0], grab[2] + 0.5, 0), INITIAL_STATE, { kind: 'pick', objectId: 'mug' }));
    expect(Math.abs(Math.abs(stream.request.targets![0]!.heading!) - Math.PI)).toBeLessThan(0.01);
  });

  it('follows a prop that has moved', () => {
    const moved: Vec3 = [mug().position[0] + 0.3, mug().position[1], mug().position[2]];
    const grab = stage.worldTag('mug', 'grab')!.position;
    const world = worldAt(grab[0] + 0.3, grab[2] + 0.5, 180, 1, { mug: moved });
    const stream = streamOf(planAction(world, INITIAL_STATE, { kind: 'pick', objectId: 'mug' }));
    expect(stream.request.targets![0]!.position![0]).toBeCloseTo(0, 6);
  });

  it('refuses things that are not grabbable or when the hands are full', () => {
    expect(planAction(worldAt(0, 0, 0), INITIAL_STATE, { kind: 'pick', objectId: 'sofa' }).type).toBe('skip');
    const holding: AvatarState = { posture: 'standing', held: { objectId: 'mug', hand: 'right' } };
    expect(planAction(worldAt(0, 0, 0), holding, { kind: 'pick', objectId: 'mug' }).type).toBe('skip');
  });

  it('puts the held mug on a surface: go near, then reach and detach at 1.7 s', () => {
    const holding: AvatarState = { posture: 'standing', held: { objectId: 'mug', hand: 'right' } };
    const far = planAction(worldAt(-1, 1.2, 0), holding, { kind: 'put', objectId: 'mug', surfaceId: 'coffee-table' });
    expect(far.type).toBe('insert');

    const table = room.objects.find((o) => o.id === 'coffee-table')!;
    // Stand just south of the table, facing it.
    const world = worldAt(table.position[0], table.position[2] + 0.8, 180);
    const stream = streamOf(planAction(world, holding, { kind: 'put', objectId: 'mug', surfaceId: 'coffee-table' }));
    const target = stream.request.targets![0]!;
    expect(target.hand).toBe('right');
    expect([target.t, target.until]).toEqual([1.5, 1.8]);
    expect(target.position![1]).toBeGreaterThan(0.42); // above the 0.42 m top
    expect(target.position![1]).toBeLessThan(0.7);
    const event = stream.events[0]!;
    expect(event).toMatchObject({ t: 1.7, kind: 'detach', objectId: 'mug', hand: 'right' });
    expect(event.surface!.y).toBeCloseTo(0.42, 6);
    expect(stream.held).toBeNull();
  });

  it('only puts what is held, on something with a top', () => {
    const holding: AvatarState = { posture: 'standing', held: { objectId: 'mug', hand: 'left' } };
    expect(planAction(worldAt(0, 0, 0), INITIAL_STATE, { kind: 'put', objectId: 'mug', surfaceId: 'coffee-table' }).type).toBe('skip');
    expect(planAction(worldAt(0, 0, 0), holding, { kind: 'put', objectId: 'mug', surfaceId: 'sofa' }).type).toBe('skip');
  });
});

describe('footprints', () => {
  it('clamps a point onto the top, inset from the edge', () => {
    const table = room.objects.find((o) => o.id === 'coffee-table')!;
    const [x, z] = nearestFootprintPoint(table, [table.position[0] + 5, 0, table.position[2] + 5], 0.15);
    expect(x).toBeCloseTo(table.position[0] + 0.5 - 0.15, 6);
    expect(z).toBeCloseTo(table.position[2] + 0.3 - 0.15, 6);
    const centre = nearestFootprintPoint(table, [table.position[0], 0, table.position[2]], 0.15);
    expect(centre).toEqual([table.position[0], table.position[2]]);
  });

  it('keeps world-to-motion consistent with the planner', () => {
    const frame = worldAt(1, 1, 90).frame;
    expect(worldToMotion(frame, 1, 3)[0]).toBeCloseTo(-2, 6);
  });
});

describe('planning with other avatars (occupancy)', () => {
  function withOthers(base: PlanWorld, occupancy: RoomOccupancy, id = 'echo'): PlanWorld {
    return { ...base, others: occupancy.others(id), occupancy: occupancy.forAvatar(id) };
  }

  it('plans exactly as before when nobody else is in the room', () => {
    const alone = planAction(worldAt(0, -0.3, 0), INITIAL_STATE, { kind: 'go', objectId: 'bookshelf' });
    const crowded = new RoomOccupancy();
    const same = planAction(withOthers(worldAt(0, -0.3, 0), crowded), INITIAL_STATE, { kind: 'go', objectId: 'bookshelf' });
    expect(same).toEqual(alone);
  });

  it('moves the goal off another avatar standing there and claims the new spot', () => {
    const stand = stage.worldTag('bookshelf', 'stand')!;
    const occupancy = new RoomOccupancy();
    occupancy.standing('sage', { x: stand.position[0], z: stand.position[2] });
    const plan = planAction(withOthers(worldAt(0, -0.3, 0), occupancy), INITIAL_STATE, { kind: 'go', objectId: 'bookshelf' });
    expect(plan.type).toBe('stream');
    const goal = occupancy.others('sage')[0]!.goal!;
    expect(Math.hypot(goal.x - stand.position[0], goal.z - stand.position[2])).toBeGreaterThanOrEqual(0.45);
    expect(Math.hypot(goal.x - stand.position[0], goal.z - stand.position[2])).toBeLessThanOrEqual(1.0001);
  });

  it('skips when there is no free spot near the goal', () => {
    const stand = stage.worldTag('bookshelf', 'stand')!;
    const occupancy = new RoomOccupancy();
    occupancy.standing('sage', { x: stand.position[0], z: stand.position[2] });
    const world = withOthers(worldAt(0, -0.3, 0), occupancy);
    world.closestWalkable = () => [stand.position[0], 0, stand.position[2]];
    expect(planAction(world, INITIAL_STATE, { kind: 'go', objectId: 'bookshelf' })).toEqual({
      type: 'skip',
      reason: 'someone is standing there',
    });
  });

  it('inserts one side-step waypoint when the path passes close to a standing avatar', () => {
    const world = worldAt(0, -0.3, 0);
    const occupancy = new RoomOccupancy();
    occupancy.standing('sage', { x: -1.4, z: -0.4 });
    const crowded = withOthers(world, occupancy);
    const direct = stage.findPath([0, 0, -0.3], [-2.2, 0, -0.5])!;
    const stepped = sideStepPath(crowded, direct);
    expect(stepped.length).toBe(direct.length + 1);
    const waypoint = stepped.find((p) => !direct.some((q) => q[0] === p[0] && q[2] === p[2]))!;
    expect(Math.hypot(waypoint[0] + 1.4, waypoint[2] + 0.4)).toBeGreaterThanOrEqual(0.45);
    // Without others the path is untouched, and a standing avatar at the goal is not walked around.
    expect(sideStepPath(world, direct)).toBe(direct);
    const atGoal = new RoomOccupancy();
    atGoal.standing('sage', { x: -2.2, z: -0.5 });
    expect(sideStepPath(withOthers(world, atGoal), direct)).toEqual(direct);
  });

  it('refuses a seat another avatar holds, naming the holder, and claims a free one', () => {
    const occupancy = new RoomOccupancy();
    occupancy.setNames({ sage: 'Sage' });
    occupancy.claim('seat', 'sofa', 'sage');
    const plan = planAction(withOthers(worldAt(0, -0.3, 0), occupancy), INITIAL_STATE, { kind: 'sit', objectId: 'sofa' });
    expect(plan).toEqual({ type: 'skip', reason: 'Sage is sitting on the sofa' });
    const free = planAction(withOthers(worldAt(0, -0.3, 0), occupancy), INITIAL_STATE, { kind: 'sit', objectId: 'armchair' });
    expect(free.type).toBe('stream');
    expect(occupancy.holder('seat', 'armchair')).toBe('echo');
  });

  it('refuses an object another avatar holds ("<Name> has it")', () => {
    const occupancy = new RoomOccupancy();
    occupancy.setNames({ sage: 'Sage' });
    occupancy.claim('object', 'mug', 'sage');
    const plan = planAction(withOthers(worldAt(1.1, -0.45, 0), occupancy), INITIAL_STATE, { kind: 'pick', objectId: 'mug' });
    expect(plan).toEqual({ type: 'skip', reason: 'Sage has it' });
    occupancy.release('object', 'mug', 'sage');
    const ok = planAction(withOthers(worldAt(1.1, -0.45, 0), occupancy), INITIAL_STATE, { kind: 'pick', objectId: 'mug' });
    expect(ok.type).toBe('stream');
    expect(occupancy.holder('object', 'mug')).toBe('echo');
  });
});
