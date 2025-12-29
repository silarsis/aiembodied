import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '.dev-home/AppData/Roaming/Electron/memory.db');
const animationsDir = path.join(__dirname, '.dev-home/AppData/Roaming/Electron/vrma-animations');

// Open database
const db = new Database(dbPath);
const animations = db.prepare('SELECT id, name, filePath FROM vrma_animations ORDER BY createdAt DESC').all();

console.log('Found animations:\n');

// Helper to read GLB JSON chunk
function extractGltfJson(buffer) {
  try {
    // GLB header: magic (4), version (4), length (4)
    const magic = buffer.toString('ascii', 0, 4);
    if (magic !== 'glTF') {
      throw new Error('Not a valid GLB file');
    }
    
    const version = buffer.readUInt32LE(4);
    const totalLength = buffer.readUInt32LE(8);
    
    // First chunk header: length (4), type (4)
    const chunkLength = buffer.readUInt32LE(12);
    const chunkType = buffer.toString('ascii', 16, 20);
    
    if (chunkType !== 'JSON') {
      throw new Error('First chunk is not JSON');
    }
    
    const jsonBuffer = buffer.slice(20, 20 + chunkLength);
    const jsonStr = jsonBuffer.toString('utf8');
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error(`  Error parsing GLB: ${error.message}`);
    return null;
  }
}

// Process each animation
for (const anim of animations) {
  const filePath = path.join(animationsDir, path.basename(anim.filePath));
  console.log(`Animation: ${anim.name}`);
  console.log(`  ID: ${anim.id}`);
  
  try {
    const buffer = await fs.readFile(filePath);
    const gltf = extractGltfJson(buffer);
    
    if (!gltf) {
      console.log('  Could not parse GLB\n');
      continue;
    }
    
    // Look for VRMC_vrm_animation extension
    const vrmaExt = gltf.extensions?.VRMC_vrm_animation;
    if (!vrmaExt) {
      console.log('  No VRMA extension found\n');
      continue;
    }
    
    console.log(`  Meta: ${JSON.stringify(vrmaExt.meta)}`);
    
    // Check for hips animation
    const humanBones = vrmaExt.humanoid?.humanBones || {};
    const hipsAnimationExists = Object.values(humanBones).some(bone => bone.node !== undefined);
    
    // Find animations targeting hips (node index in humanBones)
    const animations_array = gltf.animations || [];
    let hasHipsPosition = false;
    
    for (const anim of animations_array) {
      for (const channel of anim.channels || []) {
        const target = channel.target;
        // Check if animation targets hips position
        if (target.path === 'translation') {
          hasHipsPosition = true;
          const sampler = anim.samplers?.[channel.sampler];
          if (sampler) {
            const times = gltf.accessors?.[sampler.input]?.extensions?.EXT_meshopt_compression ? '(compressed)' : 'readable';
            console.log(`    Hips position track found: ${times}`);
          }
        }
      }
    }
    
    if (!hasHipsPosition) {
      console.log(`  Hips: No position keyframes (empty hips block)`);
    }
    
  } catch (error) {
    console.error(`  Error: ${error.message}`);
  }
  
  console.log('');
}

db.close();
