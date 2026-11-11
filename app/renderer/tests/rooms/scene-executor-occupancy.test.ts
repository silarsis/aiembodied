import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomFile } from '../../../main/src/rooms/types.js';
import type { AvatarMotionChunkEvent, AvatarMotionStreamRequest, AvatarMotionStreamResult } from '../../src/avatar/types.js';
import { RoomOccupancy } from '../../src/rooms/room-occupancy.js';
import { RoomStage } from '../../src/rooms/room-stage.js';
import type { PlanWorld, StreamEvent } from '../../src/rooms/scene-actions.js';
import { SceneActionExecutor, type ChunkHooks, type SceneActivity, type SceneBridge, type SceneEnv } from '../../src/rooms/scene-executor.js';
import type { RootPose } from '../../src/rooms/scene-frames.js';
import { builtInRoom } from './fixtures.js';

let room: RoomFile;
let stage: RoomStage;

beforeAll(async () => {
  room = builtInRoom('reading-room');
  stage = await RoomStage.create(room);
});

class Env implements SceneEnv {
  constructor(
    private readonly id: string,
    private readonly occupancy: RoomOccupancy | null,
    public pose: RootPose,
  ) {}
  planWorld(): PlanWorld {
    this.occupancy?.standing(this.id, { x: this.pose.x, z: this.pose.z });
    return {
      room,
      hasNavigation: stage.hasNavigation,
      findPath: (from, to) => stage.findPath(from, to),
      closestWalkable: (p) => stage.closestWalkable(p),
      objectPosition: () => null,
      frame: { origin: { ...this.pose }, scale: 1 },
      restHipsHeight: 0.95,
      ...(this.occupancy ? { others: this.occupancy.others(this.id), occupancy: this.occupancy.forAvatar(this.id) } : {}),
    };
  }
  setRootPose(pose: RootPose): void {
    this.pose = pose;
    this.occupancy?.standing(this.id, { x: pose.x, z: pose.z });
  }
  attach(): boolean {
    return true;
  }
  detach(_event: StreamEvent): void {}
  releaseHeld(): void {}
}

class Bridge implements SceneBridge {
  requests: AvatarMotionStreamRequest[] = [];
  played: Array<{ chunk: AvatarMotionChunkEvent; hooks: ChunkHooks }> = [];
  private resolvers = new Map<string, { resolve: (r: AvatarMotionStreamResult) => void; reject: (e: unknown) => void }>();
  streamMotion(request: AvatarMotionStreamRequest): Promise<AvatarMotionStreamResult> {
    this.requests.push(request);
    return new Promise((resolve, reject) => this.resolvers.set(request.streamId, { resolve, reject }));
  }
  cancelMotion(streamId: string): void {
    this.resolvers.get(streamId)?.reject(new Error('aborted'));
  }
  playChunk(chunk: AvatarMotionChunkEvent, hooks: ChunkHooks): void {
    this.played.push({ chunk, hooks });
  }
  /** One chunk with an end pose, played to its end, then the stream resolved. */
  async complete(streamId: string, executor: SceneActionExecutor, session?: string): Promise<void> {
    const request = this.requests.find((entry) => entry.streamId === streamId)!;
    const end = request.path?.points.at(-1) ?? [0, 0];
    executor.handleChunk({ streamId, index: 0, start: 0, name: 'c', duration: 2, data: '', endPose: { root: end as [number, number], height: 0.95, heading: 0 } });
    this.resolvers.get(streamId)?.resolve({ streamId, chunks: 1, firstChunkMs: 1, totalMs: 2, ...(session ? { session } : {}) });
    await tick();
    const entry = this.played[this.played.length - 1]!;
    entry.hooks.onStart();
    entry.hooks.onEnd();
    await tick();
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i += 1) await tick();
  expect(condition()).toBe(true);
}

describe('executors sharing a RoomOccupancy', () => {
  let occupancy: RoomOccupancy;
  let a: SceneActionExecutor;
  let b: SceneActionExecutor;
  let bridgeA: Bridge;
  let bridgeB: Bridge;
  let activityB: SceneActivity[];
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    occupancy = new RoomOccupancy();
    occupancy.setNames({ echo: 'Echo', sage: 'Sage' });
    let n = 0;
    const make = (id: string, pose: RootPose, bridge: Bridge) => {
      const executor = new SceneActionExecutor({ newId: () => `${id}${(n += 1)}` });
      executor.setBridge(bridge);
      executor.setEnv(new Env(id, occupancy, pose));
      return executor;
    };
    bridgeA = new Bridge();
    bridgeB = new Bridge();
    a = make('echo', { x: 0, z: -0.3, yaw: 0 }, bridgeA);
    b = make('sage', { x: 0.9, z: -0.3, yaw: 0 }, bridgeB);
    activityB = [];
    b.onActivity((activity) => activityB.push(activity));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => warn.mockRestore());

  it('never walks two avatars at once, and a look or gesture is not held up', async () => {
    a.submit([{ kind: 'go', objectId: 'bookshelf' }]);
    await until(() => bridgeA.requests.length === 1);
    b.submit([{ kind: 'go', objectId: 'armchair' }]);
    await tick();
    await tick();
    expect(bridgeB.requests).toHaveLength(0);
    // Not waiting: an in-place turn.
    const gesture = vi.fn(async () => undefined);
    b.submitGesture('wave', gesture);
    await tick();
    expect(gesture).not.toHaveBeenCalled(); // queued behind its own walk, as always
    await bridgeA.complete(bridgeA.requests[0]!.streamId, a);
    await until(() => bridgeB.requests.length === 1);
    expect(bridgeB.requests[0]!.path).toBeDefined();
    await bridgeB.complete(bridgeB.requests[0]!.streamId, b);
    await until(() => gesture.mock.calls.length === 1);
  });

  it('lets an avatar look around while another one walks', async () => {
    a.submit([{ kind: 'go', objectId: 'bookshelf' }]);
    await until(() => bridgeA.requests.length === 1);
    b.submit([{ kind: 'look', objectId: 'sofa' }]);
    await until(() => bridgeB.requests.length === 1);
    expect(bridgeB.requests[0]!.path).toBeUndefined();
  });

  it('an interrupt drops the waiting avatar from the queue and leaves the walk free', async () => {
    a.submit([{ kind: 'go', objectId: 'bookshelf' }]);
    await until(() => bridgeA.requests.length === 1);
    b.submit([{ kind: 'go', objectId: 'armchair' }]);
    await tick();
    b.interrupt();
    await tick();
    await bridgeA.complete(bridgeA.requests[0]!.streamId, a);
    await tick();
    expect(bridgeB.requests).toHaveLength(0);
    expect(b.busy).toBe(false);
    // The walk is free for anyone.
    let got = false;
    void occupancy.acquireWalk('rex').then(() => (got = true));
    await tick();
    expect(got).toBe(true);
  });

  it('interrupting the walker releases the walk', async () => {
    a.submit([{ kind: 'go', objectId: 'bookshelf' }]);
    await until(() => bridgeA.requests.length === 1);
    b.submit([{ kind: 'go', objectId: 'armchair' }]);
    await tick();
    a.interrupt();
    await until(() => bridgeB.requests.length === 1);
  });

  it('holds a seat while seated, refuses it to the other avatar, and frees it on standing up', async () => {
    a.submit([{ kind: 'sit', objectId: 'sofa' }]);
    await until(() => bridgeA.requests.length === 1);
    expect(occupancy.holder('seat', 'sofa')).toBe('echo');
    await bridgeA.complete(bridgeA.requests[0]!.streamId, a, 'sess');
    expect(a.getState().posture).toBe('seated');
    expect(occupancy.holder('seat', 'sofa')).toBe('echo');

    b.submit([{ kind: 'sit', objectId: 'sofa' }]);
    await tick();
    expect(bridgeB.requests).toHaveLength(0);
    expect(activityB).toContainEqual({ type: 'skipped', label: 'sit sofa', reason: 'Echo is sitting on the sofa' });

    a.submit([{ kind: 'stand' }]);
    await until(() => bridgeA.requests.length === 2);
    await bridgeA.complete(bridgeA.requests[1]!.streamId, a);
    expect(occupancy.holder('seat', 'sofa')).toBeNull();
  });

  it('a reset releases the seat, the goal and the queue place', async () => {
    a.submit([{ kind: 'sit', objectId: 'sofa' }]);
    await until(() => bridgeA.requests.length === 1);
    expect(occupancy.holder('seat', 'sofa')).toBe('echo');
    a.reset();
    expect(occupancy.holder('seat', 'sofa')).toBeNull();
    expect(occupancy.others('sage').find((other) => other.id === 'echo')?.goal).toBeUndefined();
  });
});

describe('a single avatar', () => {
  it('plans and runs without occupancy exactly as before', async () => {
    const bridge = new Bridge();
    const executor = new SceneActionExecutor({ newId: () => 's1' });
    executor.setBridge(bridge);
    executor.setEnv(new Env('echo', null, { x: 0, z: -0.3, yaw: 0 }));
    executor.submit([{ kind: 'go', objectId: 'bookshelf' }]);
    await until(() => bridge.requests.length === 1);
    expect(bridge.requests[0]!.path).toBeDefined();
  });
});
