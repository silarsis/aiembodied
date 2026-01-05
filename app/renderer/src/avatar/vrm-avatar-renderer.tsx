import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRM,
  VRMLoaderPlugin,
  VRMUtils,
  VRMExpressionPresetName,
  type VRMExpressionManager,
  type VRMPose,
} from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, type VRMAnimation } from '@pixiv/three-vrm-animation';
import type { VisemeFrame } from '../audio/viseme-driver.js';
import type { AvatarModelSummary } from './types.js';
import { getPreloadApi } from '../preload-api.js';
import {
  useAvatarAnimationQueue,
  type AvatarAnimationEvent,
  type AvatarAnimationTiming,
  type VRMPoseData,
  type VRMPoseExpressions,
} from './animation-bus.js';
import { toAnimationSlug } from './animation-tags.js';
import { useBehaviorCues, type BehaviorCueEvent } from './behavior-cues.js';
import {
  createClipFromVrma,
  createHumanoidRotationTrack,
  createMixerForVrm,
  createVrmAnimationClip,
} from './animations/index.js';
import {
  IdleAnimationScheduler,
  type IdleAnimationSchedulerConfig,
  type IdleClipRegistration,
} from './animations/idle-scheduler.js';

export interface VrmRendererStatus {
  status: 'idle' | 'loading' | 'ready' | 'error';
  message?: string;
}

export interface IdleAnimationOptions {
  enableBreathing?: boolean;
  enableMicroMovement?: boolean;
  enableBlink?: boolean;
  vrmaAnimations?: VRMAnimation[];
  additionalClips?: IdleClipRegistration[];
}

export interface VrmAvatarRendererProps {
  frame: VisemeFrame | null;
  model: AvatarModelSummary | null | undefined;
  onStatusChange?: (status: VrmRendererStatus) => void;
  className?: string;
  idleOptions?: IdleAnimationOptions;
  animationVersion?: number;
}

const VISEME_PRESETS: VRMExpressionPresetName[] = [
  VRMExpressionPresetName.Aa,
  VRMExpressionPresetName.Ih,
  VRMExpressionPresetName.Ou,
  VRMExpressionPresetName.Ee,
  VRMExpressionPresetName.Oh,
];

const BLINK_HOLD_SECONDS = 0.12;
const CAMERA_DISTANCE = 1.45;
const CAMERA_HEIGHT = 1.35;
const CAMERA_FOV = 35;
const TARGET_MODEL_HEIGHT = 1.6;
const MIN_SCALE = 0.01;
const MAX_SCALE = 100;
const CAMERA_PADDING = 1.25;
const MAX_RENDERABLE_SIZE = TARGET_MODEL_HEIGHT * 6;
const VRM_CANVAS_WIDTH = 480;
const VRM_CANVAS_HEIGHT = 640;

const WAVE_ANIMATION_NAME = 'greet_face_wave';
const DEFAULT_IDLE_CLIP_NAME = 'default_idle_sway';

interface ExpressionSampler {
  name: string;
  keyframes: Array<{ t: number; v: number }>;
}

interface VrmaGltfExtensions {
  VRMC_vrm_animation?: {
    expressionSamplers?: {
      preset?: ExpressionSampler[];
      custom?: ExpressionSampler[];
    };
  };
}

interface VrmaGltf {
  extensions?: VrmaGltfExtensions;
}

interface VrmaClipWithMetadata {
  clip: THREE.AnimationClip;
  vrmaData?: VrmaGltf;
}

type AnimationQueueIntent = 'play' | 'pose';

interface QueuedAnimation {
  slug: string;
  intent: AnimationQueueIntent;
  source?: string;
  timing?: AvatarAnimationTiming;
}

interface ActiveAnimation {
  action: THREE.AnimationAction;
  intent: AnimationQueueIntent;
  onFinish: (event: { action?: THREE.AnimationAction | null }) => void;
  vrmaData?: VrmaGltf;
}

function buildIdleSchedulerConfig(
  vrm: VRM,
  options: IdleAnimationOptions | undefined,
): IdleAnimationSchedulerConfig {
  const config: IdleAnimationSchedulerConfig = {
    enableBreathing: options?.enableBreathing ?? true,
    enableMicroMovement: options?.enableMicroMovement ?? true,
    enableBlink: options?.enableBlink ?? true,
    additionalClips: [],
  };

  const extras: IdleClipRegistration[] = [];
  const reservedNames = new Set<string>();

  if (options?.additionalClips?.length) {
    for (const clip of options.additionalClips) {
      extras.push({
        ...clip,
        clip: clip.clip.clone(),
      });
      reservedNames.add(clip.name);
    }
  }

  if (options?.vrmaAnimations?.length) {
    options.vrmaAnimations.forEach((animation, index) => {
      if (!animation) {
        return;
      }
      const maybeName = (animation as unknown as { name?: unknown } | null | undefined)?.name;
      const animationName =
        typeof maybeName === 'string' && maybeName.length > 0 ? maybeName : `vrma_idle_${index}`;
      const clip = createClipFromVrma(vrm, animation, animationName);
      extras.push({
        name: animationName,
        clip,
        weight: 1,
        priority: 0,
        loop: THREE.LoopRepeat,
      });
      reservedNames.add(animationName);
    });
  }

  if (!reservedNames.has(DEFAULT_IDLE_CLIP_NAME)) {
    // // Capture current shoulder rotations after relaxed pose is applied
    // const humanoid = vrm.humanoid;
    // let baselineShoulderRotations: { left: THREE.Euler; right: THREE.Euler } | undefined;
    // if (humanoid) {
    //   const leftShoulder = humanoid.getNormalizedBoneNode('leftShoulder');
    //   const rightShoulder = humanoid.getNormalizedBoneNode('rightShoulder');
    //   if (leftShoulder && rightShoulder) {
    //     baselineShoulderRotations = {
    //       left: new THREE.Euler().setFromQuaternion(leftShoulder.quaternion),
    //       right: new THREE.Euler().setFromQuaternion(rightShoulder.quaternion),
    //     };
    //   }
    // }
    const defaultClip = createDefaultIdleClip(vrm);
    if (defaultClip) {
      extras.push({
        name: DEFAULT_IDLE_CLIP_NAME,
        clip: defaultClip,
        weight: 0.35,
        priority: -1,
        loop: THREE.LoopRepeat,
      });
    }
  }

  if (extras.length > 0) {
    config.additionalClips = extras;
  }

  return config;
}

async function loadVrmaAnimation(binary: ArrayBuffer): Promise<{ animation: VRMAnimation; gltf: VrmaGltf } | null> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const gltf = (await loader.parseAsync(binary, '/')) as {
    userData?: { vrmAnimations?: VRMAnimation[] };
    extensions?: VrmaGltfExtensions;
  };
  const animations = gltf.userData?.vrmAnimations;
  if (!animations || animations.length === 0) {
    return null;
  }
  // Safe to access index 0 after empty check
  const animation = animations[0];
  if (!animation) {
    return null;
  }
  return { animation, gltf: { extensions: gltf.extensions } };
}

async function loadVrmaClips(vrm: VRM): Promise<Map<string, VrmaClipWithMetadata>> {
  const registry = new Map<string, VrmaClipWithMetadata>();
  const bridge = getPreloadApi();
  if (!bridge?.avatar?.listAnimations || !bridge.avatar.loadAnimationBinary) {
    return registry;
  }

  const animations = await bridge.avatar.listAnimations();
  for (const [index, animation] of animations.entries()) {
    try {
      const binary = await bridge.avatar.loadAnimationBinary(animation.id);
      if (!binary) {
        continue;
      }
      const result = await loadVrmaAnimation(binary);
      if (!result) {
        continue;
      }
      const name = animation.name?.trim() || animation.id;
      const slug = toAnimationSlug(name) || `animation-${index}`;
      const clip = createClipFromVrma(vrm, result.animation, name);
      registry.set(slug, { clip, vrmaData: result.gltf });
    } catch (error) {
      console.warn('[vrm-avatar-renderer] failed to load VRMA clip', {
        id: animation.id,
        name: animation.name,
        error,
      });
    }
  }

  return registry;
}

function quaternionToArray(quaternion: THREE.Quaternion): number[] {
  return [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
}

function multiplyQuaternion(base: THREE.Quaternion, delta: THREE.Euler): THREE.Quaternion {
  const next = new THREE.Quaternion(base.x, base.y, base.z, base.w);
  next.multiply(new THREE.Quaternion().setFromEuler(delta));
  return next;
}

// Helper: Linear interpolation between expression keyframes
function evaluateKeyframes(keyframes: Array<{ t: number; v: number }>, time: number): number | null {
  if (!keyframes || keyframes.length === 0) return null;

  // Clamp to bounds
  if (time < keyframes[0].t) return keyframes[0].v;
  if (time > keyframes[keyframes.length - 1].t) return keyframes[keyframes.length - 1].v;

  // Find surrounding keyframes
  for (let i = 0; i < keyframes.length - 1; i++) {
    const current = keyframes[i];
    const next = keyframes[i + 1];
    if (time >= current.t && time <= next.t) {
      // Linear interpolation
      const progress = (time - current.t) / (next.t - current.t);
      return current.v + (next.v - current.v) * progress;
    }
  }

  return keyframes[keyframes.length - 1].v;
}

// Apply expression keyframes from VRMA metadata at the given time
function applyExpressionFrameAtTime(vrm: VRM, vrmaData: VrmaGltf, currentTime: number) {
  if (!vrmaData?.extensions?.VRMC_vrm_animation?.expressionSamplers) {
    return;
  }

  const samplers = vrmaData.extensions.VRMC_vrm_animation.expressionSamplers;
  const expressionManager = vrm.expressionManager;

  if (!expressionManager) return;

  // Process preset expressions
  const presetSamplers = samplers.preset || [];
  for (const sampler of presetSamplers) {
    const value = evaluateKeyframes(sampler.keyframes, currentTime);
    if (value !== null) {
      expressionManager.setValue(sampler.name, value);
    }
  }

  // Process custom expressions
  const customSamplers = samplers.custom || [];
  for (const sampler of customSamplers) {
    const value = evaluateKeyframes(sampler.keyframes, currentTime);
    if (value !== null) {
      expressionManager.setValue(sampler.name, value);
    }
  }
}

/**
 * Apply facial expressions from pose data to a VRM model.
 * Uses VRM 1.0 preset names (happy, sad, angry, etc.)
 */
export function applyPoseExpressions(vrm: VRM, expressions: VRMPoseExpressions | undefined) {
  if (!expressions || !vrm.expressionManager) {
    return;
  }

  const expressionManager = vrm.expressionManager;

  // Log available expressions for debugging
  const availableExpressions = expressionManager.expressions?.map(e => e.expressionName) ?? [];
  console.info('[vrm-avatar-renderer] Available model expressions:', JSON.stringify(availableExpressions));

  // Apply preset expressions (always apply, including 0, to clear previous poses)
  if (expressions.presets) {
    for (const [name, weight] of Object.entries(expressions.presets)) {
      if (typeof weight === 'number' && Number.isFinite(weight)) {
        const clampedWeight = Math.max(0, Math.min(1, weight));

        // Check if expression exists in the model
        const expressionExists = availableExpressions.includes(name);
        if (!expressionExists && clampedWeight > 0) {
          console.warn(`[vrm-avatar-renderer] Expression '${name}' not found in VRM model. Available: ${availableExpressions.join(', ')}`);
        }

        expressionManager.setValue(name, clampedWeight);
        if (clampedWeight > 0) {
          console.info(`[vrm-avatar-renderer] Set expression '${name}' to ${clampedWeight.toFixed(2)}`);
        }
      }
    }
  }

  // Apply custom expressions (always apply, including 0, to clear previous poses)
  if (expressions.custom) {
    for (const [name, weight] of Object.entries(expressions.custom)) {
      if (typeof weight === 'number' && Number.isFinite(weight)) {
        const clampedWeight = Math.max(0, Math.min(1, weight));
        expressionManager.setValue(name, clampedWeight);
      }
    }
  }
}

/**
 * Normalize VRMPoseData to extract bones, handling both legacy flat format and new nested format.
 * Legacy format: { boneName: { rotation: [...] } }
 * New format: { bones: { boneName: { rotation: [...] } }, expressions: { presets: {...} } }
 */
export function normalizePoseData(pose: VRMPoseData): {
  bones: Record<string, { rotation: number[]; position?: number[] | null }>;
  expressions: VRMPoseExpressions | undefined;
} {
  // Check if this is the new nested format
  if (pose.bones && typeof pose.bones === 'object') {
    return {
      bones: pose.bones as Record<string, { rotation: number[]; position?: number[] | null }>,
      expressions: pose.expressions,
    };
  }

  // Legacy flat format - all keys are bone names
  const bones: Record<string, { rotation: number[]; position?: number[] | null }> = {};
  for (const [key, value] of Object.entries(pose)) {
    // Skip known non-bone keys
    if (key === 'expressions' || key === 'bones') continue;

    // Check if value looks like bone data
    if (value && typeof value === 'object' && 'rotation' in value && Array.isArray(value.rotation)) {
      bones[key] = value as { rotation: number[]; position?: number[] | null };
    }
  }

  return { bones, expressions: undefined };
}

const DEFAULT_POSE_TRANSITION_DURATION = 0.5; // seconds

/** Captured state for a single bone */
export interface CapturedBoneState {
  quaternion: THREE.Quaternion;
  position?: THREE.Vector3;
}

/**
 * Captures the current bone rotations and positions from a VRM humanoid.
 * This should be called BEFORE stopping any active animation to preserve the current pose.
 */
export function captureCurrentPose(
  vrm: VRM,
  boneNames?: string[],
): Map<string, CapturedBoneState> {
  const result = new Map<string, CapturedBoneState>();
  const humanoid = vrm.humanoid;
  if (!humanoid) {
    return result;
  }

  // If specific bone names provided, capture those; otherwise capture all available
  const bonesToCapture = boneNames ?? Object.keys(humanoid.humanBones);

  for (const boneName of bonesToCapture) {
    const node = humanoid.getNormalizedBoneNode(boneName as Parameters<typeof humanoid.getNormalizedBoneNode>[0]);
    if (!node) {
      continue;
    }

    result.set(boneName, {
      quaternion: node.quaternion.clone(),
      position: node.position.clone(),
    });
  }

  return result;
}

/**
 * Creates an AnimationClip that transitions from the current bone rotations to the target pose.
 * Uses SLERP (spherical linear interpolation) for smooth quaternion interpolation.
 * 
 * @param vrm - The VRM model
 * @param targetPose - The target pose to transition to
 * @param duration - Duration of the transition in seconds
 * @param startingPose - Optional captured pose to start from (if not provided, reads current node values)
 * @returns Object with the animation clip and any expressions to apply, or null if no tracks created
 */
export function createPoseTransitionClip(
  vrm: VRM,
  targetPose: VRMPoseData,
  duration: number = DEFAULT_POSE_TRANSITION_DURATION,
  startingPose?: Map<string, CapturedBoneState>,
): { clip: THREE.AnimationClip; expressions: VRMPoseExpressions | undefined } | null {
  const humanoid = vrm.humanoid;
  if (!humanoid) {
    return null;
  }

  // Normalize pose data to handle both legacy and new formats
  const { bones, expressions } = normalizePoseData(targetPose);

  const tracks: THREE.KeyframeTrack[] = [];
  const resolvedBones: string[] = [];
  const unresolvedBones: string[] = [];

  for (const [boneName, boneData] of Object.entries(bones)) {
    const rotation = boneData.rotation;
    if (!rotation || rotation.length !== 4) {
      continue;
    }

    // Get the normalized bone node (used by VRM animations - same as wave animation)
    const node = humanoid.getNormalizedBoneNode(boneName as Parameters<typeof humanoid.getNormalizedBoneNode>[0]);
    if (!node) {
      unresolvedBones.push(boneName);
      continue;
    }

    resolvedBones.push(boneName);

    // Use captured pose if available, otherwise read current node values
    const capturedState = startingPose?.get(boneName);
    const currentQuat = capturedState?.quaternion ?? node.quaternion.clone();
    const targetQuat = new THREE.Quaternion(rotation[0], rotation[1], rotation[2], rotation[3]);

    // Create keyframe track: times [0, duration], values [current, target]
    const times = [0, duration];
    const values = [
      currentQuat.x, currentQuat.y, currentQuat.z, currentQuat.w,
      targetQuat.x, targetQuat.y, targetQuat.z, targetQuat.w,
    ];

    // Use the node's name for the track (AnimationMixer finds nodes by name)
    const track = new THREE.QuaternionKeyframeTrack(
      `${node.name}.quaternion`,
      times,
      values,
    );
    tracks.push(track);

    // Handle position if present (e.g., for hips in crouching poses)
    if (boneData.position && boneData.position.length === 3) {
      const currentPos = capturedState?.position ?? node.position.clone();
      const targetPos = boneData.position;
      const posTimes = [0, duration];
      const posValues = [
        currentPos.x, currentPos.y, currentPos.z,
        targetPos[0], targetPos[1], targetPos[2],
      ];
      const posTrack = new THREE.VectorKeyframeTrack(
        `${node.name}.position`,
        posTimes,
        posValues,
      );
      tracks.push(posTrack);
    }
  }

  if (unresolvedBones.length > 0) {
    console.warn('[vrm-avatar-renderer] Could not resolve bones for pose transition:', JSON.stringify(unresolvedBones));
  }

  if (tracks.length === 0) {
    console.warn('[vrm-avatar-renderer] No valid tracks created for pose transition');
    return null;
  }

  console.info('[vrm-avatar-renderer] Created pose transition clip:', JSON.stringify({
    trackCount: tracks.length,
    resolvedBones,
    unresolvedBones,
    duration,
    hasExpressions: !!expressions,
  }));

  return {
    clip: new THREE.AnimationClip('pose-transition', duration, tracks),
    expressions,
  };
}

export function createRightArmWaveClip(vrm: VRM): THREE.AnimationClip | null {
  const humanoid = vrm.humanoid;
  if (!humanoid) {
    console.warn('[vrm-avatar-renderer] VRM humanoid is unavailable; cannot create wave animation clip.');
    return null;
  }

  const upperArm = humanoid.getNormalizedBoneNode('rightUpperArm');
  const lowerArm = humanoid.getNormalizedBoneNode('rightLowerArm');
  const hand = humanoid.getNormalizedBoneNode('rightHand');

  if (!upperArm || !lowerArm) {
    console.warn('[vrm-avatar-renderer] Missing right arm bones; skipping wave animation setup.');
    return null;
  }

  const times = [0, 0.35, 0.7, 1.05, 1.4];

  const upperRest = upperArm.quaternion.clone();
  const lowerRest = lowerArm.quaternion.clone();
  const handRest = hand?.quaternion.clone() ?? null;

  const upperRaised = multiplyQuaternion(upperRest, new THREE.Euler(-0.9, 0.25, 0));
  const lowerRaised = multiplyQuaternion(lowerRest, new THREE.Euler(-0.7, 0.15, 0));
  const handRaised = handRest ? multiplyQuaternion(handRest, new THREE.Euler(0, 0.4, 0)) : null;

  const upperWaveOut = multiplyQuaternion(upperRaised, new THREE.Euler(0.2, 0, 0.3));
  const upperWaveIn = multiplyQuaternion(upperRaised, new THREE.Euler(-0.2, 0, -0.3));

  const lowerWaveOut = multiplyQuaternion(lowerRaised, new THREE.Euler(0.35, 0, 0.2));
  const lowerWaveIn = multiplyQuaternion(lowerRaised, new THREE.Euler(-0.35, 0, -0.2));

  const handWaveOut = handRaised ? multiplyQuaternion(handRaised, new THREE.Euler(0, 0.25, 0.15)) : null;
  const handWaveIn = handRaised ? multiplyQuaternion(handRaised, new THREE.Euler(0, -0.25, -0.15)) : null;

  const upperValues = [
    ...quaternionToArray(upperRest),
    ...quaternionToArray(upperRaised),
    ...quaternionToArray(upperWaveOut),
    ...quaternionToArray(upperWaveIn),
    ...quaternionToArray(upperRest),
  ];
  const lowerValues = [
    ...quaternionToArray(lowerRest),
    ...quaternionToArray(lowerRaised),
    ...quaternionToArray(lowerWaveOut),
    ...quaternionToArray(lowerWaveIn),
    ...quaternionToArray(lowerRest),
  ];

  const tracks: THREE.KeyframeTrack[] = [
    new THREE.QuaternionKeyframeTrack(`${upperArm.name}.quaternion`, times, upperValues),
    new THREE.QuaternionKeyframeTrack(`${lowerArm.name}.quaternion`, times, lowerValues),
  ];

  if (hand && handRest && handRaised && handWaveOut && handWaveIn) {
    const handValues = [
      ...quaternionToArray(handRest),
      ...quaternionToArray(handRaised),
      ...quaternionToArray(handWaveOut),
      ...quaternionToArray(handWaveIn),
      ...quaternionToArray(handRest),
    ];
    tracks.push(new THREE.QuaternionKeyframeTrack(`${hand.name}.quaternion`, times, handValues));
  }

  return new THREE.AnimationClip(WAVE_ANIMATION_NAME, times[times.length - 1], tracks);
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export function mapVisemeToPreset(index: number | undefined): VRMExpressionPresetName | null {
  if (typeof index !== 'number' || !Number.isFinite(index)) {
    return null;
  }
  const preset = VISEME_PRESETS[index];
  return preset ?? null;
}

export function smoothWeight(
  current: number,
  target: number,
  deltaSeconds: number,
  attackRate = 14,
  releaseRate = 10,
): number {
  const clampedTarget = clamp01(target);
  const clampedCurrent = clamp01(current);
  const rate = clampedTarget > clampedCurrent ? attackRate : releaseRate;
  const factor = 1 - Math.exp(-Math.max(0, deltaSeconds) * rate);
  if (!Number.isFinite(factor) || factor <= 0) {
    return clampedCurrent;
  }
  const next = clampedCurrent + (clampedTarget - clampedCurrent) * Math.min(1, factor);
  return clamp01(next);
}

interface VisemeWeightState {
  weights: Map<VRMExpressionPresetName, number>;
}

interface BlinkState {
  value: number;
  target: number;
  hold: number;
}

function createDefaultVisemeState(): VisemeWeightState {
  const weights = new Map<VRMExpressionPresetName, number>();
  for (const preset of VISEME_PRESETS) {
    weights.set(preset, 0);
  }
  return { weights };
}

function createDefaultBlinkState(): BlinkState {
  return { value: 0, target: 0, hold: 0 };
}

function createDefaultIdleClip(vrm: VRM): THREE.AnimationClip | null {
  const duration = 4.5;
  const hipsTrack = createHumanoidRotationTrack(vrm, 'hips', [
    { time: 0, rotation: new THREE.Euler(0, 0, 0) },
    { time: duration * 0.5, rotation: new THREE.Euler(0.04, 0, 0.03) },
    { time: duration, rotation: new THREE.Euler(0, 0, 0) },
  ]);
  const spineTrack = createHumanoidRotationTrack(vrm, 'spine', [
    { time: 0, rotation: new THREE.Euler(0, 0, 0) },
    { time: duration * 0.5, rotation: new THREE.Euler(-0.03, 0.02, -0.025) },
    { time: duration, rotation: new THREE.Euler(0, 0, 0) },
  ]);
  const headTrack = createHumanoidRotationTrack(vrm, 'head', [
    { time: 0, rotation: new THREE.Euler(0, 0, 0) },
    { time: duration * 0.5, rotation: new THREE.Euler(0.02, 0.05, 0.01) },
    { time: duration, rotation: new THREE.Euler(0, 0, 0) },
  ]);
  const leftShoulderTrack = createHumanoidRotationTrack(vrm, 'leftShoulder', [
    { time: 0, rotation: new THREE.Euler(0, 0, 0) },
    { time: duration * 0.5, rotation: new THREE.Euler(-0.02, 0, 0.03) },
    { time: duration, rotation: new THREE.Euler(0, 0, 0) },
  ]);
  const rightShoulderTrack = createHumanoidRotationTrack(vrm, 'rightShoulder', [
    { time: 0, rotation: new THREE.Euler(0, 0, 0) },
    { time: duration * 0.5, rotation: new THREE.Euler(-0.02, 0, -0.03) },
    { time: duration, rotation: new THREE.Euler(0, 0, 0) },
  ]);

  return createVrmAnimationClip(vrm, {
    name: DEFAULT_IDLE_CLIP_NAME,
    duration,
    rotations: [
      { bone: 'hips', track: hipsTrack },
      { bone: 'spine', track: spineTrack },
      { bone: 'head', track: headTrack },
      { bone: 'leftShoulder', track: leftShoulderTrack },
      { bone: 'rightShoulder', track: rightShoulderTrack },
    ],
  });
}

// detectYAxisDirection removed (unused)

// Detect if model is in T-pose by checking arm orientation relative to spine
function isInTPose(vrm: VRM): boolean {
  const humanoid = vrm.humanoid;
  if (!humanoid) {
    return false;
  }

  const leftUpperArm = humanoid.getNormalizedBoneNode('leftUpperArm');
  const rightUpperArm = humanoid.getNormalizedBoneNode('rightUpperArm');
  const chest = humanoid.getNormalizedBoneNode('chest') || humanoid.getNormalizedBoneNode('upperChest');
  const hips = humanoid.getNormalizedBoneNode('hips');

  if (!leftUpperArm || !rightUpperArm || !hips) {
    return false;
  }

  // Get spine direction (hips to chest/head)
  const hipsWorldPos = new THREE.Vector3();
  const chestWorldPos = new THREE.Vector3();
  const leftArmWorldPos = new THREE.Vector3();
  const rightArmWorldPos = new THREE.Vector3();

  hips.getWorldPosition(hipsWorldPos);
  const chestNode = chest || humanoid.getNormalizedBoneNode('head');
  if (chestNode) {
    chestNode.getWorldPosition(chestWorldPos);
  } else {
    return false;
  }
  leftUpperArm.getWorldPosition(leftArmWorldPos);
  rightUpperArm.getWorldPosition(rightArmWorldPos);

  const spineDir = chestWorldPos.sub(hipsWorldPos).normalize();

  // Get direction from shoulder to elbow (arm direction)
  const leftShoulderPos = new THREE.Vector3();
  const rightShoulderPos = new THREE.Vector3();
  humanoid.getNormalizedBoneNode('leftShoulder')?.getWorldPosition(leftShoulderPos);
  humanoid.getNormalizedBoneNode('rightShoulder')?.getWorldPosition(rightShoulderPos);

  const leftArmDir = leftArmWorldPos.clone().sub(leftShoulderPos.clone()).normalize();
  const rightArmDir = rightArmWorldPos.clone().sub(rightShoulderPos.clone()).normalize();

  // In T-pose, arms point perpendicular to spine (dot product near 0)
  // In natural pose, arms point downward (dot product near -0.7 to -1.0)
  const leftDot = spineDir.dot(leftArmDir);
  const rightDot = spineDir.dot(rightArmDir);

  console.log('[vrm-avatar-renderer] T-pose detection:', {
    spineDirY: spineDir.y.toFixed(3),
    leftArmDot: leftDot.toFixed(3),
    rightArmDot: rightDot.toFixed(3),
    absLeftDot: Math.abs(leftDot).toFixed(3),
    absRightDot: Math.abs(rightDot).toFixed(3),
    inTPose: Math.abs(leftDot) < 0.3 && Math.abs(rightDot) < 0.3,
  });

  // If both arms are roughly horizontal (dot product between -0.3 and 0.3), it's T-pose
  return Math.abs(leftDot) < 0.3 && Math.abs(rightDot) < 0.3;
}









/**
 * Create a natural stance pose for VRM humanoid using the VRM pose system.
 * Returns a VRMPose object with rotations relative to T-pose.
 * 
 * This creates a relaxed arm position:
 * - Shoulders (clavicles) relaxed slightly down (~5 degrees)
 * - Shoulders (clavicles) relaxed slightly down
 * - Upper arms rotated down but flared out slightly (not pinned to sides)
 * - Elbows bent
 * - Hands relaxed (fingers curved)
 * 
 * @returns VRMPose object with quaternion rotations for natural arm stance
 */
function createNaturalStancePose(): VRMPose {
  const pose: VRMPose = {};

  // =========================================================================
  // 1. Arms & Shoulders
  // =========================================================================

  // Shoulder (Clavicle)
  const shoulderRelaxAngle = Math.PI * 0.03; // ~5 degrees down

  const leftShoulderQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), shoulderRelaxAngle);
  pose['leftShoulder'] = { rotation: leftShoulderQuat.toArray() as [number, number, number, number] };

  const rightShoulderQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), shoulderRelaxAngle);
  pose['rightShoulder'] = { rotation: rightShoulderQuat.toArray() as [number, number, number, number] };

  // Upper Arm
  // Adjusted: Reduced down angle (75 -> 70) to flare elbows out slightly
  // Reduced inward angle (18 -> 10) to keep arms less crossed
  const armDownAngle = Math.PI * 0.39; // ~70 degrees down (was 75)
  const armForwardAngle = Math.PI * 0.05; // ~9 degrees forward
  const armInwardAngle = Math.PI * 0.06; // ~10 degrees inward (was 18)

  // Left upper arm
  const leftUpperArmQuat = new THREE.Quaternion();
  const leftUpperArmEuler = new THREE.Euler(armForwardAngle, -armInwardAngle, armDownAngle, 'XYZ');
  leftUpperArmQuat.setFromEuler(leftUpperArmEuler);
  pose['leftUpperArm'] = { rotation: leftUpperArmQuat.toArray() as [number, number, number, number] };

  // Right upper arm
  const rightUpperArmQuat = new THREE.Quaternion();
  const rightUpperArmEuler = new THREE.Euler(armForwardAngle, armInwardAngle, -armDownAngle, 'XYZ');
  rightUpperArmQuat.setFromEuler(rightUpperArmEuler);
  pose['rightUpperArm'] = { rotation: rightUpperArmQuat.toArray() as [number, number, number, number] };

  // Lower Arm (Elbow)
  const elbowBendAngle = Math.PI * 0.1; // ~18 degrees
  const elbowBendQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), elbowBendAngle);

  pose['leftLowerArm'] = { rotation: elbowBendQuat.toArray() as [number, number, number, number] };
  pose['rightLowerArm'] = { rotation: elbowBendQuat.toArray() as [number, number, number, number] };

  // =========================================================================
  // 2. Hands (Fingers)
  // =========================================================================

  // Finger curl angles
  // Fingers curl around Z axis in default VRM T-pose usually
  // Progressive curl: Proximal < Intermediate < Distal usually looks natural, 
  // or consistent curl.
  const fingerCurlAngle = Math.PI * 0.08; // ~15 degrees per joint
  // thumbCurlAngle was defined but unused because the thumb loop used fingerCurlAngle incorrectly.
  // Now it is used below in leftThumbQuat/rightThumbQuat.
  const thumbCurlAngle = Math.PI * 0.08;

  // Revised: User reported backwards curl. Flipping signs.
  // Previous: Left = -Z (Negative), Right = +Z (Positive)
  // New: Left = +Z (Positive), Right = -Z (Negative)

  const leftFingerQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), fingerCurlAngle);
  const rightFingerQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), fingerCurlAngle);

  // Thumb is special.
  // Thumbs usually need to rotate down/in.
  // Flipping thumb rotation as well to match
  // Using thumbCurlAngle correctly now
  const leftThumbQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -thumbCurlAngle, 0));
  const rightThumbQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, thumbCurlAngle, 0));

  const fingers = ['Index', 'Middle', 'Ring', 'Little'];
  const segments = ['Proximal', 'Intermediate', 'Distal'];

  fingers.forEach(finger => {
    segments.forEach(segment => {
      // Left Hand
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pose as Record<string, any>)[`left${finger}${segment}`] = { rotation: leftFingerQuat.toArray() as [number, number, number, number] };
      // Right Hand
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pose as Record<string, any>)[`right${finger}${segment}`] = { rotation: rightFingerQuat.toArray() as [number, number, number, number] };
    });
  });

  // Thumbs
  ['Proximal', 'Intermediate', 'Distal'].forEach(segment => {
    // Apply a different rotation for thumbs if needed, or simple curl
    // Thumbs in T-pose are often 45 deg?
    // Let's try a simple Z curl similar to fingers but maybe varying axis
    // For now using the same curl but maybe adjusting axis if it looks wrong.
    // Safer to stick to Z curl for now as a starting point for "relaxed" 
    // Use distinct thumb rotation
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pose as Record<string, any>)[`leftThumb${segment}`] = { rotation: leftThumbQuat.toArray() as [number, number, number, number] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pose as Record<string, any>)[`rightThumb${segment}`] = { rotation: rightThumbQuat.toArray() as [number, number, number, number] };
  });

  return pose;
}

function applyRelaxedPose(vrm: VRM) {
  const humanoid = vrm.humanoid;
  if (!humanoid) {
    return;
  }

  // Check if model is in T-pose
  const inTPose = isInTPose(vrm);
  console.log('[vrm-avatar-renderer] T-pose detection result:', inTPose);

  if (!inTPose) {
    console.log('[vrm-avatar-renderer] Model not in T-pose, skipping relaxed pose adjustment');
    return; // Already in natural pose
  }

  console.log('[vrm-avatar-renderer] Applying relaxed pose adjustment using VRM pose system...');

  // Log BEFORE positions (for debugging)
  const leftHand = humanoid.getNormalizedBoneNode('leftHand');
  const rightHand = humanoid.getNormalizedBoneNode('rightHand');

  if (leftHand && rightHand) {
    const leftHandBefore = new THREE.Vector3();
    const rightHandBefore = new THREE.Vector3();
    leftHand.getWorldPosition(leftHandBefore);
    rightHand.getWorldPosition(rightHandBefore);

    console.log('[vrm-avatar-renderer] BEFORE relaxed pose:', JSON.stringify({
      leftHand: { x: leftHandBefore.x.toFixed(3), y: leftHandBefore.y.toFixed(3), z: leftHandBefore.z.toFixed(3) },
      rightHand: { x: rightHandBefore.x.toFixed(3), y: rightHandBefore.y.toFixed(3), z: rightHandBefore.z.toFixed(3) },
    }));
  }

  // Apply natural stance pose using VRM's pose system
  const naturalPose = createNaturalStancePose();
  humanoid.setNormalizedPose(naturalPose);

  // Update the world matrix to reflect the new pose
  vrm.scene.updateWorldMatrix(true, true);

  // Log AFTER positions (for debugging)
  if (leftHand && rightHand) {
    const leftHandAfter = new THREE.Vector3();
    const rightHandAfter = new THREE.Vector3();
    leftHand.getWorldPosition(leftHandAfter);
    rightHand.getWorldPosition(rightHandAfter);

    console.log('[vrm-avatar-renderer] AFTER relaxed pose:', JSON.stringify({
      leftHand: { x: leftHandAfter.x.toFixed(3), y: leftHandAfter.y.toFixed(3), z: leftHandAfter.z.toFixed(3) },
      rightHand: { x: rightHandAfter.x.toFixed(3), y: rightHandAfter.y.toFixed(3), z: rightHandAfter.z.toFixed(3) },
    }));
  }

  console.log('[vrm-avatar-renderer] Relaxed pose applied successfully using VRM pose system');
}

/**
 * Save the natural stance pose as 'default' if it doesn't already exist.
 * This allows users to restore the avatar to its natural pose.
 */
async function saveDefaultPoseIfNeeded(): Promise<void> {
  const bridge = getPreloadApi();
  const avatar = bridge?.avatar;
  if (!avatar?.listPoses || !avatar?.uploadPose) {
    console.warn('[vrm-avatar-renderer] Pose API unavailable, skipping default pose save');
    return;
  }

  try {
    const existingPoses = await avatar.listPoses();
    const hasDefault = existingPoses.some((p) => p.name.toLowerCase() === 'default');

    if (hasDefault) {
      console.info('[vrm-avatar-renderer] Default pose already exists, skipping save');
      return;
    }

    // Get the natural stance pose and convert to uploadable format
    const naturalPose = createNaturalStancePose();
    const poseData: Record<string, { rotation: number[]; position?: number[] }> = {};

    for (const [boneName, boneData] of Object.entries(naturalPose)) {
      if (boneData?.rotation) {
        const rotation = boneData.rotation as { x: number; y: number; z: number; w: number } | [number, number, number, number];
        const rotationArray = Array.isArray(rotation)
          ? rotation
          : [rotation.x, rotation.y, rotation.z, rotation.w];
        poseData[boneName] = { rotation: rotationArray };
      }
    }

    const jsonData = JSON.stringify(poseData, null, 2);

    await avatar.uploadPose({
      name: 'default',
      fileName: 'default.pose.json',
      data: jsonData,
    });

    console.info('[vrm-avatar-renderer] Default pose saved successfully', {
      boneCount: Object.keys(poseData).length
    });
  } catch (error) {
    console.warn('[vrm-avatar-renderer] Failed to save default pose', error);
  }
}

function getHeadBounds(vrm: VRM): { width: number; height: number; depth: number } | null {
  const humanoid = vrm.humanoid;
  if (!humanoid) {
    return null;
  }

  const head = humanoid.getNormalizedBoneNode('head');
  if (!head) {
    return null;
  }

  const box = new THREE.Box3();
  let hasBounds = false;

  head.traverse((object) => {
    const mesh = object as THREE.Mesh | THREE.SkinnedMesh;
    const isMesh = (mesh as THREE.Mesh).isMesh === true;
    const isSkinnedMesh = (mesh as THREE.SkinnedMesh).isSkinnedMesh === true;
    if (!isMesh && !isSkinnedMesh) {
      return;
    }
    const geometry = mesh.geometry;
    if (!geometry) {
      return;
    }
    if (!geometry.boundingBox) {
      geometry.computeBoundingBox();
    }
    const localBox = geometry.boundingBox;
    if (!localBox) {
      return;
    }
    const worldBox = localBox.clone();
    worldBox.applyMatrix4(mesh.matrixWorld);
    if (!hasBounds) {
      box.copy(worldBox);
      hasBounds = true;
    } else {
      box.union(worldBox);
    }
  });

  if (!hasBounds) {
    return null;
  }

  const size = new THREE.Vector3();
  box.getSize(size);
  return {
    width: size.x,
    height: size.y,
    depth: size.z,
  };
}

function computeHumanoidMetrics(vrm: VRM) {
  const humanoid = vrm.humanoid;
  if (!humanoid) {
    return null;
  }

  const head = humanoid.getNormalizedBoneNode('head');
  const hips = humanoid.getNormalizedBoneNode('hips');
  const leftFoot = humanoid.getNormalizedBoneNode('leftFoot');
  const rightFoot = humanoid.getNormalizedBoneNode('rightFoot');

  if (!head) {
    return null;
  }

  const headPos = new THREE.Vector3();
  head.getWorldPosition(headPos);

  const candidates: THREE.Vector3[] = [];
  if (leftFoot) {
    const pos = new THREE.Vector3();
    leftFoot.getWorldPosition(pos);
    candidates.push(pos);
  }
  if (rightFoot) {
    const pos = new THREE.Vector3();
    rightFoot.getWorldPosition(pos);
    candidates.push(pos);
  }
  if (hips) {
    const pos = new THREE.Vector3();
    hips.getWorldPosition(pos);
    candidates.push(pos);
  }

  if (candidates.length === 0) {
    return null;
  }

  const groundY = Math.min(...candidates.map((pos) => pos.y));
  const height = headPos.y - groundY;
  if (!Number.isFinite(height) || height <= 0) {
    return null;
  }

  const center = hips
    ? new THREE.Vector3().setFromMatrixPosition(hips.matrixWorld)
    : candidates.reduce((acc, pos) => acc.add(pos), new THREE.Vector3()).multiplyScalar(1 / candidates.length);

  return { height, groundY, center };
}

function computeRenderableBounds(root: THREE.Object3D): { box: THREE.Box3; size: THREE.Vector3; center: THREE.Vector3 } | null {
  const box = new THREE.Box3();
  let hasBounds = false;

  root.traverse((object) => {
    const mesh = object as THREE.Mesh | THREE.SkinnedMesh;
    const isMesh = (mesh as THREE.Mesh).isMesh === true;
    const isSkinnedMesh = (mesh as THREE.SkinnedMesh).isSkinnedMesh === true;
    if (!isMesh && !isSkinnedMesh) {
      return;
    }
    const geometry = mesh.geometry;
    if (!geometry) {
      return;
    }
    if (!geometry.boundingBox) {
      geometry.computeBoundingBox();
    }
    const localBox = geometry.boundingBox;
    if (!localBox) {
      return;
    }
    const worldBox = localBox.clone();
    worldBox.applyMatrix4(mesh.matrixWorld);
    if (!hasBounds) {
      box.copy(worldBox);
      hasBounds = true;
    } else {
      box.union(worldBox);
    }
  });

  if (!hasBounds) {
    return null;
  }

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return { box, size, center };
}

function normalizeVrmScene(vrm: VRM, targetHeight = TARGET_MODEL_HEIGHT) {
  vrm.scene.updateWorldMatrix(true, true);
  const humanoidMetrics = computeHumanoidMetrics(vrm);
  if (humanoidMetrics) {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, targetHeight / humanoidMetrics.height));
    vrm.scene.scale.setScalar(scale);
    vrm.scene.updateWorldMatrix(true, true);
    const scaledMetrics = computeHumanoidMetrics(vrm);
    if (scaledMetrics) {
      vrm.scene.position.x -= scaledMetrics.center.x;
      vrm.scene.position.y -= scaledMetrics.groundY;
      vrm.scene.position.z -= scaledMetrics.center.z;
      vrm.scene.updateWorldMatrix(true, true);
    }
    return;
  }

  const bounds = computeRenderableBounds(vrm.scene);
  if (!bounds) {
    return;
  }

  const height = bounds.size.y;
  if (!Number.isFinite(height) || height <= 0) {
    return;
  }

  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, targetHeight / height));
  vrm.scene.scale.setScalar(scale);
  vrm.scene.updateWorldMatrix(true, true);

  const normalizedBounds = computeRenderableBounds(vrm.scene);
  if (!normalizedBounds) {
    return;
  }

  const center = normalizedBounds.center;
  const groundY = normalizedBounds.box.min.y;
  vrm.scene.position.x -= center.x;
  vrm.scene.position.y -= groundY;
  vrm.scene.position.z -= center.z;
  vrm.scene.updateWorldMatrix(true, true);
}

function fitCameraToBounds(
  camera: THREE.PerspectiveCamera,
  bounds: { size: THREE.Vector3; center: THREE.Vector3 },
) {
  const maxSize = Math.max(bounds.size.x, bounds.size.y, bounds.size.z);
  if (!Number.isFinite(maxSize) || maxSize <= 0) {
    return;
  }

  const fovRadians = (camera.fov * Math.PI) / 180;
  const distance = (maxSize * CAMERA_PADDING) / (2 * Math.tan(fovRadians / 2));
  camera.position.set(
    bounds.center.x,
    bounds.center.y + bounds.size.y * 0.1,
    bounds.center.z + distance,
  );
  camera.near = Math.max(0.01, distance / 100);
  camera.far = Math.max(camera.near + 10, distance * 10);
  camera.updateProjectionMatrix();
  camera.lookAt(bounds.center);
}

export function suppressOutlierMeshes(root: THREE.Object3D, maxSize: number) {
  let hiddenCount = 0;
  const worldBox = new THREE.Box3();
  const size = new THREE.Vector3();

  root.updateWorldMatrix(true, true);
  root.traverse((object) => {
    const mesh = object as THREE.Mesh | THREE.SkinnedMesh;
    const isMesh = (mesh as THREE.Mesh).isMesh === true;
    const isSkinnedMesh = (mesh as THREE.SkinnedMesh).isSkinnedMesh === true;
    if (!isMesh && !isSkinnedMesh) {
      return;
    }

    worldBox.setFromObject(mesh);
    if (worldBox.isEmpty()) {
      return;
    }

    worldBox.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > maxSize) {
      mesh.visible = false;
      hiddenCount += 1;
      console.warn('[vrm-avatar-renderer] Hiding oversized mesh', {
        name: mesh.name,
        maxDim: Number(maxDim.toFixed(3)),
      });
    }
  });

  return hiddenCount;
}

function disposeVrm(vrm: VRM | null) {
  if (!vrm) {
    return;
  }

  try {
    vrm.expressionManager?.resetValues();
  } catch {
    // ignore expression reset errors
  }

  try {
    VRMUtils.deepDispose(vrm.scene);
  } catch {
    // ignore deep disposal errors
  }
}

export const VrmAvatarRenderer = memo(function VrmAvatarRenderer({
  frame,
  model,
  onStatusChange,
  className,
  idleOptions,
  animationVersion,
}: VrmAvatarRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const currentVrmRef = useRef<VRM | null>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const idleSchedulerRef = useRef<IdleAnimationScheduler | null>(null);
  const waveActionRef = useRef<THREE.AnimationAction | null>(null);
  const expressionManagerRef = useRef<VRMExpressionManager | null>(null);
  const visemeStateRef = useRef<VisemeWeightState>(createDefaultVisemeState());
  const blinkStateRef = useRef<BlinkState>(createDefaultBlinkState());
  const frameRef = useRef<VisemeFrame | null>(frame);
  const animationFrameRef = useRef<number | null>(null);
  const clockRef = useRef(new THREE.Clock());
  const idleOptionsRef = useRef<IdleAnimationOptions | undefined>(idleOptions);
  const clipRegistryRef = useRef<Map<string, VrmaClipWithMetadata>>(new Map());
  const animationQueueRef = useRef<QueuedAnimation[]>([]);
  const activeAnimationRef = useRef<ActiveAnimation | null>(null);
  const animationSuspensionRef = useRef<(() => void) | null>(null);
  const vrmaRegistryReadyRef = useRef(false);
  const [rendererReady, setRendererReady] = useState(false);

  frameRef.current = frame;
  idleOptionsRef.current = idleOptions;

  const releaseIdleSuspension = useCallback(() => {
    if (animationSuspensionRef.current) {
      animationSuspensionRef.current();
      animationSuspensionRef.current = null;
    }
  }, []);

  const suspendIdleAnimations = useCallback(() => {
    if (animationSuspensionRef.current) {
      return;
    }
    const scheduler = idleSchedulerRef.current;
    animationSuspensionRef.current = scheduler?.suspend(8) ?? null;
  }, []);

  const clearActiveAnimation = useCallback(() => {
    const active = activeAnimationRef.current;
    if (!active) {
      return;
    }

    const mixer = mixerRef.current;
    if (mixer) {
      mixer.removeEventListener('finished', active.onFinish);
    }

    try {
      active.action.stop();
    } catch (error) {
      console.warn('[vrm-avatar-renderer] failed to stop animation action', error);
    }

    activeAnimationRef.current = null;
    if (animationQueueRef.current.length === 0) {
      releaseIdleSuspension();
    }
  }, [releaseIdleSuspension]);

  const playNextQueuedAnimation = useCallback(() => {
    if (activeAnimationRef.current) {
      return;
    }

    const mixer = mixerRef.current;
    if (!mixer) {
      return;
    }

    if (!vrmaRegistryReadyRef.current) {
      return;
    }

    const next = animationQueueRef.current.shift();
    if (!next) {
      releaseIdleSuspension();
      return;
    }

    const clipData = clipRegistryRef.current.get(next.slug);
    if (!clipData) {
      console.warn('[vrm-avatar-renderer] requested animation clip is unavailable', { slug: next.slug });
      playNextQueuedAnimation();
      return;
    }

    suspendIdleAnimations();

    const action = mixer.clipAction(clipData.clip);
    if (next.timing?.onStart) {
      const startAt = next.timing.startAt ?? Date.now();
      next.timing.onStart(startAt);
    }
    const handleFinished = (event: { action?: THREE.AnimationAction | null }) => {
      if (event.action !== action) {
        return;
      }

      mixer.removeEventListener('finished', handleFinished);

      if (next.intent === 'pose') {
        action.clampWhenFinished = true;
        action.enabled = true;
        action.setEffectiveTimeScale(0);
        activeAnimationRef.current = {
          action,
          intent: 'pose',
          onFinish: handleFinished,
          vrmaData: clipData.vrmaData,
        };
        return;
      }

      try {
        action.stop();
      } catch (error) {
        console.warn('[vrm-avatar-renderer] failed to stop animation after completion', error);
      }

      activeAnimationRef.current = null;
      playNextQueuedAnimation();
    };

    activeAnimationRef.current = {
      action,
      intent: next.intent,
      onFinish: handleFinished,
      vrmaData: clipData.vrmaData,
    };

    try {
      action.reset();
      action.enabled = true;
      action.setLoop(THREE.LoopOnce, 1);
      action.setEffectiveWeight(1);
      action.setEffectiveTimeScale(1);
      action.clampWhenFinished = true;
      mixer.addEventListener('finished', handleFinished);
      action.play();
    } catch (error) {
      mixer.removeEventListener('finished', handleFinished);
      activeAnimationRef.current = null;
      console.error('[vrm-avatar-renderer] failed to play animation clip', error);
      playNextQueuedAnimation();
    }
  }, [releaseIdleSuspension, suspendIdleAnimations]);

  const enqueueAnimation = useCallback(
    (request: QueuedAnimation) => {
      if (request.intent === 'pose' && activeAnimationRef.current?.intent === 'pose') {
        clearActiveAnimation();
      }

      animationQueueRef.current.push(request);
      playNextQueuedAnimation();
    },
    [clearActiveAnimation, playNextQueuedAnimation],
  );

  const playWave = useCallback(() => {
    const mixer = mixerRef.current;
    const action = waveActionRef.current;
    if (!mixer || !action) {
      return false;
    }

    const idleScheduler = idleSchedulerRef.current;
    const releaseIdle = idleScheduler?.suspend(5) ?? null;

    const handleFinished = (event: { action?: THREE.AnimationAction | null }) => {
      if (event.action !== action) {
        return;
      }
      mixer.removeEventListener('finished', handleFinished);
      releaseIdle?.();
      try {
        action.stop();
      } catch (stopError) {
        console.warn('[vrm-avatar-renderer] failed to stop wave animation after completion', stopError);
      }
    };

    try {
      action.reset();
      action.enabled = true;
      action.setLoop(THREE.LoopOnce, 1);
      action.setEffectiveWeight(1);
      action.setEffectiveTimeScale(1);
      action.clampWhenFinished = true;
      if (typeof action.fadeIn === 'function') {
        action.fadeIn(0.2);
      }
      mixer.addEventListener('finished', handleFinished);
      action.play();
      if (typeof action.fadeOut === 'function') {
        action.fadeOut(0.25);
      }
      return true;
    } catch (error) {
      mixer.removeEventListener('finished', handleFinished);
      releaseIdle?.();
      console.error('[vrm-avatar-renderer] failed to play wave animation', error);
      return false;
    }
  }, []);

  const handleBehaviorCue = useCallback(
    (event: BehaviorCueEvent) => {
      if (event.name !== 'greet_face') {
        return;
      }

      const played = playWave();
      if (!played) {
        console.warn('[vrm-avatar-renderer] Received greet_face cue but wave animation is unavailable.', {
          source: event.source,
        });
      } else {
        console.info('[vrm-avatar-renderer] greet_face cue triggered wave animation.', {
          source: event.source,
        });
      }
    },
    [playWave],
  );

  useBehaviorCues(handleBehaviorCue);

  const handleAnimationEvent = useCallback(
    (event: AvatarAnimationEvent) => {
      if (event.type === 'response') {
        if (activeAnimationRef.current?.intent === 'pose') {
          clearActiveAnimation();
          playNextQueuedAnimation();
        }
        return;
      }

      if (event.type === 'applyPose') {
        // Apply pose via animated transition for smooth interpolation
        const vrm = currentVrmRef.current;
        const mixer = mixerRef.current;
        if (!vrm?.humanoid || !mixer) {
          console.warn('[vrm-avatar-renderer] VRM humanoid or mixer not available for pose application');
          return;
        }

        try {
          // Normalize pose to get bone names for capture
          const { bones: targetBones } = normalizePoseData(event.pose);

          // IMPORTANT: Capture current bone rotations BEFORE clearing the active animation
          // This prevents the bones from snapping back to default when action.stop() is called
          const targetBoneNames = Object.keys(targetBones);
          const capturedPose = captureCurrentPose(vrm, targetBoneNames);

          // Clear any existing pose animation (this may reset bones, but we've captured them)
          if (activeAnimationRef.current?.intent === 'pose') {
            clearActiveAnimation();
          }

          // Create transition clip from captured pose to target pose
          const duration = event.transitionDuration ?? DEFAULT_POSE_TRANSITION_DURATION;
          const transitionResult = createPoseTransitionClip(vrm, event.pose, duration, capturedPose);

          if (!transitionResult) {
            console.warn('[vrm-avatar-renderer] Could not create pose transition clip');
            return;
          }

          const { clip: transitionClip, expressions: poseExpressions } = transitionResult;

          // Suspend idle animations during transition
          suspendIdleAnimations();

          const action = mixer.clipAction(transitionClip);

          const handleFinished = (finishedEvent: { action?: THREE.AnimationAction | null }) => {
            if (finishedEvent.action !== action) {
              return;
            }

            mixer.removeEventListener('finished', handleFinished);

            // Keep the pose clamped at the end
            action.clampWhenFinished = true;
            action.enabled = true;
            action.setEffectiveTimeScale(0);
            activeAnimationRef.current = {
              action,
              intent: 'pose',
              onFinish: handleFinished,
            };

            // Apply facial expressions when transition completes
            if (poseExpressions && vrm.expressionManager) {
              applyPoseExpressions(vrm, poseExpressions);
              console.info('[vrm-avatar-renderer] Applied pose expressions:', JSON.stringify({
                presets: poseExpressions.presets ? Object.keys(poseExpressions.presets) : [],
              }));
            }

            console.info('[vrm-avatar-renderer] Pose transition completed:', JSON.stringify({
              source: event.source,
            }));
          };

          activeAnimationRef.current = {
            action,
            intent: 'pose',
            onFinish: handleFinished,
          };

          // Play the transition animation
          action.reset();
          action.enabled = true;
          action.setLoop(THREE.LoopOnce, 1);
          action.setEffectiveWeight(1);
          action.setEffectiveTimeScale(1);
          action.clampWhenFinished = true;
          mixer.addEventListener('finished', handleFinished);
          action.play();

          console.info('[vrm-avatar-renderer] Started smooth pose transition:', JSON.stringify({
            source: event.source,
            boneCount: targetBoneNames.length,
            duration,
            hasExpressions: !!poseExpressions,
          }));
        } catch (error) {
          console.error('[vrm-avatar-renderer] Failed to apply pose transition', error);
          releaseIdleSuspension();
        }
        return;
      }

      const slug = event.request.slug.trim();
      if (!slug) {
        console.warn('[vrm-avatar-renderer] received animation request without a slug');
        return;
      }

      if (activeAnimationRef.current?.intent === 'pose') {
        clearActiveAnimation();
      }

      enqueueAnimation({
        slug,
        intent: event.request.intent,
        source: event.request.source,
        timing: event.request.timing,
      });
    },
    [clearActiveAnimation, enqueueAnimation, playNextQueuedAnimation, suspendIdleAnimations, releaseIdleSuspension],
  );

  useAvatarAnimationQueue(handleAnimationEvent);

  const setStatus = useMemo(() => {
    return (status: VrmRendererStatus) => {
      onStatusChange?.(status);
    };
  }, [onStatusChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const isJsdom =
      typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? /jsdom/i.test(navigator.userAgent)
        : false;

    if (isJsdom && typeof (canvas as { getContext?: unknown }).getContext !== 'function') {
      // jsdom canvas stubs may not implement getContext; skip initialization for tests
      setStatus({ status: 'idle' });
      return;
    }

    let renderer: THREE.WebGLRenderer | null = null;

    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to initialize WebGL renderer.';
      console.error('[vrm-avatar-renderer] unable to create WebGLRenderer', error);
      setStatus({ status: 'error', message });
      return;
    }

    renderer.setClearColor(0x000000, 0);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 20);
    camera.position.set(0, CAMERA_HEIGHT, CAMERA_DISTANCE);
    camera.lookAt(0, CAMERA_HEIGHT - 0.1, 0);
    cameraRef.current = camera;

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
    keyLight.position.set(0.8, 1.6, 1.0);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
    fillLight.position.set(-1.2, 1.2, 0.8);

    scene.add(ambient);
    scene.add(keyLight);
    scene.add(fillLight);

    const pixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1;
    canvas.width = Math.floor(VRM_CANVAS_WIDTH * pixelRatio);
    canvas.height = Math.floor(VRM_CANVAS_HEIGHT * pixelRatio);
    canvas.style.width = `${VRM_CANVAS_WIDTH}px`;
    canvas.style.height = `${VRM_CANVAS_HEIGHT}px`;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(VRM_CANVAS_WIDTH, VRM_CANVAS_HEIGHT, false);
    if (camera) {
      camera.aspect = VRM_CANVAS_WIDTH / VRM_CANVAS_HEIGHT;
      camera.updateProjectionMatrix();
    }

    clockRef.current = new THREE.Clock();

    const renderFrame = () => {
      const rendererInstance = rendererRef.current;
      const sceneInstance = sceneRef.current;
      const cameraInstance = cameraRef.current;
      const manager = expressionManagerRef.current;
      if (!rendererInstance || !sceneInstance || !cameraInstance) {
        return;
      }

      const delta = clockRef.current.getDelta();

      if (manager) {
        const visemeState = visemeStateRef.current;
        const blinkState = blinkStateRef.current;
        const currentFrame = frameRef.current;
        const preset = mapVisemeToPreset(currentFrame?.index);
        const targetWeight = clamp01(currentFrame?.intensity ?? 0);

        for (const visemePreset of VISEME_PRESETS) {
          const target = visemePreset === preset ? targetWeight : 0;
          const current = visemeState.weights.get(visemePreset) ?? 0;
          const next = smoothWeight(current, target, delta);
          visemeState.weights.set(visemePreset, next);
          manager.setValue(visemePreset, next);
        }

        if (currentFrame?.blink) {
          blinkState.target = 1;
          blinkState.hold = BLINK_HOLD_SECONDS;
        } else if (blinkState.hold > 0) {
          blinkState.hold = Math.max(0, blinkState.hold - delta);
          if (blinkState.hold === 0) {
            blinkState.target = 0;
          }
        }

        blinkState.value = smoothWeight(blinkState.value, blinkState.target, delta, 22, 14);
        if (blinkState.target === 0 && blinkState.value < 0.01) {
          blinkState.value = 0;
        }
        manager.setValue(VRMExpressionPresetName.Blink, blinkState.value);
        manager.update();
      }

      mixerRef.current?.update(delta);

      // Apply expression keyframes from VRMA metadata at current animation time
      const activeAnimation = activeAnimationRef.current;
      if (activeAnimation?.vrmaData && currentVrmRef.current) {
        const animationTime = activeAnimation.action.time;
        applyExpressionFrameAtTime(currentVrmRef.current, activeAnimation.vrmaData, animationTime);
      }

      idleSchedulerRef.current?.update(delta);
      currentVrmRef.current?.update(delta);
      rendererInstance.render(sceneInstance, cameraInstance);
      animationFrameRef.current = requestAnimationFrame(renderFrame);
    };

    animationFrameRef.current = requestAnimationFrame(renderFrame);
    setRendererReady(true);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = null;
      scene.remove(ambient);
      scene.remove(keyLight);
      scene.remove(fillLight);
      clearActiveAnimation();
      clipRegistryRef.current.clear();
      animationQueueRef.current = [];
      vrmaRegistryReadyRef.current = false;
      releaseIdleSuspension();
      disposeVrm(currentVrmRef.current);
      renderer.dispose();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      try {
        mixerRef.current?.stopAllAction();
      } catch (error) {
        console.warn('[vrm-avatar-renderer] failed to stop animation mixer during cleanup', error);
      }
      mixerRef.current = null;
      idleSchedulerRef.current?.dispose();
      idleSchedulerRef.current = null;
      waveActionRef.current = null;
      expressionManagerRef.current = null;
      currentVrmRef.current = null;
      visemeStateRef.current = createDefaultVisemeState();
      blinkStateRef.current = createDefaultBlinkState();
    };
  }, [clearActiveAnimation, releaseIdleSuspension, setStatus]);

  useEffect(() => {
    if (!rendererReady) {
      return;
    }

    const scene = sceneRef.current;
    if (!scene || !rendererRef.current) {
      return;
    }

    let cancelled = false;

    const unload = () => {
      clearActiveAnimation();
      clipRegistryRef.current.clear();
      animationQueueRef.current = [];
      vrmaRegistryReadyRef.current = false;
      if (currentVrmRef.current) {
        scene.remove(currentVrmRef.current.scene);
      }
      disposeVrm(currentVrmRef.current);
      currentVrmRef.current = null;
      try {
        mixerRef.current?.stopAllAction();
      } catch (error) {
        console.warn('[vrm-avatar-renderer] failed to stop animation mixer during unload', error);
      }
      mixerRef.current = null;
      idleSchedulerRef.current?.dispose();
      idleSchedulerRef.current = null;
      waveActionRef.current = null;
      expressionManagerRef.current = null;
      visemeStateRef.current = createDefaultVisemeState();
      blinkStateRef.current = createDefaultBlinkState();
      releaseIdleSuspension();
    };

    const load = async () => {
      if (!model) {
        unload();
        setStatus({ status: 'idle' });
        return;
      }

      unload();
      setStatus({ status: 'loading' });

      try {
        const bridge = getPreloadApi();
        const binary = await bridge?.avatar?.loadModelBinary(model.id);
        if (!binary) {
          throw new Error('VRM binary payload is unavailable.');
        }

        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));
        const gltf = (await loader.parseAsync(binary, '/')) as { userData?: { vrm?: VRM } };
        const vrm = gltf.userData?.vrm;
        if (!vrm) {
          throw new Error('Parsed GLTF did not include a VRM extension.');
        }

        if (typeof VRMUtils.removeUnnecessaryVertices === 'function') {
          VRMUtils.removeUnnecessaryVertices(vrm.scene);
        }
        if (typeof VRMUtils.removeUnnecessaryJoints === 'function') {
          VRMUtils.removeUnnecessaryJoints(vrm.scene);
        }
        if (typeof VRMUtils.rotateVRM0 === 'function') {
          VRMUtils.rotateVRM0(vrm);
        }

        vrm.scene.traverse((object: THREE.Object3D) => {
          object.frustumCulled = false;
        });

        vrm.scene.rotation.y = Math.PI;
        vrm.scene.updateWorldMatrix(true, true);
        normalizeVrmScene(vrm);
        applyRelaxedPose(vrm);
        saveDefaultPoseIfNeeded().catch(() => { }); // Fire-and-forget, errors handled internally
        vrm.scene.updateWorldMatrix(true, true);
        const hiddenMeshes = suppressOutlierMeshes(vrm.scene, MAX_RENDERABLE_SIZE);

        if (cancelled) {
          disposeVrm(vrm);
          return;
        }

        const renderableBounds = computeRenderableBounds(vrm.scene);
        if (renderableBounds && cameraRef.current) {
          fitCameraToBounds(cameraRef.current, renderableBounds);
        }
        const meshStats = { meshes: 0, skinnedMeshes: 0 };
        vrm.scene.traverse((object) => {
          if ((object as THREE.Mesh).isMesh) {
            meshStats.meshes += 1;
          }
          if ((object as THREE.SkinnedMesh).isSkinnedMesh) {
            meshStats.skinnedMeshes += 1;
          }
        });
        const headBounds = getHeadBounds(vrm);
        const metricsPayload = {
          modelId: model.id,
          meshCount: meshStats.meshes,
          skinnedMeshCount: meshStats.skinnedMeshes,
          hiddenMeshes,
          bounds: renderableBounds
            ? {
              size: {
                x: Number(renderableBounds.size.x.toFixed(3)),
                y: Number(renderableBounds.size.y.toFixed(3)),
                z: Number(renderableBounds.size.z.toFixed(3)),
              },
              center: {
                x: Number(renderableBounds.center.x.toFixed(3)),
                y: Number(renderableBounds.center.y.toFixed(3)),
                z: Number(renderableBounds.center.z.toFixed(3)),
              },
            }
            : null,
          head: headBounds
            ? {
              widthCm: Number((headBounds.width * 100).toFixed(1)),
              heightCm: Number((headBounds.height * 100).toFixed(1)),
              depthCm: Number((headBounds.depth * 100).toFixed(1)),
            }
            : null,
        };
        console.info('[vrm-avatar-renderer] VRM scene metrics', JSON.stringify(metricsPayload));

        scene.add(vrm.scene);
        currentVrmRef.current = vrm;
        expressionManagerRef.current = vrm.expressionManager ?? null;
        expressionManagerRef.current?.resetValues();
        const mixer = createMixerForVrm(vrm);
        mixerRef.current = mixer;
        const idleSchedulerConfig = buildIdleSchedulerConfig(vrm, idleOptionsRef.current);
        const idleScheduler = new IdleAnimationScheduler({
          mixer,
          vrm,
          config: idleSchedulerConfig,
        });
        idleScheduler.updateConfig(idleSchedulerConfig);
        idleSchedulerRef.current = idleScheduler;
        clipRegistryRef.current.clear();
        animationQueueRef.current = [];
        vrmaRegistryReadyRef.current = false;
        try {
          const animationRegistry = await loadVrmaClips(vrm);
          clipRegistryRef.current = animationRegistry;
        } catch (error) {
          console.warn('[vrm-avatar-renderer] failed to load VRMA registry', error);
        } finally {
          vrmaRegistryReadyRef.current = true;
          if (!cancelled) {
            playNextQueuedAnimation();
          }
        }
        const clip = createRightArmWaveClip(vrm);
        if (clip) {
          const action = mixer.clipAction(clip);
          action.clampWhenFinished = true;
          action.enabled = false;
          action.setLoop(THREE.LoopOnce, 1);
          action.setEffectiveWeight(1);
          action.setEffectiveTimeScale(1);
          waveActionRef.current = action;
        } else {
          waveActionRef.current = null;
        }
        setStatus({ status: 'ready' });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unable to load VRM model. Please check the console logs.';
        console.error('[vrm-avatar-renderer] failed to load VRM model', error);
        unload();
        setStatus({ status: 'error', message });
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [
    clearActiveAnimation,
    model,
    model?.id,
    model?.fileSha,
    playNextQueuedAnimation,
    releaseIdleSuspension,
    rendererReady,
    setStatus,
  ]);

  useEffect(() => {
    const vrm = currentVrmRef.current;
    const scheduler = idleSchedulerRef.current;
    if (!vrm || !scheduler) {
      return;
    }

    scheduler.updateConfig(buildIdleSchedulerConfig(vrm, idleOptions));
  }, [idleOptions]);

  useEffect(() => {
    const vrm = currentVrmRef.current;
    if (!vrm || animationVersion === undefined) {
      return;
    }

    let cancelled = false;
    void (async () => {
      vrmaRegistryReadyRef.current = false;
      try {
        const animationRegistry = await loadVrmaClips(vrm);
        if (cancelled) {
          return;
        }
        clipRegistryRef.current = animationRegistry;
      } catch (error) {
        console.warn('[vrm-avatar-renderer] failed to reload VRMA registry', error);
      } finally {
        if (!cancelled) {
          vrmaRegistryReadyRef.current = true;
          playNextQueuedAnimation();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [animationVersion, playNextQueuedAnimation]);

  return <canvas ref={canvasRef} className={className} data-renderer="vrm" />;
});
