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
