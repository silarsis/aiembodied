import fs from 'fs';

const filePath = 'c:/Users/kevin/repos/aiembodied/.dev-home/AppData/Roaming/Electron/vrm-models/40a2b55e-2fec-4221-bdde-711f1f95d349.vrm';
const buffer = fs.readFileSync(filePath);

// Parse GLB format
const jsonChunkLength = buffer.readUInt32LE(12);
const jsonStr = buffer.toString('utf8', 20, 20 + jsonChunkLength);
const json = JSON.parse(jsonStr);

console.log('Total nodes:', json.nodes.length);
console.log('First 30 node names:');
json.nodes.slice(0, 30).forEach((node, i) => {
  console.log(`  ${i}: ${node.name || '(unnamed)'}`);
});

// Look for humanoid bones
const humanBones = json.nodes.filter(n => {
  const name = n.name?.toLowerCase() || '';
  return ['upper', 'lower', 'shoulder', 'arm', 'hand', 'leg', 'foot', 'hip', 'spine', 'chest', 'neck', 'head'].some(keyword => name.includes(keyword));
});

console.log('\n=== POTENTIAL HUMANOID BONES ===');
humanBones.slice(0, 20).forEach(node => {
  console.log(`\n${node.name}:`);
  if (node.translation) console.log(`  translation: [${node.translation.map(v => v.toFixed(3)).join(', ')}]`);
  if (node.rotation) {
    const q = node.rotation;
    console.log(`  rotation (quat): [${q.map(v => v.toFixed(4)).join(', ')}]`);
  }
});

// Check VRM extension
if (json.extensions?.VRM?.humanoid) {
  console.log('\n=== VRM HUMANOID MAPPINGS (first 15) ===');
  const humanoid = json.extensions.VRM.humanoid;
  if (Array.isArray(humanoid.humanBones)) {
    humanoid.humanBones.slice(0, 15).forEach(bone => {
      const node = json.nodes[bone.node];
      if (node) {
        console.log(`\n${bone.bone}: node[${bone.node}] = "${node.name}"`);
        if (node.rotation) {
          const q = node.rotation;
          console.log(`  rotation: [${q.map(v => v.toFixed(4)).join(', ')}]`);
        }
      }
    });
  }
}
