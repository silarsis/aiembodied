import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerOptions } from 'node:worker_threads';
import type { Logger } from 'winston';
import { WakeWordService, type WorkerFactory } from '../src/wake-word/wake-word-service.js';
import type { WakeWordDetectionEvent, WakeWordWorkerMessage } from '../src/wake-word/types.js';

class FakeWorker extends EventEmitter {
  terminated = false;

  postMessage(): void {
    // noop
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function createService({
  cooldownMs = 1000,
  minConfidence = 0.5,
  worker = new FakeWorker(),
  onSpawn,
}: {
  cooldownMs?: number;
  minConfidence?: number;
  worker?: FakeWorker;
  onSpawn?: (filename: URL, options: WorkerOptions) => void;
} = {}) {
  const factory: WorkerFactory = (filename, options) => {
    onSpawn?.(filename, options);
    return worker as unknown as ReturnType<WorkerFactory>;
  };
  const service = new WakeWordService({ logger, cooldownMs, minConfidence, workerFactory: factory });
  return { service, worker };
}

describe('WakeWordService', () => {
  it('emits wake events that meet confidence threshold', async () => {
    const { service, worker } = createService();
    const listener = vi.fn();
    service.on('wake', listener);

    service.start({
      accessKey: 'key',
      keywordPath: 'porcupine',
      keywordLabel: 'Porcupine',
      sensitivity: 0.5,
    });

    const event: WakeWordDetectionEvent = {
      keywordLabel: 'Porcupine',
      confidence: 0.9,
      timestamp: Date.now(),
    };

    worker.emit('message', { type: 'wake', event } satisfies WakeWordWorkerMessage);

    expect(listener).toHaveBeenCalledWith(event);
  });

  it('filters wake events below confidence threshold', async () => {
    const { service, worker } = createService({ minConfidence: 0.8 });
    const listener = vi.fn();
    service.on('wake', listener);

    service.start({
      accessKey: 'key',
      keywordPath: 'porcupine',
      keywordLabel: 'Porcupine',
      sensitivity: 0.5,
    });

    const event: WakeWordDetectionEvent = {
      keywordLabel: 'Porcupine',
      confidence: 0.5,
      timestamp: Date.now(),
    };

    worker.emit('message', { type: 'wake', event } satisfies WakeWordWorkerMessage);

    expect(listener).not.toHaveBeenCalled();
  });

  it('applies cooldown between events', async () => {
    const { service, worker } = createService({ cooldownMs: 1000 });
    const listener = vi.fn();
    service.on('wake', listener);

    service.start({
      accessKey: 'key',
      keywordPath: 'porcupine',
      keywordLabel: 'Porcupine',
      sensitivity: 0.5,
    });

    const timestamp = Date.now();
    const firstEvent: WakeWordDetectionEvent = {
      keywordLabel: 'Porcupine',
      confidence: 0.9,
      timestamp,
    };

    const secondEvent: WakeWordDetectionEvent = {
      keywordLabel: 'Porcupine',
      confidence: 0.9,
      timestamp: timestamp + 500,
    };

    worker.emit('message', { type: 'wake', event: firstEvent } satisfies WakeWordWorkerMessage);
    worker.emit('message', { type: 'wake', event: secondEvent } satisfies WakeWordWorkerMessage);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(firstEvent);
  });

  it('terminates worker on dispose', async () => {
    const worker = new FakeWorker();
    const { service } = createService({ worker });

    service.start({
      accessKey: 'key',
      keywordPath: 'porcupine',
      keywordLabel: 'Porcupine',
      sensitivity: 0.5,
    });

    await service.dispose();

    expect(worker.terminated).toBe(true);
  });

  it('falls back to TypeScript worker entrypoint with ts-node loader in development', () => {
    const worker = new FakeWorker();
    let capturedPath: URL | undefined;
    let capturedOptions: WorkerOptions | undefined;

    const { service } = createService({
      worker,
      onSpawn: (filename, options) => {
        capturedPath = filename;
        capturedOptions = options;
      },
    });

    service.start({
      accessKey: 'key',
      keywordPath: 'porcupine',
      keywordLabel: 'Porcupine',
      sensitivity: 0.5,
    });

    expect(capturedPath?.pathname.endsWith('porcupine-worker.ts')).toBe(true);
    expect(capturedOptions?.execArgv).toBeDefined();
    expect(capturedOptions?.execArgv).toEqual(expect.arrayContaining(['--loader', 'ts-node/esm']));
  });
});
