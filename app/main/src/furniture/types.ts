/**
 * Furniture the user makes from a description: the service draws the piece, builds a 3D model of it and
 * scales that to real metres. Adding pieces to rooms is a later step.
 */

export type FurnitureStatus = 'generating' | 'ready' | 'failed';

/** How the model.glb was made from model-raw.glb: so any consumer gets real metres without scaling it. */
export interface FurnitureFit {
  /** The uniform scale applied to the raw model. */
  scale: number;
  /** Where the scaled model was moved so its bottom sits on y=0, centred on x and z. */
  offset: [number, number, number];
}

/** What is kept for one piece (the memory store holds a list of these). */
export interface FurnitureRecord {
  id: string;
  name: string;
  prompt: string;
  /** A word like "seating" or "table"; from the helper model, or guessed from the prompt. */
  category: string;
  /** Width, height, depth in metres: what the model really measures after scaling. */
  dimensions: [number, number, number];
  status: FurnitureStatus;
  /** Why the last run failed. A piece whose edit failed stays 'ready' with its old model and this set. */
  error?: string;
  fit?: FurnitureFit;
  createdAt: string;
  updatedAt: string;
}

/** What the renderer sees. */
export interface FurnitureItem extends FurnitureRecord {
  /** Progress of the running job, while there is one. */
  message?: string;
  /** Whether model.glb exists (a new piece has none until its first run succeeds). */
  hasModel: boolean;
  thumbnailDataUrl: string | null;
}

export interface FurnitureBridge {
  list(): Promise<FurnitureItem[]>;
  load(id: string): Promise<FurnitureItem>;
  /** Starts a job and returns the new piece at once, with status 'generating'. */
  generate(prompt: string): Promise<FurnitureItem>;
  /** Runs the whole generation again for this piece with a new prompt. */
  edit(id: string, prompt: string): Promise<FurnitureItem>;
  /** Cancels its running job, then removes its files and record. */
  delete(id: string): Promise<void>;
  /** The scaled GLB for the 3D view. */
  model(id: string): Promise<ArrayBuffer>;
  /** A piece changed: progress, finished or failed. */
  onChanged(listener: (item: FurnitureItem) => void): () => void;
}
