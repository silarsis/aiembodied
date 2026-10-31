import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MemoryStore } from '../../memory/index.js';
import { resolveComfyInstallation } from './comfyui-runtime.js';
import type { ImageFamily, ImageWorkflowModel } from './image-workflows.js';
import type { AvatarImageModelSelection, AvatarImageModelSummary } from '../types.js';

export interface ImageModelFile {
  folder: string;
  name: string;
  kind: string;
  title?: string;
  embeddedVae?: boolean;
  embeddedClip?: boolean;
  embeddedClip2?: boolean;
}
export function createImageModelScanner(
  scriptPath: string,
  baseUrl: string,
): () => Promise<ImageModelFile[]> {
  return async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(baseUrl).hostname)) {
      throw new Error(
        'Automatic image-model discovery currently needs ComfyUI on this computer. Image upload remains available.',
      );
    }
    const { python, directory, modelPaths, env } = await resolveComfyInstallation();
    const { stdout } = await promisify(execFile)(
      python,
      [scriptPath, '--comfy-dir', directory, ...(modelPaths ? ['--model-paths', modelPaths] : [])],
      {
        env: { ...env, PYTHONDONTWRITEBYTECODE: '1' },
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const files: unknown = JSON.parse(stdout);
    if (
      !Array.isArray(files) ||
      files.some(
        (file: unknown) =>
          !file ||
          typeof file !== 'object' ||
          !('name' in file) ||
          typeof file.name !== 'string' ||
          !('kind' in file) ||
          typeof file.kind !== 'string' ||
          !('folder' in file) ||
          typeof file.folder !== 'string',
      )
    )
      throw new Error('Could not read the installed image models.');
    return files as ImageModelFile[];
  };
}

const FAMILIES = new Set<ImageFamily>(['qwen-image-2.1', 'z-image-turbo', 'sdxl', 'sd1']);
interface Entry {
  model: ImageWorkflowModel;
  summary: AvatarImageModelSummary;
}

/** Installed files determine the choices; only a known compatible family can execute a job. */
export class AvatarImageModelService {
  private entries: Entry[] = [];
  private pending: Promise<void> | null = null;
  private selected: string | null = null;
  constructor(
    private readonly scan: () => Promise<ImageModelFile[]>,
    private readonly store?: Pick<MemoryStore, 'getValue' | 'setValue'>,
  ) {}

  private async refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.scan()
      .then((files) => {
        const find = (kind: string, preferred: string) =>
          files.find((file) => file.kind === kind && file.name === preferred)?.name ??
          files.filter((file) => file.kind === kind).sort((a, b) => a.name.localeCompare(b.name))[0]
            ?.name;
        this.entries = files
          .filter(
            (file) =>
              FAMILIES.has(file.kind as ImageFamily) &&
              file.folder ===
                (file.kind === 'sdxl' || file.kind === 'sd1' ? 'checkpoints' : 'diffusion_models'),
          )
          .map((file): Entry => {
            const family = file.kind as ImageFamily;
            const stem = file.name.replace(/\.safetensors$/i, '').replaceAll('_', ' ');
            const name = stem[0].toUpperCase() + stem.slice(1);
            const model: ImageWorkflowModel = {
              id: `${file.folder}:${file.name}`,
              name,
              family,
              model: file.name,
            };
            let reason: string | undefined;
            if (family === 'qwen-image-2.1') {
              model.clip = find('qwen3-vl', 'qwen3vl_8b_int8_convrot.safetensors');
              model.vae = find('qwen-image-vae', 'qwen_image_2.1_vae_bf16.safetensors');
              if (!model.clip || !model.vae)
                reason = 'Required supporting models are not installed.';
            } else if (family === 'z-image-turbo') {
              model.clip = find('qwen3-4b', 'qwen_3_4b.safetensors');
              model.vae = find('flux-ae', 'ae.safetensors');
              if (!model.clip || !model.vae)
                reason = 'Required supporting models are not installed.';
            } else if (
              !file.embeddedVae ||
              !file.embeddedClip ||
              (family === 'sdxl' && !file.embeddedClip2)
            ) {
              reason = 'This checkpoint is missing required supporting components.';
            }
            return {
              model,
              summary: {
                id: model.id,
                name,
                available: !reason,
                ...(reason ? { unavailableReason: reason } : {}),
              },
            };
          })
          .sort((a, b) => a.model.name.localeCompare(b.model.name));
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  private current(): string | null {
    const saved = this.store?.getValue('avatar.imageModel') ?? this.selected;
    return (
      this.entries.find((entry) => entry.model.id === saved && entry.summary.available)?.model.id ??
      this.entries.find(
        (entry) => entry.model.family === 'qwen-image-2.1' && entry.summary.available,
      )?.model.id ??
      this.entries.find((entry) => entry.summary.available)?.model.id ??
      null
    );
  }
  async list(): Promise<AvatarImageModelSelection> {
    await this.refresh();
    return {
      models: this.entries.map((entry) => ({ ...entry.summary })),
      selectedModelId: this.current(),
    };
  }
  async select(id: string): Promise<void> {
    await this.resolve(id);
    this.store?.setValue('avatar.imageModel', id);
    this.selected = id;
  }
  async resolve(id?: string): Promise<ImageWorkflowModel> {
    await this.refresh();
    const selected = id ?? this.current();
    const entry = this.entries.find((entry) => entry.model.id === selected);
    if (!entry?.summary.available)
      throw new Error(
        entry?.summary.unavailableReason ??
          'The selected image model is no longer available. Refresh the model list and choose another.',
      );
    return { ...entry.model };
  }
}
