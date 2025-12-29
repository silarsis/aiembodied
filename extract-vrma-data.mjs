import Database from 'better-sqlite3';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '.dev-home/AppData/Roaming/Electron/memory.db');
const animationsDir = path.join(__dirname, '.dev-home/AppData/Roaming/Electron/vrma-animations');

// Open database
const db = new Database(dbPath);
const animations = db.prepare('SELECT id, name, filePath FROM vrma_animations ORDER BY createdAt DESC').all();

console.log('Found animations:');
for (const anim of animations) {
  console.log(`  ${anim.name} (${anim.id})`);
}

// Load and parse VRMA files
async function parseVrmaFile(filePath) {
  try {
    const buffer = await fs.readFile(filePath);
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    const gltf = await loader.parseAsync(buffer.buffer, '/');
    const vrmAnimations = gltf.userData?.vrmAnimations;
    if (!vrmAnimations || vrmAnimations.length === 0) {
      return null;
    }
    
    const vrma = vrmAnimations[0];
    const hipsData = vrma.humanoidTracks?.translation?.get?.('hips');
    const rotationTracks = Array.from(vrma.humanoidTracks?.rotation?.entries?.() || []);
    
    return {
      duration: vrma.duration,
      hips: hipsData ? {
        hasPositionTrack: true,
        track: hipsData
      } : { hasPositionTrack: false },
      rotationBones: rotationTracks.map(([bone]) => bone),
    };
  } catch (error) {
    console.error(`Error parsing ${filePath}:`, error.message);
    return null;
  }
}

// Process each animation
for (const anim of animations) {
  const fullPath = path.join(animationsDir, path.basename(anim.filePath));
  console.log(`\n${anim.name}:`);
  console.log(`  File: ${fullPath}`);
  
  try {
    const buffer = await fs.readFile(fullPath);
    const jsonStart = buffer.indexOf(Buffer.from('glTF')) + 20; // Skip GLB header, find JSON chunk
    // For now, just check file size
    console.log(`  File size: ${buffer.length} bytes`);
  } catch (error) {
    console.error(`  Error: ${error.message}`);
  }
}

db.close();
