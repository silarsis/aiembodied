import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRM,
  VRMLoaderPlugin,
  VRMUtils,
  VRMExpressionPresetName,
  type VRMExpressionManager,
} from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, type VRMAnimation } from '@pixiv/three-vrm-animation';
import type { VisemeFrame } from '../audio/viseme-driver.js';
import type { AvatarModelSummary } from './types.js';
import { getPreloadApi } from '../preload-api.js';
import { useAvatarAnimationQueue, type AvatarAnimationEvent } from './animation-bus.js';
import { useBehaviorCues, type BehaviorCueEvent } from './behavior-cues.js';
import { createClipFromVrma, createMixerForVrm } from './animations/index.js';
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

const WAVE_ANIMATION_NAME = 'greet_face_wave';

type AnimationQueueIntent = 'play' | 'pose';

interface QueuedAnimation {
  slug: string;
  intent: AnimationQueueIntent;
  source?: string;
}

interface ActiveAnimation {
  action: THREE.AnimationAction;
  intent: AnimationQueueIntent;
  onFinish: (event: { action?: THREE.AnimationAction | null }) => void;
}

export function toAnimationSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug;
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

  if (options?.additionalClips?.length) {
    for (const clip of options.additionalClips) {
      extras.push({
        ...clip,
        clip: clip.clip.clone(),
      });
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
    });
  }

  if (extras.length > 0) {
    config.additionalClips = extras;
  }

  return config;
}

async function loadVrmaAnimation(binary: ArrayBuffer): Promise<VRMAnimation | null> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const gltf = (await loader.parseAsync(binary, '/')) as {
    userData?: { vrmAnimations?: VRMAnimation[] };
  };
  const animations = gltf.userData?.vrmAnimations;
  if (!animations || animations.length === 0) {
    return null;
  }
  return animations[0] ?? null;
}

async function loadVrmaClips(vrm: VRM): Promise<Map<string, THREE.AnimationClip>> {
  const registry = new Map<string, THREE.AnimationClip>();
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
      const vrma = await loadVrmaAnimation(binary);
      if (!vrma) {
        continue;
      }
      const name = animation.name?.trim() || animation.id;
      const slug = toAnimationSlug(name) || `animation-${index}`;
      const clip = createClipFromVrma(vrm, vrma, name);
      registry.set(slug, clip);
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
  const clipRegistryRef = useRef<Map<string, THREE.AnimationClip>>(new Map());
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

    const clip = clipRegistryRef.current.get(next.slug);
    if (!clip) {
      console.warn('[vrm-avatar-renderer] requested animation clip is unavailable', { slug: next.slug });
      playNextQueuedAnimation();
      return;
    }

    suspendIdleAnimations();

    const action = mixer.clipAction(clip);
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
      });
    },
    [clearActiveAnimation, enqueueAnimation, playNextQueuedAnimation],
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

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const pixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1;
      const width = Math.max(1, Math.floor(rect.width * pixelRatio));
      const height = Math.max(1, Math.floor(rect.height * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(rect.width || 320, rect.height || 320, false);
      if (camera) {
        camera.aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1;
        camera.updateProjectionMatrix();
      }
    };

    resize();

    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    resizeObserver?.observe(canvas);

    clockRef.current = new THREE.Clock();

    const renderFrame = () => {
      const rendererInstance = rendererRef.current;
      const sceneInstance = sceneRef.current;
      const cameraInstance = cameraRef.current;
      const manager = expressionManagerRef.current;
      if (!rendererInstance || !sceneInstance || !cameraInstance) {
        return;
      }

      resize();
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
      resizeObserver?.disconnect();
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

        vrm.scene.position.set(0, -0.9, 0);
        vrm.scene.rotation.y = Math.PI / 14;

        if (cancelled) {
          disposeVrm(vrm);
          return;
        }

        scene.add(vrm.scene);
        currentVrmRef.current = vrm;
        expressionManagerRef.current = vrm.expressionManager ?? null;
        expressionManagerRef.current?.resetValues();
        const mixer = createMixerForVrm(vrm);
        mixerRef.current = mixer;
        const idleScheduler = new IdleAnimationScheduler({
          mixer,
          vrm,
          config: buildIdleSchedulerConfig(vrm, idleOptionsRef.current),
        });
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
  }, [clearActiveAnimation, model, model?.id, model?.fileSha, releaseIdleSuspension, rendererReady, setStatus]);

  useEffect(() => {
    const vrm = currentVrmRef.current;
    const scheduler = idleSchedulerRef.current;
    if (!vrm || !scheduler) {
      return;
    }

    scheduler.updateConfig(buildIdleSchedulerConfig(vrm, idleOptions));
  }, [idleOptions]);

  return <canvas ref={canvasRef} className={className} data-renderer="vrm" />;
});
