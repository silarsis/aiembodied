import fs from 'fs';

const filePath = 'c:/Users/kevin/repos/aiembodied/.dev-home/AppData/Roaming/Electron/vrm-models/40a2b55e-2fec-4221-bdde-711f1f95d349.vrm';
const buffer = fs.readFileSync(filePath);

// Parse GLB format
const magic = buffer.toString('utf8', 0, 4);
const version = buffer.readUInt32LE(4);
const length = buffer.readUInt32LE(8);

console.log('Magic:', magic, 'Version:', version, 'Total Length:', length);

// JSON chunk
const jsonChunkLength = buffer.readUInt32LE(12);
const jsonChunkType = buffer.toString('utf8', 16, 20);
const jsonStr = buffer.toString('utf8', 20, 20 + jsonChunkLength);
const json = JSON.parse(jsonStr);

console.log('\n=== NODE REST ROTATIONS (Euler approximation) ===');

const humanBones = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
];

function quaternionToEuler(x, y, z, w) {
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return { x: roll, y: pitch, z: yaw };
}

for (const bone of humanBones) {
  const node = json.nodes.find(n => n.name === bone);
  if (node) {
    console.log(`\n${bone}:`);
    if (node.translation) console.log(`  translation: [${node.translation.map(v => v.toFixed(3)).join(', ')}]`);
    if (node.rotation) {
      const q = node.rotation;
      const euler = quaternionToEuler(q[0], q[1], q[2], q[3]);
      console.log(`  rotation (quat): [${q.map(v => v.toFixed(4)).join(', ')}]`);
      console.log(`  rotation (euler rad): x=${euler.x.toFixed(3)}, y=${euler.y.toFixed(3)}, z=${euler.z.toFixed(3)}`);
      console.log(`  rotation (euler deg): x=${(euler.x * 180 / Math.PI).toFixed(1)}°, y=${(euler.y * 180 / Math.PI).toFixed(1)}°, z=${(euler.z * 180 / Math.PI).toFixed(1)}°`);
    }
    if (!node.rotation && !node.translation) {
      console.log(`  (identity transform)`);
    }
  }
}

// Analyze what pose this represents
console.log('\n=== POSE ANALYSIS ===');
const leftArm = json.nodes.find(n => n.name === 'leftUpperArm');
const rightArm = json.nodes.find(n => n.name === 'rightUpperArm');

if (leftArm?.rotation && rightArm?.rotation) {
  const leftEuler = quaternionToEuler(leftArm.rotation[0], leftArm.rotation[1], leftArm.rotation[2], leftArm.rotation[3]);
  const rightEuler = quaternionToEuler(rightArm.rotation[0], rightArm.rotation[1], rightArm.rotation[2], rightArm.rotation[3]);
  
  console.log('Left Upper Arm X rotation:', (leftEuler.x * 180 / Math.PI).toFixed(1) + '°');
  console.log('Right Upper Arm X rotation:', (rightEuler.x * 180 / Math.PI).toFixed(1) + '°');
  
  if (Math.abs(leftEuler.x) < 0.2 && Math.abs(rightEuler.x) < 0.2) {
    console.log('\nConclusion: ARMS EXTENDED OUTWARD (T-pose or A-pose)');
  } else if (Math.abs(leftEuler.x) > 1.0 && Math.abs(rightEuler.x) > 1.0) {
    console.log('\nConclusion: ARMS RAISED/BENT (relaxed or prayer pose)');
  } else {
    console.log('\nConclusion: MIXED ARM POSITION');
  }
}
