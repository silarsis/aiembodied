// Types only: shared/ holds what the main process and the renderer both need.
import type { LlmDownload } from '../local-llm/llm-library-types.js';


/** What local-vision.json keeps. model and mmproj are absolute paths. */
export interface VisionPick {
  repo: string;
  model: string;
  mmproj: string;
  alias: string;
}


/** What the Describe the avatar row shows. */
export interface VisionStatus {
  pick: VisionPick | null;
  /** Both files are on disk. */
  ready: boolean;
  sizeBytes: number;
  /** The newest download that is running or failed, if any. */
  download: LlmDownload | null;
  folder: string;
}
