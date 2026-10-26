/**
 * Runs the retexture pixel work in a worker thread so decoding and encoding 4096² PNGs doesn't
 * freeze the Electron main process.
 */
import { Worker } from 'node:worker_threads';
import {
  assembleRetexturedVrm,
  layoutSimilarity,
  prepareRegions,
  type EditedRegion,
  type PreparedRegion,
} from './vrm-retexture.js';

export type RetextureTask =
  | { kind: 'prepare'; vrm: Uint8Array }
  | { kind: 'assemble'; vrm: Uint8Array; edited: EditedRegion[]; title?: string }
  | { kind: 'score'; original: Uint8Array; repainted: Uint8Array };

export interface RetextureRunner {
  prepare(vrm: Buffer): Promise<PreparedRegion[]>;
  assemble(vrm: Buffer, edited: EditedRegion[], title?: string): Promise<Buffer>;
  /** How well a repainted crop kept the original's layout (see `layoutSimilarity`). */
  score(original: Buffer, repainted: Buffer): Promise<number>;
}

/** Same work on the calling thread; for tests and scripts. */
export const inlineRetextureRunner: RetextureRunner = {
  prepare: async (vrm) => prepareRegions(vrm),
  assemble: async (vrm, edited, title) => assembleRetexturedVrm(vrm, edited, title),
  score: async (original, repainted) => layoutSimilarity(original, repainted),
};

function runInWorker<T>(task: RetextureTask): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(new URL('./retexture-worker.js', import.meta.url));
    let settled = false;
    worker.once('message', (message: { ok: boolean; result?: T; error?: string }) => {
      settled = true;
      void worker.terminate();
      if (message.ok) {
        resolve(message.result as T);
      } else {
        reject(new Error(message.error ?? 'Retexture worker failed.'));
      }
    });
    worker.once('error', (error) => {
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (!settled) {
        reject(new Error(`Retexture worker exited with code ${code}.`));
      }
    });
    worker.postMessage(task);
  });
}

export const workerRetextureRunner: RetextureRunner = {
  async prepare(vrm) {
    const regions = await runInWorker<PreparedRegion[]>({ kind: 'prepare', vrm });
    return regions.map((region) => ({ ...region, png: Buffer.from(region.png) }));
  },
  async assemble(vrm, edited, title) {
    const bytes = await runInWorker<Uint8Array>({ kind: 'assemble', vrm, edited, title });
    return Buffer.from(bytes);
  },
  score(original, repainted) {
    return runInWorker<number>({ kind: 'score', original, repainted });
  },
};
