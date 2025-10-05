import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WakeWordWorkerMessage } from '../src/wake-word/types.js';

interface ParentPortMock extends EventEmitter {
  postMessage: ReturnType<typeof vi.fn>;
}

const workerConfig = {
  accessKey: 'access-key',
  keywordPath: '/tmp/keyword.ppn',
  keywordLabel: 'Porcupine',
  sensitivity: 0.7,
  modelPath: '/tmp/model.pv',
  deviceIndex: 2,
};

const parentPortEmitter = new EventEmitter() as ParentPortMock;
parentPortEmitter.postMessage = vi.fn();

vi.mock('node:worker_threads', () => ({
  parentPort: parentPortEmitter,
  workerData: workerConfig,
}));

let porcupineProcessQueue: number[] = [];

class PorcupineFake {
  frameLength = 512;
  sampleRate = 16000;
  readonly process = vi.fn(() => (porcupineProcessQueue.length ? porcupineProcessQueue.shift()! : -1));
  readonly release = vi.fn();
  constructor(
    public readonly accessKey: string,
    public readonly keywords: string[],
    public readonly sensitivities: number[],
    public readonly modelPath?: string,
  ) {}
}

const porcupineInstances: PorcupineFake[] = [];
const PorcupineCtor = vi.fn(
  (accessKey: string, keywords: string[], sensitivities: number[], modelPath?: string) => {
    const instance = new PorcupineFake(accessKey, keywords, sensitivities, modelPath);
    porcupineInstances.push(instance);
    return instance;
  },
);

vi.mock('@picovoice/porcupine-node', () => ({
  Porcupine: PorcupineCtor,
}));

let recorderReadQueue: Array<() => Promise<Int16Array>> = [];

class PvRecorderFake {
  readonly start = vi.fn();
  readonly stop = vi.fn();
  readonly release = vi.fn();
  constructor(
    public readonly frameLength: number,
    public readonly deviceIndex: number,
    public readonly bufferSize: number,
  ) {}

  read(): Promise<Int16Array> {
    if (recorderReadQueue.length) {
      return recorderReadQueue.shift()!();
    }

    return Promise.resolve(new Int16Array(this.frameLength));
  }
}

const recorderInstances: PvRecorderFake[] = [];
const PvRecorderCtor = vi.fn((frameLength: number, deviceIndex: number, bufferSize: number) => {
  const instance = new PvRecorderFake(frameLength, deviceIndex, bufferSize);
  recorderInstances.push(instance);
  return instance;
});

vi.mock('@picovoice/pvrecorder-node', () => ({
  PvRecorder: PvRecorderCtor,
}));

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function waitForMessage(predicate: (message: WakeWordWorkerMessage) => boolean) {
  const timeoutAt = Date.now() + 500;
  while (Date.now() < timeoutAt) {
    const message = parentPortEmitter.postMessage.mock.calls
      .map(([payload]) => payload as WakeWordWorkerMessage)
      .find(predicate);
    if (message) {
      return message;
    }
    await flushAsync();
  }

  throw new Error('Timed out waiting for worker message');
}

describe('porcupine worker', () => {
  beforeEach(() => {
    vi.resetModules();
    porcupineProcessQueue = [];
    recorderReadQueue = [];

    parentPortEmitter.removeAllListeners();
    parentPortEmitter.postMessage.mockReset();

    porcupineInstances.length = 0;
    PorcupineCtor.mockClear();

    recorderInstances.length = 0;
    PvRecorderCtor.mockClear();
  });

  it('announces readiness, emits wake events, and shuts down gracefully', async () => {
    porcupineProcessQueue = [-1, 0, -1];

    await import('../src/wake-word/porcupine-worker.js');

    const readyMessage = await waitForMessage((message) => message.type === 'ready');
    expect(readyMessage).toEqual({
      type: 'ready',
      info: {
        frameLength: porcupineInstances[0].frameLength,
        sampleRate: porcupineInstances[0].sampleRate,
        keywordLabel: workerConfig.keywordLabel,
      },
    });

    const wakeMessage = await waitForMessage((message) => message.type === 'wake');
    expect(wakeMessage.type).toBe('wake');
    expect(wakeMessage.event.keywordLabel).toBe(workerConfig.keywordLabel);
    expect(wakeMessage.event.keywordIndex).toBe(0);
    expect(wakeMessage.event.confidence).toBe(1);
    expect(typeof wakeMessage.event.timestamp).toBe('number');

    expect(PorcupineCtor).toHaveBeenCalledWith(
      workerConfig.accessKey,
      [workerConfig.keywordPath],
      [workerConfig.sensitivity],
      workerConfig.modelPath,
    );

    expect(PvRecorderCtor).toHaveBeenCalledWith(
      porcupineInstances[0].frameLength,
      workerConfig.deviceIndex,
      50,
    );

    expect(recorderInstances[0].start).toHaveBeenCalledTimes(1);

    parentPortEmitter.emit('message', { type: 'shutdown' });
    await flushAsync();
    await flushAsync();

    expect(recorderInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(recorderInstances[0].release).toHaveBeenCalledTimes(1);
    expect(porcupineInstances[0].release).toHaveBeenCalledTimes(1);
  });

  it('reports recorder failures as serialized errors', async () => {
    recorderReadQueue = [() => Promise.reject(new Error('mic failure'))];

    await import('../src/wake-word/porcupine-worker.js');

    const errorMessage = await waitForMessage((message) => message.type === 'error');
    expect(errorMessage).toEqual({
      type: 'error',
      error: expect.objectContaining({
        message: 'mic failure',
        name: 'Error',
      }),
    });

    parentPortEmitter.emit('message', { type: 'shutdown' });
    await flushAsync();
    await flushAsync();

    expect(recorderInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(recorderInstances[0].release).toHaveBeenCalledTimes(1);
    expect(porcupineInstances[0].release).toHaveBeenCalledTimes(1);
  });
});
