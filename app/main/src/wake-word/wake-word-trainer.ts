/**
 * Trains new wake words from the Settings page by running services/wakeword-trainer in WSL, the
 * same openWakeWord pipeline that made "Hey Echo". A run takes hours on the CPU, so it runs
 * detached from the app: closing the app does not stop it, and on the next start the app finds
 * it again through the status.json the script keeps up to date in `<trained>/jobs/<slug>/`.
 * The finished model lands in `<trained>/<slug>.onnx`, where the wake word list picks it up.
 */
import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  WakeWordTrainingJob,
  WakeWordTrainingMetrics,
  WakeWordTrainingState,
  WakeWordTrainingStatus,
} from './types.js';

type TrainerLogger = Pick<Console, 'info' | 'warn' | 'error'>;

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface WakeWordTrainerOptions {
  /** `<userData>/wake-words`: trained models, and a `jobs` folder for the runs. */
  trainedDirectory: string;
  /** services/wakeword-trainer, or null when it is not on this machine (a packaged build). */
  scriptsDirectory: string | null;
  distro?: string;
  platform?: NodeJS.Platform;
  /** Runs a short command to completion (WSL checks, cancelling). */
  run?: (command: string, args: string[]) => Promise<CommandResult>;
  /** Starts the long training command, detached so it outlives the app. */
  launch?: (command: string, args: string[]) => void;
  pollIntervalMs?: number;
  /** A running job whose status has not changed for this long has stopped (the PC slept or WSL shut down). */
  staleAfterMs?: number;
  now?: () => number;
  logger?: TrainerLogger;
  onStatus?: (status: WakeWordTrainingStatus) => void;
  /** A run finished and its model is ready to pick. */
  onTrained?: (job: WakeWordTrainingJob) => void;
}

export const DEFAULT_TRAINER_DISTRO = 'Ubuntu-24.04';
const MAX_PHRASE_LENGTH = 40;

export function wakeWordSlug(phrase: string): string {
  return phrase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Letters, digits, spaces, apostrophes and hyphens: the phrase goes to a speech synthesizer. */
export function validateWakePhrase(raw: string): string {
  const phrase = raw.trim().replace(/\s+/g, ' ');
  if (!phrase || !wakeWordSlug(phrase)) {
    throw new Error('Enter the phrase to train, such as "hey echo".');
  }
  if (phrase.length > MAX_PHRASE_LENGTH) {
    throw new Error(`Keep the phrase under ${MAX_PHRASE_LENGTH} characters.`);
  }
  if (!/^[\p{L}\p{N}' -]+$/u.test(phrase)) {
    throw new Error('Use only letters, numbers, spaces, apostrophes and hyphens.');
  }
  return phrase;
}

/** C:\Users\kevin -> /mnt/c/Users/kevin; null for paths WSL cannot see that way (UNC shares). */
export function toWslPath(windowsPath: string): string | null {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!match) {
    return windowsPath.startsWith('/') ? windowsPath : null;
  }
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function defaultRun(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => resolve({ code: null, stdout, stderr: stderr || error.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function defaultLaunch(command: string, args: string[]): void {
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

interface StatusFile {
  slug?: unknown;
  phrase?: unknown;
  state?: unknown;
  stage?: unknown;
  stageLabel?: unknown;
  progress?: unknown;
  message?: unknown;
  error?: unknown;
  startedAt?: unknown;
  updatedAt?: unknown;
  pid?: unknown;
  result?: { metrics?: Record<string, unknown> };
}

const STATES = ['running', 'done', 'failed', 'cancelled'] as const;

export class WakeWordTrainer {
  private readonly distro: string;
  private readonly platform: NodeJS.Platform;
  private readonly run: (command: string, args: string[]) => Promise<CommandResult>;
  private readonly launch: (command: string, args: string[]) => void;
  private readonly now: () => number;
  private availability: Promise<{ available: boolean; reason?: string }> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshot = '';
  private lastState: string | null = null;

  constructor(private readonly options: WakeWordTrainerOptions) {
    this.distro = options.distro?.trim() || DEFAULT_TRAINER_DISTRO;
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? defaultRun;
    this.launch = options.launch ?? defaultLaunch;
    this.now = options.now ?? Date.now;
  }

  private get jobsDirectory(): string {
    return path.join(this.options.trainedDirectory, 'jobs');
  }

  /** Pick up a run that was going when the app last closed. */
  async resume(): Promise<void> {
    const job = await this.readCurrentJob();
    this.lastState = job?.state ?? null;
    if (job?.state === 'running') {
      this.startPolling();
    }
  }

  async getStatus(): Promise<WakeWordTrainingStatus> {
    const [availability, job] = await Promise.all([this.checkAvailability(), this.readCurrentJob()]);
    return { ...availability, job };
  }

  async start(rawPhrase: string, options: { quick?: boolean } = {}): Promise<WakeWordTrainingStatus> {
    const phrase = validateWakePhrase(rawPhrase);
    const availability = await this.checkAvailability();
    if (!availability.available) {
      throw new Error(availability.reason ?? 'Wake word training is not available on this machine.');
    }
    const current = await this.readCurrentJob();
    if (current?.state === 'running') {
      throw new Error(`"${current.phrase}" is still training. Cancel it first, or wait for it to finish.`);
    }

    const slug = wakeWordSlug(phrase) + (options.quick ? '_quick' : '');
    const jobDirectory = path.join(this.jobsDirectory, slug);
    await fs.mkdir(jobDirectory, { recursive: true });
    const scripts = toWslPath(this.options.scriptsDirectory ?? '');
    const wslJob = toWslPath(jobDirectory);
    const wslOutput = toWslPath(this.options.trainedDirectory);
    if (!scripts || !wslJob || !wslOutput) {
      throw new Error('The training folders must be on a local drive that WSL can reach.');
    }

    // setsid makes the script a process-group leader, so cancelling stops everything it started;
    // --wait keeps wsl.exe attached, which keeps the distro running until training ends.
    const command = [
      'setsid --wait python3',
      shellQuote(`${scripts}/train_wake_word.py`),
      '--phrase',
      shellQuote(phrase),
      '--job-dir',
      shellQuote(wslJob),
      '--output-dir',
      shellQuote(wslOutput),
      ...(options.quick ? ['--quick'] : []),
      '>',
      shellQuote(`${wslJob}/driver.log`),
      '2>&1 < /dev/null',
    ].join(' ');
    // Report the run straight away (before launching, so this never overwrites the script's own
    // status.json, which replaces it within seconds).
    const startedAt = new Date(this.now()).toISOString();
    const placeholder = {
      slug,
      phrase,
      state: 'running',
      stage: 'setup',
      stageLabel: 'Starting',
      stageProgress: 0,
      progress: 0,
      message: '',
      startedAt,
      updatedAt: startedAt,
    };
    await fs.writeFile(path.join(jobDirectory, 'status.json'), JSON.stringify(placeholder, null, 2), 'utf8');
    this.options.logger?.info('Starting wake word training', { phrase, slug, distro: this.distro, quick: Boolean(options.quick) });
    this.launch('wsl.exe', ['-d', this.distro, '--', 'bash', '-lc', command]);
    this.lastState = 'running';
    this.startPolling();
    const status = await this.getStatus();
    this.emit(status);
    return status;
  }

  async cancel(): Promise<WakeWordTrainingStatus> {
    const job = await this.readCurrentJob();
    if (!job || job.state !== 'running') {
      return this.getStatus();
    }
    const raw = await this.readStatusFile(path.join(this.jobsDirectory, job.slug, 'status.json'));
    const pid = typeof raw?.pid === 'number' && Number.isInteger(raw.pid) ? raw.pid : null;
    if (pid) {
      const result = await this.run('wsl.exe', ['-d', this.distro, '--', 'kill', '-TERM', '--', `-${pid}`]);
      if (result.code !== 0) {
        this.options.logger?.warn('Could not stop wake word training', { pid, stderr: result.stderr.trim() });
      }
    }
    // The script marks itself cancelled when it gets the signal; make sure the app agrees even
    // if it had already died.
    await this.writeState(job.slug, 'cancelled');
    const status = await this.getStatus();
    this.emit(status);
    return status;
  }

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => void this.poll(), this.options.pollIntervalMs ?? 3000);
  }

  private async poll(): Promise<void> {
    const status = await this.getStatus();
    const job = status.job;
    if (job && this.lastState === 'running' && job.state === 'done') {
      this.options.logger?.info('Wake word training finished', { phrase: job.phrase, metrics: job.metrics });
      this.options.onTrained?.(job);
    }
    this.lastState = job?.state ?? null;
    this.emit(status);
    if (!job || job.state !== 'running') {
      this.dispose();
    }
  }

  private emit(status: WakeWordTrainingStatus): void {
    const snapshot = JSON.stringify(status);
    if (snapshot !== this.lastSnapshot) {
      this.lastSnapshot = snapshot;
      this.options.onStatus?.(status);
    }
  }

  private checkAvailability(): Promise<{ available: boolean; reason?: string }> {
    this.availability ??= (async () => {
      if (this.platform !== 'win32') {
        return { available: false, reason: 'Training a wake word needs Windows with WSL.' };
      }
      const scripts = this.options.scriptsDirectory;
      if (!scripts || !existsSync(path.join(scripts, 'train_wake_word.py'))) {
        return { available: false, reason: 'The training scripts (services/wakeword-trainer) are not on this machine.' };
      }
      const result = await this.run('wsl.exe', ['-d', this.distro, '--', 'python3', '--version']);
      if (result.code !== 0) {
        return {
          available: false,
          reason: `WSL distro ${this.distro} is not available. Install it with: wsl --install -d ${this.distro}`,
        };
      }
      return { available: true };
    })();
    return this.availability;
  }

  /** The most recently updated run. */
  private async readCurrentJob(): Promise<WakeWordTrainingJob | null> {
    let slugs: string[];
    try {
      slugs = await fs.readdir(this.jobsDirectory);
    } catch {
      return null;
    }
    const jobs = await Promise.all(
      slugs.map(async (slug) => this.toJob(slug, await this.readStatusFile(path.join(this.jobsDirectory, slug, 'status.json')))),
    );
    const sorted = jobs
      .filter((job): job is WakeWordTrainingJob => job !== null)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return sorted[0] ?? null;
  }

  private async readStatusFile(file: string): Promise<StatusFile | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      return typeof parsed === 'object' && parsed !== null ? (parsed as StatusFile) : null;
    } catch {
      return null;
    }
  }

  private toJob(slug: string, raw: StatusFile | null): WakeWordTrainingJob | null {
    if (!raw || typeof raw.phrase !== 'string' || typeof raw.updatedAt !== 'string') {
      return null;
    }
    let state: WakeWordTrainingState = STATES.find((value) => value === raw.state) ?? 'failed';
    const updatedAt = Date.parse(raw.updatedAt);
    if (state === 'running' && Number.isFinite(updatedAt) && this.now() - updatedAt > (this.options.staleAfterMs ?? 120_000)) {
      state = 'interrupted';
    }
    const metrics: WakeWordTrainingMetrics = {};
    for (const key of ['accuracy', 'recall', 'falsePositivesPerHour'] as const) {
      const value = raw.result?.metrics?.[key];
      if (typeof value === 'number') {
        metrics[key] = value;
      }
    }
    return {
      slug,
      phrase: raw.phrase,
      state,
      stage: typeof raw.stage === 'string' ? raw.stage : 'setup',
      stageLabel: typeof raw.stageLabel === 'string' ? raw.stageLabel : '',
      progress: typeof raw.progress === 'number' ? Math.min(1, Math.max(0, raw.progress)) : 0,
      ...(typeof raw.message === 'string' && raw.message ? { message: raw.message } : {}),
      ...(typeof raw.error === 'string' && raw.error ? { error: raw.error } : {}),
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : raw.updatedAt,
      updatedAt: raw.updatedAt,
      logFile: path.join(this.jobsDirectory, slug, 'train.log'),
      ...(state === 'done' ? { model: path.join(this.options.trainedDirectory, `${slug}.onnx`) } : {}),
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    };
  }

  private async writeState(slug: string, state: 'cancelled'): Promise<void> {
    const file = path.join(this.jobsDirectory, slug, 'status.json');
    const raw = await this.readStatusFile(file);
    if (raw) {
      await fs.writeFile(file, JSON.stringify({ ...raw, state, updatedAt: new Date(this.now()).toISOString() }, null, 2), 'utf8');
    }
  }
}
