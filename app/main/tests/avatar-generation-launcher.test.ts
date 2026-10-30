import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  ComfyUILauncher,
  findComfyDesktopCommand,
  resolveComfyStartCommand,
} from '../src/avatar/generation/comfyui-launcher.js';
import { chooseQwenImageModels } from '../src/avatar/generation/comfyui-models.js';

function fakeChild(pid = 4321) {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', { value: pid });
  return child;
}

const command = { file: 'python.exe', args: ['main.py'], cwd: 'C:\\comfy' };

describe('ComfyUILauncher', () => {
  it('leaves a ComfyUI that is already running alone', async () => {
    const spawnFn = vi.fn();
    const killTree = vi.fn();
    const launcher = new ComfyUILauncher({
      baseUrl: 'http://127.0.0.1:8188',
      isAvailable: vi.fn().mockResolvedValue(true),
      command,
      spawnFn,
      killTree,
    });
    await launcher.ensureRunning();
    launcher.stop();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(killTree).not.toHaveBeenCalled();
  });

  it('starts ComfyUI, waits for it to answer, and kills it on stop', async () => {
    const isAvailable = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const spawnFn = vi.fn(() => fakeChild());
    const killTree = vi.fn();
    const launcher = new ComfyUILauncher({
      baseUrl: 'http://127.0.0.1:8188',
      isAvailable,
      command,
      spawnFn,
      killTree,
      sleep: async () => undefined,
    });
    await launcher.ensureRunning();
    expect(spawnFn).toHaveBeenCalledWith('python.exe', ['main.py'], expect.objectContaining({ cwd: 'C:\\comfy', windowsHide: true }));
    expect(launcher.started).toBe(true);
    launcher.stop();
    expect(killTree).toHaveBeenCalledWith(4321);
    expect(launcher.started).toBe(false);
  });

  it('reports a server that exits while starting', async () => {
    const child = fakeChild();
    const launcher = new ComfyUILauncher({
      baseUrl: 'http://127.0.0.1:8188',
      isAvailable: vi.fn().mockResolvedValue(false),
      command,
      spawnFn: vi.fn(() => child),
      killTree: vi.fn(),
      logPath: '/tmp/comfy-launcher-test/comfyui.log',
      sleep: async () => {
        child.emit('exit', 1);
      },
    });
    await expect(launcher.ensureRunning()).rejects.toThrow(/exited while starting. See \/tmp\/comfy-launcher-test\/comfyui.log/);
  });

  it('explains how to get ComfyUI when it cannot be started', async () => {
    const launcher = new ComfyUILauncher({
      baseUrl: 'http://127.0.0.1:8188',
      isAvailable: vi.fn().mockResolvedValue(false),
      command: null,
    });
    expect(launcher.canStart).toBe(false);
    await expect(launcher.ensureRunning()).rejects.toThrow(/COMFYUI_START_COMMAND/);
  });
});

describe('ComfyUI start command', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\kevin\\AppData\\Local', APPDATA: 'C:\\Users\\kevin\\AppData\\Roaming' };
  const root = 'C:\\Users\\kevin\\AppData\\Local\\Comfy-Desktop';

  it("finds Comfy Desktop's install and starts it headless like slopcore", () => {
    const files = new Set([
      `${root}\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\.venv\\Scripts\\python.exe`,
      `${root}\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\main.py`,
      `${root}\\ComfyUI-Shared\\input`,
      `${root}\\ComfyUI-Shared\\output`,
    ]);
    const found = findComfyDesktopCommand(
      env,
      'http://127.0.0.1:8188',
      (file) => files.has(file),
      () => ['ComfyUI'],
      () => 'C:\\paths.yaml',
    );
    expect(found).toEqual({
      file: `${root}\\ComfyUI-Installs\\ComfyUI\\ComfyUI\\.venv\\Scripts\\python.exe`,
      cwd: `${root}\\ComfyUI-Installs\\ComfyUI`,
      args: [
        '-s', 'ComfyUI\\main.py', '--listen', '127.0.0.1', '--port', '8188',
        '--enable-assets', '--enable-manager', '--disable-dynamic-vram',
        '--extra-model-paths-config', 'C:\\paths.yaml',
        '--input-directory', `${root}\\ComfyUI-Shared\\input`,
        '--output-directory', `${root}\\ComfyUI-Shared\\output`,
      ],
    });
  });

  it('returns null without a Comfy Desktop install', () => {
    expect(findComfyDesktopCommand(env, 'http://127.0.0.1:8188', () => false, () => [])).toBeNull();
  });

  it('prefers COMFYUI_START_COMMAND, and never starts a remote or switched-off ComfyUI', () => {
    expect(resolveComfyStartCommand({ COMFYUI_START_COMMAND: 'run-comfy.bat' }, 'http://127.0.0.1:8188', 'linux')).toEqual({
      file: 'run-comfy.bat',
      args: [],
      cwd: undefined,
      shell: true,
    });
    expect(resolveComfyStartCommand({ COMFYUI_START_COMMAND: 'x' }, 'http://10.0.0.5:8188', 'win32')).toBeNull();
    expect(resolveComfyStartCommand({ COMFYUI_START_COMMAND: 'x', COMFYUI_AUTOSTART: '0' }, 'http://127.0.0.1:8188')).toBeNull();
    expect(resolveComfyStartCommand({}, 'http://127.0.0.1:8188', 'linux')).toBeNull();
  });
});

describe('chooseQwenImageModels', () => {
  it('uses the default files when they are installed', () => {
    const { models, missing } = chooseQwenImageModels({
      diffusion_models: ['qwen_image_2.1_bf16.safetensors', 'qwen_image_2.1_int8_convrot.safetensors'],
      text_encoders: ['qwen3vl_8b_int8_convrot.safetensors'],
      vae: ['qwen_image_2.1_vae_bf16.safetensors'],
    });
    expect(missing).toEqual([]);
    expect(models).toEqual({
      unet: 'qwen_image_2.1_int8_convrot.safetensors',
      clip: 'qwen3vl_8b_int8_convrot.safetensors',
      vae: 'qwen_image_2.1_vae_bf16.safetensors',
    });
  });

  it('otherwise picks the lightest Qwen-Image 2.1 variant, from subfolders and the old folder names too', () => {
    const { models, missing } = chooseQwenImageModels({
      unet: ['Qwen\\qwen_image_2.1_bf16.safetensors', 'Qwen\\qwen_image_2.1_fp8_e4m3fn.safetensors', 'qwen_image_2.1-Q4_K.gguf'],
      clip: ['qwen3vl_8b_fp8_scaled.safetensors', 'qwen3vl_8b_bf16.safetensors'],
      vae: ['qwen_image_2.1_vae.safetensors'],
    });
    expect(missing).toEqual([]);
    expect(models.unet).toBe('Qwen\\qwen_image_2.1_fp8_e4m3fn.safetensors');
    expect(models.clip).toBe('qwen3vl_8b_fp8_scaled.safetensors');
    expect(models.vae).toBe('qwen_image_2.1_vae.safetensors');
  });

  it('lists the parts that are missing', () => {
    const { missing } = chooseQwenImageModels({ diffusion_models: ['flux1-dev.safetensors', 'qwen_image_2.1_lightning_lora.safetensors'] });
    expect(missing).toEqual([
      'diffusion model (models/diffusion_models)',
      'text encoder (models/text_encoders)',
      'VAE (models/vae)',
    ]);
  });
});
