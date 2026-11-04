import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MemoryStore } from '../../memory/index.js';
import { resolveComfyInstallation } from './comfyui-runtime.js';
import type { ImageFamily, ImageWorkflowModel } from './image-workflows.js';
import { POSE_CONTROLNETS, poseSupport } from './pose-control.js';
import type { AvatarImageModelSelection, AvatarImageModelSummary, AvatarImagePoseControl, AvatarLoraChoice, AvatarLoraSummary } from '../types.js';

export interface ImageModelFile {
  folder: string;
  name: string;
  kind: string;
  title?: string;
  /** LoRAs: the family they were trained for, and what Civitai said about them. */
  family?: string;
  baseModel?: string;
  triggerWords?: string[];
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
const LORAS_KEY = 'avatar.imageLoras';

type PoseFamily = keyof typeof POSE_CONTROLNETS;
/** Installs a family's pose ControlNet on the image step's ComfyUI server. */
export interface PoseControlInstaller {
  /** The last download of that ControlNet to the image server, if any. */
  status(family: PoseFamily): { state: 'downloading' | 'done' | 'failed'; error?: string } | null;
  /** Start downloading it; false when this server can't (another machine without the add-on). */
  install(family: PoseFamily): Promise<boolean>;
}

const POSE_NOTES: Record<AvatarImagePoseControl, string> = {
  guided: 'The pose is held by an A-pose skeleton (OpenPose ControlNet).',
  installing: 'Downloading pose control. Until it is ready, the pose comes from the prompt alone.',
  failed: 'Pose control could not be downloaded, so the pose comes from the prompt alone. Choosing this model again retries.',
  unavailable: 'This ComfyUI server cannot download pose control, so the pose comes from the prompt alone.',
  prompt: 'This model follows the A-pose from the prompt.',
  none: 'No pose control for this kind of model yet. The pose comes from the prompt alone, so check the arms are clear of the body.',
};

export class AvatarImageModelService {
  private entries: Entry[] = [];
  private loras: AvatarLoraSummary[] = [];
  private chosenLoras: AvatarLoraChoice[] = [];
  private pending: Promise<void> | null = null;
  private selected: string | null = null;
  /** The installed pose ControlNet of each family. */
  private poseNets: Partial<Record<PoseFamily, string>> = {};
  /** Families whose pose ControlNet this server can't download. */
  private readonly poseUnavailable = new Set<PoseFamily>();
  constructor(
    private readonly scan: () => Promise<ImageModelFile[]>,
    private readonly store?: Pick<MemoryStore, 'getValue' | 'setValue'>,
    private readonly poseInstaller?: PoseControlInstaller,
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
            // Civitai's name when the model was downloaded through the app, else the file name.
            const name = file.title?.trim() || stem[0].toUpperCase() + stem.slice(1);
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
        this.loras = files
          .filter((file) => file.folder === 'loras' && file.kind === 'lora')
          .map((file): AvatarLoraSummary => ({
            name: file.name,
            ...(file.title ? { title: file.title } : {}),
            ...(typeof file.family === 'string' ? { family: file.family } : {}),
            ...(typeof file.baseModel === 'string' ? { baseModel: file.baseModel } : {}),
            ...(Array.isArray(file.triggerWords) ? { triggerWords: file.triggerWords.filter((word) => typeof word === 'string') } : {}),
          }))
          .sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name));
        // The app's own pose ControlNet, else any installed OpenPose ControlNet of the family.
        const nets = files.filter((file) => file.folder === 'controlnet' && file.kind === 'controlnet');
        this.poseNets = {};
        for (const family of Object.keys(POSE_CONTROLNETS) as PoseFamily[]) {
          const ofFamily = nets.filter((file) => file.family === family);
          const name =
            ofFamily.find((file) => file.name === POSE_CONTROLNETS[family].filename)?.name ??
            ofFamily.find((file) => /open_?pose/i.test(file.name))?.name;
          if (name) this.poseNets[family] = name;
        }
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
  private savedLoras(): AvatarLoraChoice[] {
    const raw = this.store?.getValue(LORAS_KEY);
    if (raw === undefined || raw === null) return this.chosenLoras;
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((entry: unknown): entry is AvatarLoraChoice => {
            const choice = entry as Partial<AvatarLoraChoice> | null;
            return typeof choice?.name === 'string' && typeof choice.strength === 'number';
          })
        : [];
    } catch {
      return [];
    }
  }
  private poseControl(family: ImageFamily): AvatarImagePoseControl {
    const support = poseSupport(family);
    if (support !== 'controlnet') return support;
    const poseFamily = family as PoseFamily;
    if (this.poseNets[poseFamily]) return 'guided';
    if (this.poseUnavailable.has(poseFamily) || !this.poseInstaller) return 'unavailable';
    return this.poseInstaller.status(poseFamily)?.state === 'failed' ? 'failed' : 'installing';
  }

  /**
   * Make sure a family's pose ControlNet is installed or on its way. Called when a model of that
   * family is chosen or installed; a failed download is tried again only when retry is set.
   */
  async ensurePoseControl(family: ImageFamily, retry = true, scanned = false): Promise<void> {
    if (poseSupport(family) !== 'controlnet' || !this.poseInstaller) return;
    const poseFamily = family as PoseFamily;
    if (!scanned) await this.refresh();
    if (this.poseNets[poseFamily]) return;
    const last = this.poseInstaller.status(poseFamily)?.state;
    if (last === 'downloading' || (last === 'failed' && !retry)) return;
    if (last === 'done') {
      // It finished after the scan that was already running; look again before downloading twice.
      await this.refresh();
      if (this.poseNets[poseFamily]) return;
    }
    if (await this.poseInstaller.install(poseFamily)) this.poseUnavailable.delete(poseFamily);
    else this.poseUnavailable.add(poseFamily);
  }

  async list(): Promise<AvatarImageModelSelection> {
    await this.refresh();
    const selectedModelId = this.current();
    const selected = this.entries.find((entry) => entry.model.id === selectedModelId);
    // The chosen model's pose control is set up without anyone having to ask for it.
    if (selected) await this.ensurePoseControl(selected.model.family, false, true).catch(() => undefined);
    const installed = new Set(this.loras.map((lora) => lora.name));
    return {
      models: this.entries.map((entry) => {
        const poseControl = this.poseControl(entry.model.family);
        return { ...entry.summary, poseControl, poseNote: POSE_NOTES[poseControl] };
      }),
      selectedModelId,
      modelFamilies: Object.fromEntries(this.entries.map((entry) => [entry.model.id, entry.model.family])),
      loras: this.loras.map((lora) => ({ ...lora })),
      selectedLoras: this.savedLoras().filter((choice) => installed.has(choice.name)),
    };
  }
  /** The LoRAs to apply (in order), kept across restarts; each only applies to a model of its family. */
  selectLoras(choices: AvatarLoraChoice[]): void {
    const clean = choices
      .filter((choice) => choice && typeof choice.name === 'string' && Number.isFinite(choice.strength))
      .slice(0, 8)
      .map((choice) => ({ name: choice.name, strength: Math.min(2, Math.max(0, choice.strength)) }));
    this.chosenLoras = clean;
    this.store?.setValue(LORAS_KEY, JSON.stringify(clean));
  }
  async select(id: string): Promise<void> {
    const model = await this.resolve(id);
    this.store?.setValue('avatar.imageModel', id);
    this.selected = id;
    await this.ensurePoseControl(model.family, true, true).catch(() => undefined);
  }
  /**
   * The Qwen-Image model that draws a character's side and back views (an image edit, which only
   * Qwen-Image does here). The take's own model is used when it is Qwen-Image, with its LoRAs.
   */
  async resolveViewModel(preferred?: ImageWorkflowModel): Promise<ImageWorkflowModel | undefined> {
    if (preferred?.family === 'qwen-image-2.1' && preferred.clip && preferred.vae) return preferred;
    await this.refresh();
    const saved = this.current();
    const qwen = this.entries.filter(
      (entry) => entry.model.family === 'qwen-image-2.1' && entry.summary.available,
    );
    const entry = qwen.find((candidate) => candidate.model.id === saved) ?? qwen[0];
    return entry ? { ...entry.model } : undefined;
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
    const loras = this.savedLoras().flatMap((choice) => {
      const lora = this.loras.find((entry) => entry.name === choice.name);
      // A LoRA of another family (or an unknown one) would fail or wreck the image; leave it out.
      if (!lora || lora.family !== entry.model.family || choice.strength <= 0) return [];
      return [{ name: lora.name, strength: choice.strength, ...(lora.triggerWords?.length ? { triggerWords: lora.triggerWords } : {}) }];
    });
    const poseControlNet = this.poseNets[entry.model.family as PoseFamily];
    return { ...entry.model, ...(loras.length ? { loras } : {}), ...(poseControlNet ? { poseControlNet } : {}) };
  }
}

/**
 * Model discovery for a ComfyUI on another machine, where the files can't be opened: ComfyUI lists
 * each model folder over HTTP, and the kind is read from the published file names.
 */
export function createRemoteComfyModelScanner(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): () => Promise<ImageModelFile[]> {
  const root = baseUrl.replace(/\/+$/, '');
  return async () => {
    // With the aiembodied add-on installed, that machine reads the files' tensors like the scan on this PC.
    const described = await fetchFn(`${root}/aiembodied/models`, { signal: AbortSignal.timeout(30_000) })
      .then(async (response) => (response.ok ? ((await response.json()) as unknown) : null))
      .catch(() => null);
    if (Array.isArray(described) && described.every(isModelFile)) return described;
    const folders = ['diffusion_models', 'text_encoders', 'vae', 'checkpoints', 'loras', 'controlnet'] as const;
    const listed = await Promise.all(
      folders.map(async (folder) => {
        const response = await fetchFn(`${root}/models/${folder}`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) {
          if (folder === 'diffusion_models')
            throw new Error(`ComfyUI at ${root} did not list its models (${response.status}).`);
          return [] as string[];
        }
        const names: unknown = await response.json();
        return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string') : [];
      }),
    );
    const files: ImageModelFile[] = [];
    folders.forEach((folder, index) => {
      for (const name of listed[index]) {
        const kind = remoteModelKind(folder, name);
        if (!kind) continue;
        files.push({
          folder,
          name,
          kind,
          ...(folder === 'controlnet' ? { family: remoteControlNetFamily(name) } : {}),
          ...(folder === 'checkpoints' ? { embeddedVae: true, embeddedClip: true, embeddedClip2: kind === 'sdxl' } : {}),
        });
      }
    });
    return files;
  };
}

/** The kind image-models.py would report, guessed from a file's folder and name. */
export function remoteModelKind(folder: string, name: string): string | null {
  const lower = name.toLowerCase().replace(/-/g, '_');
  if (lower.includes('trellis')) {
    if (folder === 'vae' && lower.includes('shape')) return 'trellis2-shape-vae';
    if (folder === 'vae' && lower.includes('tex')) return 'trellis2-texture-vae';
    return folder === 'diffusion_models' ? 'trellis2' : null;
  }
  if (folder === 'diffusion_models') {
    if (/qwen_?image/.test(lower)) return 'qwen-image-2.1';
    if (/z_?image/.test(lower)) return lower.includes('turbo') ? 'z-image-turbo' : null;
    return null;
  }
  if (folder === 'text_encoders') {
    if (/qwen_?3_?vl|qwen3vl/.test(lower)) return 'qwen3-vl';
    if (/qwen_?3_?4b/.test(lower)) return 'qwen3-4b';
    return null;
  }
  if (folder === 'vae') {
    if (/qwen_?image/.test(lower)) return 'qwen-image-vae';
    if (lower === 'ae.safetensors' || /flux.*ae/.test(lower)) return 'flux-ae';
    return null;
  }
  if (folder === 'checkpoints') {
    if (lower.includes('hunyuan3d')) return /(^|[^a-z])(2_?)?mv([^a-z]|$)/.test(lower) ? 'hunyuan3d-2mv' : null;
    return /xl/.test(lower) ? 'sdxl' : 'sd1';
  }
  // Without the add-on only the app's own pose ControlNets are recognised, by their names.
  if (folder === 'controlnet') return remoteControlNetFamily(name) ? 'controlnet' : null;
  // Without the add-on a LoRA's family can't be read, so it is listed but never applied.
  if (folder === 'loras') return /\.safetensors$/.test(lower) ? 'lora' : null;
  return null;
}

function remoteControlNetFamily(name: string): PoseFamily | undefined {
  const base = name.split('/').at(-1);
  return (Object.keys(POSE_CONTROLNETS) as PoseFamily[]).find((family) => POSE_CONTROLNETS[family].filename === base);
}

function isModelFile(value: unknown): value is ImageModelFile {
  if (!value || typeof value !== 'object') return false;
  const file = value as Record<string, unknown>;
  return typeof file.name === 'string' && typeof file.kind === 'string' && typeof file.folder === 'string';
}
