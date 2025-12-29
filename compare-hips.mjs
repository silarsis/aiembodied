import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const animationsDir = path.join(__dirname, '.dev-home/AppData/Roaming/Electron/vrma-animations');

// Helper to read GLB and extract data
function extractAnimationData(buffer) {
  try {
    // Parse GLB header
    const magic = buffer.toString('ascii', 0, 4);
    if (magic !== 'glTF') throw new Error('Not a valid GLB file');
    
    // First chunk (JSON)
    const jsonChunkLength = buffer.readUInt32LE(12);
    const jsonStart = 20;
    const jsonBuffer = buffer.slice(jsonStart, jsonStart + jsonChunkLength);
    const gltf = JSON.parse(jsonBuffer.toString('utf8'));
    
    // Second chunk (BIN)
    const binHeaderOffset = jsonStart + jsonChunkLength + 8; // +8 for bin chunk header
    const binChunkLength = buffer.readUInt32LE(jsonStart + jsonChunkLength);
    const binStart = binHeaderOffset;
    const binData = buffer.slice(binStart);
    
    return { gltf, binData };
  } catch (error) {
    console.error(`  Error parsing GLB: ${error.message}`);
    return null;
  }
}

function extractFloat32Values(binData, offset, count) {
  const values = [];
  for (let i = 0; i < count; i++) {
    values.push(binData.readFloatLE(offset + i * 4));
  }
  return values;
}

// List and process VRMA files
const files = fs.readdirSync(animationsDir)
  .filter(f => f.endsWith('.vrma'))
  .sort();

console.log(`\n=== HIP POSITION COMPARISON ===\n`);

for (const file of files) {
  const filePath = path.join(animationsDir, file);
  
  try {
    const buffer = fs.readFileSync(filePath);
    const parsed = extractAnimationData(buffer);
    
    if (!parsed) continue;
    
    const { gltf, binData } = parsed;
    const vrmaExt = gltf.extensions?.VRMC_vrm_animation;
    
    if (!vrmaExt) continue;
    
    const name = vrmaExt.meta?.name || 'unknown';
    console.log(`${name.toUpperCase()}`);
    console.log(`${'='.repeat(name.length)}`);
    
    // Extract all hips position animations
    const animations_array = gltf.animations || [];
    const hipsPositions = [];
    
    for (const anim of animations_array) {
      for (const channel of anim.channels || []) {
        if (channel.target?.path === 'translation') {
          const sampler = anim.samplers?.[channel.sampler];
          if (sampler !== undefined) {
            const outputAccessor = gltf.accessors?.[sampler.output];
            const inputAccessor = gltf.accessors?.[sampler.input];
            
            if (inputAccessor && outputAccessor) {
              const outputView = gltf.bufferViews?.[outputAccessor.bufferView];
              const inputView = gltf.bufferViews?.[inputAccessor.bufferView];
              
              if (outputView && inputView) {
                const timeOffset = inputView.byteOffset || 0;
                const valueOffset = outputView.byteOffset || 0;
                
                const times = extractFloat32Values(binData, timeOffset, inputAccessor.count);
                const values = extractFloat32Values(binData, valueOffset, outputAccessor.count * 3);
                
                // Group into XYZ triplets
                const positionData = [];
                for (let i = 0; i < times.length; i++) {
                  positionData.push({
                    t: Number(times[i].toFixed(3)),
                    x: Number(values[i * 3].toFixed(3)),
                    y: Number(values[i * 3 + 1].toFixed(3)),
                    z: Number(values[i * 3 + 2].toFixed(3)),
                  });
                }
                
                hipsPositions.push(positionData);
              }
            }
          }
        }
      }
    }
    
    if (hipsPositions.length === 0) {
      console.log('No hips position keyframes');
    } else {
      console.log(`Hips position keyframes: ${hipsPositions.length} track(s)`);
      
      for (let trackIdx = 0; trackIdx < hipsPositions.length; trackIdx++) {
        const track = hipsPositions[trackIdx];
        console.log(`\n  Track ${trackIdx + 1} (${track.length} keyframes):`);
        
        // Summary
        const yValues = track.map(k => k.y);
        const minY = Math.min(...yValues);
        const maxY = Math.max(...yValues);
        console.log(`    Y range: ${Number(minY.toFixed(3))} → ${Number(maxY.toFixed(3))}`);
        
        // Show keyframes
        if (track.length <= 10) {
          for (const kf of track) {
            console.log(`      t=${kf.t}: [${kf.x}, ${kf.y}, ${kf.z}]`);
          }
        } else {
          console.log(`      (showing first and last 3 of ${track.length})`);
          for (let i = 0; i < Math.min(3, track.length); i++) {
            const kf = track[i];
            console.log(`      t=${kf.t}: [${kf.x}, ${kf.y}, ${kf.z}]`);
          }
          console.log(`      ...`);
          for (let i = Math.max(0, track.length - 3); i < track.length; i++) {
            const kf = track[i];
            console.log(`      t=${kf.t}: [${kf.x}, ${kf.y}, ${kf.z}]`);
          }
        }
      }
    }
    
  } catch (error) {
    console.error(`Error processing ${file}: ${error.message}`);
  }
  
  console.log('\n');
}
