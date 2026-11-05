// Installs the head close-up (MV-Adapter): its code, its Python packages and its weights. It runs on
// ComfyUI's Python and PyTorch, so nothing here touches ComfyUI or brings a second PyTorch.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.env.AVATAR_PAINT_DIR || 'services/avatar-paint');
const REPO = 'https://github.com/huanngzh/MV-Adapter';
const COMMIT = '4277e0018232bac82bb2c103caf0893cedb711be';
const WEIGHTS = 'mvadapter_ig2mv_sdxl.safetensors';
const WEIGHTS_SHA256 = 'e89a40d81c3977d946183c419690d62bd2d62c6b6683c683e2981776e2e17be7';

const local = process.env.AIEMBODIED_HOST_LOCALAPPDATA || process.env.LOCALAPPDATA || '';
const comfyDir = process.env.COMFYUI_DIR || path.join(local, 'Comfy-Desktop', 'ComfyUI-Installs', 'ComfyUI', 'ComfyUI');
const python = process.env.COMFYUI_PYTHON || path.join(comfyDir, '.venv', 'Scripts', 'python.exe');
if (!existsSync(python)) throw new Error(`ComfyUI's Python wasn't found at ${python}. Set COMFYUI_PYTHON.`);

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, env });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Setup failed (${code}).`))));
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

const repo = path.join(root, 'repo');
const models = path.join(root, 'models');
const deps = path.join(root, 'deps');
await mkdir(models, { recursive: true });

if (!existsSync(path.join(repo, '.git'))) {
  await run('git', ['init', '-q', repo]);
  await run('git', ['-C', repo, 'remote', 'add', 'origin', REPO]);
}
await run('git', ['-C', repo, 'fetch', '-q', '--depth', '1', 'origin', COMMIT]);
await run('git', ['-C', repo, 'checkout', '-q', 'FETCH_HEAD']);

// --no-deps: accelerate would otherwise pull a CPU PyTorch in front of ComfyUI's GPU one.
await run(python, ['-m', 'pip', 'install', '-q', '--no-deps', '--upgrade', '--target', deps, '-r', path.join(root, 'requirements.txt')]);

const env = { ...process.env, PYTHONPATH: deps };
const file = path.join(models, WEIGHTS);
if (!existsSync(file) || (await sha256(file)) !== WEIGHTS_SHA256) {
  await run(
    python,
    ['-c', `from huggingface_hub import hf_hub_download; hf_hub_download('huanngzh/mv-adapter', '${WEIGHTS}', local_dir=r'${models}', force_download=True)`],
    env,
  );
  if ((await sha256(file)) !== WEIGHTS_SHA256) throw new Error('MV-Adapter weights checksum mismatch.');
}
// SDXL's config files only (a few MB), so a checkpoint loads offline.
await run(
  python,
  [
    '-c',
    `from huggingface_hub import snapshot_download; snapshot_download('stabilityai/stable-diffusion-xl-base-1.0', local_dir=r'${path.join(models, 'sdxl-config')}', allow_patterns=['*.json', '*.txt'])`,
  ],
  env,
);
console.log('The avatar head close-up is ready. It runs without a network connection and needs an SDXL checkpoint in ComfyUI.');
