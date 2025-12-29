import { Buffer } from 'node:buffer';
import * as THREE from 'three';
import { VRMAnimation } from '@pixiv/three-vrm-animation';
import type { VrmaSchema } from './vrma-schema.js';

type VRMHumanBoneName = Parameters<VRMAnimation['humanoidTracks']['rotation']['set']>[0];
type VRMExpressionPresetName = Parameters<VRMAnimation['expressionTracks']['preset']['set']>[0];

const PRESET_EXPRESSIONS = new Set<VRMExpressionPresetName>([
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'blink',
  'blinkLeft',
  'blinkRight',
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'lookUp',
  'lookDown',
  'lookLeft',
  'lookRight',
  'neutral',
]);

const FLOAT_COMPONENT_TYPE = 5126 as const;

function collectDuration(values: Array<{ t: number }>): number {
  return values.reduce((max, entry) => Math.max(max, entry.t), 0);
}

function buildQuaternionTrack(bone: string, keyframes: Array<{ t: number; q: [number, number, number, number] }>) {
  const ordered = [...keyframes].sort((a, b) => a.t - b.t);
  const times = ordered.map((frame) => frame.t);
  const values = ordered.flatMap((frame) => frame.q);
  return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values);
}

function buildVectorTrack(name: string, keyframes: Array<{ t: number; p: [number, number, number] }>) {
  const ordered = [...keyframes].sort((a, b) => a.t - b.t);
  const times = ordered.map((frame) => frame.t);
  const values = ordered.flatMap((frame) => frame.p);
  return new THREE.VectorKeyframeTrack(name, times, values);
}

function buildExpressionTrack(name: string, keyframes: Array<{ t: number; v: number }>) {
  const ordered = [...keyframes].sort((a, b) => a.t - b.t);
  const times = ordered.map((frame) => frame.t);
  const values = ordered.map((frame) => frame.v);
  return new THREE.NumberKeyframeTrack(`expression/${name}`, times, values);
}

function ensureFloat32Array(values: number[]): Float32Array {
  return new Float32Array(values);
}

function padTo4Bytes(value: number): number {
  return Math.ceil(value / 4) * 4;
}

function makeAccessor({
  bufferView,
  componentType,
  count,
  type,
  min,
  max,
}: {
  bufferView: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC3' | 'VEC4';
  min?: number[];
  max?: number[];
}) {
  return {
    bufferView,
    componentType,
    count,
    type,
    min,
    max,
  };
}

function serializeFloat32(values: Float32Array): Uint8Array {
  return new Uint8Array(values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength));
}

function createGlb(json: unknown, binary: Uint8Array): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonAlignedLength = padTo4Bytes(jsonBuffer.length);
  const binAlignedLength = padTo4Bytes(binary.byteLength);
  const totalLength = 12 + 8 + jsonAlignedLength + 8 + binAlignedLength;

  const header = Buffer.alloc(12);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonAlignedLength, 0);
  jsonHeader.write('JSON', 4);

  const jsonChunk = Buffer.concat([jsonBuffer, Buffer.alloc(jsonAlignedLength - jsonBuffer.length, 0x20)]);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binAlignedLength, 0);
  binHeader.write('BIN\0', 4);

  const binChunk = Buffer.concat([Buffer.from(binary), Buffer.alloc(binAlignedLength - binary.byteLength, 0)]);

  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

export function buildVrmAnimation(definition: VrmaSchema): VRMAnimation {
  const animation = new VRMAnimation();
  const durations: number[] = [];

  for (const track of definition.tracks) {
    const quaternionTrack = buildQuaternionTrack(track.bone, track.keyframes);
    animation.humanoidTracks.rotation.set(track.bone as VRMHumanBoneName, quaternionTrack);
    durations.push(collectDuration(track.keyframes));
  }

  if (definition.hips && definition.hips.position && definition.hips.position.keyframes && definition.hips.position.keyframes.length > 0) {
    const hipsTrack = buildVectorTrack('hips.position', definition.hips.position.keyframes);
    animation.humanoidTracks.translation.set('hips', hipsTrack);
    durations.push(collectDuration(definition.hips.position.keyframes));
  }

  if (definition.expressions && definition.expressions.length > 0) {
    for (const track of definition.expressions) {
      const expressionTrack = buildExpressionTrack(track.name, track.keyframes);
      durations.push(collectDuration(track.keyframes));
      if (PRESET_EXPRESSIONS.has(track.name as VRMExpressionPresetName)) {
        animation.expressionTracks.preset.set(track.name as VRMExpressionPresetName, expressionTrack);
      } else {
        animation.expressionTracks.custom.set(track.name, expressionTrack);
      }
    }
  }

  const duration = definition.meta.duration ?? Math.max(0, ...durations, 0);
  animation.duration = Number.isFinite(duration) ? duration : 0;
  animation.restHipsPosition = new THREE.Vector3(0, 1, 0);

  return animation;
}

export function encodeVrmaGlb(definition: VrmaSchema): Buffer {
   const nodes: Array<{ name: string; translation?: [number, number, number] }> = [];
   const boneNodeMap = new Map<string, number>();

  const ensureNode = (name: string, translation?: [number, number, number]) => {
    if (boneNodeMap.has(name)) {
      return boneNodeMap.get(name) as number;
    }
    const index = nodes.length;
    nodes.push(translation ? { name, translation } : { name });
    boneNodeMap.set(name, index);
    return index;
  };

  for (const track of definition.tracks) {
    const translation = track.bone === 'hips' ? ([0, 1, 0] as [number, number, number]) : undefined;
    ensureNode(track.bone, translation);
  }

  if (definition.hips && definition.hips.position && definition.hips.position.keyframes && definition.hips.position.keyframes.length > 0) {
    ensureNode('hips', [0, 1, 0]);
  }

  // Don't create expression nodes at all—expressions are stored in metadata only

  const bufferChunks: Uint8Array[] = [];
  const bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number }> = [];
  const accessors: Array<{
    bufferView: number;
    componentType: number;
    count: number;
    type: 'SCALAR' | 'VEC3' | 'VEC4';
    min?: number[];
    max?: number[];
  }> = [];
  const animations: Array<{
    samplers: Array<{ input: number; output: number; interpolation: 'LINEAR' }>;
    channels: Array<{ sampler: number; target: { node: number; path: 'rotation' | 'translation' } }>;
  }> = [
    {
      samplers: [],
      channels: [],
    },
  ];

  const appendBuffer = (data: Uint8Array) => {
    const byteOffset = bufferChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const alignedLength = padTo4Bytes(data.byteLength);
    bufferChunks.push(data);
    if (alignedLength > data.byteLength) {
      bufferChunks.push(new Uint8Array(alignedLength - data.byteLength));
    }
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.byteLength });
    return bufferViews.length - 1;
  };

  const addSamplerChannel = (node: number, path: 'rotation' | 'translation', times: number[], values: number[], type: 'VEC3' | 'VEC4') => {
    const timeArray = ensureFloat32Array(times);
    const valueArray = ensureFloat32Array(values);

    const timeView = appendBuffer(serializeFloat32(timeArray));
    const valueView = appendBuffer(serializeFloat32(valueArray));

    const timeAccessor = accessors.length;
    accessors.push(
      makeAccessor({
        bufferView: timeView,
        componentType: FLOAT_COMPONENT_TYPE,
        count: timeArray.length,
        type: 'SCALAR',
        min: [Math.min(...times)],
        max: [Math.max(...times)],
      }),
    );
    const valueAccessor = accessors.length;
    accessors.push(
      makeAccessor({
        bufferView: valueView,
        componentType: FLOAT_COMPONENT_TYPE,
        count: valueArray.length / (type === 'VEC4' ? 4 : 3),
        type,
      }),
    );

    const samplerIndex = animations[0].samplers.length;
    animations[0].samplers.push({ input: timeAccessor, output: valueAccessor, interpolation: 'LINEAR' });
    animations[0].channels.push({ sampler: samplerIndex, target: { node, path } });
  };

  for (const track of definition.tracks) {
    const ordered = [...track.keyframes].sort((a, b) => a.t - b.t);
    const times = ordered.map((frame) => frame.t);
    const values = ordered.flatMap((frame) => frame.q);
    const nodeIndex = ensureNode(track.bone, track.bone === 'hips' ? ([0, 1, 0] as [number, number, number]) : undefined);
    addSamplerChannel(nodeIndex, 'rotation', times, values, 'VEC4');
  }

  if (definition.hips && definition.hips.position && definition.hips.position.keyframes && definition.hips.position.keyframes.length > 0) {
    const ordered = [...definition.hips.position.keyframes].sort((a, b) => a.t - b.t);
    const times = ordered.map((frame) => frame.t);
    const values = ordered.flatMap((frame) => frame.p);
    const nodeIndex = ensureNode('hips', [0, 1, 0]);
    addSamplerChannel(nodeIndex, 'translation', times, values, 'VEC3');
  }

  // Don't output expression nodes to GLB animation channels
  // Expressions are stored in VRMC metadata instead (see below)

  const humanoidBones: Record<string, { node: number }> = {};
  for (const [bone, node] of boneNodeMap.entries()) {
    humanoidBones[bone] = { node };
  }

  const expressionSamplers = {
    preset: [] as Array<{ name: string; keyframes: Array<{ t: number; v: number }> }>,
    custom: [] as Array<{ name: string; keyframes: Array<{ t: number; v: number }> }>,
  };

  if (definition.expressions && definition.expressions.length > 0) {
    for (const track of definition.expressions) {
      const sampler = {
        name: track.name,
        keyframes: track.keyframes,
      };

      const PRESET_EXPRESSIONS_SET = new Set<string>([
        'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight',
        'happy', 'angry', 'sad', 'relaxed', 'surprised',
        'lookUp', 'lookDown', 'lookLeft', 'lookRight', 'neutral',
      ]);

      if (PRESET_EXPRESSIONS_SET.has(track.name)) {
        expressionSamplers.preset.push(sampler);
      } else {
        expressionSamplers.custom.push(sampler);
      }
    }
  }

  const extensions: Record<string, unknown> = {
    VRMC_vrm_animation: {
      specVersion: '1.0',
      humanoid: {
        humanBones: humanoidBones,
      },
      meta: {
        name: definition.meta.name,
        fps: definition.meta.fps,
        loop: definition.meta.loop,
        ...(typeof definition.meta.duration === 'number' ? { duration: definition.meta.duration } : {}),
        ...(definition.meta.kind ? { kind: definition.meta.kind } : {}),
      },
      // Store expressions as samplers in metadata, not as animation channels
      ...(expressionSamplers.preset.length > 0 || expressionSamplers.custom.length > 0 
        ? { 
            expressionSamplers: {
              ...(expressionSamplers.preset.length > 0 ? { preset: expressionSamplers.preset } : {}),
              ...(expressionSamplers.custom.length > 0 ? { custom: expressionSamplers.custom } : {}),
            }
          }
        : {}),
    },
  };

  const gltf = {
    asset: {
      version: '2.0',
      generator: 'aiembodied-vrma-generator',
    },
    scene: 0,
    scenes: [{ nodes: nodes.map((_node, index) => index) }],
    nodes,
    animations,
    buffers: [
      {
        byteLength: bufferChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
      },
    ],
    bufferViews,
    accessors,
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions,
  };

  const binary = bufferChunks.length ? Buffer.concat(bufferChunks.map((chunk) => Buffer.from(chunk))) : Buffer.alloc(0);
  return createGlb(gltf, new Uint8Array(binary));
}
