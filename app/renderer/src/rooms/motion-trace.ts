/**
 * Verbose motion/contact trace and the debug switches that go with it.
 *
 * With tracing on, the scene executor, the contact solver's snapshots and the stream plumbing append JSON lines
 * to `<userData>/logs/motion-trace.jsonl` (the main process owns the file, see main/src/logging/motion-trace.ts),
 * so a developer can analyse a sitting problem from the file afterwards. Callers pass a *builder*, not data:
 * `trace(avatar, kind, () => ({ ... }))` never runs the builder (and so allocates nothing) while tracing is off.
 *
 * The settle switch lives here too: "Re-try sits that end with legs in furniture" (default on) decides whether
 * the executor plays the post-sit settle streams.
 */

export const MOTION_TRACE_STORAGE_KEY = 'aiembodied.motionTrace';
export const SETTLE_RETRY_STORAGE_KEY = 'aiembodied.settleRetries';

export interface MotionTraceLine {
  ts: string;
  /** performance.now() in the renderer, milliseconds. */
  t: number;
  avatar: string;
  kind: string;
  [key: string]: unknown;
}

/** What the renderer needs from the bridge. */
export interface MotionTraceTransport {
  append(lines: MotionTraceLine[]): void;
  /** Tells the main process the UI setting; resolves with whether tracing is on (the environment switch also counts). */
  configure(settingOn: boolean): Promise<boolean>;
}

export type TraceFn = (avatar: string, kind: string, build: () => Record<string, unknown>) => void;

const FLUSH_MS = 250;
const MAX_BATCH = 200;

let enabled = false;
let buffer: MotionTraceLine[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let transportOverride: MotionTraceTransport | null | undefined;
let settleRetries: boolean | null = null;

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function transport(): MotionTraceTransport | null {
  if (transportOverride !== undefined) return transportOverride;
  const bridge = typeof window !== 'undefined' ? (window as unknown as { aiembodied?: { motionTrace?: MotionTraceTransport } }).aiembodied : undefined;
  return bridge?.motionTrace ?? null;
}

/** Test seam: replaces the bridge (null: none). Call with `undefined` to go back to `window.aiembodied`. */
export function setMotionTraceTransport(next: MotionTraceTransport | null | undefined): void {
  transportOverride = next;
}

/** True while tracing is on. Cheap enough to call every frame. */
export function isMotionTraceEnabled(): boolean {
  return enabled;
}

/** Test seam and startup: turns the cached switch on or off without touching storage. */
export function setMotionTraceActive(on: boolean): void {
  enabled = on;
  if (!on) {
    buffer = [];
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/** The "Verbose motion log" checkbox. */
export function getMotionTraceSetting(): boolean {
  return storage()?.getItem(MOTION_TRACE_STORAGE_KEY) === '1';
}

/** Stores the checkbox and tells the main process; the cached switch follows its answer (env var included). */
export async function setMotionTraceSetting(on: boolean): Promise<void> {
  const store = storage();
  if (store) {
    if (on) store.setItem(MOTION_TRACE_STORAGE_KEY, '1');
    else store.removeItem(MOTION_TRACE_STORAGE_KEY);
  }
  await syncMotionTrace(on);
}

/** At startup: pushes the stored setting to the main process and caches whether tracing is on. */
export async function initMotionTrace(): Promise<void> {
  await syncMotionTrace(getMotionTraceSetting());
}

async function syncMotionTrace(settingOn: boolean): Promise<void> {
  const bridge = transport();
  let effective = settingOn;
  if (bridge) {
    try {
      effective = await bridge.configure(settingOn);
    } catch {
      effective = settingOn;
    }
  }
  setMotionTraceActive(effective);
}

/** The "Re-try sits that end with legs in furniture" checkbox (default on). */
export function isSettleRetryEnabled(): boolean {
  if (settleRetries === null) settleRetries = storage()?.getItem(SETTLE_RETRY_STORAGE_KEY) !== '0';
  return settleRetries;
}

export function setSettleRetryEnabled(on: boolean): void {
  settleRetries = on;
  const store = storage();
  if (!store) return;
  if (on) store.removeItem(SETTLE_RETRY_STORAGE_KEY);
  else store.setItem(SETTLE_RETRY_STORAGE_KEY, '0');
}

/** Appends one line. `build` runs only while tracing is on. */
export const trace: TraceFn = (avatar, kind, build) => {
  if (!enabled) return;
  let data: Record<string, unknown>;
  try {
    data = build();
  } catch (error) {
    data = { traceError: error instanceof Error ? error.message : String(error) };
  }
  buffer.push({ ts: new Date().toISOString(), t: Math.round(performance.now() * 100) / 100, avatar, kind, ...data });
  if (buffer.length >= MAX_BATCH) flushMotionTrace();
  else if (!flushTimer) flushTimer = setTimeout(flushMotionTrace, FLUSH_MS);
};

/** Sends what is buffered now. */
export function flushMotionTrace(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (buffer.length === 0) return;
  const lines = buffer;
  buffer = [];
  try {
    transport()?.append(lines);
  } catch {
    // Tracing must never disturb the app.
  }
}

/** Rounds to `digits` decimals for compact trace numbers. */
export function round(value: number, digits = 3): number {
  const k = 10 ** digits;
  return Math.round(value * k) / k;
}
