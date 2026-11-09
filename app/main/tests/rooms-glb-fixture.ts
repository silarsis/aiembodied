/** Builds a tiny binary glTF (.glb) for tests: one triangle-soup mesh around the given corners. */
export function makeGlb(options: { min: [number, number, number]; max: [number, number, number]; accessorRange?: boolean; node?: Record<string, unknown> }): Buffer {
  const { min, max } = options;
  const corners: number[][] = [];
  for (let corner = 0; corner < 8; corner += 1) corners.push([corner & 1 ? max[0] : min[0], corner & 2 ? max[1] : min[1], corner & 4 ? max[2] : min[2]]);
  const bin = Buffer.alloc(corners.length * 12);
  corners.forEach((p, i) => p.forEach((v, axis) => bin.writeFloatLE(v, i * 12 + axis * 4)));
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...(options.node ?? {}) }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: corners.length, type: 'VEC3', ...(options.accessorRange === false ? {} : { min, max }) }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const chunk = (type: number, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(body.length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, body]);
  };
  return Buffer.concat([header, chunk(0x4e4f534a, jsonBytes), chunk(0x004e4942, bin)]);
}
