#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import dotenv from 'dotenv';
import OpenAI, { toFile } from 'openai';

// Load environment variables from .env file (same as main app)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(repoRoot, '.env') });

// Layer specifications - matching the Python script
const LAYER_SPECS = [
  {
    spec: "base — face outline, hair, and static facial features ONLY (no eyes, no mouth).",
    filename: "base.png",
    slot: "base"
  },
  {
    spec: "eyes-open — both eyes open ONLY, isolated on full transparent canvas.",
    filename: "eyes-open.png", 
    slot: "eyes-open"
  },
  {
    spec: "eyes-closed — both eyes closed ONLY, isolated on full transparent canvas.",
    filename: "eyes-closed.png",
    slot: "eyes-closed"
  },
  {
    spec: "mouth-neutral — neutral mouth ONLY, isolated on full transparent canvas.",
    filename: "mouth-neutral.png",
    slot: "mouth-neutral"
  },
  {
    spec: "mouth-small-o — small 'O' phoneme mouth ONLY, isolated on full transparent canvas.",
    filename: "mouth-small-o.png",
    slot: "mouth-0"
  },
  {
    spec: "mouth-medium-o — medium 'O' phoneme mouth ONLY, isolated on full transparent canvas.",
    filename: "mouth-medium-o.png",
    slot: "mouth-1"
  },
  {
    spec: "mouth-wide-o — wide 'O' phoneme mouth ONLY, isolated on full transparent canvas.",
    filename: "mouth-wide-o.png",
    slot: "mouth-2"
  },
  {
    spec: "mouth-smile — smiling mouth ONLY, isolated on full transparent canvas.",
    filename: "mouth-smile.png",
    slot: "mouth-3"
  },
  {
    spec: "mouth-open — open talking mouth ONLY, isolated on full transparent canvas.",
    filename: "mouth-open.png",
    slot: "mouth-4"
  }
];

const SYSTEM_DIRECTIVE = `
Avatar layer generator: cartoon style, 150x150px, transparent background.
Keep facial placement consistent. Only render the requested component.
Bold lines, high contrast, recognizable likeness.
`;

function createLayerPrompt(layerSpec, isFirst = false) {
  const referenceNote = isFirst ? "" : "Match base alignment.";
  return `${SYSTEM_DIRECTIVE.trim()}

Render: ${layerSpec}
${referenceNote}
Clean edges, precise alignment.`;
}

// Image validation utilities (same as before)
function validatePNGHeader(buffer) {
  if (buffer.length < 8) return false;
  const pngHeader = buffer.subarray(0, 8);
  const expectedHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return pngHeader.equals(expectedHeader);
}

function extractPNGDimensions(buffer) {
  if (buffer.length < 24) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

function hasAlphaChannel(buffer) {
  if (buffer.length < 25) return false;
  const colorType = buffer[25];
  return colorType === 4 || colorType === 6;
}

function validateImageComponent(b64Data, slot) {
  const issues = [];
  
  try {
    const buffer = Buffer.from(b64Data, 'base64');
    
    if (!validatePNGHeader(buffer)) {
      issues.push('Invalid PNG header');
    }
    
    const dimensions = extractPNGDimensions(buffer);
    if (!dimensions) {
      issues.push('Cannot extract dimensions');
    } else if (dimensions.width !== 150 || dimensions.height !== 150) {
      issues.push(`Wrong size: ${dimensions.width}x${dimensions.height} (expected 150x150)`);
    }
    
    if (!hasAlphaChannel(buffer)) {
      issues.push('No alpha channel (transparent background)');
    }
    
    if (buffer.length < 200) {
      issues.push(`Very small file (${buffer.length} bytes) - likely empty`);
    }
    
    return {
      valid: issues.length === 0,
      issues,
      dimensions,
      fileSize: buffer.length,
      hasAlpha: hasAlphaChannel(buffer)
    };
  } catch (error) {
    return {
      valid: false,
      issues: [`Validation error: ${error.message}`],
      dimensions: null,
      fileSize: 0,
      hasAlpha: false
    };
  }
}

async function generateOneLayer(client, imagePath, layerSpec, filename, slot, isFirst = false) {
  console.log(`\n🎨 Generating ${slot}...`);
  
  const prompt = createLayerPrompt(layerSpec.spec, isFirst);
  
  console.log(`📝 Prompt: ${layerSpec.spec}`);
  
  try {
    // Read image file and create File object for OpenAI SDK
    const imageBuffer = await readFile(imagePath);
    const imageFile = await toFile(imageBuffer, 'image.png', { type: 'image/png' });
    
    // Call OpenAI Images Edit API
    console.log(`    🚀 Sending to OpenAI Images Edit API...`);
    const response = await client.images.edit({
      image: imageFile,
      prompt: prompt,
      size: '256x256',  // OpenAI only supports 256x256, 512x512, 1024x1024
      n: 1
    });

    if (!response.data || !response.data[0]?.b64_json) {
      throw new Error('No image data returned from OpenAI');
    }

    const b64Data = response.data[0].b64_json;
    
    // Validate the generated image
    const validation = validateImageComponent(b64Data, slot);
    
    console.log(`    📊 Generated Size: ${validation.fileSize} bytes`);
    console.log(`    📐 Dimensions: ${validation.dimensions ? `${validation.dimensions.width}x${validation.dimensions.height}` : 'Unknown'}`);
    console.log(`    🔍 Has Alpha: ${validation.hasAlpha ? 'Yes' : 'No'}`);
    console.log(`    ✅ Validation: ${validation.valid ? 'PASSED' : 'FAILED'}`);
    
    if (!validation.valid) {
      console.log(`    ⚠️  Issues:`);
      validation.issues.forEach(issue => {
        console.log(`        - ${issue}`);
      });
    }
    
    // Save the image
    const outputPath = path.join('avatar_layers', filename);
    const imageBytes = Buffer.from(b64Data, 'base64');
    await writeFile(outputPath, imageBytes);
    console.log(`    💾 Saved to: ${outputPath}`);
    
    return {
      slot,
      filename,
      validation,
      b64Data
    };
    
  } catch (error) {
    console.error(`    ❌ Failed to generate ${slot}:`, error.message);
    return {
      slot,
      filename,
      validation: { valid: false, issues: [error.message], fileSize: 0 },
      b64Data: null
    };
  }
}

async function generateAvatarLayers(imagePath) {
  console.log('🎨 Avatar Layer Generation Tool (Images Edit API)');
  console.log('===============================================');
  
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || process.env.REALTIME_API_KEY
  });
  
  // Ensure output directory exists
  await mkdir('avatar_layers', { recursive: true });
  
  console.log(`📷 Source image: ${imagePath}`);
  console.log(`🤖 Using OpenAI Images Edit API with gpt-image-1`);
  
  const results = [];
  
  // Generate layers one by one (like the Python script)
  for (let i = 0; i < LAYER_SPECS.length; i++) {
    const layerSpec = LAYER_SPECS[i];
    const isFirst = i === 0;
    
    const result = await generateOneLayer(
      client, 
      imagePath, 
      layerSpec, 
      layerSpec.filename, 
      layerSpec.slot, 
      isFirst
    );
    
    results.push(result);
    
    // Gentle pacing to avoid rate limits
    if (i < LAYER_SPECS.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  // Overall summary
  console.log(`\n🎯 Generation Summary:`);
  const validComponents = results.filter(r => r.validation.valid).length;
  const qualityScore = Math.round((validComponents / results.length) * 100);
  
  console.log(`Generated Components: ${results.length}`);
  console.log(`Valid Components: ${validComponents}/${results.length}`);
  console.log(`Quality Score: ${qualityScore}%`);
  
  if (qualityScore === 100) {
    console.log(`✅ Perfect! All components generated successfully`);
  } else if (qualityScore >= 70) {
    console.log(`✅ Good results with minor issues`);
  } else {
    console.log(`⚠️  Many components failed - may need prompt refinement`);
  }
  
  console.log(`\n📁 Components saved to: avatar_layers/`);
  
  return results;
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help') {
    console.error('Usage: node debug-avatar-images.mjs <image-file-path>');
    console.error('');
    console.error('This script uses OpenAI Images Edit API (gpt-image-1) instead of Responses API');
    console.error('Environment: Set OPENAI_API_KEY or REALTIME_API_KEY');
    process.exit(1);
  }

  const imagePath = args.find(arg => !arg.startsWith('--'));
  if (!imagePath) {
    console.error('Error: Image file path is required');
    process.exit(1);
  }

  const apiKey = process.env.OPENAI_API_KEY || process.env.REALTIME_API_KEY;
  
  if (!apiKey) {
    console.error('❌ API key required. Set OPENAI_API_KEY or REALTIME_API_KEY environment variable.');
    process.exit(1);
  }

  try {
    await generateAvatarLayers(imagePath);
  } catch (error) {
    console.error('❌ Generation failed:', error.message);
    process.exit(1);
  }
}

main().catch(console.error);
