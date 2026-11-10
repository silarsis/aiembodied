/**
 * Objects the library has no good match for, made locally with the avatar studio's ComfyUI path:
 * the image model draws the object on plain white, then the 3D step (TRELLIS.2 when installed,
 * else Hunyuan3D 2mv from the front image alone) turns the picture into a .glb. The result is kept
 * in the generated library so a later room that wants the same sort of object reuses it.
 *
 * As an ObjectSource it only answers from that library (instant); making a new one is `generate`,
 * which the room generation service runs in the background, one object at a time.
 */
import { randomInt } from 'node:crypto';
import type { ComfyGraph } from '../../avatar/generation/comfyui-client.js';
import { characterMeshGraph } from '../../avatar/generation/character/graphs.js';
import type { GeometryModel } from '../../avatar/generation/character-model-service.js';
import { buildImageWorkflow, type ImageWorkflowModel } from '../../avatar/generation/image-workflows.js';
import { ASSET_SCHEME } from '../asset-protocol.js';
import type { GeneratedObjectSummary } from '../object-settings.js';
import type { LayoutObject } from '../room-layout.js';
import { fitModel } from '../room-model-fit.js';
import type { ResolvedModel } from '../room-placer.js';
import { glbBounds } from './gltf-bounds.js';
import {
  directoryFor,
  GENERATED_IMAGE_FILE,
  GENERATED_MODEL_FILE,
  GeneratedLibrary,
  type GeneratedEntry,
  type GeneratedMeta,
} from './generated-library.js';
import { buildObjectImagePrompt, OBJECT_IMAGE_NEGATIVE } from './generated-prompt.js';
import type { ObjectSource } from './library-source.js';

/** The part of ComfyUIClient this needs; tests give it a fake. */
export interface ObjectComfy {
  uploadImage(fileName: string, png: Buffer): Promise<string>;
  run(graph: ComfyGraph, options?: { signal?: AbortSignal; output?: 'image' | 'mesh' }): Promise<Buffer>;
}

export interface GeneratedSourceOptions {
  library: GeneratedLibrary;
  /** The ComfyUI server of a Models and servers step, started if it is this PC's. */
  pickComfy: (stage: 'image' | 'mesh') => Promise<ObjectComfy>;
  /** The image model the studio uses (its LoRAs are left out: they are meant for characters). */
  imageModel: () => Promise<ImageWorkflowModel>;
  geometryModel: () => Promise<GeometryModel>;
  seed?: () => number;
  now?: () => Date;
  logger?: Pick<Console, 'warn'>;
}

export interface MadeObject {
  entry: GeneratedEntry;
  resolved: ResolvedModel;
}

export function objectImageGraph(model: ImageWorkflowModel, prompt: string, seed: number): ComfyGraph {
  const graph = buildImageWorkflow({ ...model, loras: undefined }, prompt, seed);
  if (graph.encode?.class_type === 'TextEncodeQwenImage21') graph.encode.inputs.negative_prompt = OBJECT_IMAGE_NEGATIVE;
  if (graph.negative?.class_type === 'CLIPTextEncode') graph.negative.inputs.text = OBJECT_IMAGE_NEGATIVE;
  if (graph.save?.class_type === 'SaveImage') graph.save.inputs.filename_prefix = 'aiembodied/room-object';
  return graph;
}

function resolvedFrom(entry: GeneratedEntry, object: Pick<LayoutObject, 'size'>): ResolvedModel {
  const { scale, size } = fitModel(entry.meta.bbox, object.size);
  return { model: { asset: entry.asset, file: GENERATED_MODEL_FILE, scale }, size };
}

export class GeneratedSource implements ObjectSource {
  readonly name = 'generated';
  /** Objects are made one at a time, whoever asks. */
  private lane: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: GeneratedSourceOptions) {}

  /** A model made earlier for this sort of object, or null. Never makes anything. */
  async resolve(object: LayoutObject, signal?: AbortSignal): Promise<ResolvedModel | null> {
    try {
      const entry = await this.options.library.find({ search: object.search, name: object.name, category: object.category });
      return entry ? resolvedFrom(entry, object) : null;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.options.logger?.warn('Could not search the generated objects.', { message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /** What the 3D rooms tab lists: name, when, and the picture each was made from. */
  async list(): Promise<GeneratedObjectSummary[]> {
    return (await this.options.library.list()).map((entry) => ({
      id: entry.dir,
      name: entry.meta.name,
      created: entry.meta.created,
      imageUrl: `${ASSET_SCHEME}://${entry.asset}/${encodeURIComponent(entry.meta.sourceImage)}`,
    }));
  }

  /** Deletes an object. Rooms that used it show simple shapes the next time they load. */
  remove(id: string): Promise<void> {
    return this.options.library.remove(id);
  }

  /** Makes a new object (reusing a matching earlier one first). Throws with a reason when it fails. */
  generate(object: LayoutObject, signal: AbortSignal): Promise<MadeObject & { reused: boolean }> {
    const run = this.lane.then(() => this.make(object, signal));
    this.lane = run.catch(() => undefined);
    return run;
  }

  private async make(object: LayoutObject, signal: AbortSignal): Promise<MadeObject & { reused: boolean }> {
    const cancelled = () => new Error('Cancelled.');
    if (signal.aborted) throw cancelled();
    const earlier = await this.options.library.find({ search: object.search, name: object.name, category: object.category });
    if (earlier) return { entry: earlier, resolved: resolvedFrom(earlier, object), reused: true };

    const imageModel = await this.options.imageModel();
    const geometry = await this.options.geometryModel();
    const seed = (this.options.seed ?? (() => randomInt(0, 2 ** 47)))();
    const prompt = buildObjectImagePrompt(object);

    const imageComfy = await this.options.pickComfy('image');
    const image = await imageComfy.run(objectImageGraph(imageModel, prompt, seed), { signal });
    if (signal.aborted) throw cancelled();
    if (image.length === 0) throw new Error('The image step returned nothing.');

    const created = (this.options.now?.() ?? new Date()).toISOString();
    const dir = directoryFor(object.name, `${object.name}|${prompt}|${created}|${seed}`);
    const meshComfy = await this.options.pickComfy('mesh');
    const uploaded = await meshComfy.uploadImage(`room-object-${dir}.png`, image);
    const glb = await meshComfy.run(characterMeshGraph({ front: uploaded }, seed, geometry), { signal, output: 'mesh' });
    if (signal.aborted) throw cancelled();

    const bounds = glbBounds(glb);
    if (!bounds || !bounds.size.every((n) => Number.isFinite(n)) || bounds.size[1] < 1e-3 || bounds.size[0] < 1e-3 || bounds.size[2] < 1e-3)
      throw new Error('The 3D step did not produce a usable model.');

    const meta: GeneratedMeta = {
      name: object.name,
      search: object.search,
      category: object.category,
      prompt,
      created,
      sourceImage: GENERATED_IMAGE_FILE,
      bbox: bounds,
      seed,
      geometryModel: geometry.id,
      imageModel: imageModel.id,
    };
    const entry = await this.options.library.add(dir, meta, { model: glb, image });
    return { entry, resolved: resolvedFrom(entry, object), reused: false };
  }
}
