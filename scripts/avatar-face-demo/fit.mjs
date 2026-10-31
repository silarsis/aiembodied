import { spawn } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const output = path.resolve(process.env.FACE_DEMO_OUTPUT || 'artifacts/local-face-mvp-2026-10-31');
const faceRoot = path.resolve(process.env.AVATAR_FACE_DIR || 'services/avatar-face');
const python =
  process.env.AVATAR_FACE_PYTHON ||
  path.join(faceRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const model = process.env.AVATAR_FACE_MODEL || path.join(faceRoot, 'models/face_landmarker.task');
const blender =
  process.env.BLENDER_EXE || 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe';
async function run(command, args, log) {
  let text = '';
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    child.stdout.on('data', (data) => (text += data));
    child.stderr.on('data', (data) => (text += data));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(text))));
  });
  await writeFile(log, text);
  return text;
}
for (const id of ['ada', 'malik', 'mei', 'oscar', 'ines']) {
  const directory = path.join(output, id);
  await mkdir(directory, { recursive: true });
  const deadline = Date.now() + 30 * 60_000;
  while (
    !(await access(path.join(directory, 'source.glb'))
      .then(() => true)
      .catch(() => false))
  ) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + id + ' geometry');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.log('FITTING', id);
  await run(
    python,
    [
      path.join(root, 'app/main/assets/avatar-generation/face-landmarks.py'),
      '--image',
      path.join(directory, 'concept.png'),
      '--model',
      model,
      '--output',
      path.join(directory, 'face-landmarks.json'),
    ],
    path.join(directory, 'landmarks.log'),
  );
  const log = await run(
    blender,
    [
      '-b',
      '--factory-startup',
      '-t',
      '4',
      '-P',
      path.join(root, 'app/main/assets/avatar-generation/rig-character.py'),
      '--',
      '--input',
      path.join(directory, 'source.glb'),
      '--output',
      path.join(directory, 'avatar.vrm'),
      '--name',
      id,
      '--reference',
      path.join(directory, 'concept.png'),
      '--landmarks',
      path.join(directory, 'face-landmarks.json'),
      '--emotion-renders',
    ],
    path.join(directory, 'rig.log'),
  );
  if (!log.includes('CHARACTER_READY'))
    throw new Error('Blender did not finish fitting ' + id + ': ' + log.slice(-2000));
  console.log('FITTED', id);
}
