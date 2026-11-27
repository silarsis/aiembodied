/**
 * Talking to the motion service from the page: the request body for a planned stream, reading its NDJSON answer,
 * and turning the VRMA chunks into one track per bone at the lab's frame rate.
 */
import type { AvatarMotionEndPose, AvatarRestSkeleton } from '../avatar/types.js';
import type { StreamRequestPlan } from '../rooms/scene-actions.js';
import type { Quat, Vec3 } from './pose-math.js';
import { FPS } from './types.js';

/** The part of the service's VRMA JSON the lab reads (services/motion/API.md). */
interface VrmaJson {
  meta: { fps: number; duration: number };
  tracks: Array<{ bone: string; keyframes: Array<{ t: number; q: Quat }> }>;
  hips?: { position?: { keyframes: Array<{ t: number; p: Vec3 }> } };
}

export interface MotionChunk {
  /** Offset of this chunk in the whole motion, seconds. */
  start: number;
  vrma: VrmaJson;
  endPose?: AvatarMotionEndPose;
}

export interface MotionStream {
  chunks: MotionChunk[];
  /** Usable as `continue_from` for a while. */
  session?: string;
  /** Wall time of the request, milliseconds. */
  requestMs: number;
}

/**
 * The JSON body for a planned stream. Same field names as the app's own client (the camelCase control fields
 * become snake_case); the renderer cannot import that client, which lives in the main process.
 */
export function toWire(
  plan: StreamRequestPlan,
  avatarRest: AvatarRestSkeleton | null,
  seed: number,
): Record<string, unknown> {
  const wire: Record<string, unknown> = { prompt: plan.prompt, duration: plan.duration, seed };
  if (avatarRest) wire.avatar_rest = avatarRest;
  if (plan.phases?.length) {
    wire.phases = plan.phases.map((phase) => ({ prompt: phase.prompt, start_s: phase.startS }));
  }
  if (plan.path) {
    wire.path = definedOnly({
      points: plan.path.points,
      corner_radius: plan.path.cornerRadius,
      speed: plan.path.speed,
      start_s: plan.path.startS,
      mode: plan.path.mode,
    });
  }
  if (plan.targets?.length) {
    wire.targets = plan.targets.map((target) =>
      definedOnly({
        t: target.t,
        until: target.until,
        root: target.root,
        height: target.height,
        heading: target.heading,
        reveal_s: target.revealS,
        hand: target.hand,
        joint: target.joint,
        position: target.position,
      }),
    );
  }
  if (plan.continueFrom) wire.continue_from = plan.continueFrom;
  if (plan.observed && plan.continueFrom) wire.observed = plan.observed;
  return wire;
}

function definedOnly(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

function parseEndPose(value: unknown): AvatarMotionEndPose | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as { root?: unknown; height?: unknown; heading?: unknown };
  if (
    !Array.isArray(raw.root) ||
    raw.root.length !== 2 ||
    typeof raw.height !== 'number' ||
    typeof raw.heading !== 'number'
  )
    return undefined;
  const [x, z] = raw.root as number[];
  return x === undefined || z === undefined
    ? undefined
    : { root: [x, z], height: raw.height, heading: raw.heading };
}

/** Reads the service's NDJSON answer; any `error` line or a stream with no `done` is an error. */
function parseMotionStream(text: string, requestMs: number): MotionStream {
  const chunks: MotionChunk[] = [];
  let session: string | undefined;
  let done = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as {
      type?: string;
      start?: number;
      vrma?: VrmaJson;
      end_pose?: unknown;
      session?: string;
      message?: string;
    };
    if (message.type === 'chunk' && message.vrma && typeof message.start === 'number') {
      const endPose = parseEndPose(message.end_pose);
      chunks.push({ start: message.start, vrma: message.vrma, ...(endPose ? { endPose } : {}) });
    } else if (message.type === 'done') {
      done = true;
      session = message.session;
    } else if (message.type === 'error') {
      throw new Error(`The motion service failed: ${message.message ?? 'no message'}`);
    }
  }
  if (!done) throw new Error('The motion stream ended before it finished.');
  return { chunks, ...(session ? { session } : {}), requestMs };
}

export async function requestMotion(
  baseUrl: string,
  wire: Record<string, unknown>,
): Promise<MotionStream> {
  const began = performance.now();
  const response = await fetch(`${baseUrl}/v1/motion/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(wire),
  });
  if (!response.ok) {
    throw new Error(`The motion service answered ${response.status}: ${await response.text()}`);
  }
  return parseMotionStream(await response.text(), performance.now() - began);
}

/** Every frame of a motion: one rotation per bone and the hips' position (in rest-hips-height units). */
export interface MotionTracks {
  frames: number;
  bones: Record<string, Quat[]>;
  hips: Vec3[];
}

/**
 * Lays the chunks out on the lab's frame grid. A bone or the hips that a frame does not key keeps what it had on
 * the frame before (identity and the origin at first).
 */
export function tracksFromChunks(chunks: readonly MotionChunk[]): MotionTracks {
  const keyed = new Map<string, Map<number, Quat>>();
  const hipsKeyed = new Map<number, Vec3>();
  let frames = 0;
  for (const chunk of chunks) {
    for (const track of chunk.vrma.tracks) {
      const bone = keyed.get(track.bone) ?? new Map<number, Quat>();
      keyed.set(track.bone, bone);
      for (const key of track.keyframes) {
        const frame = Math.round((chunk.start + key.t) * FPS);
        bone.set(frame, key.q);
        frames = Math.max(frames, frame + 1);
      }
    }
    for (const key of chunk.vrma.hips?.position?.keyframes ?? []) {
      const frame = Math.round((chunk.start + key.t) * FPS);
      hipsKeyed.set(frame, key.p);
      frames = Math.max(frames, frame + 1);
    }
  }
  const fill = <T>(source: Map<number, T>, initial: T): T[] => {
    const out: T[] = [];
    let held = initial;
    for (let frame = 0; frame < frames; frame += 1) {
      held = source.get(frame) ?? held;
      out.push(held);
    }
    return out;
  };
  return {
    frames,
    bones: Object.fromEntries(
      [...keyed].map(([bone, source]) => [bone, fill<Quat>(source, [0, 0, 0, 1])]),
    ),
    hips: fill<Vec3>(hipsKeyed, [0, 1, 0]),
  };
}

/** The tracks of a continuation placed after the tracks it continues. */
export function appendTracks(base: MotionTracks, extra: MotionTracks): MotionTracks {
  const bones: Record<string, Quat[]> = {};
  for (const name of new Set([...Object.keys(base.bones), ...Object.keys(extra.bones)])) {
    const first = base.bones[name] ?? Array.from({ length: base.frames }, (): Quat => [0, 0, 0, 1]);
    const heldFromBase = first[first.length - 1] ?? [0, 0, 0, 1];
    const second = extra.bones[name] ?? Array.from({ length: extra.frames }, () => heldFromBase);
    bones[name] = [...first, ...second];
  }
  return { frames: base.frames + extra.frames, bones, hips: [...base.hips, ...extra.hips] };
}
