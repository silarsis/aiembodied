import { build } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
const work = '.dev-home/face-runtime-review';
await mkdir(work, { recursive: true });
await build({
  configFile: false,
  build: {
    outDir: work,
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: 'scripts/avatar-face-demo/review-render.js',
      formats: ['iife'],
      name: 'FaceReview',
      fileName: () => 'review.js',
    },
  },
});
await writeFile(
  work + '/index.html',
  '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' blob: data:; script-src \'self\'"><title>Local face runtime verification</title></head><body><script src="review.js"></script></body></html>',
);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const executable =
  process.platform === 'win32'
    ? 'app/main/node_modules/electron/dist/electron.exe'
    : 'app/main/node_modules/electron/dist/electron';
const child = spawn(path.resolve(executable), [path.resolve('scripts/avatar-face-demo')], {
  env,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('error', (error) => {
  throw error;
});
child.on('exit', (code) => {
  process.exitCode = code;
});
