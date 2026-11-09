/**
 * Bounding box of a glTF scene from its JSON alone: the POSITION accessors' min/max of every mesh,
 * carried through the node transforms. No geometry is read, so no three.js is needed here.
 */
export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

type Mat4 = number[]; // column-major, as glTF stores it

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col += 1)
    for (let row = 0; row < 4; row += 1)
      for (let k = 0; k < 4; k += 1) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
  return out;
}

function fromTrs(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): Mat4 {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface Gltf {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: GltfNode[];
  meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number> }> }>;
  accessors?: Array<{ min?: number[]; max?: number[] }>;
}

/** Null when the file has no mesh with a usable POSITION range. */
export function gltfBounds(json: unknown): Bounds | null {
  const gltf = json as Gltf;
  const nodes = gltf.nodes ?? [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const visited = new Set<number>();

  const addMesh = (meshIndex: number, world: Mat4) => {
    for (const primitive of gltf.meshes?.[meshIndex]?.primitives ?? []) {
      const accessor = gltf.accessors?.[primitive.attributes?.POSITION ?? -1];
      if (!accessor?.min || !accessor.max || accessor.min.length < 3 || accessor.max.length < 3) continue;
      for (let corner = 0; corner < 8; corner += 1) {
        const p = [corner & 1 ? accessor.max[0] : accessor.min[0], corner & 2 ? accessor.max[1] : accessor.min[1], corner & 4 ? accessor.max[2] : accessor.min[2]];
        for (let axis = 0; axis < 3; axis += 1) {
          const v = world[axis] * p[0] + world[4 + axis] * p[1] + world[8 + axis] * p[2] + world[12 + axis];
          if (v < min[axis]) min[axis] = v;
          if (v > max[axis]) max[axis] = v;
        }
      }
    }
  };
  const walk = (index: number, parent: Mat4, depth: number) => {
    const node = nodes[index];
    if (!node || depth > 64 || visited.has(index)) return;
    visited.add(index);
    const local = node.matrix && node.matrix.length === 16 ? node.matrix : fromTrs(node.translation, node.rotation, node.scale);
    const world = multiply(parent, local);
    if (node.mesh !== undefined) addMesh(node.mesh, world);
    for (const child of node.children ?? []) walk(child, world, depth + 1);
    visited.delete(index);
  };

  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? (gltf.scenes ? [] : nodes.map((_, i) => i));
  for (const root of roots) walk(root, IDENTITY, 0);
  if (!Number.isFinite(min[0]) || !Number.isFinite(max[0])) return null;
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

interface GlbFile {
  json: Record<string, unknown>;
  bin: Buffer | null;
}

/** The JSON and binary chunks of a .glb (12-byte header, then length-prefixed chunks), or null when it is not a valid one. */
export function parseGlb(data: Buffer): GlbFile | null {
  if (data.length < 20 || data.readUInt32LE(0) !== GLB_MAGIC || data.readUInt32LE(4) !== 2) return null;
  const end = Math.min(data.length, data.readUInt32LE(8));
  let json: Record<string, unknown> | null = null;
  let bin: Buffer | null = null;
  for (let offset = 12; offset + 8 <= end; ) {
    const length = data.readUInt32LE(offset);
    const type = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > end) return null;
    if (type === CHUNK_JSON && json === null) {
      try {
        const parsed: unknown = JSON.parse(data.subarray(start, start + length).toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null) return null;
        json = parsed as Record<string, unknown>;
      } catch {
        return null;
      }
    } else if (type === CHUNK_BIN && bin === null) {
      bin = data.subarray(start, start + length);
    }
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  return json ? { json, bin } : null;
}

interface BufferView {
  byteOffset?: number;
  byteStride?: number;
  byteLength?: number;
}
interface RawAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType?: number;
  count?: number;
  type?: string;
  min?: number[];
  max?: number[];
}

/** Fills in min/max of float VEC3 POSITION accessors that have none, from the binary chunk. */
function fillPositionRanges(json: Record<string, unknown>, bin: Buffer | null): void {
  const accessors = json.accessors as RawAccessor[] | undefined;
  const views = json.bufferViews as BufferView[] | undefined;
  const meshes = json.meshes as Array<{ primitives?: Array<{ attributes?: Record<string, number> }> }> | undefined;
  if (!accessors || !views || !bin || !meshes) return;
  for (const mesh of meshes)
    for (const primitive of mesh.primitives ?? []) {
      const accessor = accessors[primitive.attributes?.POSITION ?? -1];
      if (!accessor || (accessor.min && accessor.max)) continue;
      const view = views[accessor.bufferView ?? -1];
      if (!view || accessor.componentType !== 5126 || accessor.type !== 'VEC3' || !accessor.count) continue;
      const stride = view.byteStride && view.byteStride >= 12 ? view.byteStride : 12;
      const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      if (base + stride * (accessor.count - 1) + 12 > bin.length) continue;
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < accessor.count; i += 1)
        for (let axis = 0; axis < 3; axis += 1) {
          const v = bin.readFloatLE(base + i * stride + axis * 4);
          if (!Number.isFinite(v)) continue;
          if (v < min[axis]) min[axis] = v;
          if (v > max[axis]) max[axis] = v;
        }
      if (min.every(Number.isFinite) && max.every(Number.isFinite)) {
        accessor.min = min;
        accessor.max = max;
      }
    }
}

/** Bounding box of a binary glTF (.glb), the same as `gltfBounds` gives for the JSON; null when it has no usable mesh. */
export function glbBounds(data: Buffer): Bounds | null {
  const glb = parseGlb(data);
  if (!glb) return null;
  fillPositionRanges(glb.json, glb.bin);
  return gltfBounds(glb.json);
}
