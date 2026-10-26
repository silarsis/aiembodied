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
  /** Edit instruction; `{description}` is replaced with the user's avatar description. */
  prompt: string;
}

/**
 * Regions of VRoid's body/outfit/hair atlas, as laid out in the bundled AvatarSample_A. The
 * sleeves and body panels are separate regions: cropped together, Qwen kept redrawing the two
 * sleeve panels as little pictures of the described garment.
 */
export const VROID_ATLAS_REGIONS: RetextureRegion[] = [
  {
    name: 'outfit_body',
    // Atlas rows 1000–1920: front and back body panels.
    box: [0, 0.244140625, 0.5, 0.46875],
    prompt:
      'Edit this image. It is a flat UV texture atlas of the front and back body panels of a 3D anime ' +
      "character's top, on a grey background. Recolour these panels so the clothing matches this " +
      'description: "{description}". Use the main fabric colour for the large areas and the trim or accent ' +
      'colour for the edges, hems, ribbons and stripes. This is a recolour only: do not draw any garments, ' +
      'people, hoods, pockets or new objects, and do not move or reshape anything. Every panel keeps exactly ' +
      'the same outline, position, seams and folds, and the grey background stays grey.',
  },
  {
    name: 'outfit_sleeves',
    // Atlas rows 0–1000: the two sleeve panels.
    box: [0, 0, 0.5, 0.244140625],
    prompt:
      'Edit this image. It is a flat fabric texture: two unwrapped sleeve panels from a 3D model, on a grey ' +
      'background. Recolour the fabric to the main colour of the top in this description: "{description}", ' +
      'with the trim or accent colour only on the ribbed cuff band along the bottom edge. Keep the same ' +
      'folds and shading. This is a recolour only: do not draw any clothing, people, hoods, pockets or ' +
      'objects, and do not move or reshape the panels. The grey background stays grey.',
  },
  {
    name: 'hair',
    box: [0.5, 0, 1, 0.5],
    prompt:
      'Edit this image. It is a flat UV texture atlas of anime hair strands (vertical strips with a ' +
      'gradient). Recolour the hair to match this description: "{description}". Darker at the roots, ' +
      'lighter toward the tips. Keep every strip, edge, gradient and the grey background exactly where ' +
      'they are. Flat texture map, not a picture of a person.',
  },
  {
    name: 'hair_back',
    box: [0.5, 0.75, 0.75, 1],
    prompt:
      'Edit this image. It is a flat UV texture of anime hair. Recolour the hair to match this ' +
      'description: "{description}", with soft darker vertical strand lines. Same layout. Flat texture ' +
      'map, not a picture of a person.',
  },
];

/** Put the user's description into a region's edit instruction. */
export function regionPrompt(template: string, description: string): string {
  const flat = description.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  return template.replaceAll('{description}', flat);
}

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

const LAYOUT_GRID = 64;
const FLATTEN_GREY = 128;

interface GridImage {
  luma: Float64Array;
  /** Fraction of each cell that is painted (not the flat grey `prepareRegions` puts behind). */
  painted: Float64Array;
}

function toGrid(png: Buffer): GridImage {
  const image = PNG.sync.read(png);
  const luma = new Float64Array(LAYOUT_GRID * LAYOUT_GRID);
  const painted = new Float64Array(LAYOUT_GRID * LAYOUT_GRID);
  const counts = new Float64Array(LAYOUT_GRID * LAYOUT_GRID);
  for (let row = 0; row < image.height; row += 1) {
    const gridRow = Math.min(LAYOUT_GRID - 1, Math.floor((row * LAYOUT_GRID) / image.height));
    for (let col = 0; col < image.width; col += 1) {
      const gridCol = Math.min(LAYOUT_GRID - 1, Math.floor((col * LAYOUT_GRID) / image.width));
      const index = (row * image.width + col) * 4;
      const [red, green, blue] = [image.data[index], image.data[index + 1], image.data[index + 2]];
      const cell = gridRow * LAYOUT_GRID + gridCol;
      luma[cell] += 0.299 * red + 0.587 * green + 0.114 * blue;
      if (red !== FLATTEN_GREY || green !== FLATTEN_GREY || blue !== FLATTEN_GREY) {
        painted[cell] += 1;
      }
      counts[cell] += 1;
    }
  }
  for (let cell = 0; cell < luma.length; cell += 1) {
    luma[cell] /= Math.max(1, counts[cell]);
    painted[cell] /= Math.max(1, counts[cell]);
  }
  return { luma, painted };
}

/** Luminance edge strength on the coarse grid, so colour changes matter less than shapes. */
function edgeMap(luma: Float64Array): Float64Array {
  const edges = new Float64Array(LAYOUT_GRID * LAYOUT_GRID);
  const at = (row: number, col: number) => luma[row * LAYOUT_GRID + col];
  for (let row = 1; row < LAYOUT_GRID - 1; row += 1) {
    for (let col = 1; col < LAYOUT_GRID - 1; col += 1) {
      edges[row * LAYOUT_GRID + col] = Math.hypot(at(row, col + 1) - at(row, col - 1), at(row + 1, col) - at(row - 1, col));
    }
  }
  return edges;
}

/**
 * How well a repainted crop keeps the original's layout: correlation of coarse edge maps over
 * the cells that are painted in the original (the only texels that get pasted back), from -1 to
 * 1. A true repaint scores high; an image where the model drew a character or a garment instead
 * of editing the texture scores low. `original` is a crop from `prepareRegions`.
 */
export function layoutSimilarity(original: Buffer, repainted: Buffer): number {
  const source = toGrid(original);
  const a = edgeMap(source.luma);
  const b = edgeMap(toGrid(repainted).luma);
  const cells: number[] = [];
  for (let cell = 0; cell < a.length; cell += 1) {
    if (source.painted[cell] >= 0.5) {
      cells.push(cell);
    }
  }
  if (cells.length === 0) {
    return 0;
  }
  let meanA = 0;
  let meanB = 0;
  for (const cell of cells) {
    meanA += a[cell];
    meanB += b[cell];
  }
  meanA /= cells.length;
  meanB /= cells.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (const cell of cells) {
    covariance += (a[cell] - meanA) * (b[cell] - meanB);
    varianceA += (a[cell] - meanA) ** 2;
    varianceB += (b[cell] - meanB) ** 2;
  }
  return varianceA && varianceB ? covariance / Math.sqrt(varianceA * varianceB) : 0;
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
