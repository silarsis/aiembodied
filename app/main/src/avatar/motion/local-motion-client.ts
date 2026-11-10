/**
 * Client for the local text-to-motion service in services/motion (NVIDIA ARDY or Kimodo).
 * The HTTP contract is documented in services/motion/API.md; every animation payload is the
 * app's VRMA JSON, validated here with the same schema the OpenAI pipeline uses.
 */
import { parseVrmaSchema, type VrmaSchema } from '../vrma-schema.js';
import type {
  AvatarMotionEndPose,
  AvatarMotionPath,
  AvatarMotionPhase,
  AvatarMotionTarget,
} from '../types.js';

export interface LocalMotionClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  healthTimeoutMs?: number;
}

export interface MotionServiceHealth {
  status: string;
  backend: string;
  device?: string;
  ready: boolean;
}

export interface MotionRequest {
  prompt: string;
  duration?: number;
  steps?: number;
  name?: string;
  /** The avatar's rest skeleton, for per-avatar arm calibration (see services/motion/API.md). */
  avatar_rest?: Record<string, [number, number, number]>;
  /** Streams only. Later prompts, a floor path and timed targets steer the motion (see API.md). */
  phases?: AvatarMotionPhase[];
  path?: AvatarMotionPath;
  targets?: AvatarMotionTarget[];
  constraintWeight?: number;
  continueFrom?: string;
  snapS?: number;
}

/** The JSON body the service expects: the camelCase control fields become snake_case. */
export function toWireRequest(request: MotionRequest): Record<string, unknown> {
  const { phases, path, targets, constraintWeight, continueFrom, snapS, ...rest } = request;
  const wire: Record<string, unknown> = { ...rest };
  if (phases?.length) {
    wire.phases = phases.map((phase) => ({ prompt: phase.prompt, start_s: phase.startS }));
  }
  if (path) {
    wire.path = definedOnly({
      points: path.points,
      corner_radius: path.cornerRadius,
      speed: path.speed,
      start_s: path.startS,
      mode: path.mode,
    });
  }
  if (targets?.length) {
    wire.targets = targets.map((target) =>
      definedOnly({
        t: target.t,
        until: target.until,
        root: target.root,
        height: target.height,
        heading: target.heading,
        reveal_s: target.revealS,
        hand: target.hand,
        position: target.position,
      }),
    );
  }
  if (constraintWeight !== undefined) wire.constraint_weight = constraintWeight;
  if (continueFrom) wire.continue_from = continueFrom;
  if (snapS !== undefined) wire.snap_s = snapS;
  return wire;
}

function definedOnly(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

function parseEndPose(value: unknown): AvatarMotionEndPose | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const [rootX, rootZ] = numberTuple(raw.root, 2) ?? [];
  if (rootX === undefined || rootZ === undefined) return undefined;
  if (typeof raw.height !== 'number' || typeof raw.heading !== 'number') return undefined;
  if (!Number.isFinite(raw.height) || !Number.isFinite(raw.heading)) return undefined;
  const [lx, ly, lz] = numberTuple(raw.left_hand, 3) ?? [];
  const [rx, ry, rz] = numberTuple(raw.right_hand, 3) ?? [];
  return {
    root: [rootX, rootZ],
    height: raw.height,
    heading: raw.heading,
    ...(lx !== undefined && ly !== undefined && lz !== undefined ? { leftHand: [lx, ly, lz] as [number, number, number] } : {}),
    ...(rx !== undefined && ry !== undefined && rz !== undefined ? { rightHand: [rx, ry, rz] as [number, number, number] } : {}),
  };
}

function numberTuple(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  return value.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) ? (value as number[]) : null;
}

export type MotionTimings = Record<string, number>;

export interface MotionClip {
  vrma: VrmaSchema;
  timings: MotionTimings;
}

export interface MotionChunk extends MotionClip {
  index: number;
  start: number;
  /** Where the chunk's last frame is, when the service reports it. */
  endPose?: AvatarMotionEndPose;
}

export interface MotionStreamSummary {
  chunks: number;
  timings: MotionTimings;
  /** Id for `continueFrom` on a later request. */
  session?: string;
}

export interface MotionCallOptions {
  signal?: AbortSignal;
}

export class LocalMotionClient {
  readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly healthTimeoutMs: number;

  constructor(options: LocalMotionClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? fetch;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 2000;
  }

  /** The service's health, or null when it is not reachable. */
  async health(): Promise<MotionServiceHealth | null> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as Partial<MotionServiceHealth>;
      return {
        status: typeof body.status === 'string' ? body.status : 'unknown',
        backend: typeof body.backend === 'string' ? body.backend : 'unknown',
        device: typeof body.device === 'string' ? body.device : undefined,
        ready: body.ready === true,
      };
    } catch {
      return null;
    }
  }

  async generateClip(request: MotionRequest, options: MotionCallOptions = {}): Promise<MotionClip> {
    const response = await this.post('/v1/motion/clip', request, options);
    const body = (await response.json()) as { vrma?: unknown; timings?: unknown };
    return { vrma: parseVrmaSchema(body.vrma), timings: normalizeTimings(body.timings) };
  }

  /**
   * Stream motion chunks as the service produces them. Yields each chunk in order and returns
   * the summary from the final `done` line.
   */
  async *stream(
    request: MotionRequest,
    options: MotionCallOptions = {},
  ): AsyncGenerator<MotionChunk, MotionStreamSummary, void> {
    const response = await this.post('/v1/motion/stream', request, options);
    if (!response.body) {
      throw new Error('Motion service returned an empty stream.');
    }

    for await (const line of readLines(response.body)) {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error(`Motion service sent an invalid stream line: ${line.slice(0, 120)}`);
      }

      if (message.type === 'chunk') {
        yield {
          index: typeof message.index === 'number' ? message.index : 0,
          start: typeof message.start === 'number' ? message.start : 0,
          vrma: parseVrmaSchema(message.vrma),
          timings: normalizeTimings(message.timings),
          ...(parseEndPose(message.end_pose) ? { endPose: parseEndPose(message.end_pose) } : {}),
        };
      } else if (message.type === 'done') {
        return {
          chunks: typeof message.chunks === 'number' ? message.chunks : 0,
          timings: normalizeTimings(message.timings),
          ...(typeof message.session === 'string' && message.session ? { session: message.session } : {}),
        };
      } else if (message.type === 'error') {
        throw new Error(`Motion service failed: ${String(message.message ?? 'unknown error')}`);
      }
    }

    throw new Error('Motion stream ended before it finished.');
  }

  private async post(pathName: string, request: MotionRequest, options: MotionCallOptions): Promise<Response> {
    const response = await this.fetchFn(`${this.baseUrl}${pathName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toWireRequest(request)),
      signal: options.signal,
    });
    if (!response.ok) {
      throw new Error(`Motion service request failed: HTTP ${response.status} ${await errorText(response)}`);
    }
    return response;
  }
}

async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) {
          yield line;
        }
        newline = buffered.indexOf('\n');
      }
    }
    const rest = (buffered + decoder.decode()).trim();
    if (rest) {
      yield rest;
    }
  } finally {
    reader.releaseLock();
  }
}

function normalizeTimings(value: unknown): MotionTimings {
  const timings: MotionTimings = {};
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        timings[key] = entry;
      }
    }
  }
  return timings;
}

async function errorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === 'string') {
        return parsed.error;
      }
    } catch {
      // Not JSON; fall through to the raw text.
    }
    return text.slice(0, 200);
  } catch {
    return '';
  }
}
