// Types only: shared/ holds what the main process and the renderer both need.

export interface HfFile {
  /** Path inside the repo, such as Q4_K_M/model-00001-of-00002.gguf. */
  path: string;
  size: number;
  sha256?: string;
}

/** One size of the model: a quantisation, made of one GGUF file or several split parts. */
export interface HfQuant {
  /** Unique in the repo: the first file's path without its split suffix. */
  id: string;
  /** Q4_K_M, UD-Q4_K_XL, BF16… or the file name when it has no quant in it. */
  label: string;
  files: HfFile[];
  sizeBytes: number;
}

export interface HfRepoSuggestion {
  repo: string;
  downloads: number;
  likes: number;
}

export interface HfLookup {
  /** Set when the reference named a repo that exists. */
  repo?: string;
  /** Gated repos need a Hugging Face token and the licence accepted on the website. */
  gated: boolean;
  quants: HfQuant[];
  /** The quant to preselect: the one the reference named, else a good default. */
  selected?: string;
  /** The context length the model was trained for, when Hugging Face reads it from the GGUF. */
  contextLength?: number;
  /** The repo's vision projector files (mmproj), for models that read images. */
  mmproj?: HfFile[];
  /** GGUF repos to pick from when the reference was search words or a repo with no GGUF files. */
  suggestions: HfRepoSuggestion[];
  note?: string;
}
