import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root = path.resolve(process.env.AVATAR_FACE_DIR || 'services/avatar-face');
const python = path.join(
  root,
  '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Setup failed (${code}).`)),
    );
  });
}
await mkdir(root, { recursive: true });
await run(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [
  '-m',
  'venv',
  path.join(root, '.venv'),
]);
await run(python, [
  '-m',
  'pip',
  'install',
  '-r',
  path.resolve('services/avatar-face/requirements.txt'),
]);
await mkdir(path.join(root, 'models'), { recursive: true });
const file = path.join(root, 'models/face_landmarker.task');
const expected = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';
let bytes = await readFile(file).catch(() => null);
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
  const response = await fetch(
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  );
  if (!response.ok) throw new Error(`Model download failed (${response.status}).`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Face model checksum mismatch.');
  await writeFile(file, bytes);
}
console.log('Local avatar face fitting is ready. Inference does not require a network connection.');
