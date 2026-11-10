/**
 * Hugging Face lookups for the thinking model: turn a pasted link, repo name or search words into
 * the GGUF files llama-server can run, grouped by size (quantisation).
 *
 * Accepted references:
 *   https://huggingface.co/unsloth/Qwen3-8B-GGUF                 (the repo)
 *   https://huggingface.co/unsloth/Qwen3-8B-GGUF/blob/main/Qwen3-8B-Q4_K_M.gguf   (that file's size)
 *   hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M                            (llama.cpp's -hf form)
 *   unsloth/Qwen3-8B-GGUF, unsloth/Qwen3-8B-GGUF:Q4_K_M
 *   Qwen/Qwen3-8B             (no GGUF files: the GGUF repos made from it are suggested)
 *   qwen3 8b                  (search words: the most downloaded GGUF repos are suggested)
 */

export type HuggingFaceRef = { repo: string; quant?: string; file?: string } | { search: string };

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

const HF = 'https://huggingface.co';
const HF_HOSTS = new Set(['huggingface.co', 'www.huggingface.co', 'hf.co']);
const REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
const SPLIT = /-(\d{5})-of-(\d{5})\.gguf$/i;
/** Quant names as llama.cpp and the big quantisers (unsloth, bartowski, TheBloke) write them. */
const QUANT = /(?:^|[-_./])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|FP16|MXFP4(?:_MOE)?|TQ\d_\d))(?=[-_./]|\.gguf$|$)/i;
/** Preferred default sizes, best first: a good size/quality balance for chat. */
const PREFERRED = ['Q4_K_M', 'UD-Q4_K_XL', 'Q4_K_L', 'Q4_K_S', 'Q4_0', 'Q5_K_M', 'Q8_0'];

export function parseHuggingFaceRef(text: string): HuggingFaceRef | null {
  let value = text.trim();
  if (!value) return null;
  value = value.replace(/^hf:\/\//i, '');
  let quant: string | undefined;
  let file: string | undefined;
  // Links (with or without https://).
  const asUrl = /^[a-z]+:\/\//i.test(value) ? value : /^(www\.)?(huggingface\.co|hf\.co)\//i.test(value) ? `https://${value}` : null;
  if (asUrl) {
    let url: URL;
    try {
      url = new URL(asUrl);
    } catch {
      return null;
    }
    if (!HF_HOSTS.has(url.hostname.toLowerCase())) return null;
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'models') parts.shift();
    if (parts.length < 2) return null;
    let name = parts[1];
    const colon = name.indexOf(':');
    if (colon > 0) {
      quant = name.slice(colon + 1);
      name = name.slice(0, colon);
    }
    // /blob/<rev>/<path>, /resolve/<rev>/<path>, /tree/<rev>/<folder>
    if ((parts[2] === 'blob' || parts[2] === 'resolve' || parts[2] === 'tree') && parts.length > 4) {
      const inner = parts.slice(4).join('/');
      if (/\.gguf$/i.test(inner)) file = inner;
      else quant ??= quantOf(inner) ?? undefined;
    }
    const repo = `${parts[0]}/${name}`;
    if (!REPO.test(repo)) return null;
    return { repo, ...(quant ? { quant } : {}), ...(file ? { file } : {}) };
  }
  const colon = value.lastIndexOf(':');
  if (colon > 0 && value.includes('/') && !value.slice(colon).includes('/')) {
    quant = value.slice(colon + 1).trim() || undefined;
    value = value.slice(0, colon).trim();
  }
  if (REPO.test(value)) return { repo: value, ...(quant ? { quant } : {}) };
  if (/\s/.test(value) || !value.includes('/')) return { search: value };
  return null;
}

/** The quant named in a file or folder name, such as Q4_K_M. */
export function quantOf(name: string): string | null {
  const base = name.replace(SPLIT, '.gguf');
  const parts = base.split('/');
  // The file name wins over the folder; unsloth puts big quants in a folder named after the quant.
  for (const part of [parts.at(-1) ?? base, ...parts.slice(0, -1).reverse()]) {
    const match = QUANT.exec(part);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

interface RawSibling {
  rfilename?: string;
  path?: string;
  size?: number;
  lfs?: { sha256?: string; oid?: string; size?: number };
}

/** Group a repo's files into the sizes llama-server can load. Vision projectors (mmproj) are left out. */
export function groupGgufQuants(files: RawSibling[]): HfQuant[] {
  const groups = new Map<string, HfQuant>();
  for (const entry of files) {
    const path = entry.rfilename ?? entry.path;
    if (!path || !/\.gguf$/i.test(path)) continue;
    const name = path.split('/').at(-1) ?? path;
    if (/^mmproj/i.test(name) || /[-_.]mmproj[-_.]/i.test(name)) continue;
    const split = SPLIT.exec(path);
    // A split part that isn't the first only joins the group; the group key is the path without the suffix.
    const id = split ? path.replace(SPLIT, '.gguf') : path;
    const size = entry.lfs?.size ?? entry.size ?? 0;
    const sha256 = entry.lfs?.sha256 ?? entry.lfs?.oid;
    const file: HfFile = { path, size, ...(sha256 && /^[a-f0-9]{64}$/i.test(sha256) ? { sha256: sha256.toLowerCase() } : {}) };
    const group = groups.get(id);
    if (group) {
      group.files.push(file);
      group.sizeBytes += size;
    } else {
      groups.set(id, { id, label: quantOf(path) ?? name.replace(/\.gguf$/i, ''), files: [file], sizeBytes: size });
    }
  }
  const quants = [...groups.values()];
  for (const quant of quants) quant.files.sort((a, b) => a.path.localeCompare(b.path));
  // Two files with the same quant (say, two model sizes in one repo): tell them apart by name.
  const counts = new Map<string, number>();
  for (const quant of quants) counts.set(quant.label, (counts.get(quant.label) ?? 0) + 1);
  for (const quant of quants) {
    if ((counts.get(quant.label) ?? 0) > 1) quant.label = (quant.id.split('/').at(-1) ?? quant.id).replace(/\.gguf$/i, '');
  }
  return quants.sort((a, b) => a.sizeBytes - b.sizeBytes);
}

/** A repo's vision projector (mmproj) GGUF files, sorted by name. */
export function listMmprojFiles(files: RawSibling[]): HfFile[] {
  const result: HfFile[] = [];
  for (const entry of files) {
    const path = entry.rfilename ?? entry.path;
    if (!path || !/mmproj.*\.gguf$/i.test(path)) continue;
    const sha256 = entry.lfs?.sha256 ?? entry.lfs?.oid;
    result.push({
      path,
      size: entry.lfs?.size ?? entry.size ?? 0,
      ...(sha256 && /^[a-f0-9]{64}$/i.test(sha256) ? { sha256: sha256.toLowerCase() } : {}),
    });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

/** The quant to preselect: the one asked for, else a common chat default, else the middle size. */
export function pickDefaultQuant(quants: HfQuant[], wanted?: string, file?: string): string | undefined {
  if (!quants.length) return undefined;
  if (file) {
    const hit = quants.find((quant) => quant.files.some((entry) => entry.path === file));
    if (hit) return hit.id;
  }
  if (wanted) {
    const target = wanted.toUpperCase();
    const hit = quants.find((quant) => quant.label.toUpperCase() === target) ?? quants.find((quant) => quantOf(quant.id) === target);
    if (hit) return hit.id;
  }
  for (const name of PREFERRED) {
    const hit = quants.find((quant) => quant.label.toUpperCase() === name);
    if (hit) return hit.id;
  }
  return quants[Math.floor((quants.length - 1) / 2)].id;
}

export class HuggingFaceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function headers(token?: string): Record<string, string> {
  return { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function getJson<T>(url: string, token: string | undefined, fetchFn: typeof fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetchFn(url, { headers: headers(token), signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new HuggingFaceError("Hugging Face isn't answering. Check this PC's internet connection.");
  }
  if (!response.ok) throw new HuggingFaceError(`Hugging Face answered ${response.status}.`, response.status);
  return (await response.json()) as T;
}

interface RawModel {
  id?: string;
  gated?: boolean | string;
  siblings?: RawSibling[];
  gguf?: { context_length?: number; total?: number };
  downloads?: number;
  likes?: number;
}

async function searchGgufRepos(params: Record<string, string>, token: string | undefined, fetchFn: typeof fetch): Promise<HfRepoSuggestion[]> {
  const query = new URLSearchParams({ sort: 'downloads', direction: '-1', limit: '10', ...params });
  query.append('filter', 'gguf');
  const found = await getJson<RawModel[]>(`${HF}/api/models?${query.toString()}`, token, fetchFn);
  return (Array.isArray(found) ? found : [])
    .filter((entry): entry is RawModel & { id: string } => typeof entry.id === 'string')
    .map((entry) => ({ repo: entry.id, downloads: entry.downloads ?? 0, likes: entry.likes ?? 0 }));
}

/** Read a repo's GGUF sizes, or suggest GGUF repos for search words or a repo without any. */
export async function lookupHuggingFace(ref: HuggingFaceRef, token?: string, fetchFn: typeof fetch = fetch): Promise<HfLookup> {
  if ('search' in ref) {
    const suggestions = await searchGgufRepos({ search: ref.search }, token, fetchFn);
    return {
      gated: false,
      quants: [],
      suggestions,
      ...(suggestions.length ? {} : { note: `No GGUF models on Hugging Face match “${ref.search}”. Try fewer words, or paste the repo name.` }),
    };
  }
  let model: RawModel;
  try {
    model = await getJson<RawModel>(`${HF}/api/models/${ref.repo}?blobs=true`, token, fetchFn);
  } catch (error) {
    if (error instanceof HuggingFaceError && error.status === 404) {
      // A private or mistyped repo; search for the name instead.
      const suggestions = await searchGgufRepos({ search: ref.repo.split('/')[1] }, token, fetchFn).catch(() => []);
      return { gated: false, quants: [], suggestions, note: `There is no public model called ${ref.repo} on Hugging Face${token ? '' : ' (a private one needs a Hugging Face token)'}.` };
    }
    if (error instanceof HuggingFaceError && (error.status === 401 || error.status === 403)) {
      throw new HuggingFaceError(`${ref.repo} needs a Hugging Face token${token ? ' with access to it' : ''}. Add one under Servers → Hugging Face.`, error.status);
    }
    throw error;
  }
  const repo = model.id ?? ref.repo;
  const gated = Boolean(model.gated);
  const quants = groupGgufQuants(model.siblings ?? []);
  const mmproj = listMmprojFiles(model.siblings ?? []);
  const contextLength = typeof model.gguf?.context_length === 'number' && model.gguf.context_length > 0 ? model.gguf.context_length : undefined;
  if (!quants.length) {
    // A base model (safetensors): offer the GGUF versions made from it.
    const suggestions = await searchGgufRepos({ filter: `base_model:quantized:${repo}` }, token, fetchFn).catch(() => []);
    const fallback = suggestions.length ? suggestions : await searchGgufRepos({ search: repo.split('/')[1] }, token, fetchFn).catch(() => []);
    return {
      repo,
      gated,
      quants: [],
      suggestions: fallback,
      note: `${repo} has no GGUF files, which is what llama-server runs.${fallback.length ? ' Pick one of the GGUF versions below.' : ''}`,
    };
  }
  return {
    repo,
    gated,
    quants,
    selected: pickDefaultQuant(quants, ref.quant, ref.file),
    ...(mmproj.length ? { mmproj } : {}),
    ...(contextLength ? { contextLength } : {}),
    suggestions: [],
    ...(gated ? { note: `${repo} is gated: accept its licence on huggingface.co and add a Hugging Face token under Servers before downloading.` } : {}),
  };
}

/** The download address of a file in a repo. */
export function resolveUrl(repo: string, path: string): string {
  return `${HF}/${repo}/resolve/main/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** The name llama-server serves the model as (its --alias), such as qwen3-8b-q4_k_m. */
export function aliasFor(repo: string, quantLabel: string): string {
  const name = (repo.split('/')[1] ?? repo).replace(/[-_.]?gguf$/i, '');
  const slug = `${name}-${quantLabel}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.slice(0, 80) || 'local-model';
}
