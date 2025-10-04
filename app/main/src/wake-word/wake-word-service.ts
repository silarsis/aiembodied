import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'winston';
import type {
  WakeWordDetectionEvent,
  WakeWordReadyEvent,
  WakeWordWorkerCommand,
  WakeWordWorkerConfig,
  WakeWordWorkerMessage,
} from './types.js';

export interface WakeWordServiceOptions {
  logger: Logger;
  cooldownMs: number;
  minConfidence: number;
  workerFactory?: WorkerFactory;
  workerPath?: URL;
  workerOptions?: WorkerOptions;
}

export type WorkerFactory = (filename: URL, options: WorkerOptions) => WorkerLike;

export interface WorkerLike {
  postMessage(value: WakeWordWorkerCommand): void;
  terminate(): Promise<number>;
  on(event: 'message', listener: (value: WakeWordWorkerMessage) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  off(event: 'message', listener: (value: WakeWordWorkerMessage) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'exit', listener: (code: number) => void): this;
}

export interface WakeWordStartOptions extends WakeWordWorkerConfig {}

export interface WakeWordServiceEvents {
  wake: [WakeWordDetectionEvent];
  error: [Error];
  ready: [WakeWordReadyEvent];
}

class WakeWordEventFilter {
  private lastEmitTimestamp: number | null = null;

  constructor(private readonly options: { cooldownMs: number; minConfidence: number }) {}

  shouldEmit(event: WakeWordDetectionEvent): boolean {
    if (event.confidence < this.options.minConfidence) {
      return false;
    }

    if (this.lastEmitTimestamp !== null) {
      const elapsed = event.timestamp - this.lastEmitTimestamp;
      if (elapsed < this.options.cooldownMs) {
        return false;
      }
    }

    this.lastEmitTimestamp = event.timestamp;
    return true;
  }

  reset(): void {
    this.lastEmitTimestamp = null;
  }
}

export class WakeWordService extends EventEmitter<WakeWordServiceEvents> {
  private readonly logger: Logger;
  private readonly workerFactory: WorkerFactory;
  private readonly workerPath: URL;
  private readonly baseWorkerOptions: WorkerOptions;
  private readonly filter: WakeWordEventFilter;
  private worker: WorkerLike | null = null;
  private started = false;

  constructor(options: WakeWordServiceOptions) {
    super();
    this.logger = options.logger;
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    if (options.workerPath) {
      this.workerPath = options.workerPath;
      this.baseWorkerOptions = { ...(options.workerOptions ?? {}) } as WorkerOptions;
    } else {
      const entrypoint = defaultWorkerEntrypoint();
      this.workerPath = entrypoint.url;
      this.baseWorkerOptions = {
        ...(entrypoint.options ?? {}),
        ...(options.workerOptions ?? {}),
      } as WorkerOptions;
    }
    this.filter = new WakeWordEventFilter({
      cooldownMs: options.cooldownMs,
      minConfidence: options.minConfidence,
    });
  }

  start(config: WakeWordStartOptions): void {
    if (this.started) {
      this.logger.warn('WakeWordService.start() called more than once. Ignoring subsequent call.');
      return;
    }

    const worker = this.workerFactory(this.workerPath, {
      ...this.baseWorkerOptions,
      workerData: config,
      env: process.env,
    });

    this.started = true;

    const handleMessage = (message: WakeWordWorkerMessage) => {
      if (message.type === 'wake') {
        this.handleWakeEvent(message.event);
        return;
      }

      if (message.type === 'error') {
        const error = deserializeError(message.error);
        this.logger.error('Wake word worker reported an error', {
          message: error.message,
          name: error.name,
          stack: error.stack,
        });
        this.emit('error', error);
        return;
      }

      if (message.type === 'ready') {
        this.logger.info('Wake word worker ready', {
          frameLength: message.info.frameLength,
          sampleRate: message.info.sampleRate,
          keyword: message.info.keywordLabel,
        });
        this.emit('ready', message.info);
      }
    };

    const handleError = (error: Error) => {
      this.logger.error('Wake word worker crashed', {
        message: error.message,
        stack: error.stack,
      });
      this.emit('error', error);
    };

    const handleExit = (code: number) => {
      this.logger.warn('Wake word worker exited', { code });
      this.filter.reset();
      this.worker = null;
      this.started = false;
    };

    worker.on('message', handleMessage);
    worker.on('error', handleError);
    worker.on('exit', handleExit);

    this.worker = worker;
  }

  async dispose(): Promise<void> {
    if (!this.worker) {
      return;
    }

    try {
      this.worker.postMessage({ type: 'shutdown' });
    } catch (error) {
      this.logger.warn('Failed to post shutdown command to wake word worker', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    await this.worker.terminate();
    this.worker = null;
    this.filter.reset();
    this.started = false;
  }

  private handleWakeEvent(event: WakeWordDetectionEvent): void {
    if (!this.filter.shouldEmit(event)) {
      this.logger.debug('Wake word event filtered', event);
      return;
    }

    this.logger.info('Wake word detected', {
      keyword: event.keywordLabel,
      confidence: event.confidence,
      timestamp: event.timestamp,
    });
    this.emit('wake', event);
  }
}

function defaultWorkerFactory(filename: URL, options: WorkerOptions): WorkerLike {
  return new Worker(filename, options);
}

interface WorkerEntrypoint {
  url: URL;
  options?: WorkerOptions;
}

function defaultWorkerEntrypoint(): WorkerEntrypoint {
  const jsEntrypoint = new URL('./porcupine-worker.js', import.meta.url);
  if (fileExists(jsEntrypoint)) {
    return { url: jsEntrypoint };
  }

  const tsEntrypoint = new URL('./porcupine-worker.ts', import.meta.url);
  return {
    url: tsEntrypoint,
    options: resolveTsNodeWorkerOptions(),
  };
}

function fileExists(url: URL): boolean {
  try {
    return existsSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

function resolveTsNodeWorkerOptions(): WorkerOptions | undefined {
  const execArgv = resolveTsNodeExecArgv();
  if (execArgv.length === 0) {
    return undefined;
  }

  return { execArgv } satisfies WorkerOptions;
}

function resolveTsNodeExecArgv(): string[] {
  const execArgv = process.execArgv ?? [];
  if (execArgv.some((arg) => arg.includes('ts-node'))) {
    return execArgv;
  }

  return ['--loader', 'ts-node/esm'];
}

function deserializeError(serialized: { message: string; name?: string; stack?: string }): Error {
  const error = new Error(serialized.message);
  if (serialized.name) {
    error.name = serialized.name;
  }
  if (serialized.stack) {
    error.stack = serialized.stack;
  }
  return error;
}
