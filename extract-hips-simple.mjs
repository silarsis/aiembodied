import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const animationsDir = path.join(__dirname, '.dev-home/AppData/Roaming/Electron/vrma-animations');

// Helper to read GLB JSON chunk
function extractGltfJson(buffer) {
  try {
    // GLB header: magic (4), version (4), length (4)
    const magic = buffer.toString('ascii', 0, 4);
    if (magic !== 'glTF') {
      throw new Error('Not a valid GLB file');
    }
    
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

// List VRMA files
const files = fs.readdirSync(animationsDir).filter(f => f.endsWith('.vrma'));

console.log(`Found ${files.length} VRMA files\n`);

// Process each animation file
for (const file of files) {
  const filePath = path.join(animationsDir, file);
  console.log(`File: ${file}`);
  
  try {
    const buffer = fs.readFileSync(filePath);
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
    
    console.log(`  Name: ${vrmaExt.meta?.name || 'unknown'}`);
    console.log(`  Duration: ${vrmaExt.meta?.duration || gltf.animations?.[0]?.duration || 'unknown'}`);
    console.log(`  Loop: ${vrmaExt.meta?.loop}`);
    
    // Find animations with translation (position) tracks
    const animations_array = gltf.animations || [];
    let hasHipsPosition = false;
    let hipsPositionValues = [];
    
    for (const anim of animations_array) {
      for (const channel of anim.channels || []) {
        const target = channel.target;
        // Check if animation targets hips position (translation)
        if (target.path === 'translation') {
          hasHipsPosition = true;
          const sampler = anim.samplers?.[channel.sampler];
          if (sampler !== undefined) {
            const inputAccessor = gltf.accessors?.[sampler.input];
            const outputAccessor = gltf.accessors?.[sampler.output];
            
            if (inputAccessor && outputAccessor) {
              console.log(`    Hips position: YES`);
              console.log(`      Times: ${outputAccessor.count} keyframes`);
              
              // Try to extract actual values from binary
              const bufferViewIdx = outputAccessor.bufferView;
              if (bufferViewIdx !== undefined) {
                const bufferView = gltf.bufferViews?.[bufferViewIdx];
                if (bufferView) {
                  console.log(`      Type: ${outputAccessor.type} (${outputAccessor.componentType})`);
                  const minMax = outputAccessor.max ? `min: [${outputAccessor.min}], max: [${outputAccessor.max}]` : 'N/A';
                  console.log(`      Range: ${minMax}`);
                }
              }
            }
          }
        }
      }
    }
    
    if (!hasHipsPosition) {
      console.log(`  Hips position: NO (empty hips block)`);
    }
    
  } catch (error) {
    console.error(`  Error: ${error.message}`);
  }
  
  console.log('');
}
