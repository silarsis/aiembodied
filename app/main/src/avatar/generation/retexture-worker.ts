/** Worker-thread entry: runs the atlas pixel work off the Electron main thread. */
import { parentPort } from 'node:worker_threads';
import { assembleRetexturedVrm, prepareRegions } from './vrm-retexture.js';
import type { RetextureTask } from './retexture-tasks.js';

parentPort?.on('message', (task: RetextureTask) => {
  try {
    const vrm = Buffer.from(task.vrm);
    const result =
      task.kind === 'prepare'
        ? prepareRegions(vrm)
        : assembleRetexturedVrm(
            vrm,
            task.edited.map((region) => ({ box: region.box, png: Buffer.from(region.png) })),
            task.title,
          );
    parentPort?.postMessage({ ok: true, result });
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
