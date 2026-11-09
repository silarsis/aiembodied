/**
 * Object sources: where a layout object gets its look from. The Poly Haven library is the first;
 * a generator (the avatar image-to-3D pipeline, step 5) can be slotted in between it and the
 * primitive shapes by adding another ObjectSource to the list the generation service is given.
 * An object no source resolves gets simple shapes from the placer.
 */
import { readFile } from 'node:fs/promises';
import type { LayoutObject } from '../room-layout.js';
import { fitModel } from '../room-model-fit.js';
import type { ResolvedModel } from '../room-placer.js';
import { gltfBounds } from './gltf-bounds.js';
import type { PolyHavenClient } from './polyhaven.js';
import { findBestModel } from './search.js';

export interface ObjectSource {
  readonly name: string;
  /** A model for the object, or null when this source has nothing (or failed). Never throws for a miss. */
  resolve(object: LayoutObject, signal?: AbortSignal): Promise<ResolvedModel | null>;
}

export class PolyHavenSource implements ObjectSource {
  readonly name = 'polyhaven';
  constructor(
    private readonly client: Pick<PolyHavenClient, 'catalog' | 'ensureModel'>,
    private readonly logger?: Pick<Console, 'warn'>,
  ) {}

  async resolve(object: LayoutObject, signal?: AbortSignal): Promise<ResolvedModel | null> {
    try {
      const catalog = await this.client.catalog(signal);
      const match = findBestModel(catalog, { search: object.search, name: object.name, category: object.category });
      if (!match) return null;
      const local = await this.client.ensureModel(match.entry.id, signal);
      const bounds = gltfBounds(JSON.parse(await readFile(local.path, 'utf8')) as unknown);
      if (!bounds) return null;
      const { scale, size } = fitModel(bounds, object.size);
      return { model: { asset: local.asset, file: local.file, scale }, size };
    } catch (error) {
      if (signal?.aborted) throw error;
      this.logger?.warn('Could not get a library model.', { object: object.id, message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
}

/** The first source that has a model. */
export async function resolveObject(sources: ObjectSource[], object: LayoutObject, signal?: AbortSignal): Promise<ResolvedModel | null> {
  for (const source of sources) {
    const found = await source.resolve(object, signal);
    if (found) return found;
  }
  return null;
}
