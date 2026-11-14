#!/usr/bin/env node
/**
 * Downloads the BlazeFace short-range face model that camera presence uses (Apache-2.0, see
 * app/renderer/public/models/README.md). The file is already committed; run this only if it went missing.
 * Node's fetch ignores HTTPS_PROXY, so behind a proxy run: NODE_USE_ENV_PROXY=1 node scripts/fetch-face-model.mjs
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../app/renderer/public/models/blaze_face_short_range.tflite');

const have = await stat(target).catch(() => null);
if (have && have.size > 100_000) {
  console.log(`The face model is already there (${have.size} bytes).`);
  process.exit(0);
}
const response = await fetch(URL_);
if (!response.ok) {
  console.error(`Could not download the face model: HTTP ${response.status}`);
  process.exit(1);
}
const bytes = new Uint8Array(await response.arrayBuffer());
// A TFLite file has "TFL3" at byte 4.
if (bytes.length < 100_000 || String.fromCharCode(...bytes.subarray(4, 8)) !== 'TFL3') {
  console.error('The download is not a TFLite model.');
  process.exit(1);
}
await mkdir(dirname(target), { recursive: true });
await writeFile(target, bytes);
console.log(`Saved the face model (${bytes.length} bytes) to ${target}`);
