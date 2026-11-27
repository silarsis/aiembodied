import { vi } from 'vitest';

export interface FakeMicNode {
  port: {
    onmessage: ((event: { data: Float32Array }) => void) | null;
    close: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

export function createFakeMicNode(): FakeMicNode {
  return { port: { onmessage: null, close: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
}

/** The AudioWorklet part of a fake AudioContext. */
export function fakeAudioWorklet() {
  return { addModule: vi.fn(async () => undefined) };
}

/** Seam for `createMicCaptureNode`: hand back the node the fake context carries. */
export function micNodeOf(context: AudioContext): AudioWorkletNode {
  return (context as unknown as { micNode: unknown }).micNode as AudioWorkletNode;
}
