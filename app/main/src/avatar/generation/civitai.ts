/**
 * Civitai lookups for model downloads: turn a pasted link or AIR into the file to fetch, the
 * ComfyUI folder it belongs in, and what kind of model it is.
 *
 * Accepted references:
 *   https://civitai.com/models/4201/realistic-vision?modelVersionId=130072
 *   https://civitai.com/models/4201            (latest version)
 *   https://civitai.com/api/download/models/130072?fileId=54825   (that file of that version)
 *   the same on civitai.green or civitai.red
 *   urn:air:sdxl:checkpoint:civitai:4201@130072   (or civitai:4201@130072)
 *   4201@130072, or a bare model id
 */

export interface CivitaiRef {
  modelId?: number;
  versionId?: number;
  /** A download link's fileId: that file rather than the version's primary one. */
  fileId?: number;
}

export interface CivitaiFile {
  id?: number;
  name: string;
  sizeKB: number;
  downloadUrl: string;
  sha256?: string;
  primary: boolean;
  format?: string;
}

export interface CivitaiVersion {
  id: number;
  name: string;
  baseModel: string;
  files: CivitaiFile[];
}

export interface CivitaiModel {
  modelId: number;
  name: string;
  /** Civitai's type: Checkpoint, LORA, VAE, TextualInversion, Controlnet, Upscaler… */
  type: string;
  versions: CivitaiVersion[];
  /** The version the reference named, else the newest. */
  versionId: number;
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
}

const API = 'https://civitai.com/api/v1';
/** civitai.com and its sister sites (green for SFW-only, red); they share one API. */
const CIVITAI_HOST = /(^|\.)civitai\.(com|green|red)$/i;

export function parseCivitaiRef(text: string): CivitaiRef | null {
  const value = text.trim();
  if (!value) return null;
  const air = /(?:^|:)civitai:(\d+)(?:@(\d+))?$/i.exec(value);
  if (air) return { modelId: Number(air[1]), ...(air[2] ? { versionId: Number(air[2]) } : {}) };
  const short = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (short) return { modelId: Number(short[1]), ...(short[2] ? { versionId: Number(short[2]) } : {}) };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!CIVITAI_HOST.test(url.hostname)) return null;
  const download = /\/api\/download\/models\/(\d+)/.exec(url.pathname);
  if (download) {
    const fileId = url.searchParams.get('fileId');
    return { versionId: Number(download[1]), ...(fileId && /^\d+$/.test(fileId) ? { fileId: Number(fileId) } : {}) };
  }
  const model = /\/models\/(\d+)/.exec(url.pathname);
  const version = url.searchParams.get('modelVersionId');
  if (!model && !version) return null;
  return {
    ...(model ? { modelId: Number(model[1]) } : {}),
    ...(version && /^\d+$/.test(version) ? { versionId: Number(version) } : {}),
  };
}

/** Civitai type → ComfyUI models folder. */
export function comfyFolderFor(type: string): string | null {
  switch (type.toLowerCase()) {
    case 'checkpoint':
      return 'checkpoints';
    case 'lora':
    case 'locon':
    case 'dora':
      return 'loras';
    case 'vae':
      return 'vae';
    case 'textualinversion':
      return 'embeddings';
    case 'controlnet':
      return 'controlnet';
    case 'upscaler':
      return 'upscale_models';
    case 'hypernetwork':
      return 'hypernetworks';
    default:
      return null;
  }
}

/** The image kind the app's workflows know, from Civitai's base model name. */
export function kindForBaseModel(baseModel: string): string | undefined {
  const base = baseModel.toLowerCase();
  if (/sdxl|pony|illustrious|noobai|playground/.test(base)) return 'sdxl';
  if (/^sd 1\.[45]|sd 1\.5|sd 1\.4/.test(base)) return 'sd1';
  return undefined;
}

export async function lookupCivitai(ref: CivitaiRef, apiKey: string | undefined, fetchFn: typeof fetch = fetch): Promise<CivitaiModel> {
  const get = async (path: string) => {
    const response = await fetchFn(`${API}${path}`, {
      headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) throw new Error('Civitai has no model with that id.');
    if (response.status === 401 || response.status === 403) throw new Error('Civitai refused the request. Check the Civitai API key.');
    if (!response.ok) throw new Error(`Civitai answered ${response.status}.`);
    return (await response.json()) as Record<string, unknown>;
  };
  let modelId = ref.modelId;
  if (!modelId && ref.versionId) {
    const version = await get(`/model-versions/${ref.versionId}`);
    modelId = typeof version.modelId === 'number' ? version.modelId : undefined;
    if (!modelId) throw new Error('Civitai did not say which model that version belongs to.');
  }
  if (!modelId) throw new Error('Paste a Civitai model link or AIR.');
  const body = await get(`/models/${modelId}`);
  const versions = (Array.isArray(body.modelVersions) ? body.modelVersions : []).map(toVersion).filter((v): v is CivitaiVersion => v !== null);
  if (!versions.length) throw new Error('That Civitai model has no downloadable versions.');
  const versionId = ref.versionId && versions.some((v) => v.id === ref.versionId) ? ref.versionId : versions[0].id;
  return {
    modelId,
    name: typeof body.name === 'string' ? body.name : `Civitai model ${modelId}`,
    type: typeof body.type === 'string' ? body.type : 'Other',
    versions,
    versionId,
  };
}

/** Pick the file to fetch from a looked-up model and say where it goes. */
export function planCivitaiDownload(model: CivitaiModel, versionId = model.versionId, fileId?: number): CivitaiDownloadPlan {
  const version = model.versions.find((entry) => entry.id === versionId) ?? model.versions[0];
  const files = version.files.filter((file) => /\.(safetensors|gguf|ckpt|pt|pth|bin)$/i.test(file.name));
  // The file a download link named, else the primary file, SafeTensors over pickled formats.
  const file =
    (fileId !== undefined ? files.find((entry) => entry.id === fileId) : undefined) ??
    files.find((entry) => entry.primary && /\.safetensors$/i.test(entry.name)) ??
    files.find((entry) => /\.safetensors$/i.test(entry.name)) ??
    files.find((entry) => entry.primary) ??
    files[0];
  if (!file) throw new Error('That version has no model file to download.');
  const folder = comfyFolderFor(model.type);
  if (!folder) throw new Error(`Civitai ${model.type} models don't have a ComfyUI folder the app knows.`);
  const kind = model.type.toLowerCase() === 'checkpoint' ? kindForBaseModel(version.baseModel) : undefined;
  let note: string | undefined;
  if (model.type.toLowerCase() !== 'checkpoint') note = `A ${model.type} isn't an image model on its own; the image step won't list it.`;
  else if (!kind) note = `The image step has no workflow for ${version.baseModel || 'this base model'} yet.`;
  else if (!/\.safetensors$/i.test(file.name)) note = 'Only .safetensors files can be listed as image models.';
  return {
    modelId: model.modelId,
    versionId: version.id,
    title: `${model.name} · ${version.name}`,
    type: model.type,
    baseModel: version.baseModel,
    folder,
    file,
    ...(kind ? { kind } : {}),
    ...(note ? { note } : {}),
  };
}

function toVersion(raw: unknown): CivitaiVersion | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'number') return null;
  const files = (Array.isArray(entry.files) ? entry.files : [])
    .map((value): CivitaiFile | null => {
      if (!value || typeof value !== 'object') return null;
      const file = value as Record<string, unknown>;
      if (typeof file.name !== 'string' || typeof file.downloadUrl !== 'string') return null;
      const hashes = file.hashes && typeof file.hashes === 'object' ? (file.hashes as Record<string, unknown>) : {};
      const metadata = file.metadata && typeof file.metadata === 'object' ? (file.metadata as Record<string, unknown>) : {};
      return {
        ...(typeof file.id === 'number' ? { id: file.id } : {}),
        name: file.name,
        sizeKB: typeof file.sizeKB === 'number' ? file.sizeKB : 0,
        downloadUrl: file.downloadUrl,
        primary: file.primary === true,
        ...(typeof hashes.SHA256 === 'string' ? { sha256: hashes.SHA256.toLowerCase() } : {}),
        ...(typeof metadata.format === 'string' ? { format: metadata.format } : {}),
      };
    })
    .filter((file): file is CivitaiFile => file !== null);
  return {
    id: entry.id,
    name: typeof entry.name === 'string' ? entry.name : String(entry.id),
    baseModel: typeof entry.baseModel === 'string' ? entry.baseModel : '',
    files,
  };
}
