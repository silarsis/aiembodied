/**
 * Per-avatar movement bookkeeping (docs/features/multi-avatar-movement.md, phases A and B).
 *
 * Knows which avatar a live-motion stream belongs to (so its chunks play on that avatar's actor),
 * keeps repeat filters per avatar, and owns one scene action executor per avatar. Echo's executor is
 * the one App created and injected; the others are made on first use with a bridge of their own.
 * The room env of each executor is bound by the avatar renderer (`RoomSceneController.envFor`).
 */
import { MoveRequestFilter } from '../avatar/live-motion.js';
import type { AvatarMotionChunkEvent } from '../avatar/types.js';
import { SceneActionExecutor, type SceneActivity, type SceneBridge } from './scene-executor.js';

const ECHO_ID = 'echo';

export interface MovementRig {
  avatarId: string;
  executor: SceneActionExecutor;
}

/** Streams that never end cleanly (a lost connection) must not pile up. */
export const MAX_TRACKED_STREAMS = 64;

export class MovementRigs {
  private readonly streams = new Map<string, string>();
  private readonly filters = new Map<string, MoveRequestFilter>();
  private readonly sceneFilters = new Map<string, MoveRequestFilter>();
  private readonly rigs = new Map<string, MovementRig>();
  private bridgeFactory: ((avatarId: string) => SceneBridge | null) | null = null;
  private readonly activityListeners = new Set<(avatarId: string, activity: SceneActivity) => void>();
  private readonly activityOff = new Map<string, () => void>();

  /** `echoExecutor` is Echo's existing executor; without one a new executor is made for her. */
  constructor(echoExecutor: SceneActionExecutor = new SceneActionExecutor()) {
    this.rigs.set(ECHO_ID, { avatarId: ECHO_ID, executor: echoExecutor });
  }

  /** The avatar's rig, made on first use. Echo's executor is the injected one. */
  get(avatarId: string): MovementRig {
    let rig = this.rigs.get(avatarId);
    if (!rig) {
      rig = { avatarId, executor: new SceneActionExecutor() };
      this.rigs.set(avatarId, rig);
      rig.executor.setBridge(this.bridgeFactory?.(avatarId) ?? null);
      this.watchActivity(rig);
    }
    return rig;
  }

  /**
   * How the executors of the avatars other than Echo reach the motion service and their actor. Applied to the
   * rigs that exist and to those made later; null (no service) clears them. Echo's bridge stays with App.
   */
  setBridgeFactory(factory: ((avatarId: string) => SceneBridge | null) | null): void {
    this.bridgeFactory = factory;
    for (const rig of this.rigs.values()) {
      if (rig.avatarId !== ECHO_ID) rig.executor.setBridge(factory?.(rig.avatarId) ?? null);
    }
  }

  /** Activity (tool-call rows) of every executor but Echo's, existing and future. */
  onOtherActivity(listener: (avatarId: string, activity: SceneActivity) => void): () => void {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  private watchActivity(rig: MovementRig): void {
    this.activityOff.set(
      rig.avatarId,
      rig.executor.onActivity((activity) => {
        for (const listener of [...this.activityListeners]) listener(rig.avatarId, activity);
      }),
    );
  }

  /** Offers a motion chunk to every executor, Echo's first; true when one of them started that stream. */
  handleChunk(chunk: AvatarMotionChunkEvent): boolean {
    for (const rig of this.rigs.values()) {
      if (rig.executor.handleChunk(chunk)) return true;
    }
    return false;
  }

  /** Kevin spoke: every avatar drops what it had queued. */
  interruptAll(): void {
    for (const rig of this.rigs.values()) rig.executor.interrupt();
  }

  /** The room changed or went away. */
  resetAll(): void {
    for (const rig of this.rigs.values()) rig.executor.reset();
  }

  /** `{go:}`/`{sit:}` repeat filter for this avatar (made on first use). */
  sceneFilterFor(avatarId: string): MoveRequestFilter {
    let filter = this.sceneFilters.get(avatarId);
    if (!filter) {
      filter = new MoveRequestFilter();
      this.sceneFilters.set(avatarId, filter);
    }
    return filter;
  }

  /** `{move:}` repeat filter for this avatar (made on first use), so two avatars may wave in the same breath. */
  filterFor(avatarId: string): MoveRequestFilter {
    let filter = this.filters.get(avatarId);
    if (!filter) {
      filter = new MoveRequestFilter();
      this.filters.set(avatarId, filter);
    }
    return filter;
  }

  registerStream(streamId: string, avatarId: string): void {
    this.streams.delete(streamId);
    this.streams.set(streamId, avatarId);
    while (this.streams.size > MAX_TRACKED_STREAMS) {
      const oldest = this.streams.keys().next().value;
      if (oldest === undefined) break;
      this.streams.delete(oldest);
    }
  }

  avatarForStream(streamId: string): string | undefined {
    return this.streams.get(streamId);
  }

  /** The stream ended or failed; chunks of it have all been delivered (the request resolves after the last). */
  endStream(streamId: string): void {
    this.streams.delete(streamId);
  }

  /** Ids of the avatars with a rig (Echo always). */
  avatarIds(): string[] {
    return [...this.rigs.keys()];
  }

  /** Stream ids still running, for barge-in. */
  streamIds(): string[] {
    return [...this.streams.keys()];
  }

  /** Forget everything about an avatar (it was removed). */
  drop(avatarId: string): void {
    this.filters.delete(avatarId);
    this.sceneFilters.delete(avatarId);
    if (avatarId !== ECHO_ID) {
      const rig = this.rigs.get(avatarId);
      if (rig) {
        this.activityOff.get(avatarId)?.();
        this.activityOff.delete(avatarId);
        rig.executor.setEnv(null);
        rig.executor.setBridge(null);
        this.rigs.delete(avatarId);
      }
    }
    for (const [streamId, owner] of this.streams) {
      if (owner === avatarId) this.streams.delete(streamId);
    }
  }
}
