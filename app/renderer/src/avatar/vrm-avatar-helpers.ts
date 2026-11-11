import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRM,
  VRMUtils,
  VRMExpressionPresetName,
  type VRMPose,
} from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, type VRMAnimation } from '@pixiv/three-vrm-animation';
import baseNeutralPose from '../../../main/src/avatar/base-poses/relaxed-neutral.pose.json';
import { getPreloadApi } from '../preload-api.js';
import type {
  VRMPoseData,
  VRMPoseExpressions,
  PoseTransitionConfig,
} from './animation-bus.js';
import { toAnimationSlug } from './animation-tags.js';
import {
  createClipFromVrma,
  createHumanoidRotationTrack,
  createVrmAnimationClip,
} from './animations/index.js';
import {
  type IdleAnimationSchedulerConfig,
  type IdleClipRegistration,
} from './animations/idle-scheduler.js';

/**
 * Pure VRM helpers (pose, viseme, scene-fitting and VRMA loading functions) shared by the
 * per-avatar `AvatarActor` and the per-scene `VrmAvatarRenderer`. Moved verbatim out of
 * `vrm-avatar-renderer.tsx`, which re-exports them so existing imports keep working.
 */

export interface IdleAnimationOptions {
  enableBreathing?: boolean;
  enableMicroMovement?: boolean;
  enableBlink?: boolean;
  vrmaAnimations?: VRMAnimation[];
  additionalClips?: IdleClipRegistration[];
}

export const VISEME_PRESETS: VRMExpressionPresetName[] = [
  VRMExpressionPresetName.Aa,
  VRMExpressionPresetName.Ih,
  VRMExpressionPresetName.Ou,
  VRMExpressionPresetName.Ee,
  VRMExpressionPresetName.Oh,
];

export const BLINK_HOLD_SECONDS = 0.12;
/** Blend between queued clips and the idle pose so clips don't snap in or out. */
export const CLIP_FADE_IN_SECONDS = 0.25;
export const CLIP_FADE_OUT_SECONDS = 0.3;
/** How long the body eases from the last frame of a motion into the standing pose. */
export const MOTION_RELEASE_BLEND_SECONDS = 0.3;
export const TARGET_MODEL_HEIGHT = 1.6;
export const MIN_SCALE = 0.01;
export const MAX_SCALE = 100;
export const CAMERA_PADDING = 1.25;
export const MAX_RENDERABLE_SIZE = TARGET_MODEL_HEIGHT * 6;

export const WAVE_ANIMATION_NAME = 'greet_face_wave';
export const DEFAULT_IDLE_CLIP_NAME = 'default_idle_sway';

export interface ExpressionSampler {
  name: string;
  keyframes: Array<{ t: number; v: number }>;
}

export interface VrmaGltfExtensions {
  VRMC_vrm_animation?: {
    expressionSamplers?: {
      preset?: ExpressionSampler[];
      custom?: ExpressionSampler[];
    };
  };
}

export interface VrmaGltf {
  extensions?: VrmaGltfExtensions;
}

export interface VrmaClipWithMetadata {
  clip: THREE.AnimationClip;
  vrmaData?: VrmaGltf;
}


export function buildIdleSchedulerConfig(
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

export async function loadVrmaAnimation(binary: ArrayBuffer): Promise<{ animation: VRMAnimation; gltf: VrmaGltf } | null> {
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

export async function loadVrmaClips(vrm: VRM): Promise<Map<string, VrmaClipWithMetadata>> {
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
export function applyExpressionFrameAtTime(vrm: VRM, vrmaData: VrmaGltf, currentTime: number) {
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
        const resolvedName = availableExpressions.find((available) => available.toLowerCase() === name.toLowerCase()) ?? name;
        const expressionExists = availableExpressions.includes(resolvedName);
        if (!expressionExists && clampedWeight > 0) {
          console.warn(`[vrm-avatar-renderer] Expression '${name}' not found in VRM model. Available: ${availableExpressions.join(', ')}`);
        }

        expressionManager.setValue(resolvedName, clampedWeight);
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

/** Built-in stances were authored in the bundled VRM 0 rig's normalized basis. */
export function poseBonesForVrm(vrm: VRM, pose: VRMPoseData): ReturnType<typeof normalizePoseData> {
  const normalized = normalizePoseData(pose);
  if (pose.sourceVrmVersion !== '0' || vrm.meta?.metaVersion !== '1') return normalized;
  return {
    ...normalized,
    bones: Object.fromEntries(Object.entries(normalized.bones).map(([name, bone]) => [name, {
      ...bone,
      rotation: [-bone.rotation[0], bone.rotation[1], -bone.rotation[2], bone.rotation[3]],
      ...(bone.position ? { position: [-bone.position[0], bone.position[1], -bone.position[2]] } : {}),
    }])),
  };
}

export const DEFAULT_POSE_TRANSITION_DURATION = 0.5; // seconds

// Default config for eased staggered transitions (can be disabled by passing staggerFactor: 0, easing: 'linear')
const DEFAULT_POSE_TRANSITION_CONFIG: Required<PoseTransitionConfig> = {
  staggerFactor: 0.15, // 15% of duration for full stagger spread
  easing: 'easeOut',
};

/**
 * Bone chain depth from root (hips = 0).
 * Used to stagger transition start times for natural wave-like motion.
 */
const BONE_CHAIN_DEPTH: Record<string, number> = {
  // Core chain (depth 0-5)
  hips: 0,
  spine: 1,
  chest: 2,
  upperChest: 3,
  neck: 4,
  head: 5,
  // Left arm chain (branches from depth 3)
  leftShoulder: 3,
  leftUpperArm: 4,
  leftLowerArm: 5,
  leftHand: 6,
  // Right arm chain (branches from depth 3)
  rightShoulder: 3,
  rightUpperArm: 4,
  rightLowerArm: 5,
  rightHand: 6,
  // Left leg chain (branches from depth 0)
  leftUpperLeg: 1,
  leftLowerLeg: 2,
  leftFoot: 3,
  leftToes: 4,
  // Right leg chain (branches from depth 0)
  rightUpperLeg: 1,
  rightLowerLeg: 2,
  rightFoot: 3,
  rightToes: 4,
  // Left fingers (depth 7-9)
  leftThumbProximal: 7, leftThumbIntermediate: 8, leftThumbDistal: 9,
  leftIndexProximal: 7, leftIndexIntermediate: 8, leftIndexDistal: 9,
  leftMiddleProximal: 7, leftMiddleIntermediate: 8, leftMiddleDistal: 9,
  leftRingProximal: 7, leftRingIntermediate: 8, leftRingDistal: 9,
  leftLittleProximal: 7, leftLittleIntermediate: 8, leftLittleDistal: 9,
  // Right fingers (depth 7-9)
  rightThumbProximal: 7, rightThumbIntermediate: 8, rightThumbDistal: 9,
  rightIndexProximal: 7, rightIndexIntermediate: 8, rightIndexDistal: 9,
  rightMiddleProximal: 7, rightMiddleIntermediate: 8, rightMiddleDistal: 9,
  rightRingProximal: 7, rightRingIntermediate: 8, rightRingDistal: 9,
  rightLittleProximal: 7, rightLittleIntermediate: 8, rightLittleDistal: 9,
  // Eyes
  leftEye: 5,
  rightEye: 5,
  jaw: 5,
};

const MAX_BONE_DEPTH = 9;

/**
 * Easing functions for natural motion curves.
 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function applyEasing(t: number, easing: PoseTransitionConfig['easing']): number {
  switch (easing) {
    case 'easeOut': return easeOutCubic(t);
    case 'easeInOut': return easeInOutQuad(t);
    case 'linear':
    default:
      return t;
  }
}


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
 * Supports eased staggered transitions for natural wave-like motion through the skeleton.
 * 
 * @param vrm - The VRM model
 * @param targetPose - The target pose to transition to
 * @param duration - Duration of the transition in seconds
 * @param startingPose - Optional captured pose to start from (if not provided, reads current node values)
 * @param config - Optional transition config for easing and staggering
 * @returns Object with the animation clip and any expressions to apply, or null if no tracks created
 */
export function createPoseTransitionClip(
  vrm: VRM,
  targetPose: VRMPoseData,
  duration: number = DEFAULT_POSE_TRANSITION_DURATION,
  startingPose?: Map<string, CapturedBoneState>,
  config?: PoseTransitionConfig,
): { clip: THREE.AnimationClip; expressions: VRMPoseExpressions | undefined } | null {
  const humanoid = vrm.humanoid;
  if (!humanoid) {
    return null;
  }

  // Merge with defaults
  const { staggerFactor, easing } = { ...DEFAULT_POSE_TRANSITION_CONFIG, ...config };
  const useStagger = staggerFactor > 0;
  const useEasing = easing !== 'linear';

  // Normalize pose data to handle both legacy and new formats
  const { bones, expressions } = poseBonesForVrm(vrm, targetPose);

  const tracks: THREE.KeyframeTrack[] = [];
  const resolvedBones: string[] = [];
  const unresolvedBones: string[] = [];

  // Calculate total clip duration including stagger delay for deepest bones
  const maxStaggerDelay = useStagger ? staggerFactor * duration : 0;
  const totalClipDuration = duration + maxStaggerDelay;

  // Number of intermediate keyframes for easing (more = smoother curve)
  const KEYFRAME_COUNT = useEasing ? 5 : 2;

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

    // Calculate stagger delay based on bone chain depth
    const boneDepth = BONE_CHAIN_DEPTH[boneName] ?? 0;
    const normalizedDepth = boneDepth / MAX_BONE_DEPTH;
    const startDelay = useStagger ? normalizedDepth * maxStaggerDelay : 0;

    // Generate keyframes with easing
    const times: number[] = [];
    const values: number[] = [];

    for (let i = 0; i < KEYFRAME_COUNT; i++) {
      const linearT = i / (KEYFRAME_COUNT - 1); // 0 to 1
      const easedT = applyEasing(linearT, easing);
      const time = startDelay + linearT * duration;

      // SLERP between current and target quaternion
      const interpQuat = new THREE.Quaternion().slerpQuaternions(currentQuat, targetQuat, easedT);

      times.push(time);
      values.push(interpQuat.x, interpQuat.y, interpQuat.z, interpQuat.w);
    }

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

      const posTimes: number[] = [];
      const posValues: number[] = [];

      for (let i = 0; i < KEYFRAME_COUNT; i++) {
        const linearT = i / (KEYFRAME_COUNT - 1);
        const easedT = applyEasing(linearT, easing);
        const time = startDelay + linearT * duration;

        // Lerp between current and target position
        const interpX = currentPos.x + (targetPos[0] - currentPos.x) * easedT;
        const interpY = currentPos.y + (targetPos[1] - currentPos.y) * easedT;
        const interpZ = currentPos.z + (targetPos[2] - currentPos.z) * easedT;

        posTimes.push(time);
        posValues.push(interpX, interpY, interpZ);
      }

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
    duration: totalClipDuration,
    hasExpressions: !!expressions,
    easing,
    staggerFactor,
  }));

  return {
    clip: new THREE.AnimationClip('pose-transition', totalClipDuration, tracks),
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

  const upperRaised = vrm.meta?.metaVersion === '1'
    ? new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -1.1))
    : multiplyQuaternion(upperRest, new THREE.Euler(-0.9, 0.25, 0));
  const lowerRaised = vrm.meta?.metaVersion === '1'
    ? new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -1.2))
    : multiplyQuaternion(lowerRest, new THREE.Euler(-0.7, 0.15, 0));
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

export interface VisemeWeightState {
  weights: Map<VRMExpressionPresetName, number>;
}

export interface BlinkState {
  value: number;
  target: number;
  hold: number;
}

export function createDefaultVisemeState(): VisemeWeightState {
  const weights = new Map<VRMExpressionPresetName, number>();
  for (const preset of VISEME_PRESETS) {
    weights.set(preset, 0);
  }
  return { weights };
}

export function createDefaultBlinkState(): BlinkState {
  return { value: 0, target: 0, hold: 0 };
}

export function createDefaultIdleClip(vrm: VRM): THREE.AnimationClip | null {
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

/** Use the approved neutral stance directly; its forward compensation is already baked in. */
export function applyBaseNeutralPose(vrm: VRM): void {
  if (!vrm.humanoid) return;
  vrm.humanoid.setNormalizedPose(poseBonesForVrm(vrm, baseNeutralPose as VRMPoseData).bones as VRMPose);
  applyPoseExpressions(vrm, baseNeutralPose.expressions);
}

export function getHeadBounds(vrm: VRM): { width: number; height: number; depth: number } | null {
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

export function computeRenderableBounds(root: THREE.Object3D): { box: THREE.Box3; size: THREE.Vector3; center: THREE.Vector3 } | null {
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

export function normalizeVrmScene(vrm: VRM, targetHeight = TARGET_MODEL_HEIGHT) {
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

export function fitCameraToBounds(
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

/** Read the first rendered silhouette once: transparent atlas geometry must not count as a sole. */
export function renderedFootFraction(renderer: THREE.WebGLRenderer): number | null {
  try {
    const gl = renderer.getContext();
    if (typeof gl?.readPixels !== 'function') return null;
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    if (!width || !height || width * height > 8_000_000) return null;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    // WebGL rows start at the bottom; a few solid pixels exclude antialiasing specks.
    for (let row = 0; row < height; row++) {
      let visible = 0;
      for (let column = 0; column < width; column++) {
        if (pixels[(row * width + column) * 4 + 3] > 64 && ++visible >= 3) {
          return 1 - (row + 0.5) / height;
        }
      }
    }
  } catch { /* A lost context is handled by the normal renderer status path. */ }
  return null;
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

export function disposeVrm(vrm: VRM | null) {
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
