/**
 * Validates the steering fields of a motion stream request that arrive over IPC (path, targets,
 * phases and friends) before they are sent to the motion service. Anything malformed is dropped
 * rather than failing the whole movement, except a path or target list the caller clearly meant to
 * send, which is cut down to its valid entries.
 */
import type {
  AvatarMotionJoint,
  AvatarMotionObserved,
  AvatarMotionPath,
  AvatarMotionPhase,
  AvatarMotionStreamRequest,
  AvatarMotionTarget,
} from '../../shared/avatar/types.js';

export type MotionControls = Pick<
  AvatarMotionStreamRequest,
  'phases' | 'path' | 'targets' | 'constraintWeight' | 'continueFrom' | 'observed' | 'snapS'
>;

const MAX_TARGETS = 64;
const MAX_PHASES = 8;
const MAX_PATH_POINTS = 200;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function pair(value: unknown): [number, number] | undefined {
  return Array.isArray(value) && value.length === 2 && value.every(finite)
    ? [value[0], value[1]]
    : undefined;
}

function triple(value: unknown): [number, number, number] | undefined {
  return Array.isArray(value) && value.length === 3 && value.every(finite)
    ? [value[0], value[1], value[2]]
    : undefined;
}

const JOINTS: readonly AvatarMotionJoint[] = [
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
];

function sanitizeObserved(value: unknown): AvatarMotionObserved | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const joints: NonNullable<AvatarMotionObserved['joints']> = {};
  if (raw.joints && typeof raw.joints === 'object') {
    for (const joint of JOINTS) {
      const position = triple((raw.joints as Record<string, unknown>)[joint]);
      if (position) joints[joint] = position;
    }
  }
  const root = pair(raw.root);
  const observed: AvatarMotionObserved = {
    ...(Object.keys(joints).length > 0 ? { joints } : {}),
    ...(root ? { root } : {}),
    ...(finite(raw.height) && raw.height > 0 ? { height: raw.height } : {}),
  };
  return Object.keys(observed).length > 0 ? observed : undefined;
}

function sanitizePath(value: unknown): AvatarMotionPath | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.points)) return undefined;
  const points = raw.points
    .map((point) => pair(point))
    .filter((point): point is [number, number] => point !== undefined)
    .slice(0, MAX_PATH_POINTS);
  if (points.length < 2) return undefined;
  return {
    points,
    ...(finite(raw.cornerRadius) && raw.cornerRadius >= 0
      ? { cornerRadius: raw.cornerRadius }
      : {}),
    ...(finite(raw.speed) && raw.speed > 0 ? { speed: raw.speed } : {}),
    ...(finite(raw.startS) && raw.startS >= 0 ? { startS: raw.startS } : {}),
    ...(raw.mode === 'dense' || raw.mode === 'waypoints' ? { mode: raw.mode } : {}),
  };
}

function sanitizeTarget(value: unknown): AvatarMotionTarget | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (!finite(raw.t) || raw.t < 0) return undefined;
  const root = pair(raw.root);
  const position = triple(raw.position);
  const hand = raw.hand === 'left' || raw.hand === 'right' ? raw.hand : undefined;
  // A hand target needs its position and the pelvis values to hold (see services/motion/API.md).
  if (
    raw.hand !== undefined &&
    (!hand || !position || !root || !finite(raw.height) || !finite(raw.heading))
  ) {
    return undefined;
  }
  const joint = JOINTS.find((name) => name === raw.joint);
  if (raw.joint !== undefined && (!joint || !position || hand)) return undefined;
  return {
    t: raw.t,
    ...(finite(raw.until) && raw.until >= raw.t ? { until: raw.until } : {}),
    ...(root ? { root } : {}),
    ...(finite(raw.height) ? { height: raw.height } : {}),
    ...(finite(raw.heading) ? { heading: raw.heading } : {}),
    ...(finite(raw.revealS) && raw.revealS >= 0 ? { revealS: raw.revealS } : {}),
    ...(hand && position ? { hand, position } : {}),
    ...(joint && position ? { joint, position } : {}),
  };
}

function sanitizePhase(value: unknown): AvatarMotionPhase | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!prompt || !finite(raw.startS) || raw.startS < 0) return undefined;
  return { prompt, startS: raw.startS };
}

export function sanitizeMotionControls(
  request: Partial<AvatarMotionStreamRequest>,
): MotionControls {
  const controls: MotionControls = {};
  const path = sanitizePath(request.path);
  if (path) controls.path = path;
  if (Array.isArray(request.targets)) {
    const targets = request.targets
      .slice(0, MAX_TARGETS)
      .map(sanitizeTarget)
      .filter((target): target is AvatarMotionTarget => target !== undefined);
    if (targets.length > 0) controls.targets = targets;
  }
  if (Array.isArray(request.phases)) {
    const phases = request.phases
      .slice(0, MAX_PHASES)
      .map(sanitizePhase)
      .filter((phase): phase is AvatarMotionPhase => phase !== undefined);
    if (phases.length > 0) controls.phases = phases;
  }
  if (finite(request.constraintWeight) && request.constraintWeight > 0) {
    controls.constraintWeight = request.constraintWeight;
  }
  if (typeof request.continueFrom === 'string' && /^[\w-]{1,64}$/.test(request.continueFrom)) {
    controls.continueFrom = request.continueFrom;
  }
  const observed = controls.continueFrom ? sanitizeObserved(request.observed) : undefined;
  if (observed) controls.observed = observed;
  if (finite(request.snapS) && request.snapS >= 0) controls.snapS = request.snapS;
  return controls;
}
