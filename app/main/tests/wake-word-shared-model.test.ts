import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInside, readSharedWakeWord } from '../src/wake-word/shared-model.js';
import type { WakeWordConfig } from '../src/config/config-manager.js';

const BASE = { keywordLabel: 'Hey Kev', threshold: 0.5, cooldownMs: 1500 };

describe('wake-word:model', () => {
  let directory: string;
  let trained: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'wake-share-'));
    trained = path.join(directory, 'wake-words');
    await mkdir(trained, { recursive: true });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('sends only the settings for a built-in model (it ships with the app on every PC)', async () => {
    const config: WakeWordConfig = { ...BASE, model: 'hey_echo', deviceIndex: 3 };
    expect(await readSharedWakeWord(config, trained)).toEqual({ model: 'hey_echo', ...BASE });
  });

  it('sends the file of a trained model inside the trained folder', async () => {
    const file = path.join(trained, 'hey-kev.onnx');
    await writeFile(file, Buffer.from([9, 8, 7]));
    const answer = await readSharedWakeWord({ ...BASE, model: file }, trained);
    expect(answer?.model).toBe('hey-kev.onnx');
    expect(Array.from(answer?.bytes ?? [])).toEqual([9, 8, 7]);
    expect(answer).toMatchObject(BASE);
  });

  it('never sends a file outside the trained folder, a non-onnx file, an empty file or a missing one', async () => {
    const outside = path.join(directory, 'secret.onnx');
    await writeFile(outside, Buffer.from([1]));
    expect(await readSharedWakeWord({ ...BASE, model: outside }, trained)).toBeNull();
    expect(await readSharedWakeWord({ ...BASE, model: path.join(trained, '..', 'secret.onnx') }, trained)).toBeNull();
    const text = path.join(trained, 'notes.txt');
    await writeFile(text, 'x');
    expect(await readSharedWakeWord({ ...BASE, model: text }, trained)).toBeNull();
    const empty = path.join(trained, 'empty.onnx');
    await writeFile(empty, '');
    expect(await readSharedWakeWord({ ...BASE, model: empty }, trained)).toBeNull();
    expect(await readSharedWakeWord({ ...BASE, model: path.join(trained, 'missing.onnx') }, trained)).toBeNull();
    expect(await readSharedWakeWord({ ...BASE, model: '/etc/passwd' }, trained)).toBeNull();
  });

  it('isInside is strict', () => {
    expect(isInside('/a/b', '/a/b/c.onnx')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(false);
    expect(isInside('/a/b', '/a/bc/c.onnx')).toBe(false);
    expect(isInside('/a/b', '/a/b/../c.onnx')).toBe(false);
  });
});
