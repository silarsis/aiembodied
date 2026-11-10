import * as THREE from 'three';

/** Pelvis travel in one frame above this is not walking (about 9 m/s at 60 fps). */
const JUMP_METRES = 0.15;
/** A hand moving this far in one frame means the pose changed abruptly. */
const POSE_JUMP_METRES = 0.25;
const MAX_REPORTS_PER_MINUTE = 20;

export interface JumpContext {
  /** What the mixer is playing, for the log line. */
  clip?: string;
  clipTime?: number;
  clipWeight?: number;
}

interface Tracked {
  hips: THREE.Object3D;
  hands: THREE.Object3D[];
  root: THREE.Object3D;
}

const TMP = new THREE.Vector3();

/**
 * Diagnostic for avatar flicker in rooms: after each rendered frame, compares the pelvis and hands
 * with the previous frame and logs a warning (with what was playing) when either moved further
 * than a body can in one frame. Logs go to the app's diagnostics log.
 */
export class JumpDetector {
  private tracked: Tracked | null = null;
  private last: THREE.Vector3[] = [];
  private lastContext: JumpContext = {};
  private reports: number[] = [];

  constructor(private readonly now: () => number = () => performance.now()) {}

  track(root: THREE.Object3D | null, hips: THREE.Object3D | null | undefined, hands: (THREE.Object3D | null | undefined)[]): void {
    this.tracked = root && hips ? { root, hips, hands: hands.filter((h): h is THREE.Object3D => !!h) } : null;
    this.last = [];
  }

  /** Forget the previous frame (the avatar was placed on purpose, e.g. on entering a room). */
  reset(): void {
    this.last = [];
  }

  /** Call after the frame's poses are final. Returns true when a jump was found. */
  check(context: JumpContext = {}): boolean {
    const tracked = this.tracked;
    if (!tracked) return false;
    const nodes = [tracked.hips, ...tracked.hands];
    const points = nodes.map((node) => node.getWorldPosition(new THREE.Vector3()));
    const previous = this.last;
    const previousContext = this.lastContext;
    this.last = points;
    this.lastContext = context;
    if (previous.length !== points.length) return false;
    const hipsMove = horizontal(points[0], previous[0]);
    let handMove = 0;
    for (let i = 1; i < points.length; i += 1) handMove = Math.max(handMove, points[i].distanceTo(previous[i]));
    if (hipsMove <= JUMP_METRES && handMove <= POSE_JUMP_METRES) return false;
    if (!this.allowReport()) return true;
    tracked.root.getWorldPosition(TMP);
    console.warn('[rooms] avatar jumped in one frame', {
      hipsMove: round(hipsMove),
      handMove: round(handMove),
      hipsFrom: xyz(previous[0]),
      hipsTo: xyz(points[0]),
      root: xyz(TMP),
      rootYawDeg: round((tracked.root.rotation.y * 180) / Math.PI),
      hipsLocal: xyz(tracked.hips.position),
      before: previousContext,
      now: context,
    });
    return true;
  }

  private allowReport(): boolean {
    const time = this.now();
    this.reports = this.reports.filter((t) => time - t < 60_000);
    if (this.reports.length >= MAX_REPORTS_PER_MINUTE) return false;
    this.reports.push(time);
    return true;
  }
}

function horizontal(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function xyz(v: THREE.Vector3): [number, number, number] {
  return [round(v.x), round(v.y), round(v.z)];
}
