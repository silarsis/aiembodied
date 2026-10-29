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
  autoRestart = true,
  restartDelayMs = 100,
  maxRestartDelayMs = 1000,
  onSpawn,
}: {
  cooldownMs?: number;
  minConfidence?: number;
  worker?: FakeWorker;
  autoRestart?: boolean;
  restartDelayMs?: number;
  maxRestartDelayMs?: number;
  onSpawn?: (filename: URL, options: WorkerOptions) => void;
} = {}) {
  const factory: WorkerFactory = (filename, options) => {
    onSpawn?.(filename, options);
    return worker as unknown as ReturnType<WorkerFactory>;
  };
  const service = new WakeWordService({
    logger,
    cooldownMs,
    minConfidence,
    workerFactory: factory,
    autoRestart,
    restartDelayMs,
    maxRestartDelayMs,
  });
  return { service, worker };
}

describe('WakeWordService', () => {
  it('emits wake events that meet confidence threshold', async () => {
    const { service, worker } = createService();
    const listener = vi.fn();
    service.on('wake', listener);

    service.start({
      modelPaths: { melspectrogram: 'mel.onnx', embedding: 'embedding.onnx', wakeWord: 'hey_jarvis.onnx' },
      keywordLabel: 'Porcupine',
      threshold: 0.5,
    });

    const event: WakeWordDetectionEvent = {
      keywordLabel: 'Porcupine',
      confidence: 0.9,
      timestamp: Date.now(),
    };

    worker.emit('message', { type: 'wake', event } satisfies WakeWordWorkerMessage);

    expect(listener).toHaveBeenCalledWith(event);
  });

  it('logs detections without overriding the logger timestamp', async () => {
    const { service, worker } = createService();
    service.start({
      modelPaths: { melspectrogram: 'mel.onnx', embedding: 'embedding.onnx', wakeWord: 'hey_jarvis.onnx' },
      keywordLabel: 'Hey Jarvis',
      threshold: 0.5,
    });
    const event: WakeWordDetectionEvent = { keywordLabel: 'Hey Jarvis', confidence: 0.99, timestamp: 1234 };

    worker.emit('message', { type: 'wake', event } satisfies WakeWordWorkerMessage);

    const call = vi.mocked(logger.info).mock.calls.find(([message]) => message === 'Wake word detected');
    expect(call?.[1]).toEqual({ keyword: 'Hey Jarvis', confidence: 0.99, detectedAt: 1234 });
  });

  it('emits and logs peak scores below the threshold without treating them as wake events', () => {
    const { service, worker } = createService();
    const wake = vi.fn();
    const peak = vi.fn();
    service.on('wake', wake);
    service.on('peak', peak);
    service.start({
      modelPaths: { melspectrogram: 'mel.onnx', embedding: 'embedding.onnx', wakeWord: 'hey_jarvis.onnx' },
      keywordLabel: 'Hey Jarvis',
      threshold: 0.5,
    });
    const event: WakeWordDetectionEvent = { keywordLabel: 'Hey Jarvis', confidence: 0.31234, timestamp: 4321 };

    worker.emit('message', { type: 'peak', event } satisfies WakeWordWorkerMessage);

    expect(peak).toHaveBeenCalledWith(event);
    expect(wake).not.toHaveBeenCalled();
    const call = vi.mocked(logger.debug).mock.calls.find(([message]) => message === 'Wake word peak score');
    expect(call?.[1]).toEqual({ keyword: 'Hey Jarvis', confidence: 0.312, detectedAt: 4321 });
  });

  it('filters wake events below confidence threshold', async () => {
    const { service, worker } = createService({ minConfidence: 0.8 });
    const listener = vi.fn();
    service.on('wake', listener);

    service.start({
      modelPaths: { melspectrogram: 'mel.onnx', embedding: 'embedding.onnx', wakeWord: 'hey_jarvis.onnx' },
      keywordLabel: 'Porcupine',
      threshold: 0.5,
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
      modelPaths: { melspectrogram: 'mel.onnx', embedding: 'embedding.onnx', wakeWord: 'hey_jarvis.onnx' },
      keywordLabel: 'Porcupine',
      threshold: 0.5,
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
      modelPaths: { melspectrogram: 'mel.onnx', embedding: 'embedding.onnx', wakeWord: 'hey_jarvis.onnx' },
      keywordLabel: 'Porcupine',
      threshold: 0.5,
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
      modelPaths: { melspectrogram: 'mel.onnx', embedding: 'embedding.onnx', wakeWord: 'hey_jarvis.onnx' },
      keywordLabel: 'Porcupine',
      threshold: 0.5,
    });

    expect(capturedPath?.pathname.endsWith('wake-word-worker.ts')).toBe(true);
    expect(capturedOptions?.execArgv).toBeDefined();
    expect(capturedOptions?.execArgv).toEqual(expect.arrayContaining(['--loader', 'ts-node/esm']));
  });

  it('schedules restart when fatal error is received', async () => {
    vi.useFakeTimers();
    let spawnCount = 0;
    const workers: FakeWorker[] = [];

    const factory: WorkerFactory = () => {
      const worker = new FakeWorker();
      workers.push(worker);
      spawnCount++;
      return worker as unknown as ReturnType<WorkerFactory>;
    };

    const service = new WakeWordService({
      logger,
      cooldownMs: 1000,
      minConfidence: 0.5,
      workerFactory: factory,
      autoRestart: true,
      restartDelayMs: 100,
      maxRestartDelayMs: 1000,
    });

    service.on('error', () => { });

    service.start({
      modelPaths: { melspectrogram: 'mel.onnx', embedding: 'embedding.onnx', wakeWord: 'hey_jarvis.onnx' },
      keywordLabel: 'Porcupine',
      threshold: 0.5,
    });

    expect(spawnCount).toBe(1);

    workers[0].emit('message', {
      type: 'error',
      error: { message: 'PvRecorder failed to read audio data frame.' },
      fatal: true,
    } satisfies WakeWordWorkerMessage);
    workers[0].emit('exit', 0);

    vi.advanceTimersByTime(100);

    expect(spawnCount).toBe(2);

    vi.useRealTimers();
    await service.dispose();
  });

  it('does not restart when autoRestart is disabled', async () => {
    vi.useFakeTimers();
    let spawnCount = 0;
    const workers: FakeWorker[] = [];

    const factory: WorkerFactory = () => {
      const worker = new FakeWorker();
      workers.push(worker);
      spawnCount++;
      return worker as unknown as ReturnType<WorkerFactory>;
    };

    const service = new WakeWordService({
      logger,
      cooldownMs: 1000,
      minConfidence: 0.5,
      workerFactory: factory,
      autoRestart: false,
    });

    service.on('error', () => { });

    service.start({
      modelPaths: { melspectrogram: 'mel.onnx', embedding: 'embedding.onnx', wakeWord: 'hey_jarvis.onnx' },
      keywordLabel: 'Porcupine',
      threshold: 0.5,
    });

    workers[0].emit('message', {
      type: 'error',
      error: { message: 'PvRecorder failed to read audio data frame.' },
      fatal: true,
    } satisfies WakeWordWorkerMessage);
    workers[0].emit('exit', 0);

    vi.advanceTimersByTime(5000);

    expect(spawnCount).toBe(1);

    vi.useRealTimers();
    await service.dispose();
  });

  it('applies exponential backoff on repeated restarts', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    let spawnCount = 0;

    const factory: WorkerFactory = () => {
      const worker = new FakeWorker();
      workers.push(worker);
      spawnCount++;
      return worker as unknown as ReturnType<WorkerFactory>;
    };

    const service = new WakeWordService({
      logger,
      cooldownMs: 1000,
      minConfidence: 0.5,
      workerFactory: factory,
      autoRestart: true,
      restartDelayMs: 100,
      maxRestartDelayMs: 1000,
    });

    service.on('error', () => { });

    service.start({
      modelPaths: { melspectrogram: 'mel.onnx', embedding: 'embedding.onnx', wakeWord: 'hey_jarvis.onnx' },
      keywordLabel: 'Porcupine',
      threshold: 0.5,
    });

    expect(spawnCount).toBe(1);

    workers[0].emit('message', {
      type: 'error',
      error: { message: 'PvRecorder failed to read audio data frame.' },
      fatal: true,
    } satisfies WakeWordWorkerMessage);
    workers[0].emit('exit', 0);

    vi.advanceTimersByTime(100);
    expect(spawnCount).toBe(2);

    workers[1].emit('message', {
      type: 'error',
      error: { message: 'PvRecorder failed to read audio data frame.' },
      fatal: true,
    } satisfies WakeWordWorkerMessage);
    workers[1].emit('exit', 0);

    vi.advanceTimersByTime(100);
    expect(spawnCount).toBe(2);

    vi.advanceTimersByTime(100);
    expect(spawnCount).toBe(3);

    vi.useRealTimers();
    await service.dispose();
  });

  it('resets restart attempts on successful ready', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    let spawnCount = 0;

    const factory: WorkerFactory = () => {
      const worker = new FakeWorker();
      workers.push(worker);
      spawnCount++;
      return worker as unknown as ReturnType<WorkerFactory>;
    };

    const service = new WakeWordService({
      logger,
      cooldownMs: 1000,
      minConfidence: 0.5,
      workerFactory: factory,
      autoRestart: true,
      restartDelayMs: 100,
      maxRestartDelayMs: 1000,
    });

    service.on('error', () => { });

    service.start({
      modelPaths: { melspectrogram: 'mel.onnx', embedding: 'embedding.onnx', wakeWord: 'hey_jarvis.onnx' },
      keywordLabel: 'Porcupine',
      threshold: 0.5,
    });

    workers[0].emit('message', {
      type: 'error',
      error: { message: 'PvRecorder failed to read audio data frame.' },
      fatal: true,
    } satisfies WakeWordWorkerMessage);
    workers[0].emit('exit', 0);

    vi.advanceTimersByTime(100);
    expect(spawnCount).toBe(2);

    workers[1].emit('message', {
      type: 'ready',
      info: { frameLength: 512, sampleRate: 16000, keywordLabel: 'Porcupine' },
    } satisfies WakeWordWorkerMessage);

    workers[1].emit('message', {
      type: 'error',
      error: { message: 'PvRecorder failed to read audio data frame.' },
      fatal: true,
    } satisfies WakeWordWorkerMessage);
    workers[1].emit('exit', 0);

    vi.advanceTimersByTime(100);
    expect(spawnCount).toBe(3);

    vi.useRealTimers();
    await service.dispose();
  });
});
