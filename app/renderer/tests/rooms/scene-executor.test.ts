import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomFile } from '../../../main/src/rooms/types.js';
import type { AvatarMotionChunkEvent, AvatarMotionStreamRequest, AvatarMotionStreamResult } from '../../src/avatar/types.js';
import { RoomStage } from '../../src/rooms/room-stage.js';
import type { PlanWorld, StreamEvent } from '../../src/rooms/scene-actions.js';
import {
  SceneActionExecutor,
  type ChunkHooks,
  type ClipEndAction,
  type SceneActivity,
  type SceneBridge,
  type SceneEnv,
} from '../../src/rooms/scene-executor.js';
import { motionToWorld, type RootPose } from '../../src/rooms/scene-frames.js';
import { builtInRoom } from './fixtures.js';

let room: RoomFile;
let stage: RoomStage;

beforeAll(async () => {
  room = builtInRoom('reading-room');
  stage = await RoomStage.create(room);
});

class FakeEnv implements SceneEnv {
  pose: RootPose = { x: 0, z: -0.3, yaw: 0 };
  calls: string[] = [];
  held: string | null = null;
  planWorld(): PlanWorld {
    return {
      room,
      hasNavigation: stage.hasNavigation,
      findPath: (from, to) => stage.findPath(from, to),
      closestWalkable: (p) => stage.closestWalkable(p),
      objectPosition: () => null,
      frame: { origin: { ...this.pose }, scale: 1 },
      restHipsHeight: 0.95,
    };
  }
  setRootPose(pose: RootPose): void {
    this.pose = pose;
    this.calls.push(`root ${pose.x.toFixed(2)},${pose.z.toFixed(2)},${pose.yaw.toFixed(2)}`);
  }
  attach(objectId: string): boolean {
    this.held = objectId;
    this.calls.push(`attach ${objectId}`);
    return true;
  }
  detach(event: StreamEvent): void {
    this.held = null;
    this.calls.push(`detach ${event.objectId}`);
  }
  releaseHeld(): void {
    this.calls.push('release');
    this.held = null;
  }
}

interface PlayedChunk {
  chunk: AvatarMotionChunkEvent;
  hooks: ChunkHooks;
}

class FakeBridge implements SceneBridge {
  requests: AvatarMotionStreamRequest[] = [];
  cancelled: string[] = [];
  played: PlayedChunk[] = [];
  private resolvers = new Map<string, { resolve: (r: AvatarMotionStreamResult) => void; reject: (e: unknown) => void }>();
  streamMotion(request: AvatarMotionStreamRequest): Promise<AvatarMotionStreamResult> {
    this.requests.push(request);
    return new Promise((resolve, reject) => this.resolvers.set(request.streamId, { resolve, reject }));
  }
  cancelMotion(streamId: string): void {
    this.cancelled.push(streamId);
    this.resolvers.get(streamId)?.reject(new Error('aborted'));
  }
  playChunk(chunk: AvatarMotionChunkEvent, hooks: ChunkHooks): void {
    this.played.push({ chunk, hooks });
  }
  finish(streamId: string, chunks: number, session?: string): void {
    this.resolvers.get(streamId)?.resolve({ streamId, chunks, firstChunkMs: 10, totalMs: 20, ...(session ? { session } : {}) });
  }
  get last(): AvatarMotionStreamRequest {
    return this.requests[this.requests.length - 1]!;
  }
}

function chunk(streamId: string, index: number, endPose?: AvatarMotionChunkEvent['endPose']): AvatarMotionChunkEvent {
  return { streamId, index, start: index * 2, name: `c${index}`, duration: 2, data: '', ...(endPose ? { endPose } : {}) };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !condition(); i += 1) await tick();
  expect(condition()).toBe(true);
}

/** Feeds a stream's chunks, lets them all play, and returns the verdict of the last one. */
async function playStream(
  executor: SceneActionExecutor,
  bridge: FakeBridge,
  streamId: string,
  endPoses: Array<AvatarMotionChunkEvent['endPose']>,
  session?: string,
): Promise<ClipEndAction> {
  const before = bridge.played.length;
  endPoses.forEach((pose, index) => expect(executor.handleChunk(chunk(streamId, index, pose))).toBe(true));
  bridge.finish(streamId, endPoses.length, session);
  await tick();
  const mine = bridge.played.slice(before);
  let verdict: ClipEndAction;
  for (const entry of mine) {
    entry.hooks.onStart();
    verdict = entry.hooks.onEnd();
  }
  await tick();
  return verdict;
}

describe('SceneActionExecutor', () => {
  let executor: SceneActionExecutor;
  let env: FakeEnv;
  let bridge: FakeBridge;
  let activity: SceneActivity[];
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    let n = 0;
    executor = new SceneActionExecutor({ newId: () => `s${(n += 1)}` });
    env = new FakeEnv();
    bridge = new FakeBridge();
    activity = [];
    executor.setBridge(bridge);
    executor.setEnv(env);
    executor.onActivity((a) => activity.push(a));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => warn.mockRestore());

  it('runs actions one at a time, in order, baking the root after each', async () => {
    executor.submit([
      { kind: 'go', objectId: 'bookshelf' },
      { kind: 'look', objectId: 'sofa' },
    ]);
    await until(() => bridge.requests.length === 1);
    expect(bridge.requests[0]!.streamId).toBe('s1');
    expect(bridge.requests[0]!.path).toBeDefined();
    // The second action does not start while the first is still going.
    await tick();
    expect(bridge.requests).toHaveLength(1);

    const end = bridge.requests[0]!.path!.points.at(-1)!;
    const verdict = await playStream(executor, bridge, 's1', [undefined, { root: end, height: 0.95, heading: -1.5 }]);
    expect(verdict).toBe('release');
    // Baked at the pelvis end pose, in world space: start frame is (0,-0.3) facing +Z.
    const [wx, wz] = motionToWorld({ origin: { x: 0, z: -0.3, yaw: 0 }, scale: 1 }, end[0], end[1]);
    expect(env.calls[0]).toBe(`root ${wx.toFixed(2)},${wz.toFixed(2)},-1.50`);

    await until(() => bridge.requests.length === 2);
    expect(bridge.requests[1]!.prompt).toBe('a person turns to look at something');
    expect(activity.filter((a) => a.type === 'start').map((a) => (a as { label: string }).label)).toEqual(['bookshelf', 'sofa']);
  });

  it('does not bake until the last chunk has finished playing', async () => {
    executor.submit([{ kind: 'look', objectId: 'bookshelf' }]);
    await until(() => bridge.requests.length === 1);
    executor.handleChunk(chunk('s1', 0));
    executor.handleChunk(chunk('s1', 1, { root: [0, 0], height: 0.95, heading: -1.4 }));
    bridge.finish('s1', 2);
    await tick();
    bridge.played[0]!.hooks.onStart();
    expect(bridge.played[0]!.hooks.onEnd()).toBeUndefined();
    expect(env.calls).toEqual([]);
    bridge.played[1]!.hooks.onStart();
    expect(bridge.played[1]!.hooks.onEnd()).toBe('release');
    expect(env.calls).toHaveLength(1);
  });

  it('marks continuation chunks so they play without a blend-in', async () => {
    executor.submit([{ kind: 'look', objectId: 'bookshelf' }]);
    await until(() => bridge.requests.length === 1);
    executor.handleChunk(chunk('s1', 0));
    executor.handleChunk(chunk('s1', 1));
    expect(bridge.played.map((p) => p.hooks.continuation)).toEqual([false, true]);
  });

  it('ignores chunks from streams it did not start', () => {
    expect(executor.handleChunk(chunk('other', 0))).toBe(false);
  });

  it('sits, holds, and keeps the session, then inserts a stand before walking', async () => {
    executor.submit([{ kind: 'sit', objectId: 'sofa' }]);
    await until(() => bridge.requests.length === 1);
    const verdict = await playStream(executor, bridge, 's1', [undefined, { root: [0, -0.4], height: 0.58, heading: 0 }], 'sess-1');
    expect(verdict).toBe('hold');
    await until(() => !executor.busy);
    expect(executor.getState()).toMatchObject({ posture: 'seated', seat: { objectId: 'sofa', session: 'sess-1' } });
    expect(env.calls).toEqual([]); // no bake while seated

    executor.submit([{ kind: 'go', objectId: 'bookshelf' }]);
    await until(() => bridge.requests.length === 2);
    const stand = bridge.requests[1]!;
    expect(stand.prompt).toBe('a person stands up from the chair');
    expect(stand.continueFrom).toBe('sess-1');
    const standVerdict = await playStream(executor, bridge, 's2', [{ root: [0, 0.4], height: 0.95, heading: 3.1 }]);
    expect(standVerdict).toBe('release');
    expect(executor.getState().posture).toBe('standing');
    expect(env.calls).toHaveLength(1);
    // Then the walk itself starts, from the baked pose.
    await until(() => bridge.requests.length === 3);
    expect(bridge.requests[2]!.path).toBeDefined();
    expect(bridge.requests[2]!.continueFrom).toBeUndefined();
  });

  it('treats a sit without a session as standing', async () => {
    executor.submit([{ kind: 'sit', objectId: 'sofa' }]);
    await until(() => bridge.requests.length === 1);
    const verdict = await playStream(executor, bridge, 's1', [{ root: [0, -0.4], height: 0.58, heading: 0 }]);
    expect(verdict).toBe('release');
    expect(executor.getState().posture).toBe('standing');
  });

  it('fires attach at 1.7 s of the stream and keeps holding the object', async () => {
    vi.useFakeTimers();
    try {
      const timed = new SceneActionExecutor({ newId: () => 'r1' });
      timed.setBridge(bridge);
      timed.setEnv(env);
      const grab = stage.worldTag('mug', 'grab')!.position;
      env.pose = { x: grab[0], z: grab[2] + 0.5, yaw: Math.PI };
      timed.submit([{ kind: 'pick', objectId: 'mug' }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(bridge.last.targets![0]!.hand).toBeDefined();
      timed.handleChunk(chunk('r1', 0));
      timed.handleChunk(chunk('r1', 1, { root: [0, 0], height: 0.95, heading: 0 }));
      bridge.finish('r1', 2);
      await vi.advanceTimersByTimeAsync(0);
      bridge.played[0]!.hooks.onStart();
      bridge.played[1]!.hooks.onStart();
      await vi.advanceTimersByTimeAsync(1600);
      expect(env.calls).not.toContain('attach mug');
      await vi.advanceTimersByTimeAsync(200);
      // The event falls in the first 2 s chunk: 1.7 s after it starts.
      expect(env.calls).toContain('attach mug');
      expect(timed.getState().held).toMatchObject({ objectId: 'mug' });
      bridge.played[0]!.hooks.onEnd();
      bridge.played[1]!.hooks.onEnd();
      await vi.advanceTimersByTimeAsync(0);
      expect(timed.getState().held).toMatchObject({ objectId: 'mug' });
      expect(timed.getState().posture).toBe('standing');
      timed.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts the held mug on the coffee table, releasing it', async () => {
    const table = room.objects.find((o) => o.id === 'coffee-table')!;
    env.pose = { x: table.position[0], z: table.position[2] + 0.8, yaw: Math.PI };
    // Pretend the mug is already in hand.
    (executor as unknown as { state: unknown }).state = { posture: 'standing', held: { objectId: 'mug', hand: 'right' } };
    executor.submit([{ kind: 'put', objectId: 'mug', surfaceId: 'coffee-table' }]);
    await until(() => bridge.requests.length === 1);
    // No chunk ever starts playing here, so the leftover event fires when the stream ends.
    executor.handleChunk(chunk('s1', 0, { root: [0, 0], height: 0.95, heading: 0 }));
    bridge.finish('s1', 1);
    await tick();
    bridge.played[0]!.hooks.onStart();
    bridge.played[0]!.hooks.onEnd();
    await tick();
    expect(env.calls).toContain('detach mug');
    expect(executor.getState().held).toBeNull();
  });

  it('skips unplannable actions and carries on with the queue', async () => {
    executor.submit([
      { kind: 'sit', objectId: 'rug' },
      { kind: 'look', objectId: 'bookshelf' },
    ]);
    await until(() => bridge.requests.length === 1);
    expect(bridge.requests[0]!.prompt).toBe('a person turns to look at something');
    expect(activity).toContainEqual({ type: 'skipped', label: 'sit rug', reason: 'rug cannot be sat on' });
  });

  it('survives a failing motion stream and plays what arrived', async () => {
    executor.submit([
      { kind: 'go', objectId: 'bookshelf' },
      { kind: 'look', objectId: 'sofa' },
    ]);
    await until(() => bridge.requests.length === 1);
    bridge.cancelled.length = 0;
    (bridge as unknown as { resolvers: Map<string, { reject: (e: unknown) => void }> }).resolvers.get('s1')!.reject(new Error('boom'));
    await until(() => bridge.requests.length === 2);
    expect(activity).toContainEqual({ type: 'failed', id: 's1', message: 'boom' });
    expect(executor.getState().posture).toBe('standing');
  });

  it('queues gestures behind scene actions and skips them while seated', async () => {
    const gesture = vi.fn(async () => undefined);
    executor.submit([{ kind: 'look', objectId: 'bookshelf' }]);
    executor.submitGesture('shrug', gesture);
    await until(() => bridge.requests.length === 1);
    expect(gesture).not.toHaveBeenCalled();
    await playStream(executor, bridge, 's1', [{ root: [0, 0], height: 0.95, heading: -1.4 }]);
    await until(() => gesture.mock.calls.length === 1);

    (executor as unknown as { state: unknown }).state = {
      posture: 'seated',
      held: null,
      seat: { objectId: 'sofa', session: 'x', frame: env.planWorld().frame, approach: [0, 0, 0], facing: 0 },
    };
    executor.submitGesture('wave', gesture);
    await tick();
    expect(gesture).toHaveBeenCalledTimes(1);
  });

  describe('interruptions', () => {
    it('drops the queue and stops a walk where it is', async () => {
      executor.submit([
        { kind: 'go', objectId: 'bookshelf' },
        { kind: 'go', objectId: 'sofa' },
      ]);
      await until(() => bridge.requests.length === 1);
      executor.handleChunk(chunk('s1', 0, { root: [0, 1], height: 0.95, heading: 0.3 }));
      executor.interrupt();
      expect(bridge.cancelled).toEqual(['s1']);
      // Later chunks of the cancelled stream are dropped.
      expect(executor.handleChunk(chunk('s1', 1))).toBe(true);
      expect(bridge.played).toHaveLength(1);
      bridge.played[0]!.hooks.onStart();
      // The chunk that was already playing finishes, then the avatar is baked where it ended.
      await tick();
      expect(bridge.played[0]!.hooks.onEnd()).toBe('release');
      expect(env.calls[0]).toMatch(/^root /);
      await tick();
      expect(bridge.requests).toHaveLength(1);
      expect(executor.busy).toBe(false);
    });

    it('lets a sit finish but still drops what was queued after it', async () => {
      executor.submit([
        { kind: 'sit', objectId: 'sofa' },
        { kind: 'go', objectId: 'bookshelf' },
      ]);
      await until(() => bridge.requests.length === 1);
      executor.interrupt();
      expect(bridge.cancelled).toEqual([]);
      const verdict = await playStream(executor, bridge, 's1', [{ root: [0, -0.4], height: 0.58, heading: 0 }], 'sess');
      expect(verdict).toBe('hold');
      await tick();
      expect(bridge.requests).toHaveLength(1);
      expect(executor.getState().posture).toBe('seated');
    });

    it('does not stand a seated avatar up', async () => {
      executor.submit([{ kind: 'sit', objectId: 'sofa' }]);
      await until(() => bridge.requests.length === 1);
      await playStream(executor, bridge, 's1', [{ root: [0, -0.4], height: 0.58, heading: 0 }], 'sess');
      executor.interrupt();
      expect(executor.getState().posture).toBe('seated');
    });
  });

  describe('reset', () => {
    it('cancels streams, puts the held object back and forgets the state when the room changes', async () => {
      executor.submit([{ kind: 'go', objectId: 'bookshelf' }]);
      await until(() => bridge.requests.length === 1);
      (executor as unknown as { state: unknown }).state = { posture: 'standing', held: { objectId: 'mug', hand: 'left' } };
      executor.setEnv(new FakeEnv());
      expect(bridge.cancelled).toEqual(['s1']);
      expect(env.calls).toContain('release');
      expect(executor.getState()).toEqual({ posture: 'standing', held: null });
      expect(executor.busy).toBe(false);
      expect(activity).toContainEqual({ type: 'done', id: 's1', detail: 'stopped' });
      // A stale clip callback after the reset changes nothing.
      expect(executor.handleChunk(chunk('s1', 0))).toBe(false);
    });

    it('ignores scene actions without a room', () => {
      const bare = new SceneActionExecutor();
      bare.setBridge(bridge);
      bare.submit([{ kind: 'come' }]);
      expect(bridge.requests).toHaveLength(0);
    });
  });
});

