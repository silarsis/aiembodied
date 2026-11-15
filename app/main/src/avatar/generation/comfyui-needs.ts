/**
 * The model files a ComfyUI graph loads, found from its loader nodes' inputs. The model controller
 * uses them to send a job to a machine that has every file (see `needs` on a lease).
 */
import type { ComfyGraph } from './comfyui-client.js';

const LOADER_INPUTS = /^(ckpt_name|unet_name|vae_name|lora_name|control_net_name|model_name|clip_name\d?|bg_removal_name|style_model_name|upscale_model_name|clip_vision_name|text_encoder_name)$/;

/** File names (as written in the graph, folders kept) of every model the graph loads, de-duplicated and sorted. */
export function graphModelFiles(graph: ComfyGraph): string[] {
  const files = new Set<string>();
  for (const node of Object.values(graph)) {
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      if (LOADER_INPUTS.test(key) && typeof value === 'string' && value.includes('.')) files.add(value);
    }
  }
  return [...files].sort();
}

/** The union of the model files of several graphs. */
export function graphsModelFiles(...graphs: ComfyGraph[]): string[] {
  return [...new Set(graphs.flatMap(graphModelFiles))].sort();
}
