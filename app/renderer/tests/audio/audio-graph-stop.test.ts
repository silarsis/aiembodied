import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioGraph } from '../../src/audio/audio-graph.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(resume: () => Promise<void> = async () => {}) {
  const stopTrack = vi.fn(),
    close = vi.fn().mockResolvedValue(undefined),
    source = vi.fn();
  const node = { connect: vi.fn(), disconnect: vi.fn(), gain: { value: 0 } };
  const ctor = vi.fn();
  class Context {
    constructor() {
      ctor();
    }
    resume = resume;
    close = close;
    createMediaStreamSource = source.mockReturnValue(node);
    createGain = () => node;
    createMediaStreamDestination = () => ({ ...node, stream: {} });
    createAnalyser = () => ({ ...node, fftSize: 2048, smoothingTimeConstant: 0 });
  }
  vi.stubGlobal('AudioContext', Context);
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  return { stopTrack, close, source, ctor, stream, getUserMedia };
}

describe('audio graph cancellation', () => {
  it('releases a late microphone permission result without starting audio processing', async () => {
    const { stream, getUserMedia, stopTrack, ctor } = setup();
    let release!: (stream: MediaStream) => void;
    getUserMedia.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const graph = new AudioGraph();
    const starting = graph.start();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    await graph.stop();
    release(stream);
    await starting;
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(ctor).not.toHaveBeenCalled();
    expect(graph.getUpstreamStream()).toBeNull();
  });
  it('stops capture while context resume is pending and does not connect nodes later', async () => {
    let resume!: () => void;
    const context = setup(
      () =>
        new Promise((resolve) => {
          resume = resolve;
        }),
    );
    const graph = new AudioGraph();
    const starting = graph.start();
    await vi.waitFor(() => expect(context.ctor).toHaveBeenCalled());
    await graph.stop();
    expect(context.stopTrack).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    resume();
    await starting;
    expect(context.source).not.toHaveBeenCalled();
    expect(graph.getUpstreamStream()).toBeNull();
  });
  it('releases an active stream and audio context on stop', async () => {
    const context = setup();
    const graph = new AudioGraph();
    await graph.start();
    expect(graph.getUpstreamStream()).not.toBeNull();
    await graph.stop();
    expect(context.stopTrack).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(graph.getUpstreamStream()).toBeNull();
  });
});
