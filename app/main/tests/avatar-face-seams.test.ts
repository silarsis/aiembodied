import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readGlb } from '../src/avatar/generation/vrm-retexture.js';

interface Primitive {
  attributes: Record<string, number>;
  indices: number;
  targets?: Array<Record<string, number>>;
}
interface Document {
  accessors: Array<{
    componentType: number;
    type: string;
    count: number;
    bufferView?: number;
    byteOffset?: number;
    sparse?: {
      count: number;
      indices: { componentType: number; bufferView: number; byteOffset?: number };
      values: { bufferView: number; byteOffset?: number };
    };
  }>;
  bufferViews: Array<{ byteOffset?: number; byteStride?: number }>;
  nodes: Array<{
    name?: string;
    mesh?: number;
    skin?: number;
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }>;
  meshes: Array<{ primitives: Primitive[] }>;
  skins: Array<{ joints: number[] }>;
  extensions: { VRMC_vrm: { humanoid: { humanBones: { head: { node: number } } } } };
}
const bytes: Record<number, number> = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function accessor(doc: Document, bin: Buffer, index: number) {
  const item = doc.accessors[index],
    width = components[item.type],
    size = bytes[item.componentType];
  const scalar = (offset: number, type: number) =>
    type === 5126
      ? bin.readFloatLE(offset)
      : type === 5125
        ? bin.readUInt32LE(offset)
        : type === 5123
          ? bin.readUInt16LE(offset)
          : bin.readUInt8(offset);
  const values = Array.from({ length: item.count }, () => Array<number>(width).fill(0));
  if (item.bufferView !== undefined) {
    const view = doc.bufferViews[item.bufferView];
    const start = (view.byteOffset ?? 0) + (item.byteOffset ?? 0);
    for (let i = 0; i < item.count; i++)
      for (let j = 0; j < width; j++)
        values[i][j] = scalar(
          start + i * (view.byteStride ?? width * size) + j * size,
          item.componentType,
        );
  }
  if (item.sparse) {
    const sparse = item.sparse;
    const indices =
      (doc.bufferViews[sparse.indices.bufferView].byteOffset ?? 0) +
      (sparse.indices.byteOffset ?? 0);
    const start =
      (doc.bufferViews[sparse.values.bufferView].byteOffset ?? 0) + (sparse.values.byteOffset ?? 0);
    for (let i = 0; i < sparse.count; i++) {
      const vertex = scalar(
        indices + i * bytes[sparse.indices.componentType],
        sparse.indices.componentType,
      );
      for (let j = 0; j < width; j++)
        values[vertex][j] = scalar(start + (i * width + j) * size, item.componentType);
    }
  }
  return values;
}
const key = (point: number[]) => point.map((value) => Math.round(value * 1e6)).join(',');
const edgeKey = (a: string, b: string) => (a < b ? `${a}/${b}` : `${b}/${a}`);

describe('exported face seams on the five controlled comparison characters', () => {
  for (const id of ['ada', 'malik', 'mei', 'oscar', 'ines']) {
    it(`${id}: stitches both edges and keeps them closed under every expression and head motion`, async () => {
      const directory = path.resolve('../../artifacts/face-seam-review-2026-10-31', id);
      const glb = readGlb(await readFile(path.join(directory, 'avatar.vrm')));
      const doc = glb.json as unknown as Document;
      const headNode = doc.extensions.VRMC_vrm.humanoid.humanBones.head.node;
      const joinedEdges = new Map<string, number>();
      const meshPoints = new Map<string, Set<string>>();
      const pinned = new Map<string, boolean>();
      const skins = new Set<number>();
      let bridgeEdges: Map<string, number> | undefined;
      for (const name of ['GeneratedBody', 'FittedFace', 'FaceBoundaryBlend']) {
        const node = doc.nodes.find((n) => n.name === name)!;
        expect(node, `${name} exists`).toBeDefined();
        skins.add(node.skin!);
        expect(node.matrix).toBeUndefined();
        expect(node.translation ?? [0, 0, 0]).toEqual([0, 0, 0]);
        expect(node.rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1]);
        expect(node.scale ?? [1, 1, 1]).toEqual([1, 1, 1]);
        const headJoint = doc.skins[node.skin!].joints.indexOf(headNode);
        const points = new Set<string>();
        meshPoints.set(name, points);
        for (const primitive of doc.meshes[node.mesh!].primitives) {
          const position = accessor(doc, glb.bin, primitive.attributes.POSITION);
          const joints = accessor(doc, glb.bin, primitive.attributes.JOINTS_0);
          const weights = accessor(doc, glb.bin, primitive.attributes.WEIGHTS_0);
          const keys = position.map(key);
          keys.forEach((k) => points.add(k));
          const indices = accessor(doc, glb.bin, primitive.indices).flat();
          const edges = new Map<string, number>();
          for (let i = 0; i < indices.length; i += 3)
            for (let j = 0; j < 3; j++) {
              const edge = edgeKey(keys[indices[i + j]], keys[indices[i + ((j + 1) % 3)]]);
              edges.set(edge, (edges.get(edge) ?? 0) + 1);
              joinedEdges.set(edge, (joinedEdges.get(edge) ?? 0) + 1);
            }
          if (name === 'FaceBoundaryBlend') bridgeEdges = edges;
          const targets = (primitive.targets ?? [])
            .filter((target) => target.POSITION !== undefined)
            .map((target) => accessor(doc, glb.bin, target.POSITION));
          for (let i = 0; i < keys.length; i++) {
            const followsHead =
              Math.abs(weights[i].reduce((sum, weight) => sum + weight, 0) - 1) < 1e-6 &&
              weights[i].every(
                (weight, slot) =>
                  weight < 1e-6 || (joints[i][slot] === headJoint && weight > 0.99999),
              );
            const fixed =
              followsHead &&
              targets.every((target) => target[i].every((delta) => Math.abs(delta) < 1e-6));
            pinned.set(keys[i], (pinned.get(keys[i]) ?? true) && fixed);
          }
        }
      }
      const face = meshPoints.get('FittedFace')!,
        body = meshPoints.get('GeneratedBody')!,
        bridge = meshPoints.get('FaceBoundaryBlend')!;
      expect(skins.size, 'shared inverse bind transforms for both sides').toBe(1);
      expect(bridge.size).toBeGreaterThan(70);
      for (const point of bridge) {
        expect(face.has(point) || body.has(point), 'every bridge point meets a real surface').toBe(
          true,
        );
        expect(
          pinned.get(point),
          'shared positions have identical head weights and no expression drift',
        ).toBe(true);
      }
      const boundary = [...bridgeEdges!].filter(([, count]) => count === 1);
      expect(boundary.length).toBe(bridge.size);
      for (const [edge] of boundary)
        expect(joinedEdges.get(edge), 'each join edge has exactly two incident triangles').toBe(2);
      const report = JSON.parse(await readFile(path.join(directory, 'avatar.report.json'), 'utf8'));
      expect(report.faceFit.seam.maxJoinGapMeters).toBeLessThan(1e-6);
      expect(report.faceFit.seam.matchedSkinPixels).toBeGreaterThan(1000);
      expect(report.faceFit.blinkClosureGapMeters).toEqual([0, 0]);
    }, 15000);
  }
});
