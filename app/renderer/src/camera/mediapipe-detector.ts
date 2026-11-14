/**
 * The real face detector: MediaPipe's FaceDetector with the BlazeFace short-range model.
 *
 * Nothing is fetched from the internet while the app runs. The model sits in `public/models/` (Apache-2.0, see the
 * README next to it) and the tasks-vision WASM files are copied from node_modules into `mediapipe/wasm/` by the
 * Vite plugin in vite.config.ts. The library is imported when the camera first starts, so it adds nothing to the
 * start-up of a PC that never turns the camera on.
 */
import type { FaceDetectorLike, VideoLike } from './face-presence.js';

export const FACE_MODEL_PATH = 'models/blaze_face_short_range.tflite';
export const FACE_WASM_PATH = 'mediapipe/wasm';
/** A face needs at least this much confidence to count. */
export const MIN_FACE_CONFIDENCE = 0.6;

/** Where a bundled file lives, relative to the page (works from a file:// page in the packaged app and from the dev server). */
export function assetUrl(path: string, base: string = typeof document === 'undefined' ? 'http://localhost/' : document.baseURI): string {
  return new URL(path, base).href;
}

/** Reads a bundled file. XMLHttpRequest, because `fetch` does not read file:// URLs in a packaged Electron page. */
export function readBytes(url: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', url);
    request.responseType = 'arraybuffer';
    request.onload = () => {
      // A file:// read reports status 0 on success.
      if ((request.status === 0 || (request.status >= 200 && request.status < 300)) && request.response instanceof ArrayBuffer && request.response.byteLength > 0) {
        resolve(new Uint8Array(request.response));
      } else {
        reject(new Error(`could not read ${url} (status ${request.status})`));
      }
    };
    request.onerror = () => reject(new Error(`could not read ${url}`));
    request.send();
  });
}

export async function createMediapipeDetector(): Promise<FaceDetectorLike> {
  let model: Uint8Array;
  try {
    model = await readBytes(assetUrl(FACE_MODEL_PATH));
  } catch (error) {
    throw new Error(`the face model is missing (${error instanceof Error ? error.message : String(error)}); run "node scripts/fetch-face-model.mjs"`);
  }
  const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(assetUrl(FACE_WASM_PATH));
  const make = (delegate: 'GPU' | 'CPU') =>
    FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: model, delegate },
      runningMode: 'VIDEO',
      minDetectionConfidence: MIN_FACE_CONFIDENCE,
    });
  let detector: Awaited<ReturnType<typeof make>>;
  try {
    detector = await make('GPU');
  } catch {
    // No usable WebGL: the CPU path is slower but 2 frames a second is easy for it.
    detector = await make('CPU');
  }
  let last = 0;
  return {
    countFaces: (video: VideoLike, timestampMs: number) => {
      // MediaPipe wants strictly increasing timestamps.
      last = Math.max(last + 1, Math.round(timestampMs));
      return detector.detectForVideo(video as unknown as HTMLVideoElement, last).detections.length;
    },
    close: () => detector.close(),
  };
}
