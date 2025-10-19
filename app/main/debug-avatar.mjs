#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import dotenv from 'dotenv';
import OpenAI from 'openai';

// Image validation utilities
function validatePNGHeader(buffer) {
  if (buffer.length < 8) return false;
  const pngHeader = buffer.subarray(0, 8);
  const expectedHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return pngHeader.equals(expectedHeader);
}

function extractPNGDimensions(buffer) {
  if (buffer.length < 24) return null;
  // PNG IHDR chunk starts at byte 16, dimensions at bytes 16-23
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

function hasAlphaChannel(buffer) {
  if (buffer.length < 25) return false;
  // Check color type in IHDR chunk (byte 25)
  const colorType = buffer[25];
  // Color types 4 and 6 have alpha channel
  return colorType === 4 || colorType === 6;
}

function validateImageComponent(comp, index) {
  const issues = [];
  
  try {
    const buffer = Buffer.from(comp.data, 'base64');
    
    // 1. Check PNG header
    if (!validatePNGHeader(buffer)) {
      issues.push('Invalid PNG header');
    }
    
    // 2. Check dimensions
    const dimensions = extractPNGDimensions(buffer);
    if (!dimensions) {
      issues.push('Cannot extract dimensions');
    } else if (dimensions.width !== 150 || dimensions.height !== 150) {
      issues.push(`Wrong size: ${dimensions.width}x${dimensions.height} (expected 150x150)`);
    }
    
    // 3. Check alpha channel (transparent background)
    if (!hasAlphaChannel(buffer)) {
      issues.push('No alpha channel (transparent background)');
    }
    
    // 4. Check file size (too small = likely empty)
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

// Load environment variables from .env file (same as main app)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(repoRoot, '.env') });

// Avatar component slots from the main code
const AVATAR_COMPONENT_SLOTS = [
  'base',
  'eyes-open', 'eyes-closed',
  'mouth-neutral', 'mouth-0', 'mouth-1', 'mouth-2', 'mouth-3', 'mouth-4',
];

// Schema definition from the main code
const RESPONSE_SCHEMA_DEFINITION = {
  name: 'AvatarComponents',
  type: 'json_schema',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'components'],
    properties: {
      name: {
        type: 'string',
        description: 'Human-friendly name describing the style of the generated avatar components.',
      },
      components: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['slot', 'mimeType', 'data', 'sequence'],
          properties: {
            slot: { type: 'string', enum: AVATAR_COMPONENT_SLOTS },
            data: {
              type: 'string',
              description: 'Base64 encoded PNG with transparent background sized consistently for rendering.',
            },
            mimeType: {
              type: 'string',
              enum: ['image/png', 'image/webp'],
              default: 'image/png',
            },
            sequence: {
              type: 'integer',
              minimum: 0,
              description: 'Ordering hint when multiple frames exist for a slot.',
            },
          },
        },
      },
    },
  },
};

function extractBase64Payload(imageDataUrl) {
  const DATA_URL_PATTERN = /^data:(?<mime>[^;,]+)?;base64,(?<payload>.*)$/s;
  const match = DATA_URL_PATTERN.exec(imageDataUrl.trim());

  if (!match) {
    throw new Error('Avatar image data URL is malformed; expected base64-encoded data.');
  }

  const payloadGroup = match.groups?.payload;
  if (payloadGroup === undefined) {
    throw new Error('Avatar image data URL is malformed; expected base64-encoded data.');
  }

  const payload = payloadGroup.replace(/\s+/g, '').trim();
  if (!payload) {
    throw new Error('Avatar image data URL is missing image data.');
  }

  return payload;
}

async function imageFileToDataUrl(filePath) {
  const buffer = await readFile(filePath);
  const base64 = buffer.toString('base64');
  return `data:image/png;base64,${base64}`;
}

async function analyzeAvatarGeneration(imagePath, apiKey) {
  console.log('🔍 Avatar Generation Analysis Tool');
  console.log('================================');
  
  // Initialize OpenAI client
  const client = new OpenAI({ apiKey });
  
  // Load and process image
  console.log(`📷 Loading image: ${imagePath}`);
  const imageDataUrl = await imageFileToDataUrl(imagePath);
  const imageBase64 = extractBase64Payload(imageDataUrl);
  console.log(`📊 Image size: ${Buffer.from(imageBase64, 'base64').length} bytes`);
  
  // Prepare the request with IMPROVED PROMPTS
  const systemContent = [
    {
      type: 'input_text',
      text:
        'You are an avatar generation specialist that converts portrait photos into animation-ready layered components. '
        + 'Given a portrait photo, extract these transparent PNG layers at 150x150 pixels: '
        + '- base: Face outline, hair, and static facial features (no eyes or mouth) '
        + '- eyes-open: Open eyes only on transparent background '
        + '- eyes-closed: Closed eyes only on transparent background '
        + '- mouth-neutral through mouth-4: Different mouth shapes for speech animation (neutral, small-o, medium-o, wide-o, smile, open) '
        + 'Each component must be precisely aligned and sized for perfect overlay compositing.',
    },
  ];

  const userContent = [
    {
      type: 'input_text',
      text:
        'Convert this portrait into avatar animation layers. Make each component: '
        + '- Exactly 150x150 pixels with transparent background '
        + '- Perfectly aligned so they composite seamlessly '
        + '- High contrast and clearly visible '
        + '- Cartoon-style but recognizable as the source person '
        + '- Ready for real-time animation overlay '
        + 'Focus on clear, bold features that will be visible in a small avatar display.',
    },
    { type: 'input_image', image_url: `data:image/png;base64,${imageBase64}`, detail: 'auto' },
  ];

  const input = [
    { type: 'message', role: 'system', content: systemContent },
    { type: 'message', role: 'user', content: userContent },
  ];

  const body = {
    model: 'gpt-4.1-mini',
    input,
    text: {
      format: RESPONSE_SCHEMA_DEFINITION,
    },
  };

  console.log('\n🚀 Sending request to OpenAI...');
  console.log(`📝 Model: ${body.model}`);
  console.log(`🎯 Schema: ${RESPONSE_SCHEMA_DEFINITION.name}`);
  
  console.log('\n📋 SYSTEM PROMPT:');
  console.log('================');
  systemContent.forEach((content, i) => {
    if (content.type === 'input_text') {
      console.log(`${i + 1}. ${content.text}`);
    }
  });
  
  console.log('\n👤 USER PROMPT:');
  console.log('===============');
  userContent.forEach((content, i) => {
    if (content.type === 'input_text') {
      console.log(`${i + 1}. ${content.text}`);
    } else if (content.type === 'input_image') {
      console.log(`${i + 1}. [IMAGE DATA] ${content.image_url.substring(0, 50)}... (${content.detail} detail)`);
    }
  });
  
  console.log('\n🔧 SCHEMA REQUIREMENTS:');
  console.log('=====================');
  console.log(`Required fields: ${RESPONSE_SCHEMA_DEFINITION.schema.required.join(', ')}`);
  console.log(`Component slots: ${RESPONSE_SCHEMA_DEFINITION.schema.properties.components.items.properties.slot.enum.join(', ')}`);
  console.log(`Component required fields: ${RESPONSE_SCHEMA_DEFINITION.schema.properties.components.items.required.join(', ')}`);
  console.log(`Strict mode: ${RESPONSE_SCHEMA_DEFINITION.strict}`);
  
  let responsePayload;
  try {
    responsePayload = await client.responses.create(body);
    console.log('✅ OpenAI request successful');
  } catch (error) {
    console.error('❌ OpenAI request failed:', error.message);
    if (error.response?.data) {
      console.error('📄 Error details:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }

  // Extract and parse the response
  if (process.argv.includes('--show-raw-response')) {
    console.log('\n📤 Raw OpenAI Response:');
    console.log(JSON.stringify(responsePayload, null, 2));
  } else {
    console.log('\n📤 OpenAI Response Summary:');
    console.log(`Status: ${responsePayload.status}`);
    console.log(`Model: ${responsePayload.model}`);
    console.log(`Input tokens: ${responsePayload.usage?.input_tokens || 'N/A'}`);
    console.log(`Output tokens: ${responsePayload.usage?.output_tokens || 'N/A'}`);
    console.log(`Total tokens: ${responsePayload.usage?.total_tokens || 'N/A'}`);
    console.log('(Use --show-raw-response flag to see full response)');
  }

  // Extract text response (Responses API format)
  let text = '';
  
  // First try the output_text field (new Responses API format)
  if (responsePayload.output_text && typeof responsePayload.output_text === 'string') {
    text = responsePayload.output_text;
  }
  // Fallback to choices format
  else if (responsePayload.choices && Array.isArray(responsePayload.choices)) {
    for (const choice of responsePayload.choices) {
      if (choice.message && choice.message.content && Array.isArray(choice.message.content)) {
        for (const chunk of choice.message.content) {
          if (chunk.type === 'text' && typeof chunk.text === 'string') {
            text = chunk.text;
            break;
          }
        }
      }
    }
  }
  // Also try the output array format
  else if (responsePayload.output && Array.isArray(responsePayload.output)) {
    for (const output of responsePayload.output) {
      if (output.type === 'message' && output.content && Array.isArray(output.content)) {
        for (const chunk of output.content) {
          if (chunk.type === 'output_text' && typeof chunk.text === 'string') {
            text = chunk.text;
            break;
          }
        }
      }
    }
  }

  if (!text) {
    console.error('❌ No text content found in OpenAI response');
    process.exit(1);
  }

  console.log('\n📋 Extracted JSON Response:');
  console.log(text);

  // Parse the JSON
  let parsed;
  try {
    parsed = JSON.parse(text);
    console.log('✅ JSON parsing successful');
  } catch (error) {
    console.error('❌ JSON parsing failed:', error.message);
    process.exit(1);
  }

  // Analyze components
  console.log('\n🔍 Component Analysis:');
  console.log(`📛 Avatar Name: "${parsed.name || 'Not provided'}"`);
  console.log(`🎭 Components Generated: ${parsed.components?.length || 0}`);

  if (parsed.components && Array.isArray(parsed.components)) {
    let validComponents = 0;
    let totalIssues = 0;
    
    for (let i = 0; i < parsed.components.length; i++) {
      const comp = parsed.components[i];
      console.log(`\n  Component ${i + 1}:`);
      console.log(`    🎯 Slot: ${comp.slot}`);
      console.log(`    🔢 Sequence: ${comp.sequence}`);
      console.log(`    🖼️  MIME Type: ${comp.mimeType}`);
      console.log(`    📊 Data Size: ${comp.data?.length || 0} base64 characters`);
      
      if (comp.data) {
        // Comprehensive validation
        const validation = validateImageComponent(comp, i);
        
        console.log(`    💾 Binary Size: ${validation.fileSize} bytes`);
        console.log(`    📐 Dimensions: ${validation.dimensions ? `${validation.dimensions.width}x${validation.dimensions.height}` : 'Unknown'}`);
        console.log(`    🔍 Has Alpha Channel: ${validation.hasAlpha ? 'Yes' : 'No'}`);
        console.log(`    ✅ Validation: ${validation.valid ? 'PASSED' : 'FAILED'}`);
        
        if (!validation.valid) {
          totalIssues += validation.issues.length;
          console.log(`    ⚠️  Issues:`);
          validation.issues.forEach(issue => {
            console.log(`        - ${issue}`);
          });
        }
        
        if (validation.valid) validComponents++;
        
        // Save component to file for inspection (unless skipped)
        if (!process.argv.includes('--skip-files')) {
          try {
            const buffer = Buffer.from(comp.data, 'base64');
            const filename = `debug-component-${i + 1}-${comp.slot}.png`;
            await writeFile(filename, buffer);
            console.log(`    💾 Saved to: ${filename}`);
          } catch (error) {
            console.log(`    ❌ Save failed: ${error.message}`);
          }
        } else {
          console.log(`    💾 File saving skipped (use without --skip-files to save)`);
        }
      } else {
        console.log(`    ❌ No data provided`);
        totalIssues++;
      }
    }
    
    // Overall validation summary
    console.log(`\n🎯 Validation Summary:`);
    console.log(`Valid Components: ${validComponents}/${parsed.components.length}`);
    console.log(`Total Issues: ${totalIssues}`);
    console.log(`Quality Score: ${Math.round((validComponents / parsed.components.length) * 100)}%`);
    
    if (validComponents === parsed.components.length) {
      console.log(`✅ All components passed validation!`);
    } else if (validComponents === 0) {
      console.log(`❌ No components passed validation - consider rerunning with refined prompts`);
    } else {
      console.log(`⚠️  Mixed results - some components may need post-processing`);
    }
  }

  console.log('\n🎉 Analysis complete!');
  console.log('📁 Check the generated PNG files to inspect the avatar components.');
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help') {
    console.error('Usage: node debug-avatar.mjs <image-file-path> [options]');
    console.error('');
    console.error('Options:');
    console.error('  --show-raw-response   Show the full OpenAI API response JSON');
    console.error('  --skip-files         Skip saving individual component PNG files');
    console.error('  --help               Show this help message');
    console.error('');
    console.error('Environment: Set OPENAI_API_KEY or REALTIME_API_KEY');
    process.exit(1);
  }

  // Extract image path from args (skip flags)
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
    await analyzeAvatarGeneration(imagePath, apiKey);
  } catch (error) {
    console.error('❌ Analysis failed:', error.message);
    process.exit(1);
  }
}

main().catch(console.error);
