import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  create: vi.fn(),
  process: vi.fn(),
  release: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  recorderRelease: vi.fn(),
  read: vi.fn(),
  recorder: vi.fn(),
  postMessage: vi.fn(),
  receive: null as null | ((message: { type: string }) => void),
}));
vi.mock('node:worker_threads', () => ({
  parentPort: {
    postMessage: state.postMessage,
    on: (_name: string, handler: typeof state.receive) => {
      state.receive = handler;
    },
  },
  workerData: { modelPaths: {}, keywordLabel: 'Test', threshold: 0.5 },
}));
vi.mock('@picovoice/pvrecorder-node', () => ({
  PvRecorder: class {
    constructor() {
      state.recorder();
    }
    start = state.start;
    stop = state.stop;
    release = state.recorderRelease;
    read = state.read;
  },
}));
vi.mock('../src/wake-word/open-wake-word.js', () => ({
  OWW_FRAME_LENGTH: 1280,
  OWW_SAMPLE_RATE: 16000,
  OpenWakeWordDetector: { create: state.create },
}));
const detector = { process: state.process, release: state.release };
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.create.mockResolvedValue(detector);
  state.release.mockResolvedValue(undefined);
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});
describe('wake worker stop races', () => {
  it('discards in-flight inference and waits for it before releasing model sessions', async () => {
    let finish!: (score: number) => void;
    state.read.mockResolvedValueOnce(new Int16Array(1280));
    state.process.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await import('../src/wake-word/wake-word-worker.js');
    await vi.waitFor(() => expect(state.process).toHaveBeenCalled());
    state.postMessage.mockClear();
    state.receive?.({ type: 'shutdown' });
    expect(state.stop).toHaveBeenCalled();
    expect(state.release).not.toHaveBeenCalled();
    finish(0.99);
    await vi.waitFor(() => expect(state.release).toHaveBeenCalled());
    expect(state.postMessage).not.toHaveBeenCalled();
  });
  it('does not open the microphone if shutdown happens while models load', async () => {
    let loaded!: (value: typeof detector) => void;
    state.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          loaded = resolve;
        }),
    );
    await import('../src/wake-word/wake-word-worker.js');
    state.receive?.({ type: 'shutdown' });
    loaded(detector);
    await vi.waitFor(() => expect(state.release).toHaveBeenCalled());
    expect(state.recorder).not.toHaveBeenCalled();
    expect(state.process).not.toHaveBeenCalled();
    expect(state.postMessage).not.toHaveBeenCalled();
  });
  it('releases the microphone and discards a pending audio frame without inference', async () => {
    let frame!: (value: Int16Array) => void;
    state.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          frame = resolve;
        }),
    );
    await import('../src/wake-word/wake-word-worker.js');
    await vi.waitFor(() => expect(state.read).toHaveBeenCalled());
    state.postMessage.mockClear();
    state.receive?.({ type: 'shutdown' });
    frame(new Int16Array(1280));
    await vi.waitFor(() => expect(state.recorderRelease).toHaveBeenCalled());
    expect(state.stop).toHaveBeenCalled();
    expect(state.release).toHaveBeenCalled();
    expect(state.process).not.toHaveBeenCalled();
    expect(state.postMessage).not.toHaveBeenCalled();
  });
});
