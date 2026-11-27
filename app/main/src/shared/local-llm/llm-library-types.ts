// Types only: shared/ holds what the main process and the renderer both need.
import type { LocalLlmSettings } from './llm-settings-types.js';

export interface LocalLlmModel {
  /** <repo>:<quant id>. */
  id: string;
  repo: string;
  quant: string;
  /** The name llama-server serves it as, and the model the Thinking route asks for. */
  alias: string;
  /** The first GGUF file; llama-server finds the other split parts beside it. */
  path: string;
  files: string[];
  sizeBytes: number;
  contextLength?: number;
  downloadedAt: number;
}

export interface LocalLlmLibraryFile {
  /** The model llama-server runs. None: the start script's own default (Qwen Flash-Next). */
  selected?: string;
  models: LocalLlmModel[];
  /** Conversations at once (1..8). Absent: LOCAL_LLM_SLOTS, else 2. */
  slots?: number;
  /** Tokens of context per slot (4096 or more). Absent: LOCAL_LLM_CONTEXT, else 65536. */
  contextPerSlot?: number;
}

/** What the page lists: the downloaded models, the one in use, and where they are kept. */
export interface LocalLlmList extends LocalLlmLibraryFile {
  folder: string;
  /** The slots and per-slot context llama-server runs with, defaults filled in. */
  settings: LocalLlmSettings;
}

export type LlmDownloadState =
  'queued' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled';

export interface LlmDownload {
  id: string;
  repo: string;
  quant: string;
  label: string;
  state: LlmDownloadState;
  received: number;
  total: number;
  /** Switch Thinking to it once it is downloaded. */
  use: boolean;
  error?: string;
  /** What happened when it was put to use (llama-server restarted, or what to do by hand). */
  result?: string;
  startedAt: number;
}
