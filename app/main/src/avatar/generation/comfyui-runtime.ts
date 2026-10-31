/** Shared, on-demand server lifecycle for avatar and scenery generation. Never unloads models. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ComfyUIClient } from './comfyui-client.js';

export interface ComfyInstallation {
  directory: string;
  python: string;
  modelPaths?: string;
  env: NodeJS.ProcessEnv;
}

/** Resolve the same external installation and model paths for launching and model discovery. */
export async function resolveComfyInstallation(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ComfyInstallation> {
  const sourceEnv = environment;
  const env: NodeJS.ProcessEnv = {
    ...sourceEnv,
    LOCALAPPDATA: sourceEnv.AIEMBODIED_HOST_LOCALAPPDATA || sourceEnv.LOCALAPPDATA,
    APPDATA: sourceEnv.AIEMBODIED_HOST_APPDATA || sourceEnv.APPDATA,
    USERPROFILE: sourceEnv.AIEMBODIED_HOST_USERPROFILE || sourceEnv.USERPROFILE,
    HOME: sourceEnv.AIEMBODIED_HOST_USERPROFILE || sourceEnv.HOME,
  };
  const local = env.LOCALAPPDATA ?? path.join(env.USERPROFILE ?? '', 'AppData', 'Local');
  const install = path.join(local, 'Comfy-Desktop', 'ComfyUI-Installs', 'ComfyUI');
  const directory = env.COMFYUI_DIR || path.join(install, 'ComfyUI');
  const python = env.COMFYUI_PYTHON || path.join(directory, '.venv', 'Scripts', 'python.exe');
  if (!existsSync(path.join(directory, 'main.py')) || !existsSync(python)) {
    throw new Error(
      'ComfyUI installation not found. Install Comfy Desktop or set COMFYUI_DIR and COMFYUI_PYTHON.',
    );
  }
  let modelPaths = env.COMFYUI_MODEL_PATHS;
  if (!modelPaths && !env.COMFYUI_DIR) {
    const roaming = env.APPDATA ?? path.join(env.USERPROFILE ?? '', 'AppData', 'Roaming');
    const configs = path.join(roaming, 'Comfy Desktop', 'instance-model-paths');
    const names = await readdir(configs).catch(() => [] as string[]);
    // Avoid guessing between multiple Desktop instances with different model libraries.
    const candidates = names.filter((name) => name.endsWith('.yaml'));
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    if (candidate) modelPaths = path.join(configs, candidate);
    else
      throw new Error(
        'Set COMFYUI_MODEL_PATHS to your Comfy Desktop instance model-paths YAML file.',
      );
  }
  if (modelPaths && !existsSync(modelPaths))
    throw new Error('COMFYUI_MODEL_PATHS does not point to an existing file.');
  return { directory, python, modelPaths, env };
}

interface RuntimeOptions {
  client: Pick<ComfyUIClient, 'baseUrl' | 'isAvailable'>;
  logDirectory: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  launch?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export class ComfyUIRuntime {
  private starting: Promise<void> | null = null;

  constructor(private readonly options: RuntimeOptions) {}

  /** Concurrent requests share a single launch and readiness wait; failures can be retried. */
  ensureReady(): Promise<void> {
    if (!this.starting) {
      this.starting = this.prepare().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async prepare(): Promise<void> {
    if (await this.options.client.isAvailable()) return;
    const url = new URL(this.options.client.baseUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error(
        `ComfyUI isn't reachable at ${url.origin}. Start it on that machine or check COMFYUI_BASE_URL.`,
      );
    }
    await (this.options.launch ?? (() => this.launch(url)))();
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + (this.options.timeoutMs ?? 180_000);
    do {
      if (await this.options.client.isAvailable()) return;
      await sleep(1000);
    } while (Date.now() < deadline);
    throw new Error(
      `ComfyUI did not become ready at ${url.origin}. See ${this.options.logDirectory} for comfyui logs, then try again.`,
    );
  }

  private async launch(url: URL): Promise<void> {
    if ((this.options.platform ?? process.platform) !== 'win32') {
      throw new Error(
        'Start ComfyUI before generating images on this platform, or point COMFYUI_BASE_URL at a running server.',
      );
    }
    const { directory, python, modelPaths, env } = await resolveComfyInstallation(this.options.env);
    await mkdir(this.options.logDirectory, { recursive: true });
    const args = [
      path.join(directory, 'main.py'),
      '--listen',
      url.hostname === '[::1]' ? '::1' : url.hostname,
      '--port',
      url.port || (url.protocol === 'https:' ? '443' : '80'),
      '--disable-auto-launch',
      ...(modelPaths ? ['--extra-model-paths-config', modelPaths] : []),
    ];
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const startupErrorPath = path.join(this.options.logDirectory, 'comfyui-startup.err.log');
    await writeFile(startupErrorPath, '', 'utf8');
    const command = [
      "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; try {",
      `Start-Process -FilePath ${quote(python)}`,
      `-ArgumentList @(${args.map((arg) => quote(`"${arg}"`)).join(',')})`,
      `-WorkingDirectory ${quote(directory)} -WindowStyle Hidden`,
      `-RedirectStandardOutput ${quote(path.join(this.options.logDirectory, 'comfyui.log'))}`,
      `-RedirectStandardError ${quote(path.join(this.options.logDirectory, 'comfyui.err.log'))} | Out-Null;`,
      `} catch { $_.Exception.Message | Out-File -LiteralPath ${quote(startupErrorPath)} -Encoding utf8; exit 1 }`,
    ].join(' ');
    // Match scripts/local-services.mjs: a background service can retain inherited
    // pipes after PowerShell exits. execFile waits for those pipes and times out
    // even though the server has launched. Ignore launcher stdio and let the
    // server's redirected files carry its diagnostics. Do not detach PowerShell:
    // a venv launcher needs the hidden console created by Start-Process.
    await new Promise<void>((resolve, reject) => {
      const launcher = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(command, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, stdio: 'ignore', env, timeout: 30_000 },
      );
      launcher.once('error', () =>
        reject(
          new Error(
            `Windows could not launch ComfyUI. Check ${startupErrorPath} and your ComfyUI installation, then try again.`,
          ),
        ),
      );
      launcher.once('close', async (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        const detail = (await readFile(startupErrorPath, 'utf8').catch(() => ''))
          .replace(/^\uFEFF/, '')
          .trim()
          .slice(0, 500);
        reject(
          new Error(
            `ComfyUI could not be started${detail ? `: ${detail}` : '.'} Check ${startupErrorPath}, then try again.`,
          ),
        );
      });
    });
  }
}
