// Types only: shared/ holds what the main process and the renderer both need.

export interface CivitaiFile {
  id?: number;
  name: string;
  sizeKB: number;
  downloadUrl: string;
  sha256?: string;
  primary: boolean;
  format?: string;
}

/** What is saved beside a downloaded model (<name>.aiembodied.json) for the app to read back. */
export interface ModelInfo {
  modelId: number;
  versionId: number;
  name: string;
  type: string;
  baseModel: string;
  family?: string;
  triggerWords?: string[];
}

/** What the pop-up shows after a lookup. */
export interface CivitaiLookup {
  versions: Array<{ id: number; name: string; baseModel: string }>;
  plan: CivitaiDownloadPlan;
}

/** What to download, and where it goes. */
export interface CivitaiDownloadPlan {
  modelId: number;
  versionId: number;
  title: string;
  type: string;
  baseModel: string;
  folder: string;
  file: CivitaiFile;
  /** The app's model kind for image models, when the base model tells it (sdxl, sd1). */
  kind?: string;
  /** Why the app's image step can't use it, when it can't (it still downloads). */
  note?: string;
  /** Saved beside the file so the app knows its family and trigger words later. */
  info: ModelInfo;
}

/** What the studio shows when a LoRA has no model of its family to run on. */
export interface BaseModelSuggestions {
  serverId: string;
  serverName: string;
  baseModel: string;
  vramBytes: number | null;
  suggestions: BaseModelSuggestion[];
}

/** A base model Civitai suggests for a LoRA's family, and whether it fits the server's GPU. */
export interface BaseModelSuggestion {
  ref: string;
  modelId: number;
  versionId: number;
  name: string;
  baseModel: string;
  sizeKB: number;
  downloads: number;
  /** null when the server didn't say how much GPU memory it has. */
  fits: boolean | null;
}
