import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OWW_FRAME_LENGTH,
  OpenWakeWordDetector,
  resolveOpenWakeWordModelPaths,
} from '../src/wake-word/open-wake-word.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDirectory = path.resolve(here, '../assets/wake-word');

/** 16 kHz mono int16 PCM from openWakeWord's own test clip (Apache-2.0). */
function loadAlexaClip(): Int16Array {
  return loadClip('alexa_test.wav');
}

/** 16 kHz mono 16-bit WAV with a plain 44-byte header. */
function loadClip(name: string): Int16Array {
  const wav = readFileSync(path.join(here, 'fixtures/wake-word', name));
  const dataBytes = wav.length - 44;
  return new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + 44 + dataBytes - (dataBytes % 2)));
}

async function scoreAudio(detector: OpenWakeWordDetector, audio: Int16Array): Promise<number[]> {
  const scores: number[] = [];
  for (let offset = 0; offset + OWW_FRAME_LENGTH <= audio.length; offset += OWW_FRAME_LENGTH) {
    scores.push(await detector.process(audio.slice(offset, offset + OWW_FRAME_LENGTH)));
  }
  return scores;
}

function withSilence(audio: Int16Array, seconds: number): Int16Array {
  const padding = 16000 * seconds;
  const padded = new Int16Array(audio.length + padding * 2);
  padded.set(audio, padding);
  return padded;
}

describe('resolveOpenWakeWordModelPaths', () => {
  it('maps builtin names to bundled models and passes custom paths through', () => {
    expect(resolveOpenWakeWordModelPaths('/assets', 'hey_jarvis')).toEqual({
      melspectrogram: path.join('/assets', 'melspectrogram.onnx'),
      embedding: path.join('/assets', 'embedding_model.onnx'),
      wakeWord: path.join('/assets', 'hey_jarvis_v0.1.onnx'),
    });
    expect(resolveOpenWakeWordModelPaths('/assets', '/models/custom.onnx').wakeWord).toBe('/models/custom.onnx');
  });
});

describe('OpenWakeWordDetector', () => {
  let detector: OpenWakeWordDetector | null = null;

  afterEach(async () => {
    await detector?.release();
    detector = null;
  });

  it('matches the Python reference scores on openWakeWord\'s alexa clip', async () => {
    detector = await OpenWakeWordDetector.create(resolveOpenWakeWordModelPaths(assetsDirectory, 'alexa'));

    const scores = await scoreAudio(detector, loadAlexaClip());

    // Reference: openwakeword.Model.predict() over the same 1280-sample frames.
    const reference = [0, 0, 0, 0, 0, 0.2405, 1];
    expect(scores).toHaveLength(reference.length);
    scores.forEach((score, index) => expect(score).toBeCloseTo(reference[index] ?? 0, 3));
  });

  it('detects the wake word between stretches of silence and stays quiet on silence', async () => {
    detector = await OpenWakeWordDetector.create(resolveOpenWakeWordModelPaths(assetsDirectory, 'alexa'));

    const scores = await scoreAudio(detector, withSilence(loadAlexaClip(), 1));
    const peak = scores.indexOf(Math.max(...scores));

    expect(scores[peak]).toBeGreaterThan(0.9);
    expect(Math.max(...scores.slice(0, 10))).toBeLessThan(0.1);
  });

  it('does not fire a different wake word model on the clip', async () => {
    detector = await OpenWakeWordDetector.create(resolveOpenWakeWordModelPaths(assetsDirectory, 'hey_jarvis'));

    const scores = await scoreAudio(detector, withSilence(loadAlexaClip(), 1));

    expect(Math.max(...scores)).toBeLessThan(0.5);
  });

  it('detects "hey echo" with the bundled default model, and not "alexa"', async () => {
    detector = await OpenWakeWordDetector.create(resolveOpenWakeWordModelPaths(assetsDirectory, 'hey_echo'));
    const heyEcho = await scoreAudio(detector, withSilence(loadClip('hey_echo_test.wav'), 1));
    expect(Math.max(...heyEcho)).toBeGreaterThan(0.9);
    expect(Math.max(...heyEcho.slice(0, 10))).toBeLessThan(0.1);

    await detector.release();
    detector = await OpenWakeWordDetector.create(resolveOpenWakeWordModelPaths(assetsDirectory, 'hey_echo'));
    const alexa = await scoreAudio(detector, withSilence(loadAlexaClip(), 1));
    expect(Math.max(...alexa)).toBeLessThan(0.5);
  });

  it('rejects frames of the wrong length', async () => {
    detector = await OpenWakeWordDetector.create(resolveOpenWakeWordModelPaths(assetsDirectory, 'alexa'));

    await expect(detector.process(new Int16Array(512))).rejects.toThrow('1280-sample frames');
  });
});
