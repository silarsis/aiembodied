/**
 * Verbose motion/contact trace: JSON lines in `<userData>/logs/motion-trace.jsonl`.
 *
 * The renderer (rooms/motion-trace.ts) and the local motion client send lines here when tracing is on, so a
 * developer can analyse avatar sitting problems from a file. Writes are batched and asynchronous (never on the
 * frame path); when the file passes `maxBytes` it is renamed to `motion-trace.1.jsonl` (one old file is kept).
 * Tracing is on when `AIEMBODIED_MOTION_TRACE=1` or the "Verbose motion log" setting says so.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const MOTION_TRACE_FILE = 'motion-trace.jsonl';
export const MOTION_TRACE_OLD_FILE = 'motion-trace.1.jsonl';
export const MOTION_TRACE_MAX_BYTES = 20 * 1024 * 1024;
const FLUSH_MS = 250;
/** A renderer batch never writes more lines than this at once. */
const MAX_LINES_PER_BATCH = 2000;
/** What waits for the disk is dropped beyond this many lines. */
const MAX_PENDING = 20000;

export interface MotionTraceSinkOptions {
  /** The folder the files go in (created on the first write). */
  directory: string;
  env?: NodeJS.ProcessEnv;
  maxBytes?: number;
  flushMs?: number;
  now?: () => Date;
  /** Milliseconds, for the `t` of lines the main process writes itself. */
  clock?: () => number;
}

export function motionTraceEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AIEMBODIED_MOTION_TRACE?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on';
}

export class MotionTraceSink {
  readonly file: string;
  private readonly oldFile: string;
  private readonly directory: string;
  private readonly envOn: boolean;
  private readonly maxBytes: number;
  private readonly flushMs: number;
  private readonly now: () => Date;
  private readonly clock: () => number;
  private settingOn = false;
  private pending: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private size: number | null = null;

  constructor(options: MotionTraceSinkOptions) {
    this.directory = options.directory;
    this.file = path.join(options.directory, MOTION_TRACE_FILE);
    this.oldFile = path.join(options.directory, MOTION_TRACE_OLD_FILE);
    this.envOn = motionTraceEnvEnabled(options.env ?? process.env);
    this.maxBytes = options.maxBytes ?? MOTION_TRACE_MAX_BYTES;
    this.flushMs = options.flushMs ?? FLUSH_MS;
    this.now = options.now ?? (() => new Date());
    this.clock = options.clock ?? (() => performance.now());
  }

  get enabled(): boolean {
    return this.envOn || this.settingOn;
  }

  /** The UI setting; returns whether tracing is on now (the environment switch also counts). */
  configure(settingOn: boolean): boolean {
    this.settingOn = settingOn === true;
    return this.enabled;
  }

  /** Appends lines sent by the renderer. Ignored while tracing is off. */
  append(lines: unknown): void {
    if (!this.enabled || !Array.isArray(lines)) return;
    for (const line of lines.slice(0, MAX_LINES_PER_BATCH)) {
      if (line && typeof line === 'object' && !Array.isArray(line)) this.enqueue(line as Record<string, unknown>);
    }
  }

  /** A line from the main process itself. `data` is only built while tracing is on. */
  log(avatar: string, kind: string, build: () => Record<string, unknown>): void {
    if (!this.enabled) return;
    let data: Record<string, unknown>;
    try {
      data = build();
    } catch (error) {
      data = { traceError: error instanceof Error ? error.message : String(error) };
    }
    this.enqueue({ ts: this.now().toISOString(), t: Math.round(this.clock() * 100) / 100, avatar, kind, src: 'main', ...data });
  }

  /** Resolves when everything queued so far is on disk. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.length > 0) {
      const text = this.pending.join('');
      this.pending = [];
      this.chain = this.chain.then(() => this.write(text)).catch(() => undefined);
    }
    return this.chain;
  }

  private enqueue(line: Record<string, unknown>): void {
    let text: string;
    try {
      text = `${JSON.stringify({ ts: this.now().toISOString(), t: Math.round(this.clock() * 100) / 100, ...line })}\n`;
    } catch {
      return;
    }
    if (this.pending.length >= MAX_PENDING) return;
    this.pending.push(text);
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.flushMs);
      this.timer.unref?.();
    }
  }

  private async write(text: string): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    if (this.size === null) {
      this.size = await fs.stat(this.file).then((stat) => stat.size, () => 0);
    }
    if (this.size > this.maxBytes) {
      await fs.rm(this.oldFile, { force: true });
      await fs.rename(this.file, this.oldFile).catch(() => undefined);
      this.size = 0;
    }
    await fs.appendFile(this.file, text, 'utf8');
    this.size += Buffer.byteLength(text);
  }
}
