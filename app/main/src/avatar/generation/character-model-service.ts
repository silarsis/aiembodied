import type { MemoryStore } from '../../memory/index.js';
import type { ImageModelFile } from './image-model-service.js';
import type { AvatarCharacterModelSelection, AvatarCharacterModelSummary } from '../types.js';

/**
 * The weights a geometry run loads. TRELLIS.2 builds a textured mesh from the front image alone;
 * Hunyuan3D 2mv builds the shape from front, side and back views, which are then painted on.
 */
export type GeometryModel =
  | {
      kind: 'trellis2';
      id: string;
      name: string;
      unet: string;
      shapeVae: string;
      textureVae: string;
    }
  | { kind: 'hunyuan3d-2mv'; id: string; name: string; checkpoint: string };

/** Whether a geometry model is given the side and back views as well as the front. */
export function usesViews(model: GeometryModel | undefined): boolean {
  return model?.kind === 'hunyuan3d-2mv';
}
export interface RigModel {
  id: string;
  name: string;
  /** fitted: MediaPipe face topology. stylised: a vision model's feature boxes bend the head's painted face. */
  face: 'fitted' | 'stylised';
  /** Stylised only: the ComfyUI text encoder file that answers where the features are. */
  visionModel?: string;
}

export const DEFAULT_TRELLIS_UNET = 'trellis_2_int8_convrot.safetensors';
const DEFAULT_SHAPE_VAE = 'trellis_2_shape_vae_bf16.safetensors';
const DEFAULT_TEXTURE_VAE = 'trellis_2_texture_vae_bf16.safetensors';
export const BLENDER_FACE_FIT_RIG = 'blender-face-fit';
export const BLENDER_STYLISED_FACE_RIG = 'blender-stylised-face';
/** Qwen3-VL, which finds stylised eyes and mouths; ComfyUI already has it as Qwen-Image's text encoder. */
export const DEFAULT_FACE_VISION_MODEL = 'qwen3vl_8b_int8_convrot.safetensors';

export const DEFAULT_HUNYUAN_MV = 'hunyuan3d-dit-v2-mv.safetensors';
/**
 * Hunyuan3D 2mv became the default in November 2026. Choices saved before then (when TRELLIS.2 was
 * the only option) are not carried over, so the new default applies once.
 */
const GEOMETRY_KEY = 'avatar.geometryModel.v2';
const RIG_KEY = 'avatar.rigModel';

interface Entry<T> {
  model: T;
  summary: AvatarCharacterModelSummary;
}

function hunyuanName(file: string): string {
  const variant = file
    .replace(/\.safetensors$/i, '')
    .replace(/^hunyuan3d[_-]?(dit[_-]?)?v?2[_-]?mv[_-]?/i, '')
    .replaceAll(/[_-]/g, ' ')
    .trim();
  return variant ? `Hunyuan3D 2mv (${variant})` : 'Hunyuan3D 2mv';
}

function displayName(file: string): string {
  const stem = file.replace(/\.safetensors$/i, '').replace(/^trellis_?2_?/i, '');
  const variant = stem.replaceAll('_', ' ').trim();
  return variant ? `TRELLIS.2 (${variant})` : 'TRELLIS.2';
}

/**
 * Lists the models that turn an approved image into an animated avatar: the 3D geometry model
 * (Hunyuan3D 2mv first, then TRELLIS.2 variants found in ComfyUI) and the rig and face method.
 */
export class AvatarCharacterModelService {
  private geometry: Entry<GeometryModel>[] = [];
  private rig: Entry<RigModel>[] = [];
  private pending: Promise<void> | null = null;
  private selected: { geometry: string | null; rig: string | null } = { geometry: null, rig: null };

  constructor(
    private readonly scan: () => Promise<ImageModelFile[]>,
    private readonly checkRig: () => Promise<void>,
    private readonly store?: Pick<MemoryStore, 'getValue' | 'setValue'>,
  ) {}

  private async refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      let files: ImageModelFile[] | null;
      try {
        files = await this.scan();
      } catch {
        // Discovery needs a local ComfyUI install; the workflow defaults still run on a remote one.
        files = null;
      }
      this.geometry = this.geometryEntries(files);
      let rigReason: string | undefined;
      try {
        await this.checkRig();
      } catch (error) {
        rigReason = error instanceof Error ? error.message : String(error);
      }
      const vision = files
        ? files.find((file) => file.kind === 'qwen3-vl' && file.name === DEFAULT_FACE_VISION_MODEL)?.name ??
          files.find((file) => file.kind === 'qwen3-vl')?.name
        : DEFAULT_FACE_VISION_MODEL;
      const stylisedReason =
        rigReason ??
        (vision
          ? undefined
          : `Finding stylised faces needs Qwen3-VL in ComfyUI. Put ${DEFAULT_FACE_VISION_MODEL} in its text_encoders folder and refresh.`);
      this.rig = [
        {
          model: { id: BLENDER_FACE_FIT_RIG, name: 'Blender auto-rig with fitted face', face: 'fitted' },
          summary: {
            id: BLENDER_FACE_FIT_RIG,
            name: 'Blender auto-rig with fitted face',
            description:
              'Fits a humanoid skeleton in Blender, then a local MediaPipe face with speech, blink, gaze and six emotions.',
            available: !rigReason,
            ...(rigReason ? { unavailableReason: rigReason } : {}),
          },
        },
        {
          model: {
            id: BLENDER_STYLISED_FACE_RIG,
            name: 'Blender auto-rig with stylised face',
            face: 'stylised',
            ...(vision ? { visionModel: vision } : {}),
          },
          summary: {
            id: BLENDER_STYLISED_FACE_RIG,
            name: 'Blender auto-rig with stylised face',
            description:
              'For anime, furry and cartoon faces: a vision model finds the eyes and mouth, and the head’s own painted face blinks, talks and shows six emotions.',
            available: !stylisedReason,
            ...(stylisedReason ? { unavailableReason: stylisedReason } : {}),
          },
        },
      ];
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private geometryEntries(files: ImageModelFile[] | null): Entry<GeometryModel>[] {
    return [...this.hunyuanEntries(files), ...this.trellisEntries(files)];
  }

  private hunyuanEntries(files: ImageModelFile[] | null): Entry<GeometryModel>[] {
    const description = 'Shape from front, side and back views, then painted from those views.';
    const checkpoints = files
      ? files
          .filter((file) => file.kind === 'hunyuan3d-2mv' && file.folder === 'checkpoints')
          .map((file) => file.name)
          .sort((a, b) =>
            a === DEFAULT_HUNYUAN_MV ? -1 : b === DEFAULT_HUNYUAN_MV ? 1 : a.localeCompare(b),
          )
      : [DEFAULT_HUNYUAN_MV];
    if (!checkpoints.length)
      return [
        {
          model: { kind: 'hunyuan3d-2mv', id: DEFAULT_HUNYUAN_MV, name: 'Hunyuan3D 2mv', checkpoint: DEFAULT_HUNYUAN_MV },
          summary: {
            id: DEFAULT_HUNYUAN_MV,
            name: 'Hunyuan3D 2mv',
            description,
            views: true,
            available: false,
            unavailableReason: `Hunyuan3D 2mv was not found in ComfyUI. Put ${DEFAULT_HUNYUAN_MV} in its checkpoints folder and refresh.`,
          },
        },
      ];
    return checkpoints.map((checkpoint) => {
      const name = hunyuanName(checkpoint);
      return {
        model: { kind: 'hunyuan3d-2mv', id: checkpoint, name, checkpoint },
        summary: { id: checkpoint, name, description, views: true, available: true },
      };
    });
  }

  private trellisEntries(files: ImageModelFile[] | null): Entry<GeometryModel>[] {
    const pick = (kind: string, preferred: string) =>
      files?.find((file) => file.kind === kind && file.name === preferred)?.name ??
      files?.filter((file) => file.kind === kind).sort((a, b) => a.name.localeCompare(b.name))[0]
        ?.name;
    const shapeVae = files ? pick('trellis2-shape-vae', DEFAULT_SHAPE_VAE) : DEFAULT_SHAPE_VAE;
    const textureVae = files
      ? pick('trellis2-texture-vae', DEFAULT_TEXTURE_VAE)
      : DEFAULT_TEXTURE_VAE;
    const unets = files
      ? files
          .filter((file) => file.kind === 'trellis2' && file.folder === 'diffusion_models')
          .map((file) => file.name)
      : [DEFAULT_TRELLIS_UNET];
    if (!unets.length) {
      return [
        {
          model: {
            kind: 'trellis2',
            id: DEFAULT_TRELLIS_UNET,
            name: displayName(DEFAULT_TRELLIS_UNET),
            unet: DEFAULT_TRELLIS_UNET,
            shapeVae: DEFAULT_SHAPE_VAE,
            textureVae: DEFAULT_TEXTURE_VAE,
          },
          summary: {
            id: DEFAULT_TRELLIS_UNET,
            name: displayName(DEFAULT_TRELLIS_UNET),
            available: false,
            unavailableReason:
              'TRELLIS.2 weights were not found in ComfyUI. Install them and refresh.',
          },
        },
      ];
    }
    const reason =
      !shapeVae || !textureVae
        ? 'The TRELLIS.2 shape and texture VAEs are not both installed.'
        : undefined;
    return unets
      .map((unet): Entry<GeometryModel> => {
        const name = displayName(unet);
        return {
          model: {
            kind: 'trellis2',
            id: unet,
            name,
            unet,
            shapeVae: shapeVae ?? DEFAULT_SHAPE_VAE,
            textureVae: textureVae ?? DEFAULT_TEXTURE_VAE,
          },
          summary: {
            id: unet,
            name,
            description: 'Textured mesh from the front image only, generated in ComfyUI.',
            available: !reason,
            ...(reason ? { unavailableReason: reason } : {}),
          },
        };
      })
      .sort((a, b) =>
        a.model.id === DEFAULT_TRELLIS_UNET
          ? -1
          : b.model.id === DEFAULT_TRELLIS_UNET
            ? 1
            : a.model.name.localeCompare(b.model.name),
      );
  }

  private current<T extends { id: string }>(
    entries: Entry<T>[],
    saved: string | null,
  ): string | null {
    return (
      entries.find((entry) => entry.model.id === saved && entry.summary.available)?.model.id ??
      entries.find((entry) => entry.summary.available)?.model.id ??
      null
    );
  }

  async list(): Promise<AvatarCharacterModelSelection> {
    await this.refresh();
    return {
      geometry: this.geometry.map((entry) => ({ ...entry.summary })),
      rig: this.rig.map((entry) => ({ ...entry.summary })),
      selectedGeometryId: this.current(
        this.geometry,
        this.store?.getValue(GEOMETRY_KEY) ?? this.selected.geometry,
      ),
      selectedRigId: this.current(this.rig, this.store?.getValue(RIG_KEY) ?? this.selected.rig),
    };
  }

  async select(stage: 'geometry' | 'rig', id: string): Promise<void> {
    if (stage === 'geometry') {
      await this.resolveGeometry(id);
      this.store?.setValue(GEOMETRY_KEY, id);
      this.selected.geometry = id;
    } else if (stage === 'rig') {
      await this.resolveRig(id);
      this.store?.setValue(RIG_KEY, id);
      this.selected.rig = id;
    } else {
      throw new Error('Unknown avatar model stage.');
    }
  }

  async resolveGeometry(id?: string): Promise<GeometryModel> {
    await this.refresh();
    const wanted =
      id ??
      this.current(this.geometry, this.store?.getValue(GEOMETRY_KEY) ?? this.selected.geometry);
    // With nothing usable, explain why the first (default) option can't run.
    const entry =
      this.geometry.find((candidate) => candidate.model.id === wanted) ??
      (id === undefined ? this.geometry[0] : undefined);
    if (!entry?.summary.available)
      throw new Error(
        entry?.summary.unavailableReason ??
          'The selected 3D model is no longer available. Refresh the model list and choose another.',
      );
    return { ...entry.model };
  }

  async resolveRig(id?: string): Promise<RigModel> {
    await this.refresh();
    const wanted = id ?? this.current(this.rig, this.store?.getValue(RIG_KEY) ?? this.selected.rig);
    const entry =
      this.rig.find((candidate) => candidate.model.id === wanted) ??
      (id === undefined ? this.rig[0] : undefined);
    if (!entry?.summary.available)
      throw new Error(
        entry?.summary.unavailableReason ??
          'The selected rig method is no longer available. Refresh the model list and choose another.',
      );
    return { ...entry.model };
  }
}
