/**
 * Pure helpers for restyling a VRoid VRM's texture atlas while keeping its mesh, rig, spring
 * bones and expressions untouched. All pixel work lives here so it can run in a worker thread.
 *
 * VRoid exports put body, outfit and hair on one square `_MainTex` atlas plus a matching MToon
 * `_ShadeTexture`. We crop atlas regions, have ComfyUI repaint them, paste them back through the
 * original alpha, and rebuild the shade texture from the old shade/main ratio.
 */
import { PNG } from 'pngjs';

export interface Glb {
  json: GltfJson;
  bin: Buffer;
}

interface GltfJson {
  images?: Array<{ bufferView?: number; mimeType?: string; name?: string }>;
  textures?: Array<{ source?: number }>;
  bufferViews: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number }>;
  buffers: Array<{ byteLength: number; uri?: string }>;
  extensions?: {
    VRM?: {
      meta?: { title?: string };
      materialProperties?: Array<{ name?: string; textureProperties?: Record<string, number> }>;
    };
  };
  [key: string]: unknown;
}

export interface RetextureRegion {
  name: string;
  /** Fractions of the atlas: [left, top, right, bottom]. */
  box: [number, number, number, number];
  prompt: string;
}

/** Regions of VRoid's body/outfit/hair atlas, as laid out in the bundled AvatarSample_A. */
export const VROID_ATLAS_REGIONS: RetextureRegion[] = [
  {
    name: 'outfit',
    box: [0, 0, 0.5, 0.46875],
    prompt:
      "Image 1 is a UV texture atlas for an anime character's top or jacket: flat unwrapped sleeve and body " +
      'panels. Repaint it as the top worn by the character in image 2, matching its colours, trim and ' +
      'pattern. Keep every panel exactly where it is, same outline, same seams and folds, flat even ' +
      'lighting, texture-map style, no character, no background objects.',
  },
  {
    name: 'hair',
    box: [0.5, 0, 1, 0.5],
    prompt:
      'Image 1 is a UV texture atlas of anime hair strands: vertical hair strips with a gradient. Repaint ' +
      'the hair in the hair colour of the character in image 2, with slightly darker shading at the roots ' +
      'and lighter highlights toward the tips. Keep every strip, edge and gradient in exactly the same ' +
      'place, texture-map style, no face, no character.',
  },
  {
    name: 'hair_back',
    box: [0.5, 0.75, 0.75, 1],
    prompt:
      'Image 1 is a UV texture of anime hair. Repaint it in the hair colour of the character in image 2, ' +
      'with soft darker vertical strand lines, same layout, texture-map style.',
  },
];

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export function readGlb(buffer: Buffer): Glb {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error('Not a GLB/VRM file.');
  }
  let offset = 12;
  let json: GltfJson | null = null;
  let bin: Buffer = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON) {
      json = JSON.parse(data.toString('utf8')) as GltfJson;
    } else if (type === CHUNK_BIN) {
      bin = Buffer.from(data);
    }
    offset += 8 + length;
  }
  if (!json) {
    throw new Error('GLB has no JSON chunk.');
  }
  return { json, bin };
}

export function writeGlb(glb: Glb): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(glb.json), 'utf8');
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const binPadded = Buffer.concat([glb.bin, Buffer.alloc((4 - (glb.bin.length % 4)) % 4)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);
  const chunkHeader = (length: number, type: number) => {
    const out = Buffer.alloc(8);
    out.writeUInt32LE(length, 0);
    out.writeUInt32LE(type, 4);
    return out;
  };
  return Buffer.concat([
    header,
    chunkHeader(jsonPadded.length, CHUNK_JSON),
    jsonPadded,
    chunkHeader(binPadded.length, CHUNK_BIN),
    binPadded,
  ]);
}

export function getImageBytes(glb: Glb, imageIndex: number): Buffer {
  const image = glb.json.images?.[imageIndex];
  if (!image || image.bufferView === undefined) {
    throw new Error(`Image ${imageIndex} is not embedded in the GLB.`);
  }
  const view = glb.json.bufferViews[image.bufferView];
  const start = view.byteOffset ?? 0;
  return glb.bin.subarray(start, start + view.byteLength);
}

/**
 * Swap the bytes of some images and repack the binary chunk so no stale bytes are left behind.
 * Every bufferView keeps its index, so accessors and images stay valid.
 */
export function replaceImages(glb: Glb, replacements: Map<number, Buffer>): Glb {
  const viewReplacements = new Map<number, Buffer>();
  for (const [imageIndex, bytes] of replacements) {
    const image = glb.json.images?.[imageIndex];
    if (!image || image.bufferView === undefined) {
      throw new Error(`Image ${imageIndex} is not embedded in the GLB.`);
    }
    image.mimeType = 'image/png';
    viewReplacements.set(image.bufferView, bytes);
  }

  const parts: Buffer[] = [];
  let offset = 0;
  const bufferViews = glb.json.bufferViews.map((view, index) => {
    const start = view.byteOffset ?? 0;
    const bytes = viewReplacements.get(index) ?? glb.bin.subarray(start, start + view.byteLength);
    const padding = (4 - (offset % 4)) % 4;
    if (padding) {
      parts.push(Buffer.alloc(padding));
      offset += padding;
    }
    parts.push(bytes);
    const next = { ...view, byteOffset: offset, byteLength: bytes.length };
    offset += bytes.length;
    return next;
  });

  const bin = Buffer.concat(parts);
  const json: GltfJson = {
    ...glb.json,
    bufferViews,
    buffers: glb.json.buffers.map((buffer, index) => (index === 0 ? { ...buffer, byteLength: bin.length } : buffer)),
  };
  return { json, bin };
}

export interface AtlasImages {
  main: number;
  shade: number;
}

/** Find the shared body/outfit/hair atlas through the VRM 0.x MToon material properties. */
export function findVroidAtlas(json: GltfJson): AtlasImages {
  const materials = json.extensions?.VRM?.materialProperties ?? [];
  const body = materials.find((material) => /Body_00_SKIN/.test(material.name ?? ''));
  const props = body?.textureProperties;
  if (!props || props._MainTex === undefined || props._ShadeTexture === undefined) {
    throw new Error('Base VRM is not a VRoid model with a shared body/outfit/hair atlas.');
  }
  const imageFor = (textureIndex: number) => {
    const source = json.textures?.[textureIndex]?.source;
    if (source === undefined) {
      throw new Error(`Texture ${textureIndex} has no image.`);
    }
    return source;
  };
  return { main: imageFor(props._MainTex), shade: imageFor(props._ShadeTexture) };
}

export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function regionPixels(region: RetextureRegion, atlasWidth: number, atlasHeight: number): PixelBox {
  const [left, top, right, bottom] = region.box;
  const x = Math.round(left * atlasWidth);
  const y = Math.round(top * atlasHeight);
  return { x, y, width: Math.round(right * atlasWidth) - x, height: Math.round(bottom * atlasHeight) - y };
}

export interface PreparedRegion {
  name: string;
  prompt: string;
  box: PixelBox;
  /** The crop flattened onto mid grey, as an opaque PNG. */
  png: Buffer;
}

/** Crop each region out of the atlas, ready to upload to ComfyUI. */
export function prepareRegions(vrm: Buffer, regions: RetextureRegion[] = VROID_ATLAS_REGIONS): PreparedRegion[] {
  const glb = readGlb(vrm);
  const atlas = PNG.sync.read(getImageBytes(glb, findVroidAtlas(glb.json).main));
  return regions.map((region) => {
    const box = regionPixels(region, atlas.width, atlas.height);
    const crop = new PNG({ width: box.width, height: box.height });
    for (let row = 0; row < box.height; row += 1) {
      for (let col = 0; col < box.width; col += 1) {
        const src = ((box.y + row) * atlas.width + box.x + col) * 4;
        const dst = (row * box.width + col) * 4;
        const alpha = atlas.data[src + 3] / 255;
        for (let channel = 0; channel < 3; channel += 1) {
          crop.data[dst + channel] = Math.round(atlas.data[src + channel] * alpha + 128 * (1 - alpha));
        }
        crop.data[dst + 3] = 255;
      }
    }
    return { name: region.name, prompt: region.prompt, box, png: PNG.sync.write(crop) };
  });
}

export interface EditedRegion {
  box: PixelBox;
  png: Buffer;
}

/**
 * Paste the repainted regions into the atlas (keeping the original alpha, so only texels that
 * were painted before change), rebuild the shade texture, and return the new VRM.
 */
export function assembleRetexturedVrm(vrm: Buffer, edited: EditedRegion[], title?: string): Buffer {
  const glb = readGlb(vrm);
  const atlasImages = findVroidAtlas(glb.json);
  const main = PNG.sync.read(getImageBytes(glb, atlasImages.main));
  const shade = PNG.sync.read(getImageBytes(glb, atlasImages.shade));
  if (shade.width !== main.width || shade.height !== main.height) {
    throw new Error('Shade texture does not match the main atlas size.');
  }

  const originalMain = Buffer.from(main.data);

  for (const region of edited) {
    const image = PNG.sync.read(region.png);
    const { x, y, width, height } = region.box;
    for (let row = 0; row < height; row += 1) {
      // Nearest-neighbour sampling covers the rare case where ComfyUI returns a slightly different size.
      const srcRow = Math.min(image.height - 1, Math.floor((row * image.height) / height));
      for (let col = 0; col < width; col += 1) {
        const srcCol = Math.min(image.width - 1, Math.floor((col * image.width) / width));
        const src = (srcRow * image.width + srcCol) * 4;
        const dst = ((y + row) * main.width + x + col) * 4;
        main.data[dst] = image.data[src];
        main.data[dst + 1] = image.data[src + 1];
        main.data[dst + 2] = image.data[src + 2];
      }
    }
  }

  // MToon shade: carry over the original shade/main ratio per texel.
  for (let index = 0; index < main.data.length; index += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const ratio = Math.min(1.5, (shade.data[index + channel] + 1) / (originalMain[index + channel] + 1));
      shade.data[index + channel] = Math.min(255, Math.round(main.data[index + channel] * ratio));
    }
    shade.data[index + 3] = 255;
  }

  const result = replaceImages(
    glb,
    new Map([
      [atlasImages.main, PNG.sync.write(main)],
      [atlasImages.shade, PNG.sync.write(shade, { colorType: 2 })],
    ]),
  );
  const meta = result.json.extensions?.VRM?.meta;
  if (title && meta) {
    meta.title = title;
  }
  return writeGlb(result);
}
