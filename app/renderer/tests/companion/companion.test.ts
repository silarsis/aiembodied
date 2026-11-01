import { describe, expect, it } from 'vitest';
import { decodePcm16Base64, SpeechDetector } from '../../src/companion/speech-detector.js';
import { readConnection, readNdjson } from '../../src/companion/companion-client.js';
import { downsample, stripTags } from '../../src/companion/conversation.js';

const RATE = 16000;
const FRAME = 1600; // 100 ms

function frame(amplitude: number): Float32Array {
  const samples = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) samples[i] = amplitude * Math.sin((2 * Math.PI * 200 * i) / RATE);
  return samples;
}

function repeat(count: number, value: number): number[] {
  return new Array<number>(count).fill(value);
}

function run(detector: SpeechDetector, frames: number[], startMs = 0) {
  let now = startMs;
  const results = [];
  for (const amplitude of frames) {
    now += 100;
    const result = detector.push(frame(amplitude), RATE, now);
    if (result) results.push(result);
  }
  return results;
}

describe('SpeechDetector', () => {
  it('returns speech that ends with a pause, with a little audio from before it', () => {
    const detector = new SpeechDetector();
    detector.start(0);
    const quiet = repeat(10, 0.003);
    const results = run(detector, [...quiet, ...repeat(10, 0.2), ...repeat(9, 0.003)]);
    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result?.type).toBe('utterance');
    if (result?.type === 'utterance') {
      // 300 ms pre-roll + 1 s speech + 800 ms pause.
      expect(result.durationMs).toBeGreaterThanOrEqual(2000);
      expect(result.durationMs).toBeLessThanOrEqual(2300);
    }
  });

  it('ignores a click and a steady background noise', () => {
    const detector = new SpeechDetector({ noSpeechTimeoutMs: 60_000 });
    detector.start(0);
    // A fan: loud but steady, so the floor rises to it.
    const fan = repeat(40, 0.02);
    expect(run(detector, [...repeat(5, 0.003), 0.3, ...repeat(10, 0.003), ...fan])).toEqual([]);
  });

  it('times out when nothing is said', () => {
    const detector = new SpeechDetector();
    detector.start(0, 1000);
    expect(run(detector, repeat(12, 0.001))).toEqual([{ type: 'timeout' }]);
  });

  it('flushes speech in progress on a second tap', () => {
    const detector = new SpeechDetector();
    detector.start(0);
    run(detector, [0.003, 0.003, ...repeat(5, 0.2)]);
    expect(detector.flush()?.type).toBe('utterance');
    expect(detector.flush()).toBeNull();
  });

  it('decodes the PCM the Android app sends', () => {
    const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f]);
    const samples = decodePcm16Base64(btoa(String.fromCharCode(...bytes)));
    expect(Array.from(samples)).toEqual([0.5, -0.5, 32767 / 32768]);
  });
});

describe('companion helpers', () => {
  it('reads the connection from the Android URL fragment without storing the code', () => {
    const storage = new Map<string, string>();
    const fakeStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    } as unknown as Storage;
    expect(readConnection({ hash: '#code=ABCD-EFGH-JKMN&device=android-1&name=Pixel%209' }, fakeStorage)).toEqual({
      baseUrl: '',
      code: 'ABCD-EFGH-JKMN',
      deviceId: 'android-1',
      deviceName: 'Pixel 9',
    });
    expect(storage.size).toBe(0);
    // A browser without a code gets a stable device id and the pairing form.
    expect(readConnection({ hash: '' }, fakeStorage)).toBeNull();
    const first = JSON.parse(storage.get('aiembodied.companion') ?? '{}') as { deviceId: string };
    expect(first.deviceId).toMatch(/^web-/);
  });

  it('reads NDJSON split across chunks', async () => {
    const text = '{"type":"ping","ts":1}\n{"type":"transcript","requestId":"r","text":"hi"}\n{"type":"done","requestId":"r","text":"","cancelled":false}';
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const events: string[] = [];
    await readNdjson(new Response(body), (event) => events.push(event.type));
    expect(events).toEqual(['ping', 'transcript', 'done']);
  });

  it('strips avatar tags from captions and downsamples to 16 kHz', () => {
    expect(stripTags('Hi there! {anim:happy-wave}  {move:shrugs}')).toBe('Hi there!');
    expect(downsample(new Float32Array(48000), 48000, 16000)).toHaveLength(16000);
    const same = new Float32Array(10);
    expect(downsample(same, 16000, 16000)).toBe(same);
  });
});
