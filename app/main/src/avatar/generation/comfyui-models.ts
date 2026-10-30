/**
 * Picks the Qwen-Image 2.1 files to use from what the ComfyUI server actually has installed.
 * The graphs use Qwen-Image 2.1's own nodes (QwenImage21Cache, TextEncodeQwenImage21), so only
 * that family will do; within it the defaults win, then the lightest quantisation, since the
 * job shares bija's memory with the local LLM.
 */
import type { ComfyUIClient } from './comfyui-client.js';
import { DEFAULT_QWEN_IMAGE_MODELS, type QwenImageModels } from './graphs.js';

interface ModelPart {
  key: keyof QwenImageModels;
  label: string;
  /** ComfyUI model folders to look in; the second is the older name for the same folder. */
  folders: string[];
  matches: RegExp;
  excludes?: RegExp;
}

const PARTS: ModelPart[] = [
  {
    key: 'unet',
    label: 'diffusion model',
    folders: ['diffusion_models', 'unet'],
    matches: /qwen[\W_]*image[\W_]*2[._]?1/i,
    excludes: /vae|lora|lightning|controlnet/i,
  },
  { key: 'clip', label: 'text encoder', folders: ['text_encoders', 'clip'], matches: /qwen[\W_]*3[\W_]*vl/i },
  { key: 'vae', label: 'VAE', folders: ['vae'], matches: /qwen[\W_]*image[\W_]*2[._]?1.*vae/i },
];

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

/** Lower is better: the default file, then int8, fp8, anything else, full precision last. */
function rank(file: string, preferred: string): number {
  const name = baseName(file).toLowerCase();
  if (name === preferred.toLowerCase()) return 0;
  if (/int8/.test(name)) return 1;
  if (/fp8|e4m3|e5m2/.test(name)) return 2;
  if (/bf16|fp16|fp32/.test(name)) return 4;
  return 3;
}

/** Best match for each part from ComfyUI's model lists, or null when a part has none. */
export function chooseQwenImageModels(
  available: Record<string, string[]>,
  preferred: QwenImageModels = DEFAULT_QWEN_IMAGE_MODELS,
): { models: QwenImageModels; missing: string[] } {
  const models = { ...preferred };
  const missing: string[] = [];
  for (const part of PARTS) {
    const candidates = part.folders
      .flatMap((folder) => available[folder] ?? [])
      // UNETLoader and CLIPLoader can't read GGUF files without a custom node.
      .filter((file) => part.matches.test(file) && !part.excludes?.test(file) && !/\.gguf$/i.test(file))
      .sort((a, b) => rank(a, preferred[part.key]) - rank(b, preferred[part.key]) || a.length - b.length);
    if (candidates.length === 0) {
      missing.push(`${part.label} (models/${part.folders[0]})`);
    } else {
      models[part.key] = candidates[0];
    }
  }
  return { models, missing };
}

/** Ask ComfyUI what it has and pick from that; throws when a Qwen-Image 2.1 part is missing. */
export async function pickQwenImageModels(comfy: Pick<ComfyUIClient, 'listModels'>): Promise<QwenImageModels> {
  const folders = [...new Set(PARTS.flatMap((part) => part.folders))];
  const lists = await Promise.all(folders.map((folder) => comfy.listModels(folder)));
  const available = Object.fromEntries(folders.map((folder, index) => [folder, lists[index]]));
  const { models, missing } = chooseQwenImageModels(available);
  if (missing.length > 0) {
    throw new Error(
      `ComfyUI has no Qwen-Image 2.1 ${missing.join(', ')}. Install the "Qwen Image 2.1" template's models in ComfyUI and try again.`,
    );
  }
  return models;
}
