import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type Processor = {
  process(inputs: Float32Array[][]): boolean;
  port: { postMessage: (m: Float32Array, t: unknown[]) => void };
};

function loadProcessor(frameSize?: number) {
  const posted: Float32Array[] = [];
  let registered: { name: string; ctor: new (o: unknown) => Processor } | null = null;
  class AudioWorkletProcessor {
    port = { postMessage: (frame: Float32Array) => posted.push(frame) };
  }
  const source = readFileSync(
    resolve(process.cwd(), 'src/realtime/mic-capture.worklet.js'),
    'utf8',
  );
  runInNewContext(source, {
    AudioWorkletProcessor,
    Float32Array,
    Number,
    Math,
    registerProcessor: (name: string, ctor: new (o: unknown) => Processor) => {
      registered = { name, ctor };
    },
  });
  const entry = registered as unknown as { name: string; ctor: new (o: unknown) => Processor };
  const options = frameSize ? { processorOptions: { frameSize } } : {};
  return { name: entry.name, processor: new entry.ctor(options), posted };
}

describe('mic capture worklet', () => {
  it('batches 128-sample quanta into ordered 2048-sample frames', () => {
    const { name, processor, posted } = loadProcessor();
    expect(name).toBe('aiembodied-mic-capture');
    let counter = 0;
    for (let q = 0; q < 33; q += 1) {
      const quantum = new Float32Array(128).map(() => counter++);
      expect(processor.process([[quantum]])).toBe(true);
    }
    expect(posted).toHaveLength(2);
    posted.forEach((frame, index) => {
      expect(frame).toHaveLength(2048);
      expect(frame[0]).toBe(index * 2048);
      expect(frame[2047]).toBe(index * 2048 + 2047);
    });
  });

  it('skips missing or empty input and honours a custom frame size', () => {
    const { processor, posted } = loadProcessor(256);
    expect(processor.process([])).toBe(true);
    expect(processor.process([[]])).toBe(true);
    processor.process([[new Float32Array(128).fill(1)]]);
    expect(posted).toHaveLength(0);
    processor.process([[new Float32Array(128).fill(2)]]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toHaveLength(256);
    expect(posted[0][127]).toBe(1);
    expect(posted[0][128]).toBe(2);
  });
});
