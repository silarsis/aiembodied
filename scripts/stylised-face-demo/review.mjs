// Renders each exported stylised-face VRM with three-vrm, as the app does: expressions, speech, blink, gaze.
// Usage (from the repo root): STYLISED_REVIEW_DIR=<dir with characters.json> node scripts/stylised-face-demo/review.mjs
import { build } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const work = '.dev-home/stylised-face-review';
await mkdir(work, { recursive: true });
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir: work,
    emptyOutDir: false,
    minify: false,
    lib: { entry: 'scripts/stylised-face-demo/review-render.js', formats: ['iife'], name: 'FaceReview', fileName: () => 'review.js' },
  },
});
await writeFile(
  work + '/index.html',
  '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' blob: data:; script-src \'self\'"><title>Stylised face review</title></head><body><script src="review.js"></script></body></html>',
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.env.ELECTRON_EXE || (process.platform === 'win32' ? 'app/main/node_modules/electron/dist/electron.exe' : 'app/main/node_modules/electron/dist/electron');
const child = spawn(path.resolve(executable), [path.resolve('scripts/stylised-face-demo')], { env, stdio: 'inherit', windowsHide: true });
child.on('exit', (code) => (process.exitCode = code));
