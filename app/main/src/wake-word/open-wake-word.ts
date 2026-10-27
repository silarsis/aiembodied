/**
 * Streaming openWakeWord detector (https://github.com/dscripka/openWakeWord) running on
 * onnxruntime-node, so wake-word detection stays on this machine with no account or key.
 *
 * Port of openWakeWord's Python streaming pipeline (utils.AudioFeatures + Model.predict):
 * 16 kHz int16 audio in 80 ms frames → melspectrogram model → shared speech-embedding model
 * (one 96-d embedding per 8 mel frames) → wake-word model over the last 16 embeddings → score 0..1.
 */
import path from 'node:path';
import * as ort from 'onnxruntime-node';

export const OWW_SAMPLE_RATE = 16000;
/** Samples per 80 ms frame; the detector must be fed exactly this many at a time. */
export const OWW_FRAME_LENGTH = 1280;

const MEL_BINS = 32;
const EMBEDDING_WINDOW = 76;
const EMBEDDING_STEP = 8;
const EMBEDDING_SIZE = 96;
/** Extra samples before each frame so the melspectrogram windows overlap the previous frame. */
const MEL_CONTEXT_SAMPLES = 160 * 3;
const MAX_MEL_FRAMES = 10 * 97;
const MAX_EMBEDDINGS = 120;
/** Scores are forced to 0 for the first few frames while the buffers fill with real audio. */
const WARMUP_FRAMES = 5;

export const BUILTIN_WAKE_WORD_MODELS = ['hey_jarvis', 'alexa', 'hey_mycroft', 'hey_rhasspy'] as const;
export type BuiltinWakeWordModel = (typeof BUILTIN_WAKE_WORD_MODELS)[number];

export interface OpenWakeWordModelPaths {
  melspectrogram: string;
  embedding: string;
  wakeWord: string;
}

/** Paths to the bundled models; `wakeWord` is a builtin name or a path to a custom .onnx model. */
export function resolveOpenWakeWordModelPaths(assetsDirectory: string, wakeWord: string): OpenWakeWordModelPaths {
  const builtin = (BUILTIN_WAKE_WORD_MODELS as readonly string[]).includes(wakeWord);
  return {
    melspectrogram: path.join(assetsDirectory, 'melspectrogram.onnx'),
    embedding: path.join(assetsDirectory, 'embedding_model.onnx'),
    wakeWord: builtin ? path.join(assetsDirectory, `${wakeWord}_v0.1.onnx`) : wakeWord,
  };
}

export class OpenWakeWordDetector {
  private rawHistory = new Int16Array(0);
  private melFrames: Float32Array[] = [];
  private embeddings: Float32Array[] = [];
  private framesProcessed = 0;

  private constructor(
    private readonly melspec: ort.InferenceSession,
    private readonly embedding: ort.InferenceSession,
    private readonly wakeWord: ort.InferenceSession,
    private readonly wakeWordInputFrames: number,
  ) {}

  static async create(paths: OpenWakeWordModelPaths): Promise<OpenWakeWordDetector> {
    const options: ort.InferenceSession.SessionOptions = { intraOpNumThreads: 1, interOpNumThreads: 1 };
    const [melspec, embedding, wakeWord] = await Promise.all([
      ort.InferenceSession.create(paths.melspectrogram, options),
      ort.InferenceSession.create(paths.embedding, options),
      ort.InferenceSession.create(paths.wakeWord, options),
    ]);
    const inputFrames = wakeWordInputFrames(wakeWord);
    const detector = new OpenWakeWordDetector(melspec, embedding, wakeWord, inputFrames);
    await detector.reset();
    return detector;
  }

  /** Clear all audio history, as if the detector had just been created. */
  async reset(): Promise<void> {
    this.rawHistory = new Int16Array(0);
    this.melFrames = Array.from({ length: EMBEDDING_WINDOW }, () => new Float32Array(MEL_BINS).fill(1));
    this.framesProcessed = 0;
    // Like openWakeWord, start the embedding history from 10 s of silence.
    const silenceMel = await this.melspectrogram(new Int16Array(OWW_SAMPLE_RATE * 10));
    this.embeddings = [];
    for (let start = 0; start + EMBEDDING_WINDOW <= silenceMel.length; start += EMBEDDING_STEP) {
      this.embeddings.push(await this.embed(silenceMel.slice(start, start + EMBEDDING_WINDOW)));
    }
    this.embeddings = this.embeddings.slice(-MAX_EMBEDDINGS);
  }

  /** Feed one 80 ms frame (1280 samples of 16 kHz int16 audio); returns the wake-word score 0..1. */
  async process(frame: Int16Array): Promise<number> {
    if (frame.length !== OWW_FRAME_LENGTH) {
      throw new Error(`openWakeWord expects ${OWW_FRAME_LENGTH}-sample frames, got ${frame.length}.`);
    }

    const history = new Int16Array(this.rawHistory.length + frame.length);
    history.set(this.rawHistory);
    history.set(frame, this.rawHistory.length);
    this.rawHistory = history.slice(-(OWW_FRAME_LENGTH + MEL_CONTEXT_SAMPLES));

    this.melFrames.push(...(await this.melspectrogram(this.rawHistory)));
    if (this.melFrames.length > MAX_MEL_FRAMES) {
      this.melFrames = this.melFrames.slice(-MAX_MEL_FRAMES);
    }

    this.embeddings.push(await this.embed(this.melFrames.slice(-EMBEDDING_WINDOW)));
    if (this.embeddings.length > MAX_EMBEDDINGS) {
      this.embeddings = this.embeddings.slice(-MAX_EMBEDDINGS);
    }

    const score = await this.score();
    this.framesProcessed += 1;
    return this.framesProcessed <= WARMUP_FRAMES ? 0 : score;
  }

  async release(): Promise<void> {
    await Promise.all([this.melspec.release(), this.embedding.release(), this.wakeWord.release()]);
  }

  private async melspectrogram(samples: Int16Array): Promise<Float32Array[]> {
    const input = Float32Array.from(samples);
    const output = await runSingle(this.melspec, new ort.Tensor('float32', input, [1, input.length]));
    const data = output.data as Float32Array;
    const frames: Float32Array[] = [];
    for (let offset = 0; offset + MEL_BINS <= data.length; offset += MEL_BINS) {
      // openWakeWord's transform to match Google's TF speech_embedding preprocessing.
      frames.push(data.slice(offset, offset + MEL_BINS).map((value) => value / 10 + 2));
    }
    return frames;
  }

  private async embed(window: Float32Array[]): Promise<Float32Array> {
    const input = new Float32Array(EMBEDDING_WINDOW * MEL_BINS);
    window.forEach((frame, index) => input.set(frame, index * MEL_BINS));
    const output = await runSingle(this.embedding, new ort.Tensor('float32', input, [1, EMBEDDING_WINDOW, MEL_BINS, 1]));
    return Float32Array.from(output.data as Float32Array);
  }

  private async score(): Promise<number> {
    const recent = this.embeddings.slice(-this.wakeWordInputFrames);
    const input = new Float32Array(this.wakeWordInputFrames * EMBEDDING_SIZE);
    recent.forEach((embedding, index) => input.set(embedding, index * EMBEDDING_SIZE));
    const output = await runSingle(
      this.wakeWord,
      new ort.Tensor('float32', input, [1, this.wakeWordInputFrames, EMBEDDING_SIZE]),
    );
    return (output.data as Float32Array)[0] ?? 0;
  }
}

async function runSingle(session: ort.InferenceSession, input: ort.Tensor): Promise<ort.Tensor> {
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) {
    throw new Error('openWakeWord model has no inputs or outputs.');
  }
  const outputs = await session.run({ [inputName]: input });
  const output = outputs[outputName];
  if (!output) {
    throw new Error(`openWakeWord model did not return ${outputName}.`);
  }
  return output;
}

/** Number of embedding frames the wake-word model looks at (16 for the stock models). */
function wakeWordInputFrames(session: ort.InferenceSession): number {
  const metadata = session.inputMetadata?.[0] as { shape?: readonly unknown[] } | undefined;
  const frames = metadata?.shape?.[1];
  return typeof frames === 'number' && frames > 0 ? frames : 16;
}
