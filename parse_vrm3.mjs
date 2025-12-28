import fs from 'fs';

const filePath = 'c:/Users/kevin/repos/aiembodied/.dev-home/AppData/Roaming/Electron/vrm-models/40a2b55e-2fec-4221-bdde-711f1f95d349.vrm';
const buffer = fs.readFileSync(filePath);

// Parse GLB format
const jsonChunkLength = buffer.readUInt32LE(12);
const jsonStr = buffer.toString('utf8', 20, 20 + jsonChunkLength);
const json = JSON.parse(jsonStr);

function quaternionToEuler(x, y, z, w) {
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return { x: roll, y: pitch, z: yaw };
}

// Get VRM humanoid mappings
const humanoid = json.extensions.VRM.humanoid;
const boneMap = {};
humanoid.humanBones.forEach(bone => {
  const node = json.nodes[bone.node];
  boneMap[bone.bone] = node;
});

console.log('=== VRM REST POSE (Default rotations) ===\n');

const keyBones = [
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
];

for (const boneName of keyBones) {
  const node = boneMap[boneName];
  if (!node) continue;
  
  console.log(`${boneName}:`);
  
  if (node.rotation) {
    const q = node.rotation;
    const euler = quaternionToEuler(q[0], q[1], q[2], q[3]);
    console.log(`  Quat: [${q.map(v => v.toFixed(4)).join(', ')}]`);
    console.log(`  Euler (rad): X=${euler.x.toFixed(3)}, Y=${euler.y.toFixed(3)}, Z=${euler.z.toFixed(3)}`);
    console.log(`  Euler (deg): X=${(euler.x * 180/Math.PI).toFixed(1)}°, Y=${(euler.y * 180/Math.PI).toFixed(1)}°, Z=${(euler.z * 180/Math.PI).toFixed(1)}°`);
  } else {
    console.log(`  (identity/no rotation)`);
  }
  console.log();
}

// Check if arms are extended
console.log('=== POSE DETERMINATION ===');
const leftArm = boneMap['leftUpperArm'];
const rightArm = boneMap['rightUpperArm'];

if (leftArm && rightArm) {
  const leftRotation = leftArm.rotation || [0, 0, 0, 1];
  const rightRotation = rightArm.rotation || [0, 0, 0, 1];
  
  const leftEuler = quaternionToEuler(leftRotation[0], leftRotation[1], leftRotation[2], leftRotation[3]);
  const rightEuler = quaternionToEuler(rightRotation[0], rightRotation[1], rightRotation[2], rightRotation[3]);
  
  console.log(`Left Upper Arm X-rotation: ${(leftEuler.x * 180/Math.PI).toFixed(1)}°`);
  console.log(`Right Upper Arm X-rotation: ${(rightEuler.x * 180/Math.PI).toFixed(1)}°`);
  
  const absLeftX = Math.abs(leftEuler.x);
  const absRightX = Math.abs(rightEuler.x);
  
  if (absLeftX < 0.3 && absRightX < 0.3) {
    console.log('\n✓ POSE: T-POSE or A-POSE (Arms extended horizontally)');
    console.log('  → The arms are nearly straight out to the sides');
  } else if (absLeftX > 1.2 && absRightX > 1.2) {
    console.log('\n✓ POSE: RELAXED/PRAYER (Arms bent upward)');
    console.log('  → The arms are bent at the elbows and raised');
  } else if (absLeftX > 0.5 && absRightX > 0.5) {
    console.log('\n✓ POSE: ARMS BENT DOWN (hands at sides)');
    console.log('  → The arms are bent but lower');
  } else {
    console.log('\n? POSE: MIXED or UNUSUAL');
  }
}
