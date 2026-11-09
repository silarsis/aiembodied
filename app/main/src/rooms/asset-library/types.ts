/** What the room builder needs from a model library. Poly Haven is the first one. */
export interface CatalogEntry {
  /** Library id, e.g. "ArmChair_01". */
  id: string;
  name: string;
  categories: string[];
  tags: string[];
}

/** A model that is on disk, ready to be served to the renderer. */
export interface LocalModel {
  /** Folder under the asset cache, e.g. "polyhaven/ArmChair_01". */
  asset: string;
  /** The glTF file, relative to that folder. */
  file: string;
  /** Absolute path of the glTF file (for measuring). */
  path: string;
}
