/** Worker-thread entry: runs the atlas pixel work off the Electron main thread. */
import { parentPort } from 'node:worker_threads';
import { assembleRetexturedVrm, layoutSimilarity, prepareRegions } from './vrm-retexture.js';
import type { RetextureTask } from './retexture-tasks.js';

function runTask(task: RetextureTask): unknown {
  switch (task.kind) {
    case 'prepare':
      return prepareRegions(Buffer.from(task.vrm));
    case 'assemble':
      return assembleRetexturedVrm(
        Buffer.from(task.vrm),
        task.edited.map((region) => ({ box: region.box, png: Buffer.from(region.png) })),
        task.title,
      );
    case 'score':
      return layoutSimilarity(Buffer.from(task.original), Buffer.from(task.repainted));
  }
}

parentPort?.on('message', (task: RetextureTask) => {
  try {
    parentPort?.postMessage({ ok: true, result: runTask(task) });
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
