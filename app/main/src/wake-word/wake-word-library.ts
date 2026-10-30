/**
 * The wake words the Settings page offers: the bundled models, plus the ones trained in the app
 * (an .onnx file with a .json description beside it, in `<userData>/wake-words`).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BUILTIN_WAKE_WORD_MODELS } from './open-wake-word.js';
import type { WakeWordOption, WakeWordTrainingMetrics } from './types.js';

/** "hey_echo_v0.1.onnx" or "hey_echo" -> "Hey Echo". */
export function wakeWordLabel(model: string): string {
  return path
    .basename(model)
    .replace(/\.onnx$/i, '')
    .replace(/_v\d+(\.\d+)*$/, '')
    .split(/[_\s-]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

interface TrainedModelMetadata {
  phrase?: unknown;
  trainedAt?: unknown;
  quick?: unknown;
  metrics?: Record<string, unknown>;
}

function readMetrics(raw: Record<string, unknown> | undefined): WakeWordTrainingMetrics | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const metrics: WakeWordTrainingMetrics = {};
  for (const key of ['accuracy', 'recall', 'falsePositivesPerHour'] as const) {
    if (typeof raw[key] === 'number') {
      metrics[key] = raw[key];
    }
  }
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

export async function listTrainedWakeWords(directory: string): Promise<WakeWordOption[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return [];
  }
  const options: WakeWordOption[] = [];
  for (const name of names.filter((file) => file.toLowerCase().endsWith('.onnx')).sort()) {
    const model = path.join(directory, name);
    let metadata: TrainedModelMetadata = {};
    try {
      metadata = JSON.parse(await fs.readFile(model.replace(/\.onnx$/i, '.json'), 'utf8')) as TrainedModelMetadata;
    } catch {
      // A model copied in by hand has no description; its file name still gives a label.
    }
    const phrase = typeof metadata.phrase === 'string' && metadata.phrase.trim() ? metadata.phrase.trim() : undefined;
    const metrics = readMetrics(metadata.metrics);
    options.push({
      model,
      label: phrase ? phrase.replace(/\b\w/g, (letter) => letter.toUpperCase()) : wakeWordLabel(name),
      source: 'trained',
      ...(phrase ? { phrase } : {}),
      ...(typeof metadata.trainedAt === 'string' ? { trainedAt: metadata.trainedAt } : {}),
      ...(metadata.quick === true ? { quick: true } : {}),
      ...(metrics ? { metrics } : {}),
    });
  }
  return options;
}

export async function listWakeWords(trainedDirectory: string): Promise<WakeWordOption[]> {
  const builtins: WakeWordOption[] = BUILTIN_WAKE_WORD_MODELS.map((model) => ({
    model,
    label: wakeWordLabel(model),
    source: 'builtin',
  }));
  return [...builtins, ...(await listTrainedWakeWords(trainedDirectory))];
}
