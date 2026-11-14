/**
 * `wake-word:model`: what a satellite PC asks bija for before it starts its own wake word worker. It answers with the
 * wake word picked on bija (its settings) and, for a trained model, the .onnx file. A built-in model ships with the
 * app on every PC, so only its name goes over. A model that is not a built-in name or a file inside the trained
 * models folder is never read: a satellite must not be able to make bija send any file.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WakeWordConfig } from '../config/config-manager.js';
import { BUILTIN_WAKE_WORD_MODELS } from './open-wake-word.js';

/** A wake word model is a few hundred kilobytes; anything much bigger is not one. */
export const MAX_SHARED_MODEL_BYTES = 16 * 1024 * 1024;

export interface SharedWakeWordAnswer {
  model: string;
  keywordLabel: string;
  threshold: number;
  cooldownMs: number;
  /** The trained model's .onnx file. The link carries bytes as they are. */
  bytes?: Uint8Array;
}

/** True when `candidate` is a file path inside `directory` (not the directory itself, no `..` escape). */
export function isInside(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Null when the picked model cannot be shared (outside the trained folder, not .onnx, too big, unreadable). */
export async function readSharedWakeWord(config: WakeWordConfig, trainedDirectory: string): Promise<SharedWakeWordAnswer | null> {
  const base = { keywordLabel: config.keywordLabel, threshold: config.threshold, cooldownMs: config.cooldownMs };
  if ((BUILTIN_WAKE_WORD_MODELS as readonly string[]).includes(config.model)) return { model: config.model, ...base };
  if (!config.model.toLowerCase().endsWith('.onnx') || !isInside(trainedDirectory, config.model)) return null;
  try {
    const info = await stat(config.model);
    if (!info.isFile() || info.size === 0 || info.size > MAX_SHARED_MODEL_BYTES) return null;
    const bytes = await readFile(config.model);
    return { model: path.basename(config.model), ...base, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  } catch {
    return null;
  }
}
