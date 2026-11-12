/**
 * Runs scene actions one at a time. Each action is planned (scene-actions.ts) into one motion
 * stream, whose chunks are played as they arrive; when the last chunk has played, the avatar's root
 * is moved to where the motion ended (the "bake") and the next action starts from there. The
 * executor knows nothing about WebGL: the world comes in through `SceneEnv` and the motion service
 * and animation playback through `SceneBridge`, so it runs in tests with fakes.
 */
import type { ClipEndAction } from '../avatar/animation-bus.js';
import type {
  AvatarMotionChunkEvent,
  AvatarMotionEndPose,
  AvatarMotionStreamRequest,
  AvatarMotionStreamResult,
  AvatarRestSkeleton,
} from '../avatar/types.js';
import {
  INITIAL_STATE,
  planAction,
  type ActionPlan,
  type AvatarState,
  type Hand,
  type PlanWorld,
  type PlannedStream,
  type SceneAction,
  type StreamEvent,
} from './scene-actions.js';
import type { AvatarOccupancy } from './room-occupancy.js';
import { bakedRootPose, type RootPose } from './scene-frames.js';

export type { ClipEndAction };

export interface ChunkHooks {
  /** Start where the previous clip ended, with no blend-in. */
  continuation: boolean;
  onStart(): void;
  onEnd(): ClipEndAction;
}

/** The motion service and animation playback, as the executor needs them. */
export interface SceneBridge {
  streamMotion(request: AvatarMotionStreamRequest): Promise<AvatarMotionStreamResult>;
  /** Stops generating; the stream's promise then rejects. */
  cancelMotion?(streamId: string): void;
  playChunk(chunk: AvatarMotionChunkEvent, hooks: ChunkHooks): void;
  avatarRest?(): AvatarRestSkeleton | undefined;
}

/** The room and the avatar in it. */
export interface SceneEnv {
  /** A snapshot for planning, or null while there is no room or avatar. */
  planWorld(): PlanWorld | null;
  setRootPose(pose: RootPose): void;
  attach(objectId: string, hand: Hand): boolean;
  detach(event: StreamEvent): void;
  /** Puts every carried object back where it came from (the room is going away). */
  releaseHeld(): void;
  /** The avatar sat down on this object and its sit clip is held: fit the pelvis onto the seat surface. */
  setSeat?(objectId: string): void;
  /** The avatar is standing (or getting up): let the seat fit ease away. */
  clearSeat?(): void;
}

export type SceneActivity =
  | { type: 'start'; id: string; label: string }
  | { type: 'done'; id: string; detail?: string }
  | { type: 'failed'; id: string; message: string }
  | { type: 'skipped'; label: string; reason: string };

export interface SceneExecutorOptions {
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface ScheduledEvent {
  handle: unknown;
  event: StreamEvent;
  fired: boolean;
}

interface RunningStream {
  id: string;
  planned: PlannedStream;
  interruptible: boolean;
  enqueued: number;
  finished: number;
  lastEndPose?: AvatarMotionEndPose;
  generationEnded: boolean;
  failed: boolean;
  cancelled: boolean;
  session?: string;
  pending: StreamEvent[];
  timers: ScheduledEvent[];
  settled: boolean;
  done: Deferred;
}

/** Decides at its turn, from where the avatar is by then, which actions to run (none: nothing happens). */
export type PlanBuilder = (world: PlanWorld, state: AvatarState) => SceneAction[];

type QueueItem =
  | { type: 'action'; action: SceneAction }
  | { type: 'task'; label: string; run: () => Promise<unknown> }
  | { type: 'plan'; label: string; build: PlanBuilder };

const MAX_INSERT_DEPTH = 4;
const DEFAULT_CHUNK_SECONDS = 2;

export class SceneActionExecutor {
  private env: SceneEnv | null = null;
  private bridge: SceneBridge | null = null;
  private state: AvatarState = { ...INITIAL_STATE };
  private queue: QueueItem[] = [];
  private streams = new Map<string, RunningStream>();
  private running = false;
  /** This avatar's claims in the room, from the last plan's world; null with a single avatar. */
  private occupancy: AvatarOccupancy | null = null;
  /** Bumped by `reset`; work that started under an older generation stops touching state. */
  private generation = 0;
  /** Bumped by `interrupt`; the rest of an interrupted action chain is dropped. */
  private epoch = 0;
  private listeners = new Set<(activity: SceneActivity) => void>();
  private interruptListeners = new Set<() => void>();
  private readonly newId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: SceneExecutorOptions = {}) {
    this.newId = options.newId ?? (() => Math.random().toString(36).slice(2, 10));
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  setBridge(bridge: SceneBridge | null): void {
    this.bridge = bridge;
  }

  /** Binds the room the avatar is in. A different (or no) room resets everything first. */
  setEnv(env: SceneEnv | null): void {
    if (env === this.env) return;
    this.reset();
    this.env = env;
  }

  onActivity(listener: (activity: SceneActivity) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): AvatarState {
    return this.state;
  }

  /** A snapshot of the room and the avatar in it for planning, or null while there is no room or avatar. */
  world(): PlanWorld | null {
    return this.env?.planWorld() ?? null;
  }

  /** Called after each `interrupt` (the user spoke, woke the avatar or tapped). */
  onInterrupt(listener: () => void): () => void {
    this.interruptListeners.add(listener);
    return () => {
      this.interruptListeners.delete(listener);
    };
  }

  /** True while an action is queued or running. */
  get busy(): boolean {
    return this.running || this.queue.length > 0;
  }

  /** Queues actions after whatever is already waiting. */
  submit(actions: SceneAction[]): void {
    if (!this.env || !this.bridge) {
      console.warn('[scene-actions] ignoring scene actions: no room is active');
      return;
    }
    for (const action of actions) this.queue.push({ type: 'action', action });
    void this.pump();
  }

  /**
   * Queues a decision: when its turn comes, `build` looks at the room and the avatar as they are by
   * then and returns the actions to run (for example, walk home only if it wandered off).
   */
  submitPlan(label: string, build: PlanBuilder): void {
    if (!this.env || !this.bridge) return;
    this.queue.push({ type: 'plan', label, build });
    void this.pump();
  }

  /**
   * Queues a body gesture ({move:...}) behind the scene actions. It is skipped, with a warning,
   * while seated: a gesture generated from a standing start would not fit the seated pose.
   */
  submitGesture(label: string, run: () => Promise<unknown>): void {
    this.queue.push({ type: 'task', label, run });
    void this.pump();
  }

  /**
   * The user spoke, woke the avatar or tapped: forget what was queued and stop a walk or turn in
   * progress where the avatar is. Sitting, standing up, picking up and putting down finish, and a
   * seated avatar stays seated.
   */
  interrupt(): void {
    this.epoch += 1;
    this.queue.length = 0;
    this.occupancy?.cancelWalk();
    for (const stream of this.streams.values()) {
      if (stream.interruptible && !stream.cancelled) this.cancelStream(stream);
    }
    for (const listener of [...this.interruptListeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[scene-actions] interrupt listener threw', error);
      }
    }
  }

  /** The room changed or went away: cancel everything, put carried things back and forget the state. */
  reset(): void {
    this.generation += 1;
    this.epoch += 1;
    this.queue.length = 0;
    this.running = false;
    for (const stream of this.streams.values()) {
      this.cancelStream(stream);
      this.clearTimers(stream);
      if (!stream.settled) this.emit({ type: 'done', id: stream.id, detail: 'cancelled' });
      stream.settled = true;
      stream.done.resolve();
    }
    this.streams.clear();
    try {
      this.env?.releaseHeld();
    } catch (error) {
      console.warn('[scene-actions] could not put the held object down', error);
    }
    this.env?.clearSeat?.();
    this.state = { ...INITIAL_STATE };
    try {
      this.occupancy?.releaseAll();
    } catch (error) {
      console.warn('[scene-actions] could not release the room claims', error);
    }
    this.occupancy = null;
  }

  /** Takes a motion chunk if it belongs to a scene stream; returns false for any other stream. */
  handleChunk(chunk: AvatarMotionChunkEvent): boolean {
    const stream = this.streams.get(chunk.streamId);
    if (!stream) return false;
    if (stream.cancelled || !this.bridge) return true;
    stream.enqueued += 1;
    if (chunk.endPose) stream.lastEndPose = chunk.endPose;
    const length = chunk.duration ?? DEFAULT_CHUNK_SECONDS;
    this.bridge.playChunk(chunk, {
      continuation: chunk.index > 0 || stream.planned.request.continueFrom !== undefined,
      onStart: () => this.chunkStarted(stream, chunk.start, length),
      onEnd: () => this.chunkEnded(stream),
    });
    return true;
  }

  // -- Queue ----------------------------------------------------------------------------------

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    try {
      while (generation === this.generation) {
        const item = this.queue.shift();
        if (!item) break;
        const epoch = this.epoch;
        try {
          if (item.type === 'task') {
            if (this.state.posture === 'seated') {
              console.warn(`[scene-actions] skipping "${item.label}" while seated`);
              this.emit({ type: 'skipped', label: item.label, reason: 'the avatar is seated' });
            } else {
              await item.run();
            }
          } else if (item.type === 'plan') {
            await this.runPlan(item, generation, epoch);
          } else {
            await this.runAction(item.action, generation, epoch, 0);
          }
        } catch (error) {
          console.warn('[scene-actions] an action failed', error);
        }
      }
    } finally {
      if (generation === this.generation) this.running = false;
    }
  }

  private async runPlan(item: Extract<QueueItem, { type: 'plan' }>, generation: number, epoch: number): Promise<void> {
    const world = this.env?.planWorld();
    if (!world) return;
    let actions: SceneAction[];
    try {
      actions = item.build(world, this.state);
    } catch (error) {
      console.warn(`[scene-actions] could not decide "${item.label}"`, error);
      return;
    }
    for (const action of actions) await this.runAction(action, generation, epoch, 0);
  }

  private stale(generation: number, epoch: number): boolean {
    return generation !== this.generation || epoch !== this.epoch;
  }

  private async runAction(action: SceneAction, generation: number, epoch: number, depth: number): Promise<void> {
    if (this.stale(generation, epoch)) return;
    const env = this.env;
    if (!env) return;
    const world = env.planWorld();
    if (!world) {
      console.warn('[scene-actions] the avatar is not ready for', action.kind);
      return;
    }
    this.occupancy = world.occupancy ?? null;
    let plan: ActionPlan;
    try {
      plan = planAction(world, this.state, action);
    } catch (error) {
      console.warn('[scene-actions] could not plan', action.kind, error);
      return;
    }
    if (plan.type === 'skip') {
      console.warn(`[scene-actions] skipping ${action.kind}: ${plan.reason}`);
      this.emit({ type: 'skipped', label: describeAction(action), reason: plan.reason });
      return;
    }
    if (plan.type === 'insert') {
      if (depth >= MAX_INSERT_DEPTH) {
        console.warn(`[scene-actions] giving up on ${action.kind}: too many steps to get ready`);
        return;
      }
      for (const inserted of plan.actions) await this.runAction(inserted, generation, epoch, depth + 1);
      await this.runAction(action, generation, epoch, depth + 1);
      return;
    }
    await this.runStream(plan.stream, generation, epoch);
  }

  // -- Streams --------------------------------------------------------------------------------

  private async runStream(planned: PlannedStream, generation: number, epoch: number): Promise<void> {
    // Only one avatar walks at a time; gestures, looks and in-place actions never wait.
    const occupancy = this.occupancy;
    let releaseWalk: (() => void) | null = null;
    if (occupancy && planned.request.path) {
      releaseWalk = await occupancy.acquireWalk();
      if (this.stale(generation, epoch)) {
        releaseWalk();
        this.syncClaims();
        return;
      }
    }
    try {
      await this.runStreamNow(planned, generation);
    } finally {
      releaseWalk?.();
    }
  }

  private async runStreamNow(planned: PlannedStream, generation: number): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return;
    const id = this.newId();
    const request = planned.request;
    const stream: RunningStream = {
      id,
      planned,
      interruptible:
        planned.outcome.posture === 'standing' && planned.events.length === 0 && request.continueFrom === undefined,
      enqueued: 0,
      finished: 0,
      generationEnded: false,
      failed: false,
      cancelled: false,
      pending: [...planned.events],
      timers: [],
      settled: false,
      done: deferred(),
    };
    this.streams.set(id, stream);
    // Getting up (or walking off) starts from the plain floor, so the seat fit eases out first.
    if (this.state.posture === 'seated') this.env?.clearSeat?.();
    this.emit({ type: 'start', id, label: planned.label });

    const rest = bridge.avatarRest?.();
    let result: Promise<AvatarMotionStreamResult>;
    try {
      result = bridge.streamMotion({
        streamId: id,
        prompt: request.prompt,
        duration: request.duration,
        ...(rest ? { avatarRest: rest } : {}),
        ...(request.phases ? { phases: request.phases } : {}),
        ...(request.path ? { path: request.path } : {}),
        ...(request.targets ? { targets: request.targets } : {}),
        ...(request.continueFrom ? { continueFrom: request.continueFrom } : {}),
      });
    } catch (error) {
      result = Promise.reject(error);
    }
    result.then(
      (summary) => {
        stream.session = summary.session;
        this.generationEnded(stream, null, summary);
      },
      (error: unknown) => this.generationEnded(stream, error, null),
    );

    await stream.done.promise;
    if (generation === this.generation) this.streams.delete(id);
  }

  private generationEnded(stream: RunningStream, error: unknown, summary: AvatarMotionStreamResult | null): void {
    if (stream.settled || stream.generationEnded) return;
    stream.generationEnded = true;
    if (error && !stream.cancelled) {
      stream.failed = true;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[scene-actions] ${stream.planned.label} failed:`, message);
      this.emit({ type: 'failed', id: stream.id, message });
    } else if (summary) {
      this.emit({ type: 'done', id: stream.id, detail: `${summary.chunks} chunk${summary.chunks === 1 ? '' : 's'}` });
    }
    if (stream.finished >= stream.enqueued) this.finalize(stream);
  }

  private chunkStarted(stream: RunningStream, start: number, length: number): void {
    if (stream.settled) return;
    for (const event of [...stream.pending]) {
      if (event.t >= start + length) continue;
      stream.pending.splice(stream.pending.indexOf(event), 1);
      const delayMs = Math.max(0, (event.t - start) * 1000);
      const scheduled: ScheduledEvent = { handle: undefined, event, fired: false };
      scheduled.handle = this.setTimer(() => {
        scheduled.fired = true;
        if (!stream.settled) this.fireEvent(event);
      }, delayMs);
      stream.timers.push(scheduled);
    }
  }

  private chunkEnded(stream: RunningStream): ClipEndAction {
    if (stream.settled) return undefined;
    stream.finished += 1;
    if (stream.generationEnded && stream.finished >= stream.enqueued) return this.finalize(stream);
    return undefined;
  }

  private fireEvent(event: StreamEvent): void {
    const env = this.env;
    if (!env) return;
    try {
      if (event.kind === 'attach') {
        if (env.attach(event.objectId, event.hand)) this.state = { ...this.state, held: { objectId: event.objectId, hand: event.hand } };
        else console.warn(`[scene-actions] could not pick up ${event.objectId}`);
      } else {
        env.detach(event);
        this.state = { ...this.state, held: null };
      }
    } catch (error) {
      console.warn('[scene-actions] could not', event.kind, event.objectId, error);
    }
  }

  /** The stream has been generated and every clip of it has played (or was cancelled): bake and move on. */
  private finalize(stream: RunningStream): ClipEndAction {
    if (stream.settled) return undefined;
    stream.settled = true;
    const { planned } = stream;
    const played = stream.enqueued > 0;
    // Events that never got their moment (a short or cut-off stream) still happen, unless it failed.
    if (!stream.failed && !stream.cancelled) {
      for (const scheduled of stream.timers) if (!scheduled.fired) this.fireEvent(scheduled.event);
      for (const event of stream.pending) this.fireEvent(event);
    }
    this.clearTimers(stream);
    stream.pending = [];
    if (stream.cancelled) this.emit({ type: 'done', id: stream.id, detail: 'stopped' });

    let verdict: ClipEndAction;
    const env = this.env;
    if (env && played) {
      const endPose = stream.lastEndPose ?? (stream.cancelled || stream.failed ? undefined : planned.expectedEnd);
      const { outcome } = planned;
      const session = stream.failed || stream.cancelled ? undefined : stream.session;
      if (outcome.posture === 'seated' && !session) {
        console.warn('[scene-actions] sit did not finish cleanly; treating the avatar as standing');
      }
      if (outcome.posture === 'seated' && session) {
        this.state = { ...this.state, posture: 'seated', seat: { ...outcome.seat, session } };
        env.setSeat?.(outcome.seat.objectId);
        verdict = 'hold';
      } else {
        if (endPose) {
          env.setRootPose(bakedRootPose(planned.frame, endPose));
        } else {
          console.warn('[scene-actions] the motion service reported no end pose; the avatar returns to where it started');
        }
        this.state = { ...this.state, posture: 'standing', seat: undefined };
        env.clearSeat?.();
        verdict = 'release';
      }
    }
    this.syncClaims();
    stream.done.resolve();
    return verdict;
  }

  /** Between actions nothing is claimed beyond where the avatar sits and what it holds. */
  private syncClaims(): void {
    const occupancy = this.occupancy;
    if (!occupancy) return;
    try {
      occupancy.releaseSpot();
      occupancy.keepOnly({
        ...(this.state.posture === 'seated' && this.state.seat ? { seat: this.state.seat.objectId } : {}),
        ...(this.state.held ? { object: this.state.held.objectId } : {}),
      });
    } catch (error) {
      console.warn('[scene-actions] could not update the room claims', error);
    }
  }

  private cancelStream(stream: RunningStream): void {
    if (stream.cancelled) return;
    stream.cancelled = true;
    if (!stream.generationEnded) {
      try {
        this.bridge?.cancelMotion?.(stream.id);
      } catch (error) {
        console.warn('[scene-actions] could not cancel the motion stream', error);
      }
    }
    // Nothing of this stream is playing yet: there is nothing to wait for.
    if (stream.enqueued === 0 && !stream.settled) {
      stream.generationEnded = true;
      this.finalize(stream);
    }
  }

  private clearTimers(stream: RunningStream): void {
    for (const scheduled of stream.timers) this.clearTimer(scheduled.handle);
    stream.timers = [];
  }

  private emit(activity: SceneActivity): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(activity);
      } catch (error) {
        console.error('[scene-actions] activity listener threw', error);
      }
    }
  }
}

function describeAction(action: SceneAction): string {
  switch (action.kind) {
    case 'go':
    case 'look':
    case 'sit':
    case 'pick':
      return `${action.kind} ${action.objectId}`;
    case 'lookAtPoint':
      return `look at ${action.label ?? 'a point'}`;
    case 'put':
      return `put ${action.objectId} on ${action.surfaceId}`;
    default:
      return action.kind;
  }
}
