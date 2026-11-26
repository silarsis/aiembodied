/**
 * Scales a generated GLB to real metres. The mesh from the 3D step has no real size, so one uniform scale
 * makes its height match the piece's, and a translation puts its bottom on y=0 centred on x and z. Both are
 * baked into a new root node, so any consumer gets metres without scaling it.
 */
import { glbBounds, parseGlb, type Bounds } from '../rooms/asset-library/gltf-bounds.js';
import type { FurnitureFit } from '../shared/furniture/types.js';

type Vec3 = [number, number, number];

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** The scale that makes the height `height` metres, the offset that grounds and centres the result, and its size. */
export function fitBounds(bounds: Bounds, height: number): FurnitureFit & { dimensions: Vec3 } {
  if (!(bounds.size[1] > 1e-6) || !(height > 0)) throw new Error('The model has no height to scale.');
  const scale = height / bounds.size[1];
  return {
    scale,
    offset: [-((bounds.min[0] + bounds.max[0]) / 2) * scale, -bounds.min[1] * scale, -((bounds.min[2] + bounds.max[2]) / 2) * scale],
    dimensions: [round(bounds.size[0] * scale), round(bounds.size[1] * scale), round(bounds.size[2] * scale)],
  };
}

function padded(data: Buffer, fill: number): Buffer {
  const rest = (4 - (data.length % 4)) % 4;
  return rest ? Buffer.concat([data, Buffer.alloc(rest, fill)]) : data;
}

/** A .glb from its JSON and binary chunk. */
export function writeGlb(json: Record<string, unknown>, bin: Buffer | null): Buffer {
  const jsonChunk = padded(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binChunk = bin ? padded(bin, 0) : null;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + (binChunk ? 8 + binChunk.length : 0), 8);
  const chunk = (type: number, body: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(body.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, body]);
  };
  return Buffer.concat([header, chunk(CHUNK_JSON, jsonChunk), ...(binChunk ? [chunk(CHUNK_BIN, binChunk)] : [])]);
}

/** The same model under a new root node carrying the scale and translation. */
export function bakeTransform(glb: Buffer, fit: FurnitureFit): Buffer {
  const parsed = parseGlb(glb);
  if (!parsed) throw new Error('The 3D step did not return a valid model.');
  const json = parsed.json as {
    scene?: number;
    scenes?: Array<{ nodes?: number[] }>;
    nodes?: Array<Record<string, unknown>>;
  };
  const scene = json.scenes?.[json.scene ?? 0];
  if (!scene) throw new Error('The model has no scene to scale.');
  const nodes = json.nodes ?? (json.nodes = []);
  nodes.push({ name: 'furniture', children: scene.nodes ?? [], scale: [fit.scale, fit.scale, fit.scale], translation: fit.offset });
  scene.nodes = [nodes.length - 1];
  return writeGlb(parsed.json, parsed.bin);
}

export interface FittedModel extends FurnitureFit {
  glb: Buffer;
  /** Width, height, depth in metres of what `glb` holds. */
  dimensions: Vec3;
}

/** Scales a raw GLB to `height` metres tall, standing on y=0. Throws when it holds no usable mesh. */
export function fitGlb(raw: Buffer, height: number): FittedModel {
  const bounds = glbBounds(raw);
  if (!bounds || !bounds.size.every((n) => Number.isFinite(n) && n > 1e-3)) throw new Error('The 3D step did not produce a usable model.');
  const { dimensions, ...fit } = fitBounds(bounds, height);
  return { ...fit, dimensions, glb: bakeTransform(raw, fit) };
}
